import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// 底片状态机:只允许依次推进,退回与跳步一律拒绝
export const STAGES = ["待曝光", "冲洗中", "待入盒", "已交付"];

// 复核工单状态
export const REVIEW_STATUSES = ["未关闭", "已关闭"];

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
  return { items: [], batches: [], reviews: [], idempotency: {}, seq: 0, reviewSeq: 0 };
}

function normalizeReview(raw, index) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    id: typeof r.id === "string" && r.id ? r.id : `review-legacy-${index + 1}`,
    code: typeof r.code === "string" && r.code ? r.code : `RV-LEGACY-${index + 1}`,
    itemId: typeof r.itemId === "string" ? r.itemId : "",
    itemCode: typeof r.itemCode === "string" ? r.itemCode : "",
    box: looseString(r.box),
    reviewer: looseString(r.reviewer),
    conclusion: looseString(r.conclusion),
    requirement: looseString(r.requirement),
    deadline: looseString(r.deadline),
    status: REVIEW_STATUSES.includes(r.status) ? r.status : "未关闭",
    resolution: looseString(r.resolution),
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    closedAt: typeof r.closedAt === "string" ? r.closedAt : "",
    version: Number.isInteger(r.version) && r.version >= 1 ? r.version : 1,
  };
}

// 截止时间:只接受真实存在的日历日期(YYYY-MM-DD,按当日结束计)或合法 ISO 时间。
// 不能用 new Date() 直接判合法——它会把 2月31日 这类不存在的日期滚到相邻月份。
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function assertRealDate(year, month, day, raw) {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    fail(400, "invalid_input", `截止时间「${raw}」不是真实存在的日历日期`);
  }
}

function parseDeadline(value) {
  const v = reqString(value, "截止时间", 40);
  const dateOnly = DATE_ONLY_RE.exec(v);
  if (dateOnly) {
    assertRealDate(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]), v);
    return `${v}T23:59:59.999Z`;
  }
  const dateTime = DATE_TIME_RE.exec(v);
  if (dateTime) {
    assertRealDate(Number(dateTime[1]), Number(dateTime[2]), Number(dateTime[3]), v);
    const [, , , , hour, minute, second = "0", zone] = dateTime;
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
      fail(400, "invalid_input", `截止时间「${v}」的时间部分不合法`);
    }
    if (zone && zone !== "Z") {
      const [zh, zm] = zone.slice(1).split(":").map(Number);
      if (zh > 23 || zm > 59) fail(400, "invalid_input", `截止时间「${v}」的时区偏移不合法`);
    }
    return v;
  }
  fail(400, "invalid_input", `截止时间「${v}」不是合法日期,请使用 YYYY-MM-DD 或 ISO 时间(如 2026-09-30T18:00:00Z)`);
}

function isOverdue(review, now) {
  return review.status === "未关闭" && new Date(review.deadline).getTime() < now;
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
    reviews: Array.isArray(raw?.reviews) ? raw.reviews.map(normalizeReview) : [],
    idempotency: raw?.idempotency && typeof raw.idempotency === "object" && !Array.isArray(raw.idempotency) ? raw.idempotency : {},
    seq: Number.isInteger(raw?.seq) && raw.seq >= 0 ? raw.seq : 0,
    reviewSeq: Number.isInteger(raw?.reviewSeq) && raw.reviewSeq >= 0 ? raw.reviewSeq : 0,
  };
  // 旧数据迁移:序号只从批次编号恢复(底片编号形如 PC-0001-02,尾号会虚增序号)
  for (const batch of db.batches) {
    const m = /^PC-(\d+)$/.exec(typeof batch.code === "string" ? batch.code : "");
    if (m) db.seq = Math.max(db.seq, Number(m[1]));
  }
  for (const review of db.reviews) {
    const m = /^RV-(\d+)$/.exec(typeof review.code === "string" ? review.code : "");
    if (m) db.reviewSeq = Math.max(db.reviewSeq, Number(m[1]));
  }
  return db;
}

