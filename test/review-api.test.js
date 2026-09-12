import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CyanotypeStore } from "../src/store.js";
import { createApp } from "../src/app.js";

async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), "cyanotype-review-api-"));
  const store = await new CyanotypeStore(join(dir, "db.json")).load();
  const server = createApp(store);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
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

async function get(base, path) {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const REVIEW = { reviewer: "张三", conclusion: "边角显影不均", requirement: "重涂边角后复晒", deadline: "2099-01-01" };

async function boxedItem(base, box) {
  const created = await post(base, "/api/batches", { chemicalBatch: "B-1", exposure: "5分钟", waterSource: "泉水", count: 1 });
  const id = created.body.items[0].id;
  await post(base, `/api/items/${id}/transition`, { to: "冲洗中" });
  await post(base, `/api/items/${id}/transition`, { to: "待入盒", box });
  return id;
}

test("API:复核工单全流程(发起→拦截交付→关闭→交付)", async () => {
  const { base, close } = await startServer();
  try {
    const id = await boxedItem(base, "蓝盒A-01");

    // 发起工单(带幂等键)
    const created = await post(base, `/api/items/${id}/reviews`, REVIEW, { "Idempotency-Key": "rv-1" });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "RV-0001");
    assert.equal(created.body.status, "未关闭");
    assert.equal(created.body.reviewer, "张三");

    // 重复提交同一键 → 重放,不生成新工单
    const replay = await post(base, `/api/items/${id}/reviews`, REVIEW, { "Idempotency-Key": "rv-1" });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("x-idempotent-replay"), "true");
    assert.equal((await get(base, "/api/reviews")).body.length, 1);

    // 未关闭工单阻止交付
    const blocked = await post(base, `/api/items/${id}/transition`, { to: "已交付" });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "open_review");

    // 关闭必须填写处理结果
    assert.equal((await post(base, "/api/reviews/RV-0001/close", {})).status, 400);

    // 关闭 → 交付放行
    const closed = await post(base, "/api/reviews/RV-0001/close", { resolution: "已复检合格" });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, "已关闭");
    assert.equal(closed.body.resolution, "已复检合格");
    assert.equal((await post(base, `/api/items/${id}/transition`, { to: "已交付" })).status, 200);
  } finally {
    await close();
  }
});

test("API:非法状态与非法输入", async () => {
  const { base, close } = await startServer();
  try {
    // 待曝光底片不能发起复核
    const created = await post(base, "/api/batches", { chemicalBatch: "B-1", exposure: "5分钟", waterSource: "泉水", count: 1 });
    const id = created.body.items[0].id;
    const early = await post(base, `/api/items/${id}/reviews`, REVIEW);
    assert.equal(early.status, 409);
    assert.equal(early.body.error, "invalid_state");

    // 缺字段 / 非法截止时间 / 不存在的底片与工单
    await post(base, `/api/items/${id}/transition`, { to: "冲洗中" });
    await post(base, `/api/items/${id}/transition`, { to: "待入盒", box: "蓝盒A-01" });
    assert.equal((await post(base, `/api/items/${id}/reviews`, { ...REVIEW, reviewer: "" })).status, 400);
    assert.equal((await post(base, `/api/items/${id}/reviews`, { ...REVIEW, deadline: "not-a-date" })).status, 400);
    assert.equal((await post(base, "/api/items/NOPE/reviews", REVIEW)).status, 404);
    assert.equal((await post(base, "/api/reviews/RV-9999/close", { resolution: "x" })).status, 404);
    assert.equal((await get(base, "/api/reviews?status=" + encodeURIComponent("不存在"))).status, 400);
    assert.equal((await get(base, "/api/reviews?overdue=maybe")).status, 400);
  } finally {
    await close();
  }
});

test("API:同一盒位同时只能一张未关闭工单,并发发起只有一个成功", async () => {
  const { base, close } = await startServer();
  try {
    const id = await boxedItem(base, "蓝盒A-01");
    const results = await Promise.all([
      post(base, `/api/items/${id}/reviews`, REVIEW),
      post(base, `/api/items/${id}/reviews`, { ...REVIEW, reviewer: "李四" }),
      post(base, `/api/items/${id}/reviews`, { ...REVIEW, reviewer: "王五" }),
    ]);
    assert.equal(results.filter(r => r.status === 201).length, 1);
    assert.equal(results.filter(r => r.status === 409 && r.body.error === "box_review_exists").length, 2);
    assert.equal((await get(base, "/api/reviews")).body.length, 1);
  } finally {
    await close();
  }
});

test("API:并发关闭同一工单,只有一次生效", async () => {
  const { base, close } = await startServer();
  try {
    const id = await boxedItem(base, "蓝盒A-01");
    await post(base, `/api/items/${id}/reviews`, REVIEW);

    const results = await Promise.all([
      post(base, "/api/reviews/RV-0001/close", { resolution: "结果甲" }),
      post(base, "/api/reviews/RV-0001/close", { resolution: "结果乙" }),
      post(base, "/api/reviews/RV-0001/close", { resolution: "结果丙" }),
    ]);
    assert.equal(results.filter(r => r.status === 200).length, 1);
    assert.equal(results.filter(r => r.status === 409 && r.body.error === "invalid_state").length, 2);

    const reviews = (await get(base, "/api/reviews")).body;
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].status, "已关闭");
    assert.ok(["结果甲", "结果乙", "结果丙"].includes(reviews[0].resolution));
  } finally {
    await close();
  }
});

test("API:逾期工单在列表与统计中标出", async () => {
  const { base, close } = await startServer();
  try {
    const a = await boxedItem(base, "蓝盒A-01");
    const b = await boxedItem(base, "蓝盒A-02");
    await post(base, `/api/items/${a}/reviews`, { ...REVIEW, deadline: "2020-01-01" });
    await post(base, `/api/items/${b}/reviews`, { ...REVIEW, deadline: "2099-12-31" });

    const all = (await get(base, "/api/reviews")).body;
    const overdueByCode = Object.fromEntries(all.map(r => [r.code, r.overdue]));
    assert.deepEqual(overdueByCode, { "RV-0001": true, "RV-0002": false });

    const overdueOnly = (await get(base, "/api/reviews?overdue=true")).body;
    assert.deepEqual(overdueOnly.map(r => r.code), ["RV-0001"]);
    const openOnly = (await get(base, "/api/reviews?status=" + encodeURIComponent("未关闭"))).body;
    assert.equal(openOnly.length, 2);
    const byBox = (await get(base, "/api/reviews?box=" + encodeURIComponent("蓝盒A-02"))).body;
    assert.deepEqual(byBox.map(r => r.code), ["RV-0002"]);

    const stats = (await get(base, "/api/stats")).body;
    assert.deepEqual(stats.reviews, { open: 2, overdue: 1 });
  } finally {
    await close();
  }
});

test("页面包含复核工单要素", async () => {
  const { base, close } = await startServer();
  try {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /发起复核工单/);
    assert.match(html, /复核人/);
    assert.match(html, /缺陷结论/);
    assert.match(html, /整改要求/);
    assert.match(html, /截止时间/);
    assert.match(html, /处理结果/);
    assert.match(html, /逾期工单/);
  } finally {
    await close();
  }
});
