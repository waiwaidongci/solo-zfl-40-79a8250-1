import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CyanotypeStore } from "../src/store.js";
import { createApp } from "../src/app.js";

const BATCH_1 = { chemicalBatch: "B-1", exposure: "5分钟", waterSource: "泉水", count: 1 };
const BATCH_2 = { chemicalBatch: "B-2", exposure: "6分钟", waterSource: "井水", count: 2 };
const REVIEW = { reviewer: "张三", conclusion: "边角显影不均", requirement: "重涂边角", deadline: "2099-01-01" };

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "cyanotype-rollback-"));
  const store = await new CyanotypeStore(join(dir, "db.json")).load();
  return { store, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function injectPersistFailure(store, message = "disk full") {
  const original = store._persistNow.bind(store);
  store._persistNow = () => Promise.reject(new Error(message));
  return () => { store._persistNow = original; };
}

async function onDisk(store) {
  return JSON.parse(await readFile(store.filePath, "utf8"));
}

test("落盘失败完整回滚:失败记录不可查询,文件保持原内容,序号回退", async () => {
  const { store, cleanup } = await tempStore();
  try {
    await store.createBatch(BATCH_1);
    const restore = injectPersistFailure(store);
    await assert.rejects(store.createBatch(BATCH_2), /disk full/);
    restore();

    // 内存中失败记录不可查询
    assert.equal(store.listBatches().length, 1);
    assert.equal(store.listItems().length, 1);
    assert.equal(store.stats().total, 1);
    // 文件保持原内容
    const disk = await onDisk(store);
    assert.equal(disk.batches.length, 1);
    assert.equal(disk.items.length, 1);
    assert.equal(disk.batches[0].chemicalBatch, "B-1");
    // 序号回退:新批次仍是 PC-0002,不会跳号
    const { result } = await store.createBatch(BATCH_2);
    assert.equal(result.batch.code, "PC-0002");
    assert.equal(store.listItems().length, 3);
    // 恢复后文件与内存一致
    const after = await onDisk(store);
    assert.equal(after.batches.length, 2);
    assert.equal(after.items.length, 3);
  } finally {
    await cleanup();
  }
});

test("落盘失败回滚幂等键:同一键可安全重试,成功后才占用", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const { result } = await store.createBatch(BATCH_1);
    const id = result.items[0].id;

    const restore = injectPersistFailure(store);
    await assert.rejects(store.transition(id, { to: "冲洗中" }, "t-key-1"), /disk full/);
    restore();

    // 状态与版本回滚
    const item = store.getItem(id);
    assert.equal(item.status, "待曝光");
    assert.equal(item.version, 1);
    // 失败未占用幂等键:同键同内容重试按新请求执行,而不是重放或报冲突
    const retry = await store.transition(id, { to: "冲洗中" }, "t-key-1");
    assert.equal(retry.replayed, false);
    assert.equal(retry.result.status, "冲洗中");
    // 成功后才占用键:再次提交才是重放
    const replay = await store.transition(id, { to: "冲洗中" }, "t-key-1");
    assert.equal(replay.replayed, true);
    // 文件中的状态与内存一致
    const disk = await onDisk(store);
    assert.equal(disk.items.find(i => i.id === id).status, "冲洗中");
  } finally {
    await cleanup();
  }
});

test("步骤、复晒次数与工单在落盘失败时同样回滚", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const { result } = await store.createBatch(BATCH_1);
    const id = result.items[0].id;
    await store.transition(id, { to: "冲洗中" });
    await store.transition(id, { to: "待入盒", box: "R-1" });

    const restore = injectPersistFailure(store);
    await assert.rejects(store.addStep(id, { step: "复晒", reexpose: true, defect: "水渍" }), /disk full/);
    await assert.rejects(store.createReview(id, REVIEW), /disk full/);
    restore();

    // 复晒次数、缺陷、步骤、工单全部回滚
    const item = store.getItem(id);
    assert.equal(item.reexposeCount, 0);
    assert.equal(item.defect, "");
    assert.equal(item.steps.length, 0);
    assert.equal(store.listReviews().length, 0);
    // 工单序号回退:重新发起仍是 RV-0001
    const { result: review } = await store.createReview(id, REVIEW);
    assert.equal(review.code, "RV-0001");
    // 关闭失败也回滚
    const restore2 = injectPersistFailure(store);
    await assert.rejects(store.closeReview("RV-0001", { resolution: "完成" }), /disk full/);
    restore2();
    assert.equal(store.listReviews({ status: "未关闭" }).length, 1);
    const closed = await store.closeReview("RV-0001", { resolution: "完成" });
    assert.equal(closed.result.status, "已关闭");
  } finally {
    await cleanup();
  }
});

