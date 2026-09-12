import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CyanotypeStore, STAGES } from "../src/store.js";

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "cyanotype-store-"));
  const store = await new CyanotypeStore(join(dir, "db.json")).load();
  return { store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function makeBatch(store, count = 2, extra = {}) {
  const { result } = await store.createBatch({
    chemicalBatch: "B-0620",
    exposure: "8分钟",
    waterSource: "井水过滤",
    plateSize: "18x24cm",
    count,
    ...extra,
  });
  return result;
}

test("一次曝光拆成多块底片,并记录药液批次、曝光时间、冲洗水源", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const { batch, items } = await makeBatch(store, 3);
    assert.equal(items.length, 3);
    assert.equal(batch.count, 3);
    for (const item of items) {
      assert.equal(item.status, "待曝光");
      assert.equal(item.chemicalBatch, "B-0620");
      assert.equal(item.exposure, "8分钟");
      assert.equal(item.waterSource, "井水过滤");
      assert.equal(item.batchId, batch.id);
      assert.equal(item.reexposeCount, 0);
    }
    assert.deepEqual(items.map(i => i.code), ["PC-0001-01", "PC-0001-02", "PC-0001-03"]);
  } finally {
    await cleanup();
  }
});

test("状态只能依次推进:退回与跳步都拒绝", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const { items } = await makeBatch(store, 1);
    const id = items[0].id;

    // 跳步:待曝光 → 待入盒
    await assert.rejects(store.transition(id, { to: "待入盒", box: "A-1" }), /不允许跳步/);
    // 未知状态
    await assert.rejects(store.transition(id, { to: "已销毁" }), /未知状态/);

    // 依次推进到已交付
    await store.transition(id, { to: "冲洗中" });
    await store.transition(id, { to: "待入盒", box: "蓝盒A-03" });
    // 退回:待入盒 → 冲洗中
    await assert.rejects(store.transition(id, { to: "冲洗中" }), /不允许退回/);
    // 原地不动也算非法
    await assert.rejects(store.transition(id, { to: "待入盒", box: "蓝盒A-03" }), /不允许退回|只能依次推进/);
    await store.transition(id, { to: "已交付" });
    // 交付后不能再推进
    await assert.rejects(store.transition(id, { to: "已交付" }), /已交付/);

    const item = store.getItem(id);
    assert.equal(item.status, "已交付");
    assert.deepEqual(item.logs.filter(l => l.step === "状态推进").length, 3);
  } finally {
    await cleanup();
  }
});

test("同一盒位不能同时存放两块未交付底片,交付后盒位释放", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const { items } = await makeBatch(store, 2);
    const [a, b] = items;
    for (const item of [a, b]) await store.transition(item.id, { to: "冲洗中" });

    await store.transition(a.id, { to: "待入盒", box: "蓝盒A-03" });
    // 第二块底片入同一盒位 → 拒绝
    await assert.rejects(store.transition(b.id, { to: "待入盒", box: "蓝盒A-03" }), /已被未交付底片 .* 占用/);
    // 入盒必须指定盒位
    await assert.rejects(store.transition(b.id, { to: "待入盒" }), /必须指定盒位/);
    // 换空盒位可以
    await store.transition(b.id, { to: "待入盒", box: "蓝盒A-04" });
    // a 交付后盒位释放,c 可以入
    const { items: more } = await makeBatch(store, 1, { chemicalBatch: "B-0621" });
    const c = more[0];
    await store.transition(c.id, { to: "冲洗中" });
    await assert.rejects(store.transition(c.id, { to: "待入盒", box: "蓝盒A-03" }), /占用/);
    await store.transition(a.id, { to: "已交付" });
    await store.transition(c.id, { to: "待入盒", box: "蓝盒A-03" });
    assert.equal(store.getItem(c.id).box, "蓝盒A-03");
  } finally {
    await cleanup();
  }
});

