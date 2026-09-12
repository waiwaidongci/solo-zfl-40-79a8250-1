export function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法蓝晒底片批次工作台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; margin-top:12px; }
    button:disabled { opacity:.5; cursor:not-allowed; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:130px; flex:1; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:110px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    #toast { position:fixed; right:20px; bottom:20px; max-width:360px; padding:12px 16px; border-radius:8px; color:#fff; display:none; z-index:9; }
    #toast.ok { display:block; background:var(--accent); } #toast.err { display:block; background:var(--warn); }
    .row { display:flex; gap:10px; align-items:center; } .row > * { flex:1; } .check { display:flex; gap:8px; align-items:center; margin-top:10px; } .check input { width:auto; } .check label { margin:0; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法蓝晒底片批次工作台</h1><div class="meta">一次曝光拆分为多块底片 · 待曝光 → 冲洗中 → 待入盒 → 已交付</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="batchForm">
        <h2>新增曝光批次</h2>
        <label>药液批次 *</label><input name="chemicalBatch" required maxlength="120" placeholder="如 B-0620">
        <label>曝光时间 *</label><input name="exposure" required maxlength="120" placeholder="如 8分钟">
        <label>冲洗水源 *</label><input name="waterSource" required maxlength="120" placeholder="如 井水过滤">
        <label>玻璃板尺寸</label><input name="plateSize" maxlength="60" placeholder="如 18x24cm">
        <label>拆分底片数量(1-100)*</label><input name="count" type="number" min="1" max="100" value="1" required>
        <button type="submit">创建批次并拆分底片</button>
      </form>
      <form id="stepForm" style="margin-top:14px">
        <h2>记录工艺步骤</h2>
        <label>选择底片(仅未交付)</label><select name="id" id="itemSelect" required></select>
        <label>步骤名称 *</label><input name="step" required maxlength="60" placeholder="如 涂布 / 曝光 / 冲洗 / 复晒 / 修补">
        <label>显影状态</label><input name="developStatus" maxlength="60">
        <label>缺陷类型</label><input name="defect" maxlength="120">
        <label>修补记录</label><input name="repair" maxlength="200">
        <div class="check"><input type="checkbox" name="reexpose" id="reexpose"><label for="reexpose">本次为复晒(计入复晒次数)</label></div>
        <label>备注</label><input name="note" maxlength="300">
        <button type="submit">提交记录</button>
      </form>
      <form id="reviewForm" style="margin-top:14px">
        <h2>发起复核工单</h2>
        <label>选择底片(仅待入盒)</label><select name="id" id="reviewItemSelect" required></select>
        <label>复核人 *</label><input name="reviewer" required maxlength="120">
        <label>缺陷结论 *</label><input name="conclusion" required maxlength="120">
        <label>整改要求 *</label><input name="requirement" required maxlength="200">
        <label>截止时间 *</label><input name="deadline" type="date" required>
        <button type="submit">发起复核</button>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar">
        <select id="fStatus"><option value="">全部状态</option></select>
        <select id="fBatch"><option value="">全部批次</option></select>
        <input id="fBox" placeholder="按盒位筛选,如 蓝盒A-03">
        <input id="fDefect" placeholder="按缺陷筛选">
        <input id="fQ" placeholder="搜索关键词">
      </div>
      <div class="panel"><h2>底片列表</h2><div class="grid" id="cards"></div></div>
      <div class="panel" style="margin-top:14px">
        <h2>复核工单</h2>
        <div class="toolbar"><select id="fReview"><option value="">全部工单</option><option>未关闭</option><option>已关闭</option><option value="逾期">仅逾期</option></select></div>
        <div class="grid" id="reviews"></div>
      </div>
    </section>
  </main>
  <div id="toast"></div>
  <script>
    var STAGES = ["待曝光","冲洗中","待入盒","已交付"];
    var items = [], batches = [], stats = null, reviews = [];
    var batchFormKey = crypto.randomUUID();
    var stepFormKey = crypto.randomUUID();
    var reviewFormKey = crypto.randomUUID();
    var advanceKeys = {};
    var closeKeys = {};

    function esc(s) {
      return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
    }
    function toast(msg, ok) {
      var el = document.getElementById("toast");
      el.textContent = msg;
      el.className = ok ? "ok" : "err";
      clearTimeout(el._t);
      el._t = setTimeout(function(){ el.className = ""; }, 4000);
    }
    // 与接口一致的截止时间校验:必须是真实存在的日历日期(含闰年规则)
    function isRealDate(y, m, d) {
      var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      var days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1];
    }
    function validDeadline(v) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (m) return isRealDate(+m[1], +m[2], +m[3]);
      m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(v);
      if (!m) return false;
      if (!isRealDate(+m[1], +m[2], +m[3])) return false;
      if (+m[4] > 23 || +m[5] > 59 || (m[6] !== undefined && +m[6] > 59)) return false;
      if (m[7] && m[7] !== "Z") {
        var off = m[7].slice(1).split(":");
        if (+off[0] > 23 || +off[1] > 59) return false;
      }
      return true;
    }
    async function api(path, options) {
      var res = await fetch(path, options);
      var data = {};
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) throw new Error(data.message || data.error || ("请求失败 " + res.status));
      return data;
    }
    function jsonPost(path, payload, key) {
      return api(path, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(payload) });
    }

    async function load() {
      var params = new URLSearchParams();
      var fStatus = document.getElementById("fStatus").value;
      var fBatch = document.getElementById("fBatch").value;
      var fBox = document.getElementById("fBox").value.trim();
      var fDefect = document.getElementById("fDefect").value.trim();
      var fQ = document.getElementById("fQ").value.trim();
      if (fStatus) params.set("status", fStatus);
      if (fBatch) params.set("batch", fBatch);
      if (fBox) params.set("box", fBox);
      if (fDefect) params.set("defect", fDefect);
      if (fQ) params.set("q", fQ);
      var results = await Promise.all([api("/api/items?" + params.toString()), api("/api/batches"), api("/api/stats"), api("/api/reviews")]);
      items = results[0]; batches = results[1]; stats = results[2]; reviews = results[3];
      render();
    }

    function render() {
      var statsHtml = STAGES.map(function(s){ return '<div class="stat"><span>' + s + '</span><strong>' + (stats.byStatus[s] || 0) + '</strong></div>'; }).join("");
      statsHtml += '<div class="stat"><span>缺陷底片</span><strong class="warn">' + stats.withDefect + '</strong></div>';
      statsHtml += '<div class="stat"><span>复晒总次数</span><strong>' + stats.reexposeTotal + '</strong></div>';
      statsHtml += '<div class="stat"><span>未关闭工单</span><strong>' + stats.reviews.open + '</strong></div>';
      statsHtml += '<div class="stat"><span>逾期工单</span><strong class="warn">' + stats.reviews.overdue + '</strong></div>';
      document.getElementById("stats").innerHTML = statsHtml;

      var batchSel = document.getElementById("fBatch");
      var keepBatch = batchSel.value;
      batchSel.innerHTML = '<option value="">全部批次</option>' + batches.map(function(b){
        return '<option value="' + esc(b.code) + '"' + (b.code === keepBatch ? ' selected' : '') + '>' + esc(b.code) + ' · ' + esc(b.chemicalBatch) + '</option>';
      }).join("");

      var itemSel = document.getElementById("itemSelect");
      var keepItem = itemSel.value;
      var open = items.filter(function(i){ return i.status !== "已交付"; });
      itemSel.innerHTML = open.length ? open.map(function(i){
        return '<option value="' + esc(i.id) + '"' + (i.id === keepItem ? ' selected' : '') + '>' + esc(i.code) + ' · ' + esc(i.status) + '</option>';
      }).join("") : '<option value="">(暂无未交付底片)</option>';

      var reviewSel = document.getElementById("reviewItemSelect");
      var keepReview = reviewSel.value;
      var boxed = items.filter(function(i){ return i.status === "待入盒"; });
      reviewSel.innerHTML = boxed.length ? boxed.map(function(i){
        return '<option value="' + esc(i.id) + '"' + (i.id === keepReview ? ' selected' : '') + '>' + esc(i.code) + ' · ' + esc(i.box || "未入盒") + '</option>';
      }).join("") : '<option value="">(暂无待入盒底片)</option>';

      document.getElementById("cards").innerHTML = items.length ? items.map(cardHtml).join("") : '<div class="meta">暂无符合条件的底片</div>';
      Array.prototype.forEach.call(document.querySelectorAll("[data-advance]"), function(btn){
        btn.onclick = function(){ advance(btn.getAttribute("data-advance")); };
      });

      var rf = document.getElementById("fReview").value;
      var visibleReviews = reviews.filter(function(r){
        if (rf === "逾期") return r.overdue;
        return !rf || r.status === rf;
      });
      document.getElementById("reviews").innerHTML = visibleReviews.length ? visibleReviews.map(reviewHtml).join("") : '<div class="meta">暂无符合条件的工单</div>';
      Array.prototype.forEach.call(document.querySelectorAll("[data-close]"), function(btn){
        btn.onclick = function(){ closeReview(btn.getAttribute("data-close")); };
      });
    }

    function reviewHtml(r) {
      var h = '<article class="card"><div class="row"><h3 style="margin:0">' + esc(r.code) + '</h3><span class="pill">' + esc(r.status) + '</span></div>';
      h += '<div class="meta">底片 ' + esc(r.itemCode) + ' · 盒位 ' + esc(r.box) + '</div>';
      h += '<div class="meta">复核人 ' + esc(r.reviewer) + ' · 截止 ' + esc(String(r.deadline).slice(0, 10)) + '</div>';
      if (r.overdue) h += '<div class="warn">已逾期,请尽快处理</div>';
      h += '<div>缺陷结论:' + esc(r.conclusion) + '</div>';
      h += '<div>整改要求:' + esc(r.requirement) + '</div>';
      if (r.status === "未关闭") {
        h += '<button data-close="' + esc(r.id) + '">关闭工单</button>';
      } else {
        h += '<div class="meta">处理结果:' + esc(r.resolution) + '</div>';
      }
      return h + '</article>';
    }

    async function closeReview(id) {
      var resolution = prompt("请输入处理结果(必填)");
      if (resolution === null) return;
      if (!resolution.trim()) { toast("处理结果不能为空", false); return; }
      closeKeys[id] = closeKeys[id] || crypto.randomUUID();
      try {
        await jsonPost("/api/reviews/" + encodeURIComponent(id) + "/close", { resolution: resolution }, closeKeys[id]);
        delete closeKeys[id];
        toast("工单已关闭", true);
      } catch (e) {
        toast(e.message, false);
      }
      await load();
    }

    function cardHtml(item) {
      var idx = STAGES.indexOf(item.status);
      var next = STAGES[idx + 1];
      var batch = batches.find(function(b){ return b.id === item.batchId; });
      var h = '<article class="card"><div class="row"><h3 style="margin:0">' + esc(item.code) + '</h3><span class="pill">' + esc(item.status) + '</span></div>';
      h += '<div class="meta">曝光批次 ' + esc(batch ? batch.code : "无") + ' · 药液 ' + esc(item.chemicalBatch) + ' · 曝光 ' + esc(item.exposure) + ' · 水源 ' + esc(item.waterSource) + '</div>';
      if (item.plateSize) h += '<div class="meta">玻璃板 ' + esc(item.plateSize) + '</div>';
      h += '<div class="meta">盒位 ' + (item.box ? esc(item.box) : "未入盒") + ' · 复晒 ' + item.reexposeCount + ' 次 · 版本 v' + item.version + '</div>';
      if (item.defect) h += '<div class="warn">缺陷:' + esc(item.defect) + '</div>';
      var openReview = reviews.find(function(r){ return r.itemId === item.id && r.status === "未关闭"; });
      if (openReview) h += '<div class="warn">复核工单 ' + esc(openReview.code) + (openReview.overdue ? "(已逾期)" : "") + ' 未关闭,暂不能交付</div>';
      var steps = (item.steps || []).slice(-3).map(function(s){
        var parts = '[' + esc(s.stage || "") + '] ' + esc(s.step);
        if (s.reexpose) parts += '(复晒)';
        if (s.defect) parts += ' 缺陷:' + esc(s.defect);
        if (s.repair) parts += ' 修补:' + esc(s.repair);
        if (s.note) parts += ' — ' + esc(s.note);
        return '<div>' + parts + '</div>';
      }).join("");
      h += '<div class="logs meta"><b>步骤</b>' + (steps || '<div>暂无步骤记录</div>') + '</div>';
      var logs = (item.logs || []).slice(-3).map(function(l){ return '<div>' + esc(l.step) + ':' + esc(l.note) + '</div>'; }).join("");
      h += '<div class="logs meta"><b>日志</b>' + (logs || '<div>暂无日志</div>') + '</div>';
      if (next) {
        h += '<button data-advance="' + esc(item.id) + '">推进到「' + next + '」</button>';
      } else {
        h += '<button disabled>已交付</button>';
      }
      return h + '</article>';
    }

    async function advance(id) {
      var item = items.find(function(x){ return x.id === id; });
      if (!item) return;
      var next = STAGES[STAGES.indexOf(item.status) + 1];
      if (!next) return;
      var box = "";
      if (next === "待入盒") {
        box = prompt("请输入盒位(同一盒位不能同时存放两块未交付底片)", item.box || "");
        if (box === null) return;
        if (!box.trim()) { toast("盒位不能为空", false); return; }
      }
      advanceKeys[id] = advanceKeys[id] || crypto.randomUUID();
      try {
        await jsonPost("/api/items/" + encodeURIComponent(id) + "/transition", { to: next, box: box, expectedVersion: item.version }, advanceKeys[id]);
        delete advanceKeys[id];
        toast(item.code + " 已推进到「" + next + "」", true);
      } catch (e) {
        toast(e.message, false);
      }
      await load();
    }

    document.getElementById("batchForm").onsubmit = async function(ev) {
      ev.preventDefault();
      var form = ev.target;
      var btn = form.querySelector("button");
      btn.disabled = true;
      var fd = new FormData(form);
      var payload = { chemicalBatch: fd.get("chemicalBatch"), exposure: fd.get("exposure"), waterSource: fd.get("waterSource"), plateSize: fd.get("plateSize"), count: Number(fd.get("count")) };
      try {
        var r = await jsonPost("/api/batches", payload, batchFormKey);
        toast("批次 " + r.batch.code + " 已创建,拆出 " + r.items.length + " 块底片", true);
        form.reset();
        batchFormKey = crypto.randomUUID();
      } catch (e) {
        toast(e.message, false);
      }
      btn.disabled = false;
      await load();
    };

    document.getElementById("stepForm").onsubmit = async function(ev) {
      ev.preventDefault();
      var form = ev.target;
      var id = document.getElementById("itemSelect").value;
      if (!id) { toast("请先选择底片", false); return; }
      var btn = form.querySelector("button");
      btn.disabled = true;
      var fd = new FormData(form);
      var payload = { step: fd.get("step"), developStatus: fd.get("developStatus"), defect: fd.get("defect"), repair: fd.get("repair"), note: fd.get("note"), reexpose: fd.has("reexpose") };
      try {
        await jsonPost("/api/items/" + encodeURIComponent(id) + "/steps", payload, stepFormKey);
        toast("步骤已记录", true);
        form.reset();
        stepFormKey = crypto.randomUUID();
      } catch (e) {
        toast(e.message, false);
      }
      btn.disabled = false;
      await load();
    };

    document.getElementById("reviewForm").onsubmit = async function(ev) {
      ev.preventDefault();
      var form = ev.target;
      var id = document.getElementById("reviewItemSelect").value;
      if (!id) { toast("请先选择待入盒底片", false); return; }
      var btn = form.querySelector("button");
      btn.disabled = true;
      var fd = new FormData(form);
      var payload = { reviewer: fd.get("reviewer"), conclusion: fd.get("conclusion"), requirement: fd.get("requirement"), deadline: fd.get("deadline") };
      if (!validDeadline(payload.deadline || "")) {
        toast("截止时间必须是真实存在的日历日期或合法时间", false);
        btn.disabled = false;
        return;
      }
      try {
        var r = await jsonPost("/api/items/" + encodeURIComponent(id) + "/reviews", payload, reviewFormKey);
        toast("复核工单 " + r.code + " 已发起", true);
        form.reset();
        reviewFormKey = crypto.randomUUID();
      } catch (e) {
        toast(e.message, false);
      }
      btn.disabled = false;
      await load();
    };

    ["fStatus","fBatch"].forEach(function(id){ document.getElementById(id).onchange = function(){ load().catch(function(e){ toast(e.message, false); }); }; });
    document.getElementById("fReview").onchange = render;
    ["fBox","fDefect","fQ"].forEach(function(id){ document.getElementById(id).oninput = function(){ load().catch(function(e){ toast(e.message, false); }); }; });
    document.getElementById("reload").onclick = function(){ load().catch(function(e){ toast(e.message, false); }); };

    var statusSel = document.getElementById("fStatus");
    statusSel.innerHTML = '<option value="">全部状态</option>' + STAGES.map(function(s){ return '<option>' + s + '</option>'; }).join("");
    load().catch(function(e){ toast(e.message, false); });
  </script>
</body>
</html>`;
}