test("并发下失败回滚不误伤并发成功的变更", async () => {
  const { store, cleanup } = await tempStore();
  try {
    // 只让第一次落盘失败
    let calls = 0;
    const original = store._persistNow.bind(store);
    store._persistNow = (state) => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("injected")) : original(state);
    };
    const results = await Promise.allSettled([
      store.createBatch({ ...BATCH_1, chemicalBatch: "B-甲" }),
      store.createBatch({ ...BATCH_1, chemicalBatch: "B-乙" }),
    ]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.filter(r => r.status === "rejected").length, 1);

    // 内存与文件都只有成功的那条,且编号从 PC-0001 开始
    assert.equal(store.listBatches().length, 1);
    assert.equal(store.listBatches()[0].code, "PC-0001");
    assert.equal(store.listItems().length, 1);
    const disk = await onDisk(store);
    assert.equal(disk.batches.length, 1);
    assert.equal(disk.items.length, 1);
  } finally {
    await cleanup();
  }
});

test("失败后重启:磁盘状态一致;重试成功后重启:记录完整", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyanotype-rollback-reload-"));
  const file = join(dir, "db.json");
  try {
    const s1 = await new CyanotypeStore(file).load();
    await s1.createBatch(BATCH_1);
    const restore = injectPersistFailure(s1);
    await assert.rejects(s1.createBatch(BATCH_2), /disk full/);
    restore();

    // 直接重启:看不到失败记录
    const s2 = await new CyanotypeStore(file).load();
    assert.equal(s2.listBatches().length, 1);
    assert.equal(s2.listItems().length, 1);
    assert.equal(s2.listBatches()[0].chemicalBatch, "B-1");

    // 重试成功后再重启:两条批次都在,编号连续
    await s2.createBatch(BATCH_2);
    const s3 = await new CyanotypeStore(file).load();
    assert.deepEqual(s3.listBatches().map(b => b.code), ["PC-0001", "PC-0002"]);
    assert.equal(s3.listItems().length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("API:落盘失败返回 500 后查询不到失败记录,同键重试成功且只落一条", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyanotype-rollback-api-"));
  const store = await new CyanotypeStore(join(dir, "db.json")).load();
  const server = createApp(store);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, payload, headers = {}) => fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  try {
    const restore = injectPersistFailure(store);
    const failed = await post("/api/batches", BATCH_2, { "Idempotency-Key": "api-key-1" });
    assert.equal(failed.status, 500);
    restore();

    // 查询不到失败记录
    assert.equal((await (await fetch(base + "/api/items")).json()).length, 0);
    assert.equal((await (await fetch(base + "/api/batches")).json()).length, 0);
    assert.equal((await (await fetch(base + "/api/stats")).json()).total, 0);

    // 同一幂等键重试:按新请求执行(不是重放),只落一条记录
    const retry = await post("/api/batches", BATCH_2, { "Idempotency-Key": "api-key-1" });
    assert.equal(retry.status, 201);
    assert.equal(retry.headers.get("x-idempotent-replay"), null);
    assert.equal((await (await fetch(base + "/api/items")).json()).length, 2);
    assert.equal((await (await fetch(base + "/api/batches")).json()).length, 1);

    // 文件内容一致
    const disk = JSON.parse(await readFile(store.filePath, "utf8"));
    assert.equal(disk.batches.length, 1);
    assert.equal(disk.items.length, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
