/* app.js — UI controller (owner: agent D). Needs the DOM; not loaded in Node tests. */
(function (g) {
  "use strict";
  const CC = g.CC, U = CC.util, doc = g.document;
  if (!doc) return;
  if (g.pdfjsLib) g.pdfjsLib.GlobalWorkerOptions.workerSrc = "pdf.worker.min.js";

  const $ = (s) => doc.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = (n) => (n == null || !Number.isFinite(+n) ? "—" : (+n).toLocaleString("en-US", { maximumFractionDigits: 2 }));
  const ymd = (iso) => (iso ? iso.replace(/-/g, "/") : "—");
  const MANUAL = "(需人工確認)";

  const STATUS = {
    queued: ["等待中", "run"], decrypt: ["解密中", "run"], read: ["讀取中", "run"], ocr: ["辨識中", "run"],
    ok: ["通過", "ok"], bad: ["不符", "bad"], pw: ["要密碼", "pw"], unknown: ["認不出銀行", "unknown"], error: ["錯誤", "error"],
  };
  const DONE = new Set(["ok", "bad", "pw", "unknown", "error"]);
  const FAILED = new Set(["pw", "unknown", "error"]);

  const S = {
    settings: CC.settings.load(),
    passwords: [],          // memory only
    files: [],              // {id,name,size,buf,status,bank,st,rec,read,doc,ocrInfo,count,error,ocrNote}
    rows: [],               // OutRow + {fid, idx, user, excluded, ocrText, ocrClean}
    filter: "pending",
    cursor: null,
    open: new Set(),        // expanded row ids
    openFiles: new Set(),
    edit: null,             // {id, field:'type'|'desc'}
    busy: false,
    dl: undefined,          // downloads capability (undefined = still checking, null = none)
    ack: false,
    ackSig: null,           // {keys:Set of problem keys, man: manual-row count} the ack was given for
    flash: null,            // last 「套用到同摘要」 confirmation, cleared on the next action
    exported: false,
    modelP: null,
    ocrMsg: "",
    dirtyTable: false,
  };
  CC.app = { state: S };
  let seq = 0;

  /* ------------------------------ helpers ------------------------------ */
  const fileOf = (r) => S.files.find((f) => f.id === r.fid);
  const warnOf = (f) => (f && f.st && typeof f.st.warn === "string" && f.st.warn.trim()) || "";
  const fileOk = (f) => !!f && f.status === "ok" && !warnOf(f);
  const isPending = (r) => !r.confirmed && !r.excluded && (r.guess || r.ocr || !fileOk(fileOf(r)));
  const allTypes = () => {
    const s = S.settings, seen = new Set(), out = [];
    for (const t of s.fixedTypes || []) if (!seen.has(t)) { seen.add(t); out.push([t, "固定"]); }
    for (const t of s.floatingTypes || []) if (!seen.has(t)) { seen.add(t); out.push([t, "浮動"]); }
    return out;
  };
  /** Payslip earnings pick from 收入類型 and stay on 收入; every other row picks an expense type. */
  /** Payslip deductions may also pick a 轉入銀行 (→ 轉帳 sheet). */
  const typesFor = (r) => (r && r.kind === "income" ? CC.payslip.incomeTypes(S.settings).map((t) => [t, "收入"])
    : r && r.kind === "deduct" ? allTypes().concat(CC.payslip.bankTargets(S.settings).map((t) => [t, "轉帳"])) : allTypes());
  const sheetFor = (r, type) => CC.payslip.sheetFor(r, type, S.settings);
  const errMsg = (e) => (e && (e.message || e.code)) || String(e);
  function saveSettings() { try { CC.settings.save(S.settings); } catch (e) { /* storage blocked: keep in memory */ } }

  function visibleRows() {
    const f = S.filter;
    if (f === "pending") return S.rows.filter(isPending);
    if (f === "all") return S.rows;
    return S.rows.filter((r) => r.card === f);
  }

  /* ------------------------------ pipeline ------------------------------ */
  function addFiles(list) {
    let added = 0;
    for (const file of list) {
      const eml = /\.eml$/i.test(file.name) || file.type === "message/rfc822";
      if (!eml && !/\.pdf$/i.test(file.name) && file.type !== "application/pdf") continue;
      const dup = S.files.find((f) => f.name === file.name && f.size === file.size);
      if (dup && !FAILED.has(dup.status)) continue;
      if (dup) {
        // a failed entry: start it over with the fresh bytes instead of ignoring the drop
        freeDoc(dup);
        S.rows = S.rows.filter((r) => r.fid !== dup.id);
        // fresh id: the old entry's ack keys (e.g. f2|error) must not carry over to the new bytes
        const wasOpen = S.openFiles.delete(dup.id);
        Object.assign(dup, { id: "f" + ++seq, status: "queued", buf: null, file, ocrInfo: {}, bank: null, st: null, rec: null, count: null, error: null, ocrNote: null, ocrDone: false, edits: null });
        if (wasOpen) S.openFiles.add(dup.id);
        added++; continue;
      }
      const f = { id: "f" + ++seq, name: file.name, size: file.size, status: "queued", buf: null, file, ocrInfo: {}, kind: eml ? "payslip" : "statement" };
      S.files.push(f); added++;
    }
    if (added) { renderAll(); pump(); }
  }
  /** Pasted payslip text: kept in memory only, like the statements themselves. */
  function addSlipText(text) {
    text = String(text || "").trim(); if (!text) return false;
    if (S.files.some((f) => f.text === text)) return false;
    const n = S.files.filter((f) => f.kind === "payslip" && f.text != null).length + 1;
    S.files.push({ id: "f" + ++seq, name: `貼上的薪資單 ${n}`, size: text.length, status: "queued", buf: null, file: null, text, ocrInfo: {}, kind: "payslip" });
    renderAll(); pump();
    return true;
  }

  /** Payslip (.eml bytes or pasted text) → statement; same ok/bad/warn handling as a bank statement. */
  async function slipPhase(f) {
    f.status = "read"; renderFiles();
    let meta = { subject: "", from: "", date: null, text: f.text };
    if (f.text == null) { if (!f.buf) f.buf = await f.file.arrayBuffer(); meta = CC.payslip.fromEml(f.buf); }
    f.bank = CC.payslip.detect(meta.text, meta, S.settings);
    f.st = CC.payslip.parse(meta.text, meta);
    f.rec = CC.reconcile(f.st);
    f.buf = null; f.file = null;
    build(f);
  }

  async function pump() {
    if (S.busy) return;
    S.busy = true; renderBusy();
    try {
      for (;;) {
        const f = S.files.find((x) => x.status === "queued");
        if (f) { await textPhase(f); renderAll(); continue; }
        const o = S.files.find((x) => x.status === "ocr" && !x.ocrDone);
        if (o) { await ocrPhase(o); renderAll(); continue; }
        break;
      }
    } finally { S.busy = false; renderAll(); renderBusy(); }
  }

  function freeDoc(f) {
    try { f.doc && f.doc.destroy && f.doc.destroy(); } catch (e) { /* ignore */ }
    f.doc = null; f.read = null;
  }

  async function textPhase(f) {
    f.error = null; f.ocrNote = null;
    try {
      if (f.kind === "payslip") return await slipPhase(f);
      if (!f.buf) f.buf = await f.file.arrayBuffer();
      f.status = "decrypt"; renderFiles();
      try { f.doc = (await CC.pdf.open(f.buf, S.passwords)).doc; }
      catch (e) {
        if (e && e.code === "password") { f.status = "pw"; f.error = S.passwords.length ? "密碼都不對，請再輸入一組" : "這份帳單有密碼"; return; }
        throw e;
      }
      f.status = "read"; renderFiles();
      const read = await CC.pdf.read(f.doc);
      const bank = CC.banks.detect(read);
      if (!bank) { f.status = "unknown"; f.error = "不是支援的銀行，或帳單改版了"; freeDoc(f); return; }
      f.bank = bank;
      f.st = bank.parse(read);
      f.rec = CC.reconcile(f.st);
      f.buf = null; f.file = null;
      if (f.st.rows.some((r) => r.ocr)) { f.read = read; f.status = "ocr"; f.ocrDone = false; return; }
      freeDoc(f);
      build(f);
    } catch (e) {
      f.status = "error"; f.error = errMsg(e); freeDoc(f);
    }
  }

  function ensureModel() {
    if (!S.modelP) {
      S.ocrMsg = "載入文字辨識模型…（第一次約 10 MB，之後會記住）"; renderOcrMsg();
      S.modelP = CC.ocr.ensure((p) => {
        let pct = null;
        if (typeof p === "number") pct = p <= 1 ? p * 100 : p;
        else if (p && p.total) pct = (p.loaded / p.total) * 100;
        else if (p && typeof p.progress === "number") pct = p.progress <= 1 ? p.progress * 100 : p.progress;
        S.ocrMsg = "載入文字辨識模型…" + (pct != null ? " " + Math.round(pct) + "%" : (typeof p === "string" ? " " + p : ""));
        renderOcrMsg();
      }).catch((e) => { S.modelP = null; throw e; });
    }
    return S.modelP;
  }

  async function ocrPhase(f) {
    const rows = f.st.rows, idx = [];
    rows.forEach((r, i) => { if (r.ocr) idx.push(i); });
    try {
      await ensureModel();
      S.ocrMsg = `辨識 ${f.name} 的摘要（${idx.length} 筆）…`; renderOcrMsg();
      const byPage = new Map();
      for (const i of idx) { const p = rows[i].ocr.page; if (!byPage.has(p)) byPage.set(p, []); byPage.get(p).push(i); }
      for (const [pn, list] of byPage) {
        const pg = f.read.pages.find((p) => p.num === pn);
        if (!pg) throw new Error("找不到第 " + pn + " 頁");
        const res = await CC.ocr.recognize(pg.page, list.map((i) => ({ y: rows[i].ocr.y, x0: rows[i].ocr.x0, x1: rows[i].ocr.x1 })));
        list.forEach((i, k) => {
          const r = res[k] || { text: "", crop: null };
          const clean = CC.ocr.cleanup(r.text || "", S.settings.ocrFix);
          f.ocrInfo[i] = { text: r.text || "", clean, crop: r.crop || null, conf: r.conf };
          rows[i].desc = clean || MANUAL;
        });
      }
    } catch (e) {
      for (const i of idx) if (!f.ocrInfo[i]) rows[i].desc = MANUAL;
      f.ocrNote = "文字辨識失敗（" + errMsg(e) + "），摘要請手動填寫；金額不受影響。";
    }
    f.ocrDone = true;
    S.ocrMsg = "";
    freeDoc(f);
    build(f);
  }

  /** (Re)build a statement's output rows; user edits carry over by row id (kept on the file entry so a failed rebuild does not lose them). */
  function build(f) {
    const edits = f.edits || (f.edits = {});
    for (const o of S.rows) if (o.fid === f.id) edits[o.id] = { confirmed: o.confirmed, excluded: o.excluded, user: o.user };
    let out;
    try { out = (f.kind === "payslip" ? CC.payslip : CC.classify).process(f.st, f.bank, S.settings, f.name) || []; }
    catch (e) { f.status = "error"; f.error = "分類失敗：" + errMsg(e); out = []; }
    const kept = [];
    f.st.rows.forEach((r, i) => { if (!CC.classify.isPayment(r.desc, r.amount)) kept.push(i); });
    out.forEach((r, k) => {
      const m = /#(\d+)$/.exec(r.id || "");
      const si = m ? +m[1] : kept.length === out.length ? kept[k] : -1;
      r.fid = f.id; r.id = f.id + ":" + k;
      const info = si >= 0 ? f.ocrInfo[si] : null;
      if (info) { r.crop = info.crop; r.ocrText = info.text; r.ocrClean = info.clean; }
      const o = edits[r.id];
      if (o) {
        r.confirmed = o.confirmed; r.excluded = o.excluded; r.user = o.user;
        if (o.user && o.user.desc != null) r.desc = o.user.desc;
        if (o.user && o.user.type != null) { r.type = o.user.type; r.guess = false; r.sheet = sheetFor(r, r.type); }
      }
    });
    f.count = out.length;
    if (f.status !== "error") f.status = f.rec && f.rec.ok ? "ok" : "bad";
    // keep rows grouped in file order
    const order = new Map(S.files.map((x, i) => [x.id, i]));
    S.rows = S.rows.filter((r) => r.fid !== f.id).concat(out).sort((a, b) => order.get(a.fid) - order.get(b.fid) || +a.id.split(":")[1] - +b.id.split(":")[1]);
  }

  function rebuildAll() {
    for (const f of S.files) if (f.st && (f.status === "ok" || f.status === "bad")) build(f);
    renderAll();
  }

  function retry(f, pw) {
    if (pw && !S.passwords.includes(pw)) { S.passwords.push(pw); renderPw(); }
    if (f.status === "error" && f.st && f.bank && !f.file && !f.buf) {
      // parsed fine, failed later (reconcile/classify): rebuild from the parsed statement
      f.error = null; f.status = "read";
      try { if (!f.rec) f.rec = CC.reconcile(f.st); build(f); }
      catch (e) { f.status = "error"; f.error = errMsg(e); }
      renderAll(); return;
    }
    if (FAILED.has(f.status)) {
      if (!f.file && !f.buf && f.text == null) { f.error = "請重新放入這份檔案"; renderFiles(); return; }
      f.status = "queued";
    }
    renderAll(); pump();
  }

  /* ------------------------------ actions ------------------------------ */
  function nextPendingAfter(id) {
    const i = S.rows.findIndex((r) => r.id === id);
    for (let k = 1; k <= S.rows.length; k++) { const r = S.rows[(i + k) % S.rows.length]; if (r && r.id !== id && isPending(r)) return r.id; }
    return null;
  }
  function neighbourInView(id) {
    const v = visibleRows(), i = v.findIndex((r) => r.id === id);
    return i < 0 ? null : (v[i + 1] || v[i - 1] || {}).id || null;
  }
  function afterChange(id, jumpPending) {
    const r = S.rows.find((x) => x.id === id);
    const stillVisible = r && visibleRows().includes(r);
    if (jumpPending) S.cursor = nextPendingAfter(id) || (stillVisible ? id : null);
    else if (!stillVisible) S.cursor = S._next || null;
    S.open.delete(id);
  }
  function confirmRow(id) {
    const r = S.rows.find((x) => x.id === id); if (!r) return;
    const was = r.confirmed;
    r.confirmed = !was;
    if (!was) afterChange(id, true);
    renderReview(); focusTable();
  }
  function setType(id, type) {
    const r = S.rows.find((x) => x.id === id); if (!r || !type) return;
    S._next = neighbourInView(id);
    r.type = type; r.guess = false; r.sheet = sheetFor(r, type);
    r.user = Object.assign({}, r.user, { type }); r.confirmed = true;
    afterChange(id, false);
  }
  function setDesc(id, desc) {
    const r = S.rows.find((x) => x.id === id); if (!r) return;
    desc = desc.trim(); if (!desc || desc === r.desc) return;
    S._next = neighbourInView(id);
    r.desc = desc; r.user = Object.assign({}, r.user, { desc }); r.confirmed = true;
    afterChange(id, false);
  }
  function applySame(id) {
    const r = S.rows.find((x) => x.id === id); if (!r) return;
    const key = U.norm(r.desc); let n = 0;
    for (const x of S.rows) {
      if (U.norm(x.desc) !== key) continue;
      if ((x.kind === "income") !== (r.kind === "income")) continue; // an income type never lands on an expense row
      if (r.sheet === CC.exporter.BANK_SHEET && x.kind !== "deduct") continue; // a 轉入銀行 only fits payslip deductions
      x.type = r.type; x.guess = false; x.sheet = sheetFor(x, r.type);
      x.user = Object.assign({}, x.user, { type: r.type });
      if (!x.ocr || x === r) x.confirmed = true;
      n++;
    }
    try { S.settings = CC.settings.learn(S.settings, r.desc, r.type) || S.settings; } catch (e) { /* ignore */ }
    saveSettings();
    S.flash = `已套用「${r.type}」到 ${n} 筆，之後同樣的摘要也會這樣分。`;
    renderReview(); renderSettings(); focusTable();
  }

  /* ------------------------------ render: step 1 ------------------------------ */
  function renderBusy() { $("#app").dataset.busy = S.busy ? "1" : "0"; }
  function renderOcrMsg() {
    const el = $("#ocr-msg"); el.hidden = !S.ocrMsg; el.textContent = S.ocrMsg;
  }
  function renderPw() {
    $("#pw-chips").innerHTML = S.passwords.map((p, i) =>
      `<li class="chip"><span>${esc("•".repeat(Math.min(p.length, 12)))}</span><button type="button" data-pw="${i}" aria-label="移除第 ${i + 1} 組密碼">×</button></li>`).join("");
  }
  function renderFiles() {
    const list = $("#file-list");
    $("#files-empty").hidden = S.files.length > 0;
    const keepFocus = doc.activeElement && doc.activeElement.closest && doc.activeElement.closest("#file-list") && doc.activeElement.id;
    const typed = {}; // half-typed per-file passwords survive the re-render
    list.querySelectorAll("[data-retry-pw]").forEach((i) => { if (i.value) typed[i.id] = [i.value, i.selectionStart, i.selectionEnd]; });
    list.innerHTML = S.files.map((f) => {
      const warn = warnOf(f);
      const [lbl, cls] = f.status === "ok" && warn ? ["需核對", "pw"] : STATUS[f.status] || ["?", "run"];
      const open = S.openFiles.has(f.id) || f.status === "pw";
      const bank = f.bank ? f.bank.name : "";
      const date = f.st ? ymd(f.st.closing) : "—";
      const cnt = f.count != null ? f.count + " 筆" : "—";
      let more = "";
      if (open) {
        if (f.st && f.kind === "payslip") {
          const st = f.st, rc = f.rec || {};
          more += `<dl class="recon">
            <dt>發薪日</dt><dd>${date}</dd><dt>實發金額</dt><dd>${money(st.net)}</dd>
            <dt>收入項目合計</dt><dd>${money(st.earn)}</dd><dt>薪資單應發</dt><dd>${money(st.gross)}</dd>
            <dt>扣項合計</dt><dd>${money(st.ded)}</dd><dt>薪資單應扣</dt><dd>${money(st.deduct)}</dd>
            <dt>原始項目</dt><dd>${st.rows.length} 筆</dd><dt>輸出</dt><dd>${f.count != null ? f.count + " 筆" : "—"}</dd></dl>`;
          if (f.status === "bad") more += `<p class="file-err">收入 − 扣項 = ${money(rc.total)}，和實發 ${money(rc.expect)} 不符，這份的項目會標紅，請對照薪資單。</p>`;
        } else if (f.st) {
          const rc = f.rec || {};
          const due = CC.exporter.dueOf(f.st.cur, f.st.due);
          more += `<dl class="recon">
            <dt>結帳日</dt><dd>${date}</dd><dt>繳款截止日</dt><dd>${due === CC.exporter.NO_PAY ? due : ymd(due)}</dd>
            <dt>上期應繳</dt><dd>${money(f.st.prev)}</dd><dt>本期應繳</dt><dd>${money(f.st.cur)}</dd>
            <dt>明細合計（含繳款）</dt><dd>${money(rc.total)}</dd><dt>應為（本期−上期）</dt><dd>${money(rc.expect)}</dd>
            <dt>原始明細</dt><dd>${f.st.rows.length} 筆</dd><dt>輸出</dt><dd>${f.count != null ? f.count + " 筆" : "—"}</dd></dl>`;
          if (f.status === "bad") more += `<p class="file-err">合計和帳單總額差 ${money((rc.total || 0) - (rc.expect || 0))} 元，這份的明細會標紅，請對照紙本帳單。</p>`;
        }
        if (warn && !FAILED.has(f.status)) more += `<p class="file-err file-warn">需核對：${esc(warn)}</p>`;
        if (f.error) more += `<p class="file-err">${esc(f.error)}</p>`;
        if (f.ocrNote) more += `<p class="file-err">${esc(f.ocrNote)}</p>`;
        if (f.status === "pw") more += `<div class="retry"><input type="password" id="pw-${f.id}" data-retry-pw="${f.id}" placeholder="這份的密碼" aria-label="${esc(f.name)} 的密碼" autocomplete="off"><button type="button" class="btn sm" data-retry="${f.id}">用這組密碼重試</button></div>`;
        else if (f.status === "error" || f.status === "unknown") more += `<div class="retry"><button type="button" class="btn sm" data-retry="${f.id}">重試</button></div>`;
        // pasted text has no file to drop again: let a wrong or failed paste be removed and pasted anew
        if (f.text != null) more += `<div class="retry"><button type="button" class="btn sm ghost" data-remove="${f.id}">移除這份</button></div>`;
      }
      return `<li class="file" data-status="${f.status}" data-open="${open ? 1 : 0}">
        <button type="button" class="file-row" data-file="${f.id}" aria-expanded="${open}">
          <span class="caret" aria-hidden="true">▶</span>
          <span class="fname" title="${esc(f.name)}">${esc(f.name)}</span>
          <span class="fbank">${esc(bank) || '<span class="hint">—</span>'}</span>
          <span class="fdate">${date}</span><span class="fcount">${cnt}</span>
          <span class="st ${cls}">${lbl}</span>
          <span class="fmeta mono hint">${date} · ${cnt}</span>
        </button>${open ? `<div class="file-more">${more}</div>` : ""}</li>`;
    }).join("");
    for (const id in typed) { const el = doc.getElementById(id); if (el) el.value = typed[id][0]; }
    if (keepFocus) {
      const el = doc.getElementById(keepFocus);
      if (el) { el.focus(); const t = typed[keepFocus]; if (t && t[1] != null) try { el.setSelectionRange(t[1], t[2]); } catch (e) { /* not a text input */ } }
    }
    const n = S.files.length, ok = S.files.filter(fileOk).length, run = S.files.filter((f) => !DONE.has(f.status)).length;
    $("#file-summary").innerHTML = !n ? "尚未放入" :
      `<b>${n}</b> 份 · 通過 <b id="ok-count">${ok}</b>` + (n - ok - run ? ` · 要處理 <b>${n - ok - run}</b>` : "") + (run ? ` · 處理中 <b>${run}</b>` : "");
  }

  /* ------------------------------ render: step 2 ------------------------------ */
  function renderFilter() {
    const cards = [...new Set(S.rows.map((r) => r.card))];
    const opts = [["pending", "待確認", S.rows.filter(isPending).length], ["all", "全部", S.rows.length]]
      .concat(cards.map((c) => [c, c, S.rows.filter((r) => r.card === c).length]));
    if (!opts.some((o) => o[0] === S.filter)) S.filter = "pending";
    $("#filter").innerHTML = opts.map(([v, l, n]) =>
      `<button type="button" data-filter="${esc(v)}" aria-pressed="${S.filter === v}" ${v === "pending" ? 'id="filter-pending"' : ""}>${esc(l)}<span class="ct">${n}</span></button>`).join("");
  }

  function rowHtml(r) {
    const f = fileOf(r), bad = !fileOk(f) && !r.confirmed;
    const cur = S.cursor === r.id, open = S.open.has(r.id), ed = S.edit && S.edit.id === r.id ? S.edit.field : null;
    const cls = ["row", cur && "cur", bad && "bad", r.excluded && "excl", r.confirmed && "confirmed"].filter(Boolean).join(" ");
    const typeCell = ed === "type"
      ? `<input class="edit" id="edit-type" value="" placeholder="${esc(r.type)}" aria-label="搜尋類型" aria-controls="type-pop" aria-autocomplete="list" autocomplete="off">`
      : `<button type="button" class="cell" data-act="type" title="改類型（T）">${esc(r.type)}</button>`;
    const descCell = ed === "desc"
      ? `<input class="edit" id="edit-desc" value="${esc(r.desc)}" aria-label="摘要" autocomplete="off">`
      : `<button type="button" class="cell" data-act="desc" title="改摘要（E）">${esc(r.desc)}</button>`;
    const amt = Math.round(r.amount);
    let h = `<tr class="${cls}" data-id="${r.id}" aria-selected="${cur}">
      <td class="c-x"><button type="button" class="xbtn" data-act="expand" aria-expanded="${open}" aria-label="展開">▶</button></td>
      <td class="c-date">${ymd(r.date)}</td>
      <td class="c-type${r.guess && !r.confirmed ? " guess" : ""}">${typeCell}</td>
      <td class="c-desc${r.ocr && !r.confirmed ? " ocr" : ""}">${descCell}</td>
      <td class="c-card">${esc(r.card)}</td>
      <td class="c-inst">${esc(r.inst || "")}</td>
      <td class="c-amt${amt < 0 ? " neg" : ""}">${money(amt)}</td>
      <td class="c-sheet">${esc(r.sheet)}</td>
      <td class="c-src" title="${esc(r.file)}">${esc(f && f.bank ? f.bank.name : r.file)}</td>
      <td class="c-ok"><button type="button" class="okbtn${r.confirmed ? " on" : ""}" data-act="confirm">${r.confirmed ? "已確認" : "確認"}</button></td></tr>`;
    if (open) {
      const same = S.rows.filter((x) => U.norm(x.desc) === U.norm(r.desc)).length;
      h += `<tr class="detail" data-for="${r.id}"><td colspan="10"><div class="det">
        <div class="det-crop">${r.crop ? `<img src="${esc(r.crop)}" alt="帳單上的摘要原圖">` : `<p class="none">${r.ocr ? "沒有原圖（辨識失敗）" : "這筆摘要直接取自 PDF 文字，沒有 OCR。"}</p>`}</div>
        <dl>
          ${r.ocr ? `<dt>辨識原文</dt><dd>${esc(r.ocrText || "—")}</dd><dt>清理後</dt><dd>${esc(r.ocrClean || "—")}</dd>` : ""}
          <dt>帳單原文</dt><dd>${esc(r.descRaw || r.desc)}</dd>
          <dt>目前摘要</dt><dd>${esc(r.desc)}</dd>
          <dt>消費日 / 檔案</dt><dd>${ymd(r.date)} · ${esc(r.file)}</dd>
          ${bad ? `<dt>核對</dt>${checkNote(f)}` : ""}
        </dl>
        <div class="det-act">
          <button type="button" class="btn sm" data-act="apply">套用到同摘要（${same} 筆）</button>
          <button type="button" class="btn sm ghost" data-act="exclude">${r.excluded ? "恢復這筆" : "這筆不要匯出"}</button>
        </div></div></td></tr>`;
    }
    return h;
  }

  function checkNote(f) {
    const warn = warnOf(f), out = [];
    if (f && f.status === "bad") out.push(`<dd>不符：這份帳單的合計不符，請對照紙本</dd>`);
    if (warn) out.push(`<dd>需核對：${esc(warn)}</dd>`);
    if (!out.length) out.push(`<dd>${f ? esc((STATUS[f.status] || ["需核對"])[0]) : "需核對"}：請對照紙本</dd>`);
    return out.join("");
  }

  function renderReview() {
    if (S.edit) { S.dirtyTable = true; return; }
    S.dirtyTable = false;
    const has = S.rows.length > 0, v = visibleRows();
    const fixed = S.rows.filter((r) => !r.excluded && r.sheet === "固定").length;
    const flo = S.rows.filter((r) => !r.excluded && r.sheet === "浮動").length;
    const inc = S.rows.filter((r) => !r.excluded && r.sheet === CC.exporter.INCOME_SHEET).length;
    const bank = S.rows.filter((r) => !r.excluded && r.sheet === CC.exporter.BANK_SHEET).length;
    $("#count-total").textContent = fixed + flo + inc + bank; $("#count-fixed").textContent = fixed; $("#count-float").textContent = flo;
    $("#count-income").textContent = inc; $("#count-income-wrap").hidden = !inc;
    $("#count-bank").textContent = bank; $("#count-bank-wrap").hidden = !bank;
    $("#review-empty").hidden = has || S.files.some((f) => f.status === "ok" || f.status === "bad");
    $("#review-bar").hidden = !has;
    const doneEmpty = has && S.filter === "pending" && v.length === 0;
    $("#review-done").hidden = !doneEmpty || S.busy;
    $("#review-wrap").hidden = !has || v.length === 0;
    if (!v.some((r) => r.id === S.cursor)) S.cursor = v.length ? v[0].id : null;
    renderFilter(); renderFlash();
    $("#review-body").innerHTML = v.map(rowHtml).join("");
    renderExport(); renderSteps();
  }

  function renderFlash() {
    let el = $("#review-flash");
    if (!el) {
      el = doc.createElement("p"); el.id = "review-flash"; el.className = "hint"; el.setAttribute("role", "status");
      el.style.flexBasis = "100%"; el.style.margin = "0";
      $("#review-bar").appendChild(el);
    }
    el.hidden = !S.flash; el.textContent = S.flash || "";
  }
  /** Any new review action dismisses the previous 「套用」 confirmation. */
  function clearFlash() { if (S.flash) { S.flash = null; renderFlash(); } }

  function focusTable() {
    if (S.edit) return;
    const w = $("#review-wrap"); if (w.hidden) return;
    w.focus({ preventScroll: true });
    const tr = w.querySelector("tr.row.cur");
    tr && tr.scrollIntoView({ block: "nearest" });
  }

  /* ---- inline editors ---- */
  function startEdit(id, field) {
    if (!S.rows.some((r) => r.id === id)) return;
    S.cursor = id; S.edit = null; renderReview();
    S.edit = { id, field };
    const tr = $(`tr.row[data-id="${CSS.escape(id)}"]`); if (!tr) { S.edit = null; return; }
    const r = S.rows.find((x) => x.id === id);
    tr.outerHTML = rowHtml(r);
    const inp = $(field === "type" ? "#edit-type" : "#edit-desc");
    inp.focus(); if (field === "desc") inp.select();
    if (field === "type") openPop(inp, r);
  }
  function endEdit(refocus = true) {
    S.edit = null; closePop(); renderReview(); if (refocus) focusTable();
  }

  let pop = { items: [], active: 0, input: null };
  function openPop(inp, r) {
    pop = { items: [], active: 0, input: inp, row: r };
    const filterPop = () => {
      const q = U.norm(inp.value);
      pop.items = typesFor(r).filter(([t]) => !q || U.norm(t).includes(q));
      const cur = pop.items.findIndex(([t]) => t === r.type);
      pop.active = q ? 0 : Math.max(0, cur);
      drawPop();
    };
    inp.addEventListener("input", filterPop);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); const n = pop.items.length; if (!n) return;
        pop.active = (pop.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n; drawPop();
      } else if (e.key === "Enter") {
        e.preventDefault(); const it = pop.items[pop.active];
        if (it) { setType(r.id, it[0]); endEdit(); }
      } else if (e.key === "Escape") { e.preventDefault(); endEdit(); }
      else if (e.key === "Tab") { endEdit(false); }
    });
    inp.addEventListener("blur", () => setTimeout(() => { if (S.edit && S.edit.field === "type" && doc.activeElement !== inp) endEdit(false); }, 120));
    filterPop();
    g.addEventListener("resize", placePop); $("#review-wrap").addEventListener("scroll", placePop, { passive: true });
  }
  function drawPop() {
    const el = $("#type-pop");
    el.innerHTML = pop.items.length ? pop.items.map(([t, sh], i) =>
      `<div class="opt" role="option" id="opt-${i}" data-type="${esc(t)}" aria-selected="${i === pop.active}"><span>${esc(t)}</span><small>${sh}</small></div>`).join("")
      : `<p class="nores">沒有這個類型</p>`;
    pop.input && pop.input.setAttribute("aria-activedescendant", pop.items.length ? "opt-" + pop.active : "");
    el.hidden = false; placePop();
    const a = el.querySelector('[aria-selected="true"]'); a && a.scrollIntoView({ block: "nearest" });
  }
  function placePop() {
    const el = $("#type-pop"); if (el.hidden || !pop.input || !pop.input.isConnected) return;
    const b = pop.input.getBoundingClientRect(), vh = g.innerHeight, vw = g.innerWidth;
    const w = Math.min(Math.max(b.width, 240), vw - 16);
    el.style.width = w + "px"; el.style.left = Math.max(8, Math.min(b.left, vw - w - 8)) + "px";
    const below = vh - b.bottom;
    if (below < 220 && b.top > below) { el.style.top = ""; el.style.bottom = (vh - b.top + 2) + "px"; el.style.maxHeight = Math.min(300, b.top - 12) + "px"; }
    else { el.style.bottom = ""; el.style.top = (b.bottom + 2) + "px"; el.style.maxHeight = Math.min(300, below - 12) + "px"; }
  }
  function closePop() {
    $("#type-pop").hidden = true; pop.input = null;
    g.removeEventListener("resize", placePop); $("#review-wrap").removeEventListener("scroll", placePop);
  }

  /* ------------------------------ render: step 3 ------------------------------ */
  /** Export-gate problems: [{key, text}]. File problems are keyed by the file entry's id (unique per drop). */
  function problems() {
    const out = [];
    for (const f of S.files) {
      if (!DONE.has(f.status)) continue;
      const warn = warnOf(f);
      if (warn && !FAILED.has(f.status)) out.push({ key: f.id + "|warn", text: `${f.name}：需核對，${warn}` });
      if (f.status === "ok") continue;
      const lbl = STATUS[f.status][0];
      if (f.status === "bad") out.push({ key: f.id + "|bad", text: `${f.name}：${lbl}（合計 ${money(f.rec.total)}，應為 ${money(f.rec.expect)}）` });
      else out.push({ key: f.id + "|" + f.status, text: `${f.name}：${lbl}${f.error ? "，" + f.error : ""}，沒有匯出這份` });
    }
    const man = manualCount();
    if (man) out.push({ key: "manual", text: `${man} 筆摘要是「${MANUAL}」` });
    return out;
  }
  const manualCount = () => S.rows.filter((r) => !r.excluded && r.desc === MANUAL).length;
  function ackNow() { S.ack = true; S.ackSig = { keys: new Set(problems().map((p) => p.key)), man: manualCount() }; }
  function renderExport() {
    const rows = S.rows.filter((r) => !r.excluded), probs = problems(), running = S.busy || S.files.some((f) => !DONE.has(f.status));
    // a problem the ack did not cover (new file failed, more manual rows, etc.): ask again.
    // Fewer manual rows keep the ack (and lower the acknowledged count, so a later increase asks again).
    if (S.ack) {
      const sig = S.ackSig, man = manualCount();
      if (!sig || man > sig.man || !probs.every((p) => p.key === "manual" || sig.keys.has(p.key))) { S.ack = false; S.ackSig = null; }
      else sig.man = man;
    }
    const gated = probs.length > 0 && !S.ack;
    $("#gate").hidden = !probs.length;
    $("#gate-list").innerHTML = probs.map((p) => `<li>${esc(p.text)}</li>`).join("");
    $("#gate-ack").checked = S.ack;
    const fixed = rows.filter((r) => r.sheet === "固定").length, flo = rows.filter((r) => r.sheet === "浮動").length;
    const inc = rows.filter((r) => r.sheet === CC.exporter.INCOME_SHEET).length;
    const bank = rows.filter((r) => r.sheet === CC.exporter.BANK_SHEET).length;
    const dis = !rows.length || gated || running;
    const pay = CC.exporter.payRows(checks()).length;
    $("#btn-xlsx").disabled = dis; $("#btn-fixed").disabled = dis || !fixed; $("#btn-float").disabled = dis || !flo;
    $("#btn-pay").disabled = dis || !pay; $("#btn-income").disabled = dis || !inc; $("#btn-income").hidden = !inc;
    $("#btn-bank").disabled = dis || !bank; $("#btn-bank").hidden = !bank;
    $("#btn-xlsx").hidden = S.dl === null;
    $("#btn-fixed").textContent = `複製固定（${fixed}）`; $("#btn-float").textContent = `複製浮動（${flo}）`;
    $("#btn-pay").textContent = `複製繳費（${pay}）`; $("#btn-income").textContent = `複製收入（${inc}）`;
    $("#btn-bank").textContent = `複製轉帳（${bank}）`;
    const extra = (inc ? [CC.exporter.INCOME_SHEET] : []).concat(bank ? [CC.exporter.BANK_SHEET] : []);
    const pend = S.rows.filter(isPending).length;
    $("#export-summary").textContent = !rows.length ? "等明細出來" : running ? "還在處理帳單…" :
      pend ? `還有 ${pend} 筆待確認，也可以先匯出` : "可以匯出了";
    $("#export-hint").textContent = S.dl === null
      ? "這個環境不能存檔，請用「複製固定」「複製浮動」「複製繳費」" + (inc ? "「複製收入」" : "") + (bank ? "「複製轉帳」" : "") + "，貼到活頁簿對應的工作表。複製的內容含標題列。"
      : "Excel 檔含「固定」「浮動」「核對結果」「繳費」" + extra.map((x) => `「${x}」`).join("") + "四五六"[extra.length] + "張工作表。複製的內容含標題列，可直接貼到活頁簿。";
  }
  function exportRows(sheet) {
    return S.rows.filter((r) => !r.excluded && (!sheet || r.sheet === sheet))
      .map((r) => Object.assign({}, r, r.confirmed ? { guess: false, ocr: false } : {}))
      .sort((a, b) => (a.card < b.card ? -1 : a.card > b.card ? 1 : 0) || String(a.date || "").localeCompare(String(b.date || "")));
  }
  function checks() {
    return S.files.map((f) => ({
      file: f.name, bank: f.bank ? f.bank.name : "", closing: f.st ? f.st.closing : null,
      prev: f.st ? f.st.prev : null, cur: f.st ? f.st.cur : null, due: f.st ? f.st.due : null,
      card: f.kind === "payslip" ? ((S.rows.find((r) => r.fid === f.id) || {}).card || "") // account as rebuilt from settings
        : f.bank ? ((S.settings.cards || {})[f.bank.id] || {}).name || f.bank.card : "",
      total: f.rec ? f.rec.total : null, expect: f.rec ? f.rec.expect : null,
      ok: fileOk(f), count: f.count || 0, // a statement warn (st.warn) is not "OK" in 核對結果
      kind: f.kind, // a payslip's 實發 is not a bill: kept out of 繳費
      error: f.status === "ok" ? (warnOf(f) ? "需核對：" + warnOf(f) : undefined)
        : f.status === "bad" ? (warnOf(f) ? "不符，請檢查；需核對：" + warnOf(f) : undefined)
        : (STATUS[f.status][0] + (f.error ? "：" + f.error : "")),
    }));
  }
  function msg(sel, text, kind) { const el = $(sel); el.hidden = !text; el.textContent = text || ""; el.className = "note" + (kind ? " " + kind : ""); }
  const saveErr = (e) => ({ declined: "已取消儲存。", unavailable: "這裡不能存檔，請改用複製。", rate_limited: "存檔太頻繁，請稍等再試。" })[e && e.code] || ("存檔失敗：" + errMsg(e));

  async function doXlsx() {
    const btn = $("#btn-xlsx"); btn.disabled = true; msg("#export-msg", "產生 Excel 中…");
    try {
      const buf = await CC.exporter.toXlsx(exportRows(), checks());
      const close = S.files.map((f) => f.st && f.st.closing).filter(Boolean).sort().pop() || new Date().toISOString().slice(0, 10);
      const name = `信用卡明細_${close.slice(0, 4)}${close.slice(5, 7)}.xlsx`;
      await CC.exporter.save(name, buf);
      S.exported = true; msg("#export-msg", `已存成 ${name}`, "ok");
    } catch (e) { msg("#export-msg", saveErr(e), "bad"); }
    renderExport(); renderSteps();
  }
  function doCopy(sheet) {
    const X = CC.exporter, pay = sheet === "繳費", box = $("#tsv-box"), ta = $("#tsv-text");
    const rows = pay ? X.payRows(checks()) : exportRows(sheet);
    const tsv = pay ? X.payTSV(checks()) : sheet === X.INCOME_SHEET ? X.incomeTSV(rows) : sheet === X.BANK_SHEET ? X.bankTSV(rows) : X.toTSV(rows);
    const fallback = () => {
      box.hidden = false; ta.value = tsv; ta.focus(); ta.select();
      msg("#export-msg", `瀏覽器不讓程式寫入剪貼簿，${sheet} ${rows.length} 筆已選取在下面，請自行複製。`, "bad");
    };
    try {
      const p = g.navigator.clipboard && g.navigator.clipboard.writeText(tsv);
      if (!p) return fallback();
      p.then(() => { box.hidden = true; S.exported = true; msg("#export-msg", `已複製${sheet} ${rows.length} 筆（含標題列），貼到活頁簿「${sheet}」工作表。`, "ok"); renderSteps(); }, fallback);
    } catch (e) { fallback(); }
  }

  function renderSteps() {
    const ran = S.files.length > 0 && S.files.every((f) => DONE.has(f.status)) && !S.busy;
    const reviewed = ran && S.rows.length > 0 && !S.rows.some(isPending);
    const st = [ran, reviewed, S.exported];
    const cur = !ran ? 1 : !reviewed && !S.exported ? 2 : 3;
    doc.querySelectorAll("#steps li").forEach((li, i) => {
      li.classList.toggle("done", st[i]); li.classList.toggle("current", cur === i + 1);
      li.querySelector("button").setAttribute("aria-current", cur === i + 1 ? "step" : "false");
    });
  }

  /* ------------------------------ settings drawer ------------------------------ */
  function renderSettings() {
    const s = S.settings;
    doc.querySelectorAll('input[name="dateMode"]').forEach((i) => (i.checked = i.value === s.dateMode));
    const types = allTypes();
    $("#card-body").innerHTML = (CC.banks.list || []).map((b) => {
      const c = (s.cards && s.cards[b.id]) || { name: b.card, defaultType: "日用其他" };
      return `<tr><td>${esc(b.name)}</td>
        <td><input id="card-name-${b.id}" data-card="${b.id}" data-k="name" value="${esc(c.name)}" aria-label="${esc(b.name)} 卡片名稱"></td>
        <td><select id="card-type-${b.id}" data-card="${b.id}" data-k="defaultType" aria-label="${esc(b.name)} 預設類型">${types.map(([t]) => `<option${t === c.defaultType ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></td></tr>`;
    }).join("");
    $("#slip-account").value = (s.payslip && s.payslip.account) || "";
    const L = Object.values(s.learned || {}), conf = L.filter((x) => x && x.conflict).length;
    $("#learned-count").textContent = L.length
      ? `已學會 ${L.length} 種摘要的分類` + (conf ? `，其中 ${conf} 種在舊紀錄有兩種分法（會標黃）` : "") + "。"
      : "還沒有學到分類。匯入活頁簿，或在確認時按「套用到同摘要」。";
    $("#set-export").hidden = S.dl === null;
  }
  function renderBanks() {
    const names = (CC.banks.list || []).map((b) => b.name);
    $("#drop-banks").textContent = names.length ? "支援：" + names.join("、") : "";
  }

  function renderAll() { renderFiles(); renderOcrMsg(); renderReview(); renderExport(); renderSteps(); }

  /* ------------------------------ events ------------------------------ */
  function bind() {
    const drop = $("#drop"), fin = $("#file-input");
    fin.addEventListener("change", () => { addFiles([...fin.files]); fin.value = ""; });
    ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
    drop.addEventListener("drop", (e) => { e.preventDefault(); addFiles([...(e.dataTransfer && e.dataTransfer.files || [])]); });
    doc.addEventListener("dragover", (e) => e.preventDefault());
    doc.addEventListener("drop", (e) => { e.preventDefault(); if (!drop.contains(e.target)) addFiles([...(e.dataTransfer && e.dataTransfer.files || [])]); });

    const pin = $("#pw-input");
    const addPw = () => {
      const v = pin.value.trim(); if (!v) return;
      for (const p of v.split(/[,\s]+/)) if (p && !S.passwords.includes(p)) S.passwords.push(p);
      pin.value = ""; renderPw();
      S.files.filter((f) => f.status === "pw").forEach((f) => (f.status = "queued"));
      renderAll(); pump();
    };
    pin.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addPw(); }
      else if (e.key === "Backspace" && !pin.value && S.passwords.length) { S.passwords.pop(); renderPw(); }
    });
    pin.addEventListener("blur", addPw);
    $("#pw-box").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pw]");
      if (b) { S.passwords.splice(+b.dataset.pw, 1); renderPw(); pin.focus(); } else if (e.target === e.currentTarget) pin.focus();
    });

    $("#file-list").addEventListener("click", (e) => {
      const rm = e.target.closest("[data-remove]");
      if (rm) {
        S.files = S.files.filter((x) => x.id !== rm.dataset.remove); S.rows = S.rows.filter((r) => r.fid !== rm.dataset.remove);
        S.openFiles.delete(rm.dataset.remove); renderAll(); return;
      }
      const rb = e.target.closest("[data-retry]");
      if (rb) { const f = S.files.find((x) => x.id === rb.dataset.retry); const i = doc.getElementById("pw-" + f.id); retry(f, i && i.value.trim()); return; }
      const fb = e.target.closest("[data-file]");
      if (fb) { const id = fb.dataset.file; S.openFiles.has(id) ? S.openFiles.delete(id) : S.openFiles.add(id); renderFiles(); doc.querySelector(`[data-file="${id}"]`).focus(); }
    });
    $("#file-list").addEventListener("keydown", (e) => {
      const i = e.target.closest("[data-retry-pw]");
      if (i && e.key === "Enter") { e.preventDefault(); retry(S.files.find((x) => x.id === i.dataset.retryPw), i.value.trim()); }
    });

    $("#filter").addEventListener("click", (e) => {
      const b = e.target.closest("[data-filter]"); if (!b) return;
      S.flash = null;
      S.filter = b.dataset.filter; S.cursor = null; renderReview();
    });

    const body = $("#review-body");
    body.addEventListener("click", (e) => {
      const tr = e.target.closest("tr.row, tr.detail"); if (!tr) return;
      const id = tr.dataset.id || tr.dataset.for, act = e.target.closest("[data-act]");
      if (S.edit) return;
      const a = act && act.dataset.act;
      clearFlash();
      if (a === "type" || a === "desc") return startEdit(id, a);
      if (a === "confirm") { S.cursor = id; return confirmRow(id); }
      if (a === "expand") { S.cursor = id; S.open.has(id) ? S.open.delete(id) : S.open.add(id); renderReview(); return focusTable(); }
      if (a === "apply") return applySame(id);
      if (a === "exclude") { const r = S.rows.find((x) => x.id === id); r.excluded = !r.excluded; renderReview(); return focusTable(); }
      if (tr.classList.contains("row") && S.cursor !== id) { S.cursor = id; renderReview(); focusTable(); }
    });
    body.addEventListener("keydown", (e) => {
      if (e.target.id !== "edit-desc") return;
      if (e.key === "Enter") { e.preventDefault(); setDesc(S.edit.id, e.target.value); endEdit(); }
      else if (e.key === "Escape") { e.preventDefault(); endEdit(); }
    });
    body.addEventListener("focusout", (e) => {
      if (e.target.id === "edit-desc" && S.edit) { const id = S.edit.id, v = e.target.value; setTimeout(() => { if (S.edit && S.edit.id === id && S.edit.field === "desc") { setDesc(id, v); endEdit(false); } }, 0); }
    });
    $("#type-pop").addEventListener("mousedown", (e) => {
      e.preventDefault();
      const o = e.target.closest("[data-type]"); if (!o || !S.edit) return;
      setType(S.edit.id, o.dataset.type); endEdit();
    });

    $("#review-wrap").addEventListener("keydown", (e) => {
      if (S.edit || e.target.closest("input,textarea,select")) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const v = visibleRows(); if (!v.length) return;
      const i = Math.max(0, v.findIndex((r) => r.id === S.cursor)), k = e.key;
      if (k !== "Shift" && k !== "Tab") clearFlash();
      if (k === "ArrowDown" || k === "ArrowUp") {
        e.preventDefault();
        const next = v[Math.min(v.length - 1, Math.max(0, i + (k === "ArrowDown" ? 1 : -1)))].id;
        if (next === S.cursor) return;
        const body = $("#review-body"), old = body.querySelector("tr.row.cur"), tr = body.querySelector(`tr.row[data-id="${CSS.escape(next)}"]`);
        S.cursor = next;
        if (!tr) { renderReview(); return focusTable(); }
        if (old) { old.classList.remove("cur"); old.setAttribute("aria-selected", "false"); }
        tr.classList.add("cur"); tr.setAttribute("aria-selected", "true");
        tr.scrollIntoView({ block: "nearest" });
      } else if (k === "Enter") {
        if (e.target.closest("button")) return; // let buttons act
        e.preventDefault(); const r = v[i]; if (!r.confirmed) confirmRow(r.id); else { S.cursor = nextPendingAfter(r.id) || r.id; renderReview(); focusTable(); }
      } else if (k === "t" || k === "T") { e.preventDefault(); startEdit(v[i].id, "type"); }
      else if (k === "e" || k === "E") { e.preventDefault(); startEdit(v[i].id, "desc"); }
      else if (k === " ") {
        if (e.target.closest("button")) return;
        e.preventDefault(); const id = v[i].id; S.open.has(id) ? S.open.delete(id) : S.open.add(id); renderReview(); focusTable();
      }
    });

    $("#gate-ack").addEventListener("change", (e) => { if (e.target.checked) ackNow(); else { S.ack = false; S.ackSig = null; } renderExport(); });
    $("#btn-xlsx").addEventListener("click", doXlsx);
    $("#btn-fixed").addEventListener("click", () => doCopy("固定"));
    $("#btn-float").addEventListener("click", () => doCopy("浮動"));
    $("#btn-pay").addEventListener("click", () => doCopy("繳費"));
    $("#btn-income").addEventListener("click", () => doCopy(CC.exporter.INCOME_SHEET));
    $("#btn-bank").addEventListener("click", () => doCopy(CC.exporter.BANK_SHEET));
    $("#slip-add").addEventListener("click", () => {
      const ta = $("#slip-text");
      if (addSlipText(ta.value)) ta.value = ""; // the pasted payslip is not left on screen
    });
    $("#slip-account").addEventListener("change", (e) => {
      S.settings.payslip = Object.assign({ companies: [] }, S.settings.payslip, { account: e.target.value.trim() });
      saveSettings(); rebuildAll();
    });

    doc.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => {
      const sec = doc.getElementById(b.dataset.goto);
      const reduce = g.matchMedia && g.matchMedia("(prefers-reduced-motion: reduce)").matches;
      sec.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    }));

    // settings drawer
    const dlg = $("#settings");
    $("#btn-settings").addEventListener("click", () => { renderSettings(); dlg.showModal ? dlg.showModal() : dlg.setAttribute("open", ""); });
    $("#set-close").addEventListener("click", () => dlg.close ? dlg.close() : dlg.removeAttribute("open"));
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    $("#set-date").addEventListener("change", (e) => {
      if (e.target.name !== "dateMode") return;
      S.settings.dateMode = e.target.value; saveSettings(); rebuildAll();
    });
    $("#card-body").addEventListener("change", (e) => {
      const el = e.target.closest("[data-card]"); if (!el) return;
      const id = el.dataset.card, b = (CC.banks.list || []).find((x) => x.id === id);
      S.settings.cards = S.settings.cards || {};
      const c = (S.settings.cards[id] = Object.assign({ name: b ? b.card : id, defaultType: "日用其他" }, S.settings.cards[id]));
      c[el.dataset.k] = el.value.trim() || c[el.dataset.k];
      saveSettings(); rebuildAll();
    });
    $("#set-workbook").addEventListener("change", async (e) => {
      const file = e.target.files[0]; if (!file) return;
      msg("#set-wb-msg", "讀取 " + file.name + "…");
      try {
        const res = await CC.settings.importWorkbook(await file.arrayBuffer());
        if (CC.settings.applyWorkbook) S.settings = CC.settings.applyWorkbook(S.settings, res) || S.settings;
        else if (res && res.learned) S.settings.learned = Object.assign({}, S.settings.learned, res.learned);
        saveSettings();
        msg("#set-wb-msg", `已從「${file.name}」學到 ${res ? res.count : 0} 種摘要` + (res && res.conflicts ? `（${res.conflicts} 種有兩種分法）` : "") + "。", "ok");
        rebuildAll();
      } catch (err) { msg("#set-wb-msg", "讀不了這個活頁簿：" + errMsg(err), "bad"); }
      e.target.value = ""; renderSettings();
    });
    $("#set-export").addEventListener("click", async () => {
      try {
        const buf = new TextEncoder().encode(CC.settings.exportJSON(S.settings)).buffer;
        await CC.exporter.save("cc-settings.json", buf, "application/json");
        msg("#set-msg", "已存成 cc-settings.json", "ok");
      } catch (e) { msg("#set-msg", saveErr(e), "bad"); }
    });
    $("#set-import").addEventListener("change", async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        S.settings = CC.settings.importJSON(await file.text(), S.settings); saveSettings();
        msg("#set-msg", "已匯入設定。", "ok"); renderSettings(); rebuildAll();
      } catch (err) { msg("#set-msg", errMsg(err), "bad"); }
      e.target.value = "";
    });
  }

  /* ------------------------------ boot ------------------------------ */
  function boot() {
    bind(); renderBanks(); renderPw(); renderAll(); renderSettings();
    // inside a claude.ai Artifact saving goes through the downloads capability; on an ordinary web host
    // (e.g. GitHub Pages) there is no window.claude and the browser's own download is used instead
    Promise.resolve().then(() => g.claude && g.claude.use ? g.claude.use("downloads") : "browser")
      .then((d) => d || null, () => null)
      .then((d) => { S.dl = d; renderExport(); renderSettings(); });
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", boot); else boot();
})(typeof globalThis !== "undefined" ? globalThis : this);
