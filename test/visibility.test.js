import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CyanotypeStore } from "../src/store.js";
import { createApp } from "../src/app.js";

const BATCH = { chemicalBatch: "B-1", exposure: "5分钟", waterSource: "泉水", count: 1 };

async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), "cyanotype-visibility-"));
  const store = await new CyanotypeStore(join(dir, "db.json")).load();
  const server = createApp(store);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    store,
    server,
    dir,
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await store.drain().catch(() => {});
      await new Promise(resolve => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function waitFor(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error("waitFor 超时");
}

// 把落盘改成手动闸门:每次 _persistNow 调用都挂起,由测试决定何时放行/失败。
// 闸门被拒绝时自动恢复原落盘(生产代码在失败后会做一次清理性落盘,不能也被闸住)。
// 闸门只能结算一次,避免清理时重复触发真实落盘。
function gatePersist(store) {
  const gates = [];
  const original = store._persistNow.bind(store);
  store._persistNow = (state) => new Promise((resolve, reject) => {
    const gate = {
      settled: false,
      resolve: () => {
        if (gate.settled) return;
        gate.settled = true;
        resolve(original(state));
      },
      reject: (error) => {
        if (gate.settled) return;
        gate.settled = true;
        store._persistNow = original;
        reject(error);
      },
    };
    gates.push(gate);
  });
  return {
    gates,
    restore: () => { store._persistNow = original; },
    releaseAll: () => {
      store._persistNow = original;
      for (const gate of gates.splice(0)) gate.resolve();
    },
  };
}

async function itemCount(base) {
  const res = await fetch(base + "/api/items");
  return (await res.json()).length;
}

test("慢速落盘下的并行读取:提交前读取看不到未落盘记录", async () => {
  const { store, base, close } = await startServer();
  const { gates, releaseAll } = gatePersist(store);
  try {
    const write = fetch(base + "/api/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(BATCH),
    });
    // 写入已到达存储层、落盘挂起中
    await waitFor(() => gates.length === 1);
    // 此时读取只能看到已提交状态:什么都没有
    assert.equal(await itemCount(base), 0);
    assert.equal((await (await fetch(base + "/api/batches")).json()).length, 0);
    assert.equal((await (await fetch(base + "/api/stats")).json()).total, 0);

    // 放行落盘 → 提交后读取可见
    gates[0].resolve();
    const res = await write;
    assert.equal(res.status, 201);
    assert.equal(await itemCount(base), 1);
  } finally {
    releaseAll();
    await close();
  }
});

test("并发写入期间:读取只能看到已提交的记录", async () => {
  const { store, base, close } = await startServer();
  const { gates, releaseAll } = gatePersist(store);
  try {
    const post = (chemicalBatch) => fetch(base + "/api/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...BATCH, chemicalBatch }),
    });
    const w1 = post("B-甲");
    // 第一笔落盘挂起后再发第二笔:第二笔在锁后排队,读取什么都看不到
    await waitFor(() => gates.length === 1);
    const w2 = post("B-乙");
    await new Promise(r => setTimeout(r, 50));
    assert.equal(await itemCount(base), 0);

    // 放行第一笔:第二笔开始落盘;读取只能看到第一笔
    gates[0].resolve();
    await waitFor(() => gates.length === 2);
    assert.equal(await itemCount(base), 1);
    const visible = await (await fetch(base + "/api/items")).json();
    assert.equal(visible[0].chemicalBatch, "B-甲");

    // 放行第二笔:两笔都可见
    gates[1].resolve();
    assert.equal((await w1).status, 201);
    assert.equal((await w2).status, 201);
    assert.equal(await itemCount(base), 2);
  } finally {
    releaseAll();
    await close();
  }
});

test("写入失败:记录不会先出现再消失,同键重试后可见", async () => {
  const { store, base, close } = await startServer();
  const { gates, releaseAll } = gatePersist(store);
  try {
    const write = fetch(base + "/api/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "vis-key-1" },
      body: JSON.stringify(BATCH),
    });
    await waitFor(() => gates.length === 1);
    // 落盘挂起期间:记录不可见
    assert.equal(await itemCount(base), 0);

    // 落盘失败:接口报错,记录依然不可见(从未出现过)
    gates[0].reject(new Error("disk full"));
    assert.equal((await write).status, 500);
    assert.equal(await itemCount(base), 0);
    assert.equal((await (await fetch(base + "/api/stats")).json()).total, 0);

    // 闸门拒绝时已自动恢复落盘;同一幂等键重试:按新请求执行,成功后可见且只有一条
    const retry = await fetch(base + "/api/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "vis-key-1" },
      body: JSON.stringify(BATCH),
    });
    assert.equal(retry.status, 201);
    assert.equal(await itemCount(base), 1);
    // 再重放同一键:返回首次结果,不新增
    const replay = await fetch(base + "/api/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "vis-key-1" },
      body: JSON.stringify(BATCH),
    });
    assert.equal(replay.headers.get("x-idempotent-replay"), "true");
    assert.equal(await itemCount(base), 1);
  } finally {
    releaseAll();
    await close();
  }
});

test("存储层:慢速落盘期间 listItems/stats 只读已提交状态", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyanotype-visibility-store-"));
  const store = await new CyanotypeStore(join(dir, "db.json")).load();
  try {
    const original = store._persistNow.bind(store);
    store._persistNow = async (state) => {
      await new Promise(r => setTimeout(r, 150));
      return original(state);
    };
    const pending = store.createBatch(BATCH);
    // 给变更时间进入落盘等待
    await new Promise(r => setTimeout(r, 50));
    assert.equal(store.listItems().length, 0);
    assert.equal(store.listBatches().length, 0);
    assert.equal(store.stats().total, 0);
    await pending;
    assert.equal(store.listItems().length, 1);
    assert.equal(store.stats().total, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("状态推进在落盘期间同样不可见", async () => {
  const { store, base, close } = await startServer();
  let releaseAll = () => {};
  try {
    const created = await fetch(base + "/api/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(BATCH),
    }).then(r => r.json());
    const id = created.items[0].id;

    const gated = gatePersist(store);
    const gates = gated.gates;
    releaseAll = gated.releaseAll;
    const write = fetch(base + `/api/items/${id}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "冲洗中" }),
    });
    await waitFor(() => gates.length === 1);
    // 推进未落盘:读取仍是待曝光
    const during = await (await fetch(base + `/api/items/${id}`)).json();
    assert.equal(during.status, "待曝光");
    gates[0].resolve();
    assert.equal((await write).status, 200);
    const after = await (await fetch(base + `/api/items/${id}`)).json();
    assert.equal(after.status, "冲洗中");
  } finally {
    releaseAll();
    await close();
  }
});
