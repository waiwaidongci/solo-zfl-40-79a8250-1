import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// 底片状态机:只允许依次推进,退回与跳步一律拒绝
export const STAGES = ["待曝光", "冲洗中", "待入盒", "已交付"];

export class StoreError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "StoreError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new StoreError(status, code, message);
}

function reqString(value, label, max = 120) {
  if (typeof value !== "string" || !value.trim()) fail(400, "invalid_input", `${label}不能为空`);
  const v = value.trim();
  if (v.length > max) fail(400, "invalid_input", `${label}过长(最多 ${max} 字)`);
  return v;
}

function optString(value, max = 200) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") fail(400, "invalid_input", "字段类型错误,应为字符串");
  return value.trim().slice(0, max);
}

function looseString(value) {
  return typeof value === "string" ? value : "";
}

function emptyDb() {
  return { items: [], batches: [], idempotency: {}, seq: 0 };
}

function normalizeItem(raw, index) {
  const it = raw && typeof raw === "object" ? raw : {};
  return {
    id: typeof it.id === "string" && it.id ? it.id : (typeof it.code === "string" && it.code ? it.code : `legacy-${index + 1}`),
    code: typeof it.code === "string" && it.code ? it.code : `CN-LEGACY-${index + 1}`,
    batchId: typeof it.batchId === "string" ? it.batchId : null,
    plateSize: looseString(it.plateSize),
    chemicalBatch: looseString(it.chemicalBatch),
    exposure: looseString(it.exposure),
    waterSource: looseString(it.waterSource),
    box: looseString(it.box),
    status: STAGES.includes(it.status) ? it.status : STAGES[0],
    defect: looseString(it.defect),
    reexposeCount: Number.isInteger(it.reexposeCount) && it.reexposeCount >= 0 ? it.reexposeCount : 0,
    version: Number.isInteger(it.version) && it.version >= 1 ? it.version : 1,
    steps: Array.isArray(it.steps) ? it.steps : [],
    logs: Array.isArray(it.logs) ? it.logs : [],
    createdAt: typeof it.createdAt === "string" ? it.createdAt : "",
  };
}

function normalizeDb(raw) {
  const db = {
    items: Array.isArray(raw?.items) ? raw.items.map(normalizeItem) : [],
    batches: Array.isArray(raw?.batches) ? raw.batches.filter(b => b && typeof b === "object") : [],
    idempotency: raw?.idempotency && typeof raw.idempotency === "object" && !Array.isArray(raw.idempotency) ? raw.idempotency : {},
    seq: Number.isInteger(raw?.seq) && raw.seq >= 0 ? raw.seq : 0,
  };
  // 旧数据迁移:序号只从批次编号恢复(底片编号形如 PC-0001-02,尾号会虚增序号)
  for (const batch of db.batches) {
    const m = /^PC-(\d+)$/.exec(typeof batch.code === "string" ? batch.code : "");
    if (m) db.seq = Math.max(db.seq, Number(m[1]));
  }
  return db;
}