test("复晒次数、缺陷与修补记录关联到具体步骤", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const { items } = await makeBatch(store, 1);
    const id = items[0].id;

    await store.addStep(id, { step: "涂布", note: "阴天" });
    await store.addStep(id, { step: "复晒", reexpose: true, defect: "边角显影不均", repair: "边角重涂" });
    await store.transition(id, { to: "冲洗中" });
    await store.addStep(id, { step: "复晒", reexpose: true, repair: "二次定影" });

    const item = store.getItem(id);
    assert.equal(item.reexposeCount, 2);
    assert.equal(item.defect, "边角显影不均");
    assert.equal(item.steps.length, 3);
    assert.equal(item.steps[1].stage, "待曝光");
    assert.equal(item.steps[1].defect, "边角显影不均");
    assert.equal(item.steps[1].repair, "边角重涂");
    assert.equal(item.steps[2].stage, "冲洗中");
    assert.equal(item.steps[2].reexpose, true);

    // 已交付后不能再追加工艺记录
    await store.transition(id, { to: "待入盒", box: "B-1" });
    await store.transition(id, { to: "已交付" });
    await assert.rejects(store.addStep(id, { step: "修补" }), /已交付/);
  } finally {
    await cleanup();
  }
});

test("幂等:重复提交不生成重复记录;同键不同内容拒绝", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const key = "req-batch-1";
    const first = await store.createBatch({ chemicalBatch: "B-1", exposure: "5分钟", waterSource: "泉水", count: 2 }, key);
    const second = await store.createBatch({ chemicalBatch: "B-1", exposure: "5分钟", waterSource: "泉水", count: 2 }, key);
    assert.equal(second.replayed, true);
    assert.equal(second.result.batch.id, first.result.batch.id);
    assert.equal(store.listItems().length, 2);
    assert.equal(store.listBatches().length, 1);

    // 同键不同内容 → 409
    await assert.rejects(
      store.createBatch({ chemicalBatch: "B-2", exposure: "5分钟", waterSource: "泉水", count: 2 }, key),
      /不同内容/
    );

    // 推进与步骤记录同样幂等
    const id = first.result.items[0].id;
    const t1 = await store.transition(id, { to: "冲洗中" }, "req-t-1");
    const t2 = await store.transition(id, { to: "冲洗中" }, "req-t-1");
    assert.equal(t2.replayed, true);
    assert.equal(store.getItem(id).version, t1.result.version);

    const s1 = await store.addStep(id, { step: "复晒", reexpose: true }, "req-s-1");
    await store.addStep(id, { step: "复晒", reexpose: true }, "req-s-1");
    assert.equal(store.getItem(id).reexposeCount, 1);
    assert.equal(store.getItem(id).steps.length, 1);
    assert.equal(s1.result.steps.length, 1);
  } finally {
    await cleanup();
  }
});

test("重启后数据可恢复,幂等键仍然有效", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyanotype-reload-"));
  const file = join(dir, "db.json");
  try {
    const store1 = await new CyanotypeStore(file).load();
    const { result } = await store1.createBatch({ chemicalBatch: "B-1", exposure: "5分钟", waterSource: "泉水", count: 2 }, "boot-1");
    const id = result.items[0].id;
    await store1.transition(id, { to: "冲洗中" });
    await store1.addStep(id, { step: "复晒", reexpose: true, defect: "划痕" });

    // 模拟重启:新实例读同一文件
    const store2 = await new CyanotypeStore(file).load();
    const item = store2.getItem(id);
    assert.equal(item.status, "冲洗中");
    assert.equal(item.reexposeCount, 1);
    assert.equal(item.defect, "划痕");
    assert.equal(store2.listBatches().length, 1);

    // 重启后重复提交同一键 → 返回首次结果,不产生新记录
    const replay = await store2.createBatch({ chemicalBatch: "B-1", exposure: "5分钟", waterSource: "泉水", count: 2 }, "boot-1");
    assert.equal(replay.replayed, true);
    assert.equal(store2.listItems().length, 2);

    // 编号序列也从持久化状态恢复,新批次不重复编号
    const { result: next } = await store2.createBatch({ chemicalBatch: "B-2", exposure: "6分钟", waterSource: "泉水", count: 1 });
    assert.equal(next.batch.code, "PC-0002");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("乐观锁:expectedVersion 不匹配时拒绝并发更新", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const { items } = await makeBatch(store, 1);
    const id = items[0].id;
    await store.transition(id, { to: "冲洗中", expectedVersion: 1 });
    await assert.rejects(store.transition(id, { to: "待入盒", box: "A-1", expectedVersion: 1 }), /版本/);
    await store.transition(id, { to: "待入盒", box: "A-1", expectedVersion: 2 });
    assert.equal(store.getItem(id).status, "待入盒");
  } finally {
    await cleanup();
  }
});

