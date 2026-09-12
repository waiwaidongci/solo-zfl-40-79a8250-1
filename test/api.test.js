import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CyanotypeStore } from "../src/store.js";
import { createApp } from "../src/app.js";

async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), "cyanotype-api-"));
  const store = await new CyanotypeStore(join(dir, "db.json")).load();
  const server = createApp(store);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    store,
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

async function get(base, path) {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const BATCH = { chemicalBatch: "B-0620", exposure: "8分钟", waterSource: "井水过滤", count: 2 };

test("API:批次创建、筛选、统计一致", async () => {
  const { base, close } = await startServer();
  try {
    const created = await post(base, "/api/batches", BATCH);
    assert.equal(created.status, 201);
    assert.equal(created.body.items.length, 2);

    const a = created.body.items[0];
    await post(base, `/api/items/${a.id}/transition`, { to: "冲洗中" });
    await post(base, `/api/items/${a.id}/transition`, { to: "待入盒", box: "蓝盒A-03" });
    await post(base, `/api/items/${a.id}/steps`, { step: "冲洗", defect: "边角显影不均", repair: "边角重涂" });

    // 按批次 / 盒位 / 缺陷 / 状态筛选
    assert.equal((await get(base, "/api/items?batch=" + created.body.batch.code)).body.length, 2);
    assert.equal((await get(base, "/api/items?batch=B-0620")).body.length, 2);
    assert.equal((await get(base, "/api/items?box=" + encodeURIComponent("蓝盒A-03"))).body.length, 1);
    assert.equal((await get(base, "/api/items?defect=" + encodeURIComponent("显影不均"))).body.length, 1);
    assert.equal((await get(base, "/api/items?status=" + encodeURIComponent("待入盒"))).body.length, 1);
    assert.equal((await get(base, "/api/items?status=" + encodeURIComponent("已交付"))).body.length, 0);

    // 统计与列表一致
    const items = (await get(base, "/api/items")).body;
    const stats = (await get(base, "/api/stats")).body;
    assert.equal(stats.total, items.length);
    for (const [stage, count] of Object.entries(stats.byStatus)) {
      assert.equal(count, items.filter(i => i.status === stage).length);
    }
    assert.equal(stats.withDefect, 1);
  } finally {
    await close();
  }
});

test("API:异常输入返回 400/404/405/413", async () => {
  const { base, close } = await startServer();
  try {
    // 非法 JSON
    const badJson = await fetch(base + "/api/batches", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, "invalid_json");

    // 非对象 JSON
    const arrBody = await fetch(base + "/api/batches", { method: "POST", headers: { "Content-Type": "application/json" }, body: "[1,2]" });
    assert.equal(arrBody.status, 400);

    // 缺字段 / 非法数量
    assert.equal((await post(base, "/api/batches", { exposure: "8分钟" })).status, 400);
    assert.equal((await post(base, "/api/batches", { ...BATCH, count: 0 })).status, 400);
    assert.equal((await post(base, "/api/batches", { ...BATCH, count: "两块" })).status, 400);

    // 不存在的底片 / 未知路由 / 方法不允许
    assert.equal((await post(base, "/api/items/NOPE/transition", { to: "冲洗中" })).status, 404);
    assert.equal((await get(base, "/api/nope")).status, 404);
    const notAllowed = await fetch(base + "/api/stats", { method: "DELETE" });
    assert.equal(notAllowed.status, 405);

    // 非法筛选值
    assert.equal((await get(base, "/api/items?status=" + encodeURIComponent("不存在"))).status, 400);

    // 请求体超限
    const huge = await fetch(base + "/api/batches", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"x":"' + "a".repeat(1024 * 1024 + 10) + '"}' });
    assert.equal(huge.status, 413);
  } finally {
    await close();
  }
});

test("API:状态机拒绝跳步与退回,盒位冲突返回 409", async () => {
  const { base, close } = await startServer();
  try {
    const created = await post(base, "/api/batches", BATCH);
    const [a, b] = created.body.items;

    // 跳步
    const skip = await post(base, `/api/items/${a.id}/transition`, { to: "待入盒", box: "X-1" });
    assert.equal(skip.status, 409);
    assert.equal(skip.body.error, "invalid_transition");

    await post(base, `/api/items/${a.id}/transition`, { to: "冲洗中" });
    await post(base, `/api/items/${b.id}/transition`, { to: "冲洗中" });
    await post(base, `/api/items/${a.id}/transition`, { to: "待入盒", box: "蓝盒A-03" });

    // 退回
    const back = await post(base, `/api/items/${a.id}/transition`, { to: "冲洗中" });
    assert.equal(back.status, 409);

    // 盒位冲突
    const conflict = await post(base, `/api/items/${b.id}/transition`, { to: "待入盒", box: "蓝盒A-03" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "box_occupied");

    // 缺盒位
    assert.equal((await post(base, `/api/items/${b.id}/transition`, { to: "待入盒" })).status, 400);
  } finally {
    await close();
  }
});

test("API:幂等键重复提交不生成重复记录", async () => {
  const { base, close } = await startServer();
  try {
    const key = "form-submit-abc";
    const first = await post(base, "/api/batches", BATCH, { "Idempotency-Key": key });
    const second = await post(base, "/api/batches", BATCH, { "Idempotency-Key": key });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.headers.get("x-idempotent-replay"), "true");
    assert.equal(second.body.batch.id, first.body.batch.id);
    assert.equal((await get(base, "/api/items")).body.length, 2);
    assert.equal((await get(base, "/api/batches")).body.length, 1);

    // 同键不同内容 → 409
    const reused = await post(base, "/api/batches", { ...BATCH, chemicalBatch: "B-9999" }, { "Idempotency-Key": key });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error, "idempotency_key_reused");

    // 步骤记录重复提交也不重复计数
    const id = first.body.items[0].id;
    await post(base, `/api/items/${id}/steps`, { step: "复晒", reexpose: true }, { "Idempotency-Key": "step-1" });
    await post(base, `/api/items/${id}/steps`, { step: "复晒", reexpose: true }, { "Idempotency-Key": "step-1" });
    const item = (await get(base, `/api/items/${id}`)).body;
    assert.equal(item.reexposeCount, 1);
    assert.equal(item.steps.length, 1);
  } finally {
    await close();
  }
});