export class CyanotypeStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.db = null;
    this._saveChain = Promise.resolve();
    this._mutationChain = Promise.resolve();
    this._tmpSeq = 0;
  }

  async load() {
    const dir = dirname(this.filePath);
    try {
      await mkdir(dir, { recursive: true });
    } catch (error) {
      fail(500, "db_not_writable", `数据目录不可写,请先检查目录权限: ${error.message}`);
    }
    await this._cleanStaleTmp(dir);
    if (!existsSync(this.filePath)) {
      this.db = emptyDb();
      try {
        await this._persist();
      } catch (error) {
        fail(500, "db_not_writable", `数据目录不可写,请先检查目录权限: ${error.message}`);
      }
    } else {
      let raw;
      try {
        raw = JSON.parse(await readFile(this.filePath, "utf8"));
      } catch (error) {
        fail(500, "db_corrupted", `数据文件损坏,无法恢复: ${error.message}`);
      }
      this.db = normalizeDb(raw);
    }
    await this._probeWritable();
    return this;
  }

  // 启动时确认数据目录可写:真实写入一个探针文件再删除
  async _probeWritable() {
    const probe = `${this.filePath}.probe-${process.pid}`;
    try {
      const fh = await open(probe, "w");
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      await unlink(probe);
    } catch (error) {
      fail(500, "db_not_writable", `数据目录不可写,请先检查目录权限: ${error.message}`);
    }
  }

  // 清理上次中断可能残留的临时文件
  async _cleanStaleTmp(dir) {
    const prefix = basename(this.filePath) + ".";
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(prefix) && name.endsWith(".tmp")) {
        await unlink(join(dir, name)).catch(() => {});
      }
    }
  }

  // 原子且持久地落盘:写临时文件 → fsync → rename → 目录 fsync。
  // 任何一步失败都不会留下半截数据;通过队列串行化,避免并发写坏文件。
  async _persistNow() {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${++this._tmpSeq}.tmp`;
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(JSON.stringify(this.db, null, 2));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, this.filePath);
    const dh = await open(dir, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  }

  _persist() {
    const run = this._saveChain.then(() => this._persistNow());
    this._saveChain = run.catch(() => {});
    return run;
  }

  // 等待所有在途写入落盘(优雅退出用)
  async drain() {
    await this._saveChain;
  }

  // 健康检查:数据库文件是否可读(真实读取,而非仅查权限位)
  async healthCheck() {
    if (!this.db) return { readable: false, error: "数据库未加载" };
    try {
      await readFile(this.filePath, "utf8");
      return { readable: true };
    } catch (error) {
      return { readable: false, error: error.message };
    }
  }

  // 变更串行锁:同一时刻只允许一个"修改内存 + 落盘"组合操作,
  // 这样落盘失败时的整体回滚不会误伤并发成功的其他变更。
  _enqueue(fn) {
    const run = this._mutationChain.then(fn);
    this._mutationChain = run.catch(() => {});
    return run;
  }

  // 幂等执行:同一 idemKey 重复提交直接返回首次结果,不重复落记录;
  // 同一键提交不同内容视为冲突。校验失败不会占用键。
  // 落盘失败时整体回滚(内存记录、幂等键、序号),并尽力把文件恢复为原内容。
  async _idempotent(idemKey, scope, payload, mutate) {
    return this._enqueue(async () => {
      if (idemKey) {
        const hit = this.db.idempotency[idemKey];
        if (hit) {
          if (hit.scope !== scope || hit.payload !== payload) {
            fail(409, "idempotency_key_reused", "同一请求键提交了不同内容,已拒绝");
          }
          return { result: structuredClone(hit.response), replayed: true };
        }
      }
      const snapshot = structuredClone(this.db);
      let result;
      try {
        result = mutate();
        if (idemKey) {
          this.db.idempotency[idemKey] = { scope, payload, response: structuredClone(result) };
        }
        await this._persist();
      } catch (error) {
        this.db = snapshot;
        // 尽力把文件恢复为回滚后的内容(覆盖 rename 已成功但目录 fsync 失败的边角情况)
        await this._persist().catch(() => {});
        throw error;
      }
      return { result: structuredClone(result), replayed: false };
    });
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
      if (to === "已交付") {
        const open = this.db.reviews.find(r => r.itemId === item.id && r.status === "未关闭");
        if (open) fail(409, "open_review", `存在未关闭复核工单 ${open.code},不能交付`);
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

  _findReview(ref) {
    const review = this.db.reviews.find(r => r.id === ref || r.code === ref);
    if (!review) fail(404, "review_not_found", `找不到复核工单 ${ref}`);
    return review;
  }

  // 发起复核工单:仅待入盒底片可发起;同一盒位同时只能有一张未关闭工单
  async createReview(itemRef, input = {}, idemKey) {
    const reviewer = reqString(input.reviewer, "复核人");
    const conclusion = reqString(input.conclusion, "缺陷结论");
    const requirement = reqString(input.requirement, "整改要求");
    const deadline = parseDeadline(input.deadline);
    return this._idempotent(idemKey, "createReview", JSON.stringify({ itemRef, reviewer, conclusion, requirement, deadline }), () => {
      const item = this._findItem(itemRef);
      if (item.status !== "待入盒") {
        fail(409, "invalid_state", `底片当前状态为「${item.status}」,仅待入盒的底片可以发起复核`);
      }
      if (!item.box) fail(409, "invalid_state", "底片尚未指定盒位,无法发起复核");
      const clash = this.db.reviews.find(r => r.status === "未关闭" && r.box === item.box);
      if (clash) fail(409, "box_review_exists", `盒位「${item.box}」已存在未关闭工单 ${clash.code}`);
      const now = new Date().toISOString();
      this.db.reviewSeq += 1;
      const review = {
        id: randomUUID(),
        code: "RV-" + String(this.db.reviewSeq).padStart(4, "0"),
        itemId: item.id,
        itemCode: item.code,
        box: item.box,
        reviewer,
        conclusion,
        requirement,
        deadline,
        status: "未关闭",
        resolution: "",
        createdAt: now,
        closedAt: "",
        version: 1,
      };
      this.db.reviews.unshift(review);
      item.logs.push({ at: now, step: "复核", note: `发起复核工单 ${review.code}(复核人:${reviewer})` });
      item.version += 1;
      return review;
    });
  }

  // 关闭工单:必须填写处理结果;重复关闭拒绝
  async closeReview(reviewRef, input = {}, idemKey) {
    const resolution = reqString(input.resolution, "处理结果", 300);
    const expectedVersion = input.expectedVersion;
    if (expectedVersion !== undefined && !Number.isInteger(expectedVersion)) {
      fail(400, "invalid_input", "expectedVersion 必须是整数");
    }
    return this._idempotent(idemKey, "closeReview", JSON.stringify({ reviewRef, resolution, expectedVersion }), () => {
      const review = this._findReview(reviewRef);
      if (review.status === "已关闭") fail(409, "invalid_state", `工单 ${review.code} 已关闭,请勿重复操作`);
      if (expectedVersion !== undefined && review.version !== expectedVersion) {
        fail(409, "version_conflict", `工单已被他人更新(当前版本 ${review.version}),请刷新后重试`);
      }
      const now = new Date().toISOString();
      review.status = "已关闭";
      review.resolution = resolution;
      review.closedAt = now;
      review.version += 1;
      const item = this.db.items.find(i => i.id === review.itemId);
      if (item) {
        item.logs.push({ at: now, step: "复核关闭", note: `${review.code}:${resolution}` });
        item.version += 1;
      }
      return review;
    });
  }

  listReviews(filter = {}) {
    const { status, box, item, overdue } = filter;
    if (status && !REVIEW_STATUSES.includes(status)) fail(400, "invalid_filter", `未知工单状态「${status}」`);
    if (overdue !== undefined && overdue !== "true" && overdue !== "false") {
      fail(400, "invalid_filter", "overdue 只支持 true 或 false");
    }
    const now = Date.now();
    let reviews = this.db.reviews.map(r => ({ ...r, overdue: isOverdue(r, now) }));
    if (status) reviews = reviews.filter(r => r.status === status);
    if (box) reviews = reviews.filter(r => r.box === box);
    if (item) reviews = reviews.filter(r => r.itemId === item || r.itemCode === item);
    if (overdue === "true") reviews = reviews.filter(r => r.overdue);
    if (overdue === "false") reviews = reviews.filter(r => !r.overdue);
    return structuredClone(reviews);
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
    const now = Date.now();
    let reviewsOpen = 0;
    let reviewsOverdue = 0;
    for (const review of this.db.reviews) {
      if (review.status === "未关闭") {
        reviewsOpen += 1;
        if (isOverdue(review, now)) reviewsOverdue += 1;
      }
    }
    return {
      total: this.db.items.length,
      batches: this.db.batches.length,
      byStatus,
      withDefect,
      reexposeTotal,
      reviews: { open: reviewsOpen, overdue: reviewsOverdue },
    };
  }
}
