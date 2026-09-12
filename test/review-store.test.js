import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CyanotypeStore } from "../src/store.js";

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "cyanotype-review-"));
  const store = await new CyanotypeStore(join(dir, "db.json")).load();
  return { store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function makeItem(store, box = "蓝盒A-01") {
  const { result } = await store.createBatch({ chemicalBatch: "B-1", exposure: "5分钟", waterSource: "泉水", count: 1 });
  return result.items[0];
}

async function boxedItem(store, box = "蓝盒A-01") {
  const item = await makeItem(store);
  await store.transition(item.id, { to: "冲洗中" });
  await store.transition(item.id, { to: "待入盒", box });
  return item;
}

const REVIEW = { reviewer: "张三", conclusion: "边角显影不均", requirement: "重涂边角后复晒", deadline: "2099-01-01" };

test("待入盒底片可发起复核,工单记录复核人、缺陷结论、整改要求、截止时间", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const item = await boxedItem(store);
    const { result: review } = await store.createReview(item.id, REVIEW);
    assert.equal(review.code, "RV-0001");
    assert.equal(review.status, "未关闭");
    assert.equal(review.reviewer, "张三");
    assert.equal(review.conclusion, "边角显影不均");
    assert.equal(review.requirement, "重涂边角后复晒");
    assert.equal(review.box, "蓝盒A-01");
    assert.equal(review.itemCode, item.code);
    // 日期型截止时间按当日结束归一化
    assert.equal(review.deadline, "2099-01-01T23:59:59.999Z");
    // 底片日志留痕
    assert.ok(store.getItem(item.id).logs.some(l => l.step === "复核" && l.note.includes("RV-0001")));
  } finally {
    await cleanup();
  }
});

test("非法状态不能发起复核:待曝光、冲洗中、已交付都拒绝", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const a = await makeItem(store);
    await assert.rejects(store.createReview(a.id, REVIEW), /仅待入盒/);
    await store.transition(a.id, { to: "冲洗中" });
    await assert.rejects(store.createReview(a.id, REVIEW), /仅待入盒/);

    // 已交付底片同样拒绝
    const b = await boxedItem(store, "蓝盒A-02");
    await store.transition(b.id, { to: "已交付" });
    await assert.rejects(store.createReview(b.id, REVIEW), /仅待入盒/);

    // 不存在的底片
    await assert.rejects(store.createReview("NOPE", REVIEW), /找不到底片/);
    assert.equal(store.listReviews().length, 0);
  } finally {
    await cleanup();
  }
});

test("工单必填字段与截止时间校验", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const item = await boxedItem(store);
    await assert.rejects(store.createReview(item.id, { ...REVIEW, reviewer: "" }), /复核人不能为空/);
    await assert.rejects(store.createReview(item.id, { ...REVIEW, conclusion: " " }), /缺陷结论不能为空/);
    await assert.rejects(store.createReview(item.id, { ...REVIEW, requirement: undefined }), /整改要求不能为空/);
    await assert.rejects(store.createReview(item.id, { ...REVIEW, deadline: "" }), /截止时间不能为空/);
    await assert.rejects(store.createReview(item.id, { ...REVIEW, deadline: "不是日期" }), /不是合法日期/);
    // 完整 ISO 时间可用
    const { result } = await store.createReview(item.id, { ...REVIEW, deadline: "2099-01-01T10:00:00.000Z" });
    assert.equal(result.deadline, "2099-01-01T10:00:00.000Z");
  } finally {
    await cleanup();
  }
});

test("同一盒位任一时刻只能有一张未关闭工单", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const item = await boxedItem(store);
    await store.createReview(item.id, REVIEW);
    // 同一底片(同一盒位)再发起 → 拒绝
    await assert.rejects(store.createReview(item.id, { ...REVIEW, reviewer: "李四" }), /已存在未关闭工单 RV-0001/);
    // 关闭后可以再次发起
    await store.closeReview("RV-0001", { resolution: "已重涂并复检合格" });
    const { result: second } = await store.createReview(item.id, { ...REVIEW, reviewer: "李四" });
    assert.equal(second.code, "RV-0002");
    assert.equal(store.listReviews({ status: "未关闭" }).length, 1);
  } finally {
    await cleanup();
  }
});

test("存在未关闭工单时底片不能交付,关闭后可交付", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const item = await boxedItem(store);
    await store.createReview(item.id, REVIEW);
    await assert.rejects(store.transition(item.id, { to: "已交付" }), /未关闭复核工单 RV-0001,不能交付/);
    await store.closeReview("RV-0001", { resolution: "整改完成" });
    await store.transition(item.id, { to: "已交付" });
    assert.equal(store.getItem(item.id).status, "已交付");
  } finally {
    await cleanup();
  }
});