test("API:并发推进同一底片,只有一次成功", async () => {
  const { base, close } = await startServer();
  try {
    const created = await post(base, "/api/batches", { ...BATCH, count: 1 });
    const id = created.body.items[0].id;

    const results = await Promise.all([
      post(base, `/api/items/${id}/transition`, { to: "冲洗中" }),
      post(base, `/api/items/${id}/transition`, { to: "冲洗中" }),
      post(base, `/api/items/${id}/transition`, { to: "冲洗中" }),
    ]);
    const ok = results.filter(r => r.status === 200);
    const rejected = results.filter(r => r.status === 409);
    assert.equal(ok.length, 1);
    assert.equal(rejected.length, 2);

    const item = (await get(base, `/api/items/${id}`)).body;
    assert.equal(item.status, "冲洗中");
    assert.equal(item.logs.filter(l => l.step === "状态推进").length, 1);
  } finally {
    await close();
  }
});

test("API:并发抢占同一盒位,只有一块底片入盒", async () => {
  const { base, close } = await startServer();
  try {
    const created = await post(base, "/api/batches", { ...BATCH, count: 2 });
    const [a, b] = created.body.items;
    await Promise.all([
      post(base, `/api/items/${a.id}/transition`, { to: "冲洗中" }),
      post(base, `/api/items/${b.id}/transition`, { to: "冲洗中" }),
    ]);

    const results = await Promise.all([
      post(base, `/api/items/${a.id}/transition`, { to: "待入盒", box: "蓝盒A-03" }),
      post(base, `/api/items/${b.id}/transition`, { to: "待入盒", box: "蓝盒A-03" }),
    ]);
    assert.equal(results.filter(r => r.status === 200).length, 1);
    assert.equal(results.filter(r => r.status === 409 && r.body.error === "box_occupied").length, 1);

    const items = (await get(base, "/api/items?box=" + encodeURIComponent("蓝盒A-03"))).body;
    assert.equal(items.length, 1);
  } finally {
    await close();
  }
});

test("API:并发带过期版本号的更新被乐观锁拒绝", async () => {
  const { base, close } = await startServer();
  try {
    const created = await post(base, "/api/batches", { ...BATCH, count: 1 });
    const id = created.body.items[0].id;
    await post(base, `/api/items/${id}/transition`, { to: "冲洗中" }); // version 2

    const stale = await post(base, `/api/items/${id}/transition`, { to: "待入盒", box: "A-1", expectedVersion: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "version_conflict");

    const fresh = await post(base, `/api/items/${id}/transition`, { to: "待入盒", box: "A-1", expectedVersion: 2 });
    assert.equal(fresh.status, 200);
  } finally {
    await close();
  }
});

test("API:重启后数据仍在(同一文件重新加载)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyanotype-restart-"));
  const file = join(dir, "db.json");
  const boot = async () => {
    const store = await new CyanotypeStore(file).load();
    const server = createApp(store);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  };
  try {
    const first = await boot();
    const created = await post(first.base, "/api/batches", { ...BATCH, count: 1 }, { "Idempotency-Key": "boot-key" });
    const id = created.body.items[0].id;
    await post(first.base, `/api/items/${id}/transition`, { to: "冲洗中" });
    await new Promise(resolve => first.server.close(resolve));

    const second = await boot();
    const item = (await get(second.base, `/api/items/${id}`)).body;
    assert.equal(item.status, "冲洗中");
    // 重启后同一幂等键重放,不产生新批次
    const replay = await post(second.base, "/api/batches", { ...BATCH, count: 1 }, { "Idempotency-Key": "boot-key" });
    assert.equal(replay.headers.get("x-idempotent-replay"), "true");
    assert.equal((await get(second.base, "/api/batches")).body.length, 1);
    await new Promise(resolve => second.server.close(resolve));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("页面可访问且包含工作台要素", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /新增曝光批次/);
    assert.match(html, /记录工艺步骤/);
    assert.match(html, /按盒位筛选/);
    assert.match(html, /按缺陷筛选/);
  } finally {
    await close();
  }
});