test("输入校验:缺字段、非法数量、非法版本号都拒绝", async () => {
  const { store, cleanup } = await tempStore();
  try {
    await assert.rejects(store.createBatch({ exposure: "5分钟", waterSource: "泉水" }), /药液批次不能为空/);
    await assert.rejects(store.createBatch({ chemicalBatch: "B", waterSource: "泉水" }), /曝光时间不能为空/);
    await assert.rejects(store.createBatch({ chemicalBatch: "B", exposure: "5分钟" }), /冲洗水源不能为空/);
    await assert.rejects(store.createBatch({ chemicalBatch: "B", exposure: "5分钟", waterSource: "泉", count: 0 }), /1-100/);
    await assert.rejects(store.createBatch({ chemicalBatch: "B", exposure: "5分钟", waterSource: "泉", count: 101 }), /1-100/);
    await assert.rejects(store.createBatch({ chemicalBatch: "B", exposure: "5分钟", waterSource: "泉", count: 2.5 }), /1-100/);
    const { items } = await makeBatch(store, 1);
    await assert.rejects(store.transition(items[0].id, { to: "冲洗中", expectedVersion: "1" }), /整数/);
    await assert.rejects(store.addStep(items[0].id, { step: "  " }), /步骤名称不能为空/);
    await assert.rejects(store.transition("不存在的底片", { to: "冲洗中" }), /找不到底片/);
    assert.equal(store.listItems().length, 1);
  } finally {
    await cleanup();
  }
});

test("统计与当前记录一致,列表可按批次、盒位、缺陷筛选", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const b1 = await makeBatch(store, 2, { chemicalBatch: "B-0620" });
    const b2 = await makeBatch(store, 1, { chemicalBatch: "B-0701" });
    const [a, b] = b1.items;
    const c = b2.items[0];

    await store.transition(a.id, { to: "冲洗中" });
    await store.transition(a.id, { to: "待入盒", box: "蓝盒A-03" });
    await store.addStep(a.id, { step: "冲洗", defect: "边角显影不均" });
    await store.transition(b.id, { to: "冲洗中" });
    await store.addStep(c.id, { step: "复晒", reexpose: true, defect: "划痕" });

    const stats = store.stats();
    assert.equal(stats.total, 3);
    assert.deepEqual(stats.byStatus, { "待曝光": 1, "冲洗中": 1, "待入盒": 1, "已交付": 0 });
    assert.equal(stats.withDefect, 2);
    assert.equal(stats.reexposeTotal, 1);
    // 统计与列表实时一致
    const items = store.listItems();
    assert.equal(stats.total, items.length);
    for (const s of STAGES) {
      assert.equal(stats.byStatus[s], items.filter(i => i.status === s).length);
    }

    assert.equal(store.listItems({ batch: b1.batch.code }).length, 2);
    assert.equal(store.listItems({ batch: "B-0701" }).length, 1);
    assert.deepEqual(store.listItems({ box: "蓝盒A-03" }).map(i => i.id), [a.id]);
    assert.deepEqual(store.listItems({ defect: "划痕" }).map(i => i.id), [c.id]);
    assert.equal(store.listItems({ defect: "显影" }).length, 1);
    assert.equal(store.listItems({ status: "冲洗中" }).length, 1);
    assert.throws(() => store.listItems({ status: "不存在" }), /未知状态/);
  } finally {
    await cleanup();
  }
});
