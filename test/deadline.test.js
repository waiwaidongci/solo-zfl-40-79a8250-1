import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CyanotypeStore } from "../src/store.js";
import { createApp } from "../src/app.js";

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "cyanotype-deadline-"));
  const store = await new CyanotypeStore(join(dir, "db.json")).load();
  return { store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function boxedItem(store, n) {
  const { result } = await store.createBatch({ chemicalBatch: "B-1", exposure: "5分钟", waterSource: "泉水", count: 1 });
  const id = result.items[0].id;
  await store.transition(id, { to: "冲洗中" });
  await store.transition(id, { to: "待入盒", box: `T-${n}` });
  return id;
}

const REVIEW = { reviewer: "张三", conclusion: "边角显影不均", requirement: "重涂边角" };

// 不存在的日历日期:必须 400,而不是滚到相邻月份保存
const INVALID_DATES = [
  ["2026-02-29", "2026 不是闰年"],
  ["2100-02-29", "2100 是世纪非闰年"],
  ["2026-02-30", "2 月没有 30 日"],
  ["2026-02-31", "2 月没有 31 日(滚月回归)"],
  ["2026-04-31", "4 月只有 30 天"],
  ["2026-06-31", "6 月只有 30 天"],
  ["2026-09-31", "9 月只有 30 天"],
  ["2026-11-31", "11 月只有 30 天"],
  ["2026-01-32", "日超出范围"],
  ["2026-01-00", "日为 0"],
  ["2026-00-10", "月为 0"],
  ["2026-13-01", "月超出范围"],
  ["2026-02-30T10:00:00Z", "日期时间中的滚月日期"],
  ["2026-04-31T23:59:59.999Z", "日期时间中的不存在日期"],
];

const INVALID_TIMES = [
  ["2026-01-01T25:00:00Z", "小时超界"],
  ["2026-01-01T10:60:00Z", "分钟超界"],
  ["2026-01-01T10:00:61Z", "秒超界"],
  ["2026-01-01T10:00:00+25:00", "时区偏移小时超界"],
  ["2026-01-01T10:00:00+08:60", "时区偏移分钟超界"],
];

const INVALID_FORMATS = [
  "2026/02/01",
  "2026-2-1",
  "2026-01-01 10:00",
  "01-01-2026",
  "昨天",
  "",
];

const VALID_DATES = [
  ["2024-02-29", "闰年 2 月 29 日"],
  ["2000-02-29", "2000 是世纪闰年"],
  ["2026-01-31", "1 月 31 日"],
  ["2026-03-31", "3 月 31 日"],
  ["2026-04-30", "4 月 30 日"],
  ["2026-12-31", "12 月 31 日"],
  ["2026-02-28", "平年 2 月 28 日"],
];

test("截止时间:不存在的日历日期一律 400,不会滚到相邻月份", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const id = await boxedItem(store, 1);
    for (const [deadline, label] of [...INVALID_DATES, ...INVALID_TIMES]) {
      await assert.rejects(
        store.createReview(id, { ...REVIEW, deadline }),
        error => error.status === 400 && error.code === "invalid_input",
        `${label}: ${deadline} 应被拒绝`
      );
    }
    for (const deadline of INVALID_FORMATS) {
      await assert.rejects(
        store.createReview(id, { ...REVIEW, deadline }),
        error => error.status === 400 && error.code === "invalid_input",
        `非法格式应被拒绝: "${deadline}"`
      );
    }
    // 全部拒绝,没有工单被创建
    assert.equal(store.listReviews().length, 0);
  } finally {
    await cleanup();
  }
});

test("截止时间:真实日历日期与合法时间正常接受", async () => {
  const { store, cleanup } = await tempStore();
  try {
    let n = 0;
    for (const [deadline, label] of VALID_DATES) {
      const id = await boxedItem(store, ++n);
      const { result } = await store.createReview(id, { ...REVIEW, deadline });
      assert.equal(result.deadline, `${deadline}T23:59:59.999Z`, label);
    }
    // 合法 ISO 时间(含秒、毫秒、时区偏移、省略秒)
    const isoCases = [
      ["2099-01-01T10:00:00.000Z", "2099-01-01T10:00:00.000Z"],
      ["2099-01-01T10:00:00Z", "2099-01-01T10:00:00Z"],
      ["2099-01-01T10:00", "2099-01-01T10:00"],
      ["2099-01-01T10:00:00+08:00", "2099-01-01T10:00:00+08:00"],
      ["2099-01-01T23:59:59.999-05:30", "2099-01-01T23:59:59.999-05:30"],
    ];
    for (const [deadline, expected] of isoCases) {
      const id = await boxedItem(store, ++n);
      const { result } = await store.createReview(id, { ...REVIEW, deadline });
      assert.equal(result.deadline, expected);
    }
    assert.equal(store.listReviews().length, VALID_DATES.length + isoCases.length);
  } finally {
    await cleanup();
  }
});

test("API:滚月日期返回明确的客户端错误,且不产生工单", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyanotype-deadline-api-"));
  const store = await new CyanotypeStore(join(dir, "db.json")).load();
  const server = createApp(store);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await fetch(base + "/api/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chemicalBatch: "B-1", exposure: "5分钟", waterSource: "泉水", count: 1 }),
    }).then(r => r.json());
    const id = created.items[0].id;
    for (const to of ["冲洗中", "待入盒"]) {
      await fetch(base + `/api/items/${id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(to === "待入盒" ? { to, box: "T-1" } : { to }),
      });
    }

    const post = body => fetch(base + `/api/items/${id}/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const bad = await post({ ...REVIEW, deadline: "2026-02-31" });
    assert.equal(bad.status, 400);
    const badBody = await bad.json();
    assert.equal(badBody.error, "invalid_input");
    assert.match(badBody.message, /真实存在的日历日期/);

    const badTime = await post({ ...REVIEW, deadline: "2026-01-01T25:00:00Z" });
    assert.equal(badTime.status, 400);
    assert.match((await badTime.json()).message, /时间部分不合法/);

    const reviews = await fetch(base + "/api/reviews").then(r => r.json());
    assert.equal(reviews.length, 0, "被拒绝的输入不应产生工单");

    // 闰年真实日期可以创建
    const good = await post({ ...REVIEW, deadline: "2028-02-29" });
    assert.equal(good.status, 201);
    assert.equal((await good.json()).deadline, "2028-02-29T23:59:59.999Z");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("页面包含与接口一致的截止时间校验", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyanotype-deadline-page-"));
  const store = await new CyanotypeStore(join(dir, "db.json")).load();
  const server = createApp(store);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const html = await fetch(`http://127.0.0.1:${server.address().port}/`).then(r => r.text());
    assert.match(html, /真实存在的日历日期/);
    assert.match(html, /validDeadline/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