export class CyanotypeStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.db = null;
    this._saveChain = Promise.resolve();
    this._tmpSeq = 0;
  }

  async load() {
    if (!existsSync(this.filePath)) {
      this.db = emptyDb();
      await mkdir(dirname(this.filePath), { recursive: true });
      await this._persist();
      return this;
    }
    let raw;
    try {
      raw = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      fail(500, "db_corrupted", `数据文件损坏,无法恢复: ${error.message}`);
    }
    this.db = normalizeDb(raw);
    return this;
  }

  // 原子写盘(临时文件 + rename),并通过队列串行化,避免并发写坏文件
  _persist() {
    const run = this._saveChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.${++this._tmpSeq}.tmp`;
      await writeFile(tmp, JSON.stringify(this.db, null, 2));
      await rename(tmp, this.filePath);
    });
    this._saveChain = run.catch(() => {});
    return run;
  }

  // 幂等执行:同一 idemKey 重复提交直接返回首次结果,不重复落记录;
  // 同一键提交不同内容视为冲突。校验失败不会占用键。
  async _idempotent(idemKey, scope, payload, mutate) {
    if (idemKey) {
      const hit = this.db.idempotency[idemKey];
      if (hit) {
        if (hit.scope !== scope || hit.payload !== payload) {
          fail(409, "idempotency_key_reused", "同一请求键提交了不同内容,已拒绝");
        }
        return { result: structuredClone(hit.response), replayed: true };
      }
    }
    const result = mutate();
    if (idemKey) {
      this.db.idempotency[idemKey] = { scope, payload, response: structuredClone(result) };
    }
    await this._persist();
    return { result: structuredClone(result), replayed: false };
  }

  _findItem(ref) {
    const item = this.db.items.find(x => x.id === ref || x.code === ref);
    if (!item) fail(404, "item_not_found", `找不到底片 ${ref}`);
    return item;
  }

  // 一次曝光拆成多块底片:药液批次、曝光时间、冲洗水源记录在批次上并落到每块底片
  async createBatch(input = {}, idemKey) {
    const chemicalBatch = reqString(input.chemicalBatch, "药液批次");
    const exposure = reqString(input.exposure, "曝光时间");
    const waterSource = reqString(input.waterSource, "冲洗水源");
    const plateSize = optString(input.plateSize, 60);
    const count = input.count === undefined ? 1 : input.count;
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      fail(400, "invalid_input", "拆分数量必须是 1-100 的整数");
    }
    return this._idempotent(idemKey, "createBatch", JSON.stringify({ chemicalBatch, exposure, waterSource, plateSize, count }), () => {
      const now = new Date().toISOString();
      this.db.seq += 1;
      const batchCode = "PC-" + String(this.db.seq).padStart(4, "0");
      const batch = { id: randomUUID(), code: batchCode, chemicalBatch, exposure, waterSource, plateSize, count, createdAt: now };
      const items = [];
      for (let n = 1; n <= count; n++) {
        items.push({
          id: randomUUID(),
          code: `${batchCode}-${String(n).padStart(2, "0")}`,
          batchId: batch.id,
          plateSize,
          chemicalBatch,
          exposure,
          waterSource,
          box: "",
          status: STAGES[0],
          defect: "",
          reexposeCount: 0,
          version: 1,
          steps: [],
          logs: [{ at: now, step: "建档", note: `曝光批次 ${batchCode} 拆分建档` }],
          createdAt: now,
        });
      }
      this.db.batches.push(batch);
      this.db.items.unshift(...items);
      return { batch, items };
    });
  }

  // 状态推进:只允许走到下一状态;入盒必须指定空闲盒位
  async transition(itemRef, input = {}, idemKey) {
    const to = reqString(input.to, "目标状态", 20);
    if (!STAGES.includes(to)) fail(400, "invalid_input", `未知状态「${to}」`);
    const box = optString(input.box, 60);
    const expectedVersion = input.expectedVersion;
    if (expectedVersion !== undefined && !Number.isInteger(expectedVersion)) {
      fail(400, "invalid_input", "expectedVersion 必须是整数");
    }
    return this._idempotent(idemKey, "transition", JSON.stringify({ itemRef, to, box, expectedVersion }), () => {
      const item = this._findItem(itemRef);
      const idx = STAGES.indexOf(item.status);
      const next = STAGES[idx + 1];
      if (!next) fail(409, "invalid_transition", "底片已交付,不能再推进");
      if (to !== next) {
        const targetIdx = STAGES.indexOf(to);
        const kind = targetIdx < idx ? "不允许退回" : "不允许跳步";
        fail(409, "invalid_transition", `状态只能依次推进(${item.status} → ${next}),${kind}到「${to}」`);
      }
      if (expectedVersion !== undefined && item.version !== expectedVersion) {
        fail(409, "version_conflict", `底片已被他人更新(当前版本 ${item.version}),请刷新后重试`);
      }
      if (to === "待入盒") {
        if (!box) fail(400, "invalid_input", "入盒前必须指定盒位");
        const holder = this.db.items.find(x => x.id !== item.id && x.box === box && x.status !== "已交付");
        if (holder) fail(409, "box_occupied", `盒位「${box}」已被未交付底片 ${holder.code} 占用`);
      }
      const now = new Date().toISOString();
      const from = item.status;
      item.status = to;
      if (box) item.box = box;
      item.version += 1;
      item.logs.push({ at: now, step: "状态推进", note: `${from} → ${to}` });
      return item;
    });
  }

  // 工艺步骤记录:复晒次数、缺陷、修补都关联到具体步骤与当时所处状态
  async addStep(itemRef, input = {}, idemKey) {
    const step = reqString(input.step, "步骤名称", 60);
    const developStatus = optString(input.developStatus, 60);
    const defect = optString(input.defect, 120);
    const repair = optString(input.repair, 200);
    const note = optString(input.note, 300);
    const reexpose = input.reexpose === true || input.reexpose === "true" || input.reexpose === 1;
    return this._idempotent(idemKey, "addStep", JSON.stringify({ itemRef, step, developStatus, defect, repair, note, reexpose }), () => {
      const item = this._findItem(itemRef);
      if (item.status === "已交付") fail(409, "item_delivered", "底片已交付,不能再追加工艺记录");
      const now = new Date().toISOString();
      const record = { at: now, stage: item.status, step, developStatus, defect, repair, reexpose, note };
      item.steps.push(record);
      if (reexpose) item.reexposeCount += 1;
      if (defect) item.defect = defect;
      item.version += 1;
      item.logs.push({ at: now, step, note: note || developStatus || defect || "步骤记录" });
      return item;
    });
  }

  getItem(ref) {
    return structuredClone(this._findItem(ref));
  }

  listItems(filter = {}) {
    const { status, batch, box, defect, q } = filter;
    if (status && !STAGES.includes(status)) fail(400, "invalid_filter", `未知状态「${status}」`);
    let items = this.db.items;
    if (status) items = items.filter(i => i.status === status);
    if (batch) {
      const hit = this.db.batches.find(b => b.id === batch || b.code === batch);
      items = items.filter(i => i.batchId === hit?.id || i.chemicalBatch === batch || i.code.startsWith(batch + "-"));
    }
    if (box) items = items.filter(i => i.box === box);
    if (defect) items = items.filter(i => i.defect.includes(defect) || i.steps.some(s => typeof s.defect === "string" && s.defect.includes(defect)));
    if (q) items = items.filter(i => JSON.stringify(i).includes(q));
    return structuredClone(items);
  }

  listBatches() {
    return structuredClone(this.db.batches);
  }

  // 统计始终从当前记录实时计算,保证与列表一致
  stats() {
    const byStatus = Object.fromEntries(STAGES.map(s => [s, 0]));
    let withDefect = 0;
    let reexposeTotal = 0;
    for (const item of this.db.items) {
      byStatus[item.status] += 1;
      if (item.defect) withDefect += 1;
      reexposeTotal += item.reexposeCount;
    }
    return { total: this.db.items.length, batches: this.db.batches.length, byStatus, withDefect, reexposeTotal };
  }
}