test("关闭工单必须填写处理结果,重复关闭拒绝,幂等键重放安全", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const item = await boxedItem(store);
    await store.createReview(item.id, REVIEW);

    await assert.rejects(store.closeReview("RV-0001", {}), /处理结果不能为空/);
    await assert.rejects(store.closeReview("RV-0001", { resolution: "  " }), /处理结果不能为空/);

    const closed = await store.closeReview("RV-0001", { resolution: "已复检合格" }, "close-key-1");
    assert.equal(closed.result.status, "已关闭");
    assert.equal(closed.result.resolution, "已复检合格");
    assert.ok(closed.result.closedAt);

    // 同一幂等键重放 → 返回首次结果,不报错
    const replay = await store.closeReview("RV-0001", { resolution: "已复检合格" }, "close-key-1");
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.resolution, "已复检合格");
    // 同键不同内容 → 409
    await assert.rejects(store.closeReview("RV-0001", { resolution: "别的结果" }, "close-key-1"), /不同内容/);
    // 无键重复关闭 → 409
    await assert.rejects(store.closeReview("RV-0001", { resolution: "再次关闭" }), /已关闭/);
    // 不存在的工单
    await assert.rejects(store.closeReview("RV-9999", { resolution: "x" }), /找不到复核工单/);
    // 底片日志留痕
    assert.ok(store.getItem(item.id).logs.some(l => l.step === "复核关闭"));
  } finally {
    await cleanup();
  }
});

test("逾期工单在列表和统计中单独标出", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const a = await boxedItem(store, "蓝盒A-01");
    const b = await boxedItem(store, "蓝盒A-02");
    const c = await boxedItem(store, "蓝盒A-03");
    await store.createReview(a.id, { ...REVIEW, deadline: "2020-01-01" }); // 已逾期
    await store.createReview(b.id, { ...REVIEW, deadline: "2099-01-01" }); // 未逾期
    await store.createReview(c.id, { ...REVIEW, deadline: "2020-06-01" }); // 逾期但随后关闭
    await store.closeReview("RV-0003", { resolution: "已处理" });

    const all = store.listReviews();
    const overdueByCode = Object.fromEntries(all.map(r => [r.code, r.overdue]));
    assert.deepEqual(overdueByCode, { "RV-0001": true, "RV-0002": false, "RV-0003": false });
    assert.deepEqual(store.listReviews({ overdue: "true" }).map(r => r.code), ["RV-0001"]);
    assert.equal(store.listReviews({ overdue: "false" }).length, 2);
    assert.throws(() => store.listReviews({ overdue: "maybe" }), /true 或 false/);
    assert.throws(() => store.listReviews({ status: "不存在" }), /未知工单状态/);

    const stats = store.stats();
    assert.deepEqual(stats.reviews, { open: 2, overdue: 1 });
    // 统计与列表一致
    assert.equal(stats.reviews.open, store.listReviews({ status: "未关闭" }).length);
    assert.equal(stats.reviews.overdue, store.listReviews({ overdue: "true" }).length);
  } finally {
    await cleanup();
  }
});

test("重启后工单数据恢复,工单编号不重复", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyanotype-review-reload-"));
  const file = join(dir, "db.json");
  try {
    const store1 = await new CyanotypeStore(file).load();
    const item = await boxedItem(store1);
    await store1.createReview(item.id, REVIEW, "rv-key-1");

    const store2 = await new CyanotypeStore(file).load();
    assert.equal(store2.listReviews().length, 1);
    assert.equal(store2.listReviews()[0].code, "RV-0001");
    // 幂等键跨重启有效
    const replay = await store2.createReview(item.id, REVIEW, "rv-key-1");
    assert.equal(replay.replayed, true);
    assert.equal(store2.listReviews().length, 1);
    // 新工单编号延续
    await store2.closeReview("RV-0001", { resolution: "完成" });
    const { result: next } = await store2.createReview(item.id, REVIEW);
    assert.equal(next.code, "RV-0002");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("关闭工单支持乐观锁:过期版本号拒绝", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const item = await boxedItem(store);
    await store.createReview(item.id, REVIEW);
    await assert.rejects(store.closeReview("RV-0001", { resolution: "完成", expectedVersion: 2 }), /版本/);
    const { result } = await store.closeReview("RV-0001", { resolution: "完成", expectedVersion: 1 });
    assert.equal(result.version, 2);
  } finally {
    await cleanup();
  }
});
