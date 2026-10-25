/* banks.js — per-bank statement parsers (owner: agent A)
 * Port of parse_* / BANKS / detect in convert_reference.py, re-derived for the pdf.js text layer
 * (CC.pdf.read / CC.pdf.lines). Classic script; attaches CC.banks. Needs core.js loaded first.
 *
 * CC.banks.list   [{id, name, card, keys, ocr, parse(read) -> Statement0}]
 * CC.banks.detect(read) -> bank | null
 * Statement0 = {closing, prev, cur, rows:[{date, post, desc, amount, last4, ocr}], warn?, due?}
 * due (繳款截止日) is informational: absent when not found, never fails a parse. Banks print 無需繳款
 * instead of a date when nothing is owed; callers derive that from cur (CC.exporter.dueOf).
 */
(function (g) {
  "use strict";
  const CC = (g.CC = g.CC || {});
  const U = CC.util, P = CC.pdf;

  /* ------------------------------ helpers ------------------------------ */
  const nows = (s) => U.nfkc(s).replace(/\s+/g, ""); // label matching: pdf.js often spaces out CJK labels
  const pageLines = (pg, opts) => P.lines(pg.items, opts);
  const segsIn = P.segsIn;
  const firstRoc = (segs) => { for (const s of segs) { const d = U.roc(s.t); if (d) return d; } return null; };
  const firstMd = (segs) => { for (const s of segs) if (U.MD_RE.test(s.t)) return s.t; return null; };
  const joinT = (segs) => segs.map((s) => s.t).join(" ");

  /** Python row(): date falls back to post date; desc trimmed. */
  const row = (date, post, desc, amount, last4 = "", ocr = null) =>
    ({ date: date || post || null, post: post || null, desc: String(desc || "").trim(), amount, last4: last4 || "", ocr });

  // 繳款截止日 must fall DUE_MIN..DUE_MAX days after closing (seen: 14-18). Several banks are found by
  // position only, so anything outside the window is dropped rather than shown.
  const DUE_MIN = 7, DUE_MAX = 35;
  const dueOk = (closing, due) => {
    const days = (Date.parse(due) - Date.parse(closing)) / 864e5;
    return days >= DUE_MIN && days <= DUE_MAX;
  };

  const finish = (r) => {
    if (r.prev == null || r.cur == null || !Number.isFinite(r.prev) || !Number.isFinite(r.cur))
      throw new Error("找不到上期／本期總額（可能改版）");
    if (!r.closing) throw new Error("找不到結帳日（可能改版）");
    const st = { closing: r.closing, prev: r.prev, cur: r.cur, rows: r.rows };
    if (r.warn) st.warn = r.warn;
    if (r.due && dueOk(r.closing, r.due)) st.due = r.due;
    return st;
  };

  /* ------------------------------ 台北富邦 ------------------------------ */
  function parseFubon(read) {
    const r = { rows: [] };
    let last4 = "";
    // the value sits under its label; the next line holds the values of every label (帳單年月, 繳款截止日 ...)
    const under = (L, next, label) => {
      const lab = L.segs.find((s) => nows(s.t).includes(label));
      if (!lab) return null;
      const near = next.segs.slice().sort((a, b) => Math.abs(a.x0 - lab.x0) - Math.abs(b.x0 - lab.x0))[0];
      return near ? U.roc(near.t) : null; // 無需繳款 -> null
    };
    for (const pg of read.pages) {
      const lines = pageLines(pg);
      lines.forEach((L, i) => {
        const tc = nows(L.text);
        // first match only: later pages repeat 帳單結帳日 in notes (sometimes next to other dates)
        if (!r.closing && tc.includes("帳單結帳日") && lines[i + 1]) {
          const lab = L.segs.find((s) => nows(s.t).includes("帳單結帳日"));
          const ds = lines[i + 1].segs.filter((s) => U.roc(s.t));
          if (ds.length) {
            const lx = lab ? lab.x0 : ds[0].x0;
            ds.sort((a, b) => Math.abs(a.x0 - lx) - Math.abs(b.x0 - lx));
            r.closing = U.roc(ds[0].t);
          }
          r.due = under(L, lines[i + 1], "繳款截止日");
        }
        if (r.prev == null && tc.includes("繳(退)金額") && lines[i + 1]) {
          const nums = lines[i + 1].segs.filter((s) => U.isNum(s.t)).map((s) => U.toNum(s.t));
          if (nums.length >= 5) { r.prev = nums[0]; r.cur = nums[4]; }
        }
        const m = /末.碼\s*([0-9０-９]{4})/.exec(L.text);
        if (m) last4 = U.nfkc(m[1]);
        const segs = L.segs;
        if (!segs.length || !U.roc(segs[0].t) || segs[0].x0 > 60) return;
        const amt = segs[segs.length - 1];
        if (!U.isNum(amt.t) || amt.x0 < 480) return;
        const desc = joinT(segsIn(L, 70, 285));
        const post = firstRoc(segsIn(L, 285, 340));
        r.rows.push(row(U.roc(segs[0].t), post, desc, U.toNum(amt.t), last4));
      });
    }
    return finish(r);
  }

  /* ------------------------------ 中國信託 (OCR) ------------------------------ */
  function parseCtbc(read) {
    const r = { rows: [] };
    // 繳款截止日：第 1 頁 x 180–300 的完整日期（標籤是讀不到的中文字型）
    for (const L of pageLines(read.pages[0])) {
      const d = firstRoc(segsIn(L, 180, 300));
      if (d) { r.due = d; break; }
    }
    for (const pg of read.pages) {
      for (const L of pageLines(pg)) {
        const segs = L.segs;
        const nums = segs.filter((s) => U.isNum(s.t));
        if (segs.length && U.roc(segs[0].t) && nums.length >= 5 && r.prev == null) {
          const v = nums.map((s) => U.toNum(s.t));
          r.closing = U.roc(segs[0].t); r.prev = v[0]; r.cur = v[v.length - 1];
          continue;
        }
        const d1 = firstRoc(segsIn(L, 0, 45));
        const d2 = firstRoc(segsIn(L, 45, 110));
        const amt = segsIn(L, 230, 310).filter((s) => U.isNum(s.t));
        if ((d1 || d2) && amt.length) {
          const card = segsIn(L, 310, 360).filter((s) => /^\d{4}$/.test(s.t));
          r.rows.push(row(d1, d2, "", U.toNum(amt[amt.length - 1].t), card.length ? card[0].t : "",
            { page: pg.num, y: L.y, x0: 100, x1: 230 }));
        }
      }
    }
    return finish(r);
  }

  /* ------------------------------ 兆豐 ------------------------------ */
  function parseMega(read) {
    const r = { rows: [] };
    let last4 = "";
    const ROW = /^(\d{3}\/\d{2}\/\d{2})\s*(\d{3}\/\d{2}\/\d{2})?\s*(.*)$/;
    for (const pg of read.pages) {
      const lines = pageLines(pg);
      lines.forEach((L, i) => {
        const tc = nows(L.text);
        if (tc.includes("結帳日期") && lines[i + 1] && !r.closing) {
          const d = firstRoc(lines[i + 1].segs);
          if (d) r.closing = d;
        }
        if (tc.includes("上期待繳總額") && tc.includes("已繳金額") && lines[i + 1]) {
          const nums = lines[i + 1].segs.filter((s) => U.isNum(s.t)).map((s) => U.toNum(s.t));
          if (nums.length >= 5) { r.prev = nums[0]; r.cur = nums[4]; }
          // the same header ends with 繳款截止日; its value is the last cell below
          const ns = lines[i + 1].segs;
          if (tc.includes("繳款截止日") && ns.length) r.due = U.roc(ns[ns.length - 1].t);
        }
        let m = /\d{4}-\w{4}-\w{4}-(\d{4})/.exec(L.text);
        if (m) last4 = m[1];
        const segs = L.segs;
        m = segs.length ? ROW.exec(segs[0].t) : null;
        if (!m || segs[0].x0 > 160) return;
        const amt = segs[segs.length - 1].t;
        if (!U.isNum(amt)) return;
        const d1 = U.roc(m[1]), d2 = m[2] ? U.roc(m[2]) : null;
        const desc = [m[3], ...segs.slice(1).filter((s) => s.x0 < 295).map((s) => s.t)].join(" ").trim();
        r.rows.push(row(d1, d2 || d1, desc, U.toNum(amt), last4));
      });
    }
    return finish(r);
  }

  /* ------------------------------ 台新 ------------------------------ */
  function parseTaishin(read) {
    const r = { rows: [] };
    let last4 = "";
    for (const pg of read.pages) {
      const rowlines = [], orphans = [];
      for (const L of pageLines(pg)) {
        const tc = nows(L.text), segs = L.segs;
        const lastT = segs.length ? segs[segs.length - 1].t : "";
        if (tc.startsWith("帳單結帳日")) r.closing = U.roc(lastT) || r.closing;
        if (tc.startsWith("繳款截止日")) r.due = U.roc(lastT) || r.due;
        if (tc.startsWith("上期應繳總額") && U.isNum(lastT)) r.prev = U.toNum(lastT);
        if (tc.startsWith("=本期累計應繳金額") && U.isNum(lastT)) r.cur = U.toNum(lastT);
        const m = /卡號末四碼[:：]\s*(\d{4})/.exec(U.nfkc(L.text));
        if (m) { last4 = m[1]; continue; }
        const d1 = firstRoc(segsIn(L, 60, 110));
        const d2 = firstRoc(segsIn(L, 110, 155));
        const amt = segsIn(L, 320, 368).filter((s) => U.isNum(s.t));
        if (d1 && amt.length)
          rowlines.push({ y: L.y, d1, d2, desc: joinT(segsIn(L, 155, 320)), a: U.toNum(amt[0].t), l4: last4 });
        else if (segs.length === 1 && segs[0].x0 >= 150 && segs[0].x0 < 170)
          orphans.push({ y: L.y, t: segs[0].t });
      }
      for (const o of orphans) { // 跨行的說明：併入最近的一筆
        let near = null;
        for (const rl of rowlines) if (!near || Math.abs(rl.y - o.y) < Math.abs(near.y - o.y)) near = rl;
        if (near && Math.abs(near.y - o.y) <= 7) near.desc = o.y < near.y ? o.t + near.desc : near.desc + o.t;
      }
      for (const rl of rowlines) r.rows.push(row(rl.d1, rl.d2, rl.desc, rl.a, rl.l4));
    }
    return finish(r);
  }

  /* ------------------------------ 第一銀行 ------------------------------ */
  function parseFirst(read) {
    const r = { rows: [] };
    const pending = [];
    for (const pg of read.pages) {
      for (const L of pageLines(pg)) {
        const segs = L.segs;
        if (segs.length >= 7 && segs[0].t === "新臺幣" && r.prev == null) {
          const nums = segs.filter((s) => U.isNum(s.t)).map((s) => U.toNum(s.t));
          if (nums.length >= 5) { r.prev = nums[0]; r.cur = nums[4]; }
          r.closing = U.roc(segs[segs.length - 1].t);
          continue;
        }
        const d1 = firstMd(segsIn(L, 30, 65));
        const d2 = firstMd(segsIn(L, 65, 100));
        const amt = segsIn(L, 330, 378).filter((s) => U.isNum(s.t));
        if ((d1 || d2) && amt.length) {
          const card = segsIn(L, 378, 405).filter((s) => /^\d{4}$/.test(s.t));
          pending.push([d1, d2, joinT(segsIn(L, 100, 330)), U.toNum(amt[0].t), card.length ? card[0].t : ""]);
        }
      }
    }
    for (const [d1, d2, desc, a, c] of pending)
      r.rows.push(row(d1 ? U.mdDate(d1, r.closing) : null, d2 ? U.mdDate(d2, r.closing) : null, desc, a, c));
    // 繳款截止日：第 1 頁右欄沒有標籤文字，結帳日下方 40pt 內的下一個日期
    if (r.closing) {
      const col = pageLines(read.pages[0]).map((L) => ({ y: L.y, d: firstRoc(segsIn(L, 500, 600)) })).filter((x) => x.d);
      const at = col.findIndex((x) => x.d === r.closing);
      if (at >= 0 && col[at + 1] && col[at + 1].y - col[at].y <= 40) r.due = col[at + 1].d;
    }
    return finish(r);
  }

  /* ------------------------------ 合作金庫 (OCR) ------------------------------
   * Text layer: CJK decodes as '?', only digits / punctuation are reliable. Python kept only chars
   * [0-9?/,.\-%] from pdfium (where CJK was real text, so effectively digits); here we keep items made
   * only of [0-9/,.\-%]. The font is byte-swapped and its '0' is invisible to pdf.js's text layer;
   * core.read restores every zero from the glyphs actually drawn (CC.pdf.zeroGlyphs), so dates and
   * amounts are taken straight from the text — no geometry-based guessing, nothing is ever rescaled.
   * Sanity check that can only flag: amounts are right-aligned, so after reconstruction every amount in
   * the column must end at the same x. If they disagree by more than TCB_TOL (a zero still missing, or
   * the layout changed) the statement carries `warn`; if the zero glyphs could not be read (core used
   * the narrow-blank fallback) it carries TCB_WARN0.
   */
  const TCB_TOL = 1;
  const TCB_WARN = "合庫金額位置不一致，請人工核對";
  const TCB_WARN0 = "合庫的 0 無法辨識，請人工核對"; // zero glyphs unreadable: core fell back to the blank rule
  const tcbKeep = (it) => /^[0-9\/,.\-%]+$/.test(it.s);
  function parseTcb(read) {
    const r = { rows: [] };
    const opts = { ytol: 4.5, gap: 4, filter: tcbKeep };
    // 結帳日：第 1 頁第一個日期
    for (const L of pageLines(read.pages[0], opts)) {
      const d = firstRoc(L.segs);
      if (d) {
        r.closing = d;
        // 繳款截止日：同一行右邊印成 '115?10?15?'（年月日是 '?'），tcbKeep 會濾掉，所以看原始 items
        const x1 = L.segs.find((s) => U.roc(s.t) === d).x1;
        const it = read.pages[0].items.find((it) => Math.abs(it.y - L.y) <= opts.ytol && it.x >= x1 && U.roc(it.s.replace(/\?$/, "")));
        if (it) r.due = U.roc(it.s.replace(/\?$/, ""));
        break;
      }
    }
    let detail = false, lone = null, glyphs = true;
    const edges = [];
    for (const pg of read.pages.slice(1)) {
      if (read.swapped && !pg.glyphZeros) glyphs = false;
      // Python stops at the first '-----' line (the END rule); find it on the unfiltered items.
      const end = pg.items.find((it) => /^-{5}/.test(it.s));
      const endY = end ? end.y - 2 : Infinity;
      const lines = pageLines(pg, opts).filter((L) => L.y < endY);
      const cand = [], totals = [], pgEdges = [];
      for (const L of lines) {
        let d1 = null, d2 = null;
        for (const s of segsIn(L, 25, 85)) if ((d1 = U.roc(s.t))) break;
        for (const s of segsIn(L, 85, 140)) if ((d2 = U.roc(s.t))) break;
        const amt = segsIn(L, 290, 350).filter((s) => U.isNum(s.t));
        if (d1 && amt.length) {
          const card = segsIn(L, 350, 400).filter((s) => /^\d{4}$/.test(s.t));
          cand.push(row(d1, d2, "", U.toNum(amt[0].t), card.length ? "J" + card[0].t : "",
            { page: pg.num, y: L.y, x0: 140, x1: 300 }));
          pgEdges.push(amt[0].x1);
        } else if (amt.length && L.segs.length === 1) { totals.push(U.toNum(amt[0].t)); pgEdges.push(amt[0].x1); }
      }
      if (cand.length && totals.length) {
        r.prev = totals[0]; r.cur = totals[totals.length - 1];
        detail = true;
      }
      r.rows.push(...cand);
      if (cand.length) edges.push(...pgEdges);
      // a month without transactions: the detail table (END rule) is there but holds only totals
      if (!cand.length && end && totals.length && !lone) { lone = totals; if (!detail) edges.push(...pgEdges); }
    }
    if (!detail && !r.rows.length && lone) { r.prev = lone[0]; r.cur = lone[lone.length - 1]; }
    if (!glyphs) r.warn = TCB_WARN0;
    else if (edges.length && Math.max(...edges) - Math.min(...edges) > TCB_TOL) r.warn = TCB_WARN;
    return finish(r);
  }

  /* ------------------------------ 臺灣銀行 ------------------------------
   * The PDF carries white template placeholders ('@', 'CLOSEDTE', 'OPENBAL', ...) as separate items,
   * often touching real values. pdfplumber dropped them by colour; here: drop every '@' item and any
   * ASCII-word item that starts right where an '@' item ends.
   */
  const botClean = (items) => {
    const at = items.filter((it) => it.s.trim() === "@");
    const drop = new Set(at);
    for (const it of items)
      if (/^[A-Za-z][A-Za-z0-9]*$/.test(it.s.trim()) &&
          at.some((a) => Math.abs(a.x1 - it.x) < 1 && Math.abs(a.y - it.y) < 2)) drop.add(it);
    return items.filter((it) => !drop.has(it));
  };
  function parseBot(read) {
    const r = { rows: [] };
    const pending = [];
    for (const pg of read.pages) {
      const lines = P.lines(botClean(pg.items));
      lines.forEach((L, i) => {
        const m = /結\s*帳\s*日\s*(\d{3}\/\d{2}\/\d{2})/.exec(L.text);
        if (m && !r.closing) r.closing = U.roc(m[1]);
        // 繳款截止日 shares the line, after the phone number; 無須繳款 instead of a date when nothing is owed
        const dm = /繳\s*款\s*截\s*止\s*日.*?(\d{3}\/\d{2}\/\d{2})/.exec(L.text);
        if (dm && !r.due) r.due = U.roc(dm[1]);
        if (nows(L.text).includes("前期應繳總金額")) {
          for (const L2 of lines.slice(i + 1, i + 5)) {
            const nums = L2.segs.filter((s) => U.isNum(s.t)).map((s) => U.toNum(s.t));
            if (nums.length >= 6) { r.prev = nums[0]; r.cur = nums[nums.length - 1]; break; }
          }
        }
        const d1 = firstMd(segsIn(L, 40, 80));
        const d2 = firstMd(segsIn(L, 80, 125));
        const amt = segsIn(L, 320, 398).filter((s) => U.isNum(s.t));
        if ((d1 || d2) && amt.length) {
          const card = segsIn(L, 0, 40).filter((s) => /^\d{4}$/.test(s.t));
          pending.push([d1, d2, joinT(segsIn(L, 125, 320)), U.toNum(amt[0].t), card.length ? card[0].t : ""]);
        }
      });
    }
    for (const [d1, d2, desc, a, c] of pending)
      r.rows.push(row(d1 ? U.mdDate(d1, r.closing) : null, d2 ? U.mdDate(d2, r.closing) : null, desc, a, c));
    return finish(r);
  }

  /* ------------------------------ registry / detect ------------------------------ */
  const B = (CC.banks = {});
  B.list = [
    { id: "tcb", name: "合作金庫", card: "合庫信用卡", keys: ["tcb-bank.com.tw", "2227-3131"], ocr: true, parse: parseTcb,
      // byte-swapped font is characteristic of 合庫 statements; counts as one extra key
      // (only on top of a real key match, else any unknown bank with such a font would be 合庫)
      bonus: (read, keyHits) => (read.swapped && keyHits > 0 ? 1 : 0) },
    { id: "ctbc", name: "中國信託", card: "中國信託信用卡", keys: ["ctbc.tw", "2745-8080"], ocr: true, parse: parseCtbc },
    { id: "bot", name: "臺灣銀行", card: "臺銀信用卡", keys: ["ecard.bot.com.tw", "2182-1901"], ocr: false, parse: parseBot },
    { id: "tsb", name: "台新", card: "台新信用卡", keys: ["taishinbank.com.tw", "2655-3355"], ocr: false, parse: parseTaishin },
    { id: "first", name: "第一銀行", card: "第一銀行信用卡", keys: ["firstbank.com.tw", "2173-2999"], ocr: false, parse: parseFirst },
    { id: "fubon", name: "台北富邦", card: "台北富邦信用卡", keys: ["fubon.com", "8751-1313"], ocr: false, parse: parseFubon },
    { id: "mega", name: "兆豐", card: "兆豐信用卡", keys: ["megabank.com.tw", "(02)89820000", "8982-0000"], ocr: false, parse: parseMega },
  ];
  B.byId = (id) => B.list.find((b) => b.id === id) || null;
  /** Score = keys found in read.text (+ bank bonus); unique max wins; tie or 0 -> null. */
  B.scores = (read) => {
    // read.text joins every pdf.js item with a space, so a phone number split over items reads
    // '(02)2182 -1901'; also match against the whitespace-free text.
    const t = U.nfkc((read && read.text) || "").toLowerCase(), t2 = t.replace(/\s+/g, "");
    const has = (k) => t.includes(k) || t2.includes(k.replace(/\s+/g, ""));
    return B.list.map((b) => {
      const hits = b.keys.filter(has).length;
      return { bank: b, score: hits + (b.bonus ? b.bonus(read || {}, hits) : 0) };
    });
  };
  B.detect = (read) => {
    const sc = B.scores(read);
    const best = Math.max(...sc.map((x) => x.score));
    if (best <= 0) return null;
    const top = sc.filter((x) => x.score === best);
    return top.length === 1 ? top[0].bank : null;
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
