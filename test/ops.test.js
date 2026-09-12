import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { CyanotypeStore } from "../src/store.js";
import { createApp } from "../src/app.js";
import { createShutdown } from "../src/lifecycle.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverJs = join(root, "server.js");
const storeJsHref = pathToFileURL(join(root, "src", "store.js")).href;
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

async function tempDir() {
  return mkdtemp(join(tmpdir(), "cyanotype-ops-"));
}

async function startServer(options = {}) {
  const dir = await tempDir();
  const dbFile = join(dir, "db.json");
  const store = await new CyanotypeStore(dbFile).load();
  const server = createApp(store, options);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    store,
    server,
    dbFile,
    dir,
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await new Promise(resolve => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function post(base, path, payload, headers = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

async function waitFor(condition, timeoutMs = 15000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor 超时");
}

test("启动时确认数据目录可写:目录被占用时给出明确错误", async () => {
  const dir = await tempDir();
  try {
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory");
    await assert.rejects(
      new CyanotypeStore(join(blocker, "sub", "db.json")).load(),
      error => error.code === "db_not_writable" && /数据目录不可写/.test(error.message)
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("启动时发现数据文件损坏:拒绝启动并说明原因", async () => {
  const dir = await tempDir();
  try {
    const dbFile = join(dir, "db.json");
    await writeFile(dbFile, "{corrupted-json");
    await assert.rejects(
      new CyanotypeStore(dbFile).load(),
      error => error.code === "db_corrupted" && /数据文件损坏/.test(error.message)
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("断电模拟:写入中途 SIGKILL,数据文件仍是完整 JSON,临时文件被清理", async () => {
  const dir = await tempDir();
  const dbFile = join(dir, "db.json");
  const writer = join(dir, "writer.mjs");
  await writeFile(writer, `
    import { CyanotypeStore } from ${JSON.stringify(storeJsHref)};
    const store = await new CyanotypeStore(${JSON.stringify(dbFile)}).load();
    let i = 0;
    while (true) {
      await store.createBatch({ chemicalBatch: "B-" + i, exposure: "1分钟", waterSource: "水", count: 1 });
      i += 1;
      if (i % 25 === 0) console.log("written", i);
    }
  `);
  const child = spawn(process.execPath, [writer], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  try {
    await waitFor(() => out.includes("written"), 30000);
    child.kill("SIGKILL");
    await new Promise(resolve => child.on("exit", resolve));

    // 断电后数据文件必须是完整的 JSON(临时文件 + rename 不会留下半截数据)
    const parsed = JSON.parse(await readFile(dbFile, "utf8"));
    assert.ok(parsed.batches.length > 0, "已落盘的批次应完整可读");
    assert.equal(parsed.items.length, parsed.batches.length);

    // 重新启动时残留的临时文件被清理
    const store = await new CyanotypeStore(dbFile).load();
    assert.equal(store.listBatches().length, parsed.batches.length);
    const names = await readdir(dir);
    assert.ok(!names.some(n => n.endsWith(".tmp")), `不应残留临时文件: ${names.join(",")}`);
  } finally {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

test("故障注入:落盘失败返回 500,恢复后写链不受影响", async () => {
  const { base, store, dbFile, close } = await startServer();
  try {
    const original = store._persistNow.bind(store);
    store._persistNow = () => Promise.reject(new Error("disk full"));
    const failed = await post(base, "/api/batches", { chemicalBatch: "B-1", exposure: "5分钟", waterSource: "泉水", count: 1 });
    assert.equal(failed.status, 500);
    assert.match(failed.body.message, /disk full/);

    store._persistNow = original;
    const recovered = await post(base, "/api/batches", { chemicalBatch: "B-2", exposure: "5分钟", waterSource: "泉水", count: 1 });
    assert.equal(recovered.status, 201);
    const onDisk = JSON.parse(await readFile(dbFile, "utf8"));
    assert.ok(onDisk.batches.length >= 1);
  } finally {
    await close();
  }
});

test("健康检查:版本、监听地址、数据库可读状态、未关闭工单数", async () => {
  const { base, dbFile, close } = await startServer();
  try {
    const healthy = await fetch(base + "/api/health");
    assert.equal(healthy.status, 200);
    const body = await healthy.json();
    assert.equal(body.status, "ok");
    assert.equal(body.version, pkg.version);
    assert.match(body.address, /:\d+$/);
    assert.equal(body.db.readable, true);
    assert.equal(body.reviewsOpen, 0);

    // 建一张未关闭工单,健康检查要反映出来
    const created = await post(base, "/api/batches", { chemicalBatch: "B-1", exposure: "5分钟", waterSource: "泉水", count: 1 });
    const id = created.body.items[0].id;
    await post(base, `/api/items/${id}/transition`, { to: "冲洗中" });
    await post(base, `/api/items/${id}/transition`, { to: "待入盒", box: "H-1" });
    await post(base, `/api/items/${id}/reviews`, { reviewer: "张三", conclusion: "c", requirement: "r", deadline: "2099-01-01" });
    const withReview = await (await fetch(base + "/api/health")).json();
    assert.equal(withReview.reviewsOpen, 1);

    // 故障注入:数据文件不可读 → 503
    await rename(dbFile, dbFile + ".bak");
    await mkdir(dbFile);
    const degraded = await fetch(base + "/api/health");
    assert.equal(degraded.status, 503);
    const degradedBody = await degraded.json();
    assert.equal(degradedBody.status, "degraded");
    assert.equal(degradedBody.db.readable, false);
  } finally {
    await close();
  }
});

test("请求日志:带请求编号与响应状态,不记录请求体敏感字段", async () => {
  const lines = [];
  const { base, close } = await startServer({ logger: line => lines.push(line) });
  try {
    const created = await post(base, "/api/batches", { chemicalBatch: "B-SECRET-药液", exposure: "5分钟", waterSource: "秘密水源", count: 2 });
    const id = created.body.items[0].id;
    await post(base, `/api/items/${id}/transition`, { to: "冲洗中" });
    await post(base, `/api/items/${id}/transition`, { to: "待入盒", box: "蓝盒A-01" });
    await post(base, `/api/items/${id}/reviews`, { reviewer: "张三", conclusion: "秘密结论", requirement: "秘密要求", deadline: "2099-01-01" });
    await post(base, "/api/reviews/RV-0001/close", { resolution: "秘密处理结果" });
    await fetch(base + "/api/items?defect=" + encodeURIComponent("敏感缺陷词"));

    const log = lines.join("\n");
    // 请求编号与响应状态
    assert.match(log, /\[req-000001\] POST \/api\/batches -> 201/);
    assert.match(log, /POST \/api\/items\/[^ ]+\/transition -> 200/);
    // 白名单字段可见
    assert.match(log, /to="冲洗中"/);
    assert.match(log, /count=2/);
    // 敏感字段一律不落地
    for (const secret of ["张三", "B-SECRET-药液", "秘密水源", "秘密结论", "秘密要求", "秘密处理结果", "敏感缺陷词"]) {
      assert.ok(!log.includes(secret), `日志不应包含敏感内容: ${secret}`);
    }
    // 响应头带请求编号,且与日志编号一致(finish 事件异步触发,等待日志落行)
    const res = await fetch(base + "/api/stats");
    const rid = res.headers.get("x-request-id");
    await res.text();
    assert.match(rid, /^req-\d{6}$/);
    await waitFor(() => lines.some(l => l.includes(`[${rid}] GET /api/stats -> 200`)), 2000);
  } finally {
    await close();
  }
});

test("优雅退出(进程内):停止接收新请求,在途写入完成后才退出", async () => {
  const { base, store, server, dbFile, dir } = await startServer();
  try {
    // 注入慢速落盘,制造在途写入
    const original = store._persistNow.bind(store);
    store._persistNow = async () => {
      await new Promise(r => setTimeout(r, 150));
      return original();
    };
    const inflight = post(base, "/api/batches", { chemicalBatch: "B-1", exposure: "5分钟", waterSource: "泉水", count: 2 });
    await new Promise(r => setTimeout(r, 30)); // 确认请求已在途

    const shutdown = createShutdown(server, store, { logger: () => {} });
    await shutdown("test");

    // 在途请求正常完成
    const res = await inflight;
    assert.equal(res.status, 201);
    // shutdown 返回时写入已落盘
    const onDisk = JSON.parse(await readFile(dbFile, "utf8"));
    assert.equal(onDisk.batches.length, 1);
    assert.equal(onDisk.items.length, 2);
    // 不再接收新请求
    await assert.rejects(fetch(base + "/api/health"), /fetch failed|ECONNREFUSED/);
    // 重复调用安全
    assert.equal(await shutdown("again"), false);
  } finally {
    server.closeIdleConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("优雅退出(进程级):SIGTERM 后完成在途写入再以 0 退出", async () => {
  const dir = await tempDir();
  const dbFile = join(dir, "db.json");
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));

  const child = spawn(process.execPath, [serverJs], {
    env: { ...process.env, PORT: String(port), DB_PATH: dbFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { out += d; });
  try {
    await waitFor(() => out.includes("listening"), 15000);
    const res = await fetch(`http://127.0.0.1:${port}/api/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chemicalBatch: "B-1", exposure: "5分钟", waterSource: "泉水", count: 2 }),
    });
    assert.equal(res.status, 201);

    child.kill("SIGTERM");
    const [code] = await new Promise(resolve => child.on("exit", (c, s) => resolve([c, s])));
    assert.equal(code, 0, `子进程应以 0 退出,输出:\n${out}`);
    assert.match(out, /停止接收新请求/);

    const db = JSON.parse(await readFile(dbFile, "utf8"));
    assert.equal(db.batches.length, 1);
    assert.equal(db.items.length, 2);
  } finally {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
