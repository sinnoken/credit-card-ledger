/* payslip.js — CC.payslip
 * Payslip e-mails (.eml or pasted text) → a Statement0-like object, then OutRows for the review table.
 * One generic reader for every employer: no company names live in the code (they would be personal data);
 * the user's settings.payslip maps keywords → company name / deposit account.
 *
 * CC.payslip.fromEml(bytes) → {subject, from, date, text}        MIME: multipart, base64 / quoted-printable, charset
 * CC.payslip.parse(text, meta?) → {closing, prev:0, cur, rows:[{desc, amount}], gross, deduct, net, earn, ded, warn?}
 *     rows: + earnings, − deductions. cur = 實發 so CC.reconcile checks Σ rows = 實發.
 * CC.payslip.detect(text, meta, s) → {id:'payslip', name, card}
 * CC.payslip.process(st, src, s, file) → OutRow[]   earnings → sheet 收入, deductions → 固定/浮動 (positive),
 *     or → sheet 轉帳 when the type is a 轉入銀行 from settings.bankTargets (money moved to another account)
 */
(function (g) {
  "use strict";
  const CC = (g.CC = g.CC || {});
  const U = CC.util;
  const P = (CC.payslip = {});

  P.INCOME_SHEET = "收入";
  P.BANK_SHEET = "轉帳";
  P.INCOME_TYPE = "薪資";
  P.DEDUCT_TYPE = "保險(壽險/勞保/健保)";
  P.TOTALS = {
    gross: ["應發數小計", "應發合計", "應發金額", "應發總額", "應領合計", "應領金額", "薪資總額", "收入合計"],
    deduct: ["應扣數小計", "應扣合計", "應扣金額", "應扣總額", "扣款合計", "代扣合計", "減項合計"],
    net: ["實發金額", "實發數", "實發合計", "實領金額", "實付金額", "實發", "實領", "實付"],
  };
  // generic layout only: a positive amount under one of these labels is a deduction
  P.DEDUCT_WORDS = ["勞保", "健保", "勞退自提", "自提", "所得稅", "扣繳", "福利金", "工會", "代扣", "提存", "借支", "請假"];
  // generic layout only: label + number pairs that are not money paid or deducted
  P.SKIP_WORDS = ["提繳", "投保", "費基", "帳號", "工號", "編號", "天數", "日數", "時數", "小時", "年資", "層次", "職等",
    "職級", "扶養", "人數", "基數", "日期", "年月", "月份", "年度", "期間", "分機", "電話", "代號", "代碼", "序號", "部門"];
  const DATE_LABEL = /(發薪日期|發薪日|給付日期|發放日期|入帳日期|撥款日期)\s*[:：]?\s*(\d{2,4})\s*[\/.\-年]\s*(\d{1,2})\s*[\/.\-月]\s*(\d{1,2})/;
  const CODE_RE = /^([0-9A-Z]{1,4})\s*\((.+)\)$/;
  const CJK = /[㐀-鿿]/; // a loose label must be words, not e-mail header noise like "September 24"

  /* ------------------------------ .eml ------------------------------ */
  /** bytes → "binary string" (one char per byte; TextDecoder('latin1') would remap 0x80–0x9F). */
  const binStr = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return s;
  };
  const toBytes = (bs) => { const u = new Uint8Array(bs.length); for (let i = 0; i < bs.length; i++) u[i] = bs.charCodeAt(i) & 255; return u; };
  // Microsoft labels for Big5 that TextDecoder does not know
  const CHARSET_ALIAS = { cp950: "big5", ms950: "big5", "windows-950": "big5", "x-windows-950": "big5", "big5-hkscs": "big5" };
  /** Bytes → string. No charset: UTF-8 when valid, else Big5 (Taiwanese mail without a label). */
  const decodeText = (u8, charset) => {
    const cs = String(charset || "").trim().toLowerCase();
    if (!cs) { try { return new TextDecoder("utf-8", { fatal: true }).decode(u8); } catch (e) { return new TextDecoder("big5").decode(u8); } }
    try { return new TextDecoder(CHARSET_ALIAS[cs] || cs).decode(u8); } catch (e) { return new TextDecoder("utf-8").decode(u8); }
  };
  const fromB64 = (s) => toBytes(g.atob(s.replace(/[^A-Za-z0-9+/=]/g, "")));
  const fromQP = (s, header) => {
    s = s.replace(/=\r?\n/g, "");
    if (header) s = s.replace(/_/g, " ");
    return toBytes(s.replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))));
  };
  /** RFC 2047 encoded words in a header value. */
  const decodeWords = (v) => String(v || "")
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, cs, enc, t) => {
      try { return decodeText(/b/i.test(enc) ? fromB64(t) : fromQP(t, true), cs); } catch (e) { return m; }
    });
  /** Header value: raw 8-bit bytes (UTF-8 / Big5) and RFC 2047 words both decoded. */
  const header = (v) => decodeWords(/[\x80-\xff]/.test(v || "") ? decodeText(toBytes(v)) : v);
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  /** RFC 5322 Date → ISO date as written by the sender (no UTC shift: 07:00 +0800 stays that day). */
  const mailDate = (v) => {
    const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(v || "");
    const mo = m && MONTHS[m[2].toLowerCase()];
    return mo ? U.iso(+m[3], mo, +m[1]) : null;
  };
  const param = (v, name) => {
    const m = new RegExp(";\\s*" + name + "\\s*=\\s*(\"([^\"]*)\"|[^;\\s]+)", "i").exec(v || "");
    return m ? (m[2] != null ? m[2] : m[1]) : "";
  };
  /** Binary-string MIME entity → {headers, body}. */
  const entity = (bs) => {
    const m = /\r?\n\r?\n/.exec(bs);
    const head = m ? bs.slice(0, m.index) : bs, body = m ? bs.slice(m.index + m[0].length) : "";
    const headers = {};
    for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(); if (!(k in headers)) headers[k] = line.slice(i + 1).trim(); }
    }
    return { headers, body };
  };
  /** All leaf parts, depth first; a forwarded message/rfc822 attachment is opened (its parts get inner:true). */
  const leaves = (bs, out = [], inner = false) => {
    const e = entity(bs), ct = e.headers["content-type"] || "text/plain";
    const b = /^multipart\//i.test(ct) && param(ct, "boundary");
    if (b) {
      const parts = e.body.split("--" + b);
      for (const p of parts.slice(1)) {
        if (/^--/.test(p)) break; // closing boundary
        leaves(p.replace(/^\r?\n/, ""), out, inner);
      }
    } else if (/^message\/rfc822/i.test(ct)) {
      const cte = (e.headers["content-transfer-encoding"] || "").toLowerCase();
      leaves(cte === "base64" ? binStr(fromB64(e.body)) : cte === "quoted-printable" ? binStr(fromQP(e.body)) : e.body, out, true);
    } else { e.inner = inner; out.push(e); }
    return out;
  };
  const leafText = (e) => {
    const cte = (e.headers["content-transfer-encoding"] || "").toLowerCase();
    const u8 = cte === "base64" ? fromB64(e.body) : cte === "quoted-printable" ? fromQP(e.body) : toBytes(e.body);
    return decodeText(u8, param(e.headers["content-type"], "charset"));
  };
  /** HTML → text with table cells as tabs and rows as lines. */
  P.htmlToText = (h) => String(h || "")
    .replace(/<!--[\s\S]*?-->/g, "").replace(/<(head|style|script)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\b[^>]*>/gi, "\n").replace(/<\/(p|div|tr|li|h\d|table)>/gi, "\n").replace(/<\/(td|th)>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => codePoint(+d)).replace(/&amp;/gi, "&");
  const codePoint = (n) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");

  /** .eml bytes (ArrayBuffer / Uint8Array) → {subject, from, date (ISO or null), text}. A forwarded message's
   *  own body comes first; text/plain is preferred unless it holds no payslip items (an "open in HTML" stub). */
  P.fromEml = (bytes) => {
    const bs = binStr(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const top = entity(bs).headers;
    const parts = leaves(bs).sort((a, b) => (b.inner ? 1 : 0) - (a.inner ? 1 : 0)); // stable: inner parts first
    const isType = (e, t) => new RegExp("^" + t, "i").test(e.headers["content-type"] || "text/plain") && !/attachment/i.test(e.headers["content-disposition"] || "");
    const texts = [];
    for (const e of parts) {
      if (isType(e, "text/plain")) texts.push(leafText(e));
      else if (isType(e, "text/html")) texts.push(P.htmlToText(leafText(e)));
    }
    if (!texts.length) throw new Error("信件裡找不到內文");
    const parses = (t) => { try { P.parse(t); return true; } catch (e) { return false; } };
    return { subject: header(top.subject), from: header(top.from), date: mailDate(top.date), text: texts.find(parses) || texts[0] };
  };

  /* ------------------------------ text ------------------------------ */
  const AMT_RE = /^(-)?(?:NT)?\$?(-)?(\d[\d,]*(?:\.\d+)?)元?(-)?$/;
  /** Cell → number when the whole cell is an amount: -700, $-700, (700), 700-, 30,000元. Account-like 8+ digit
   *  runs without commas are not amounts. */
  const amountOf = (cell) => {
    let c = U.nfkc(cell).replace(/\s+/g, "").replace(/[−–]/g, "-");
    const pm = /^\((.*)\)$/.exec(c);
    if (pm) c = pm[1];
    const m = AMT_RE.exec(c);
    if (!m || (!m[3].includes(",") && m[3].replace(/\..*/, "").length >= 8)) return null;
    const n = Number(m[3].replace(/,/g, ""));
    return pm || m[1] || m[2] || m[4] ? -n : n;
  };
  const hasWord = (label, words) => { const n = U.norm(label); return words.some((w) => n.includes(U.norm(w))); };
  const totalOf = (label) => {
    const n = U.norm(label);
    for (const k of ["gross", "deduct", "net"]) if (P.TOTALS[k].some((w) => n.startsWith(U.norm(w)))) return k;
    return null;
  };

  /** Payslip text → statement. meta.date (e-mail date) is the fallback when no 發薪日期 is printed. */
  P.parse = (text, meta) => {
    const cells = String(text || "").split(/\r?\n/).flatMap((l) => l.split("\t")).map((c) => c.trim()).filter(Boolean);
    const totals = {}, coded = [], loose = [];
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i], next = i + 1 < cells.length ? amountOf(cells[i + 1]) : null;
      if (amountOf(c) != null) continue;
      const k = totalOf(c);
      if (k && next != null) { if (!(k in totals)) totals[k] = k === "net" ? next : Math.abs(next); i++; continue; }
      if (!k && next != null && CODE_RE.test(U.nfkc(c))) { coded.push({ desc: c, amount: next }); i++; continue; }
      if (!k && next != null && c.length <= 24 && CJK.test(c) && !hasWord(c, P.SKIP_WORDS)) { loose.push({ desc: c, amount: next }); i++; continue; }
      // 「本薪：30,000」 / 「本薪 30,000 勞保費 1,200」 / 「實發：29,300」 inside one cell (NFKC: full-width digits)
      const n = U.nfkc(c);
      if (!/\d\s*[\/.\-年]\s*\d/.test(n))
        for (const m of n.matchAll(/([^\d\s:：$,.\-][^\d:：$]*?)\s*[:：]?\s*((?:NT)?\$?-?\d[\d,]*(?:\.\d+)?元?)(?=\s|$)/g)) {
          const lab = m[1].trim(), amt = amountOf(m[2]), k2 = totalOf(lab);
          if (amt == null) continue;
          if (k2) { if (!(k2 in totals)) totals[k2] = k2 === "net" ? amt : Math.abs(amt); }
          else if (CJK.test(lab) && !hasWord(lab, P.SKIP_WORDS)) loose.push({ desc: lab, amount: amt });
        }
    }
    // an employer code like A1(本薪) marks the item table; without one fall back to the loose label/amount pairs.
    // A layout that prints no negative amounts at all lists deductions as positive: sign them by keyword.
    const items = coded.length ? coded : loose, signed = items.some((x) => x.amount < 0);
    const rows = items.map((x) => ({ desc: x.desc, amount: !signed && x.amount > 0 && hasWord(x.desc, P.DEDUCT_WORDS) ? -x.amount : x.amount }))
      .filter((x) => x.amount !== 0);
    if (!rows.length) throw new Error("找不到薪資項目（可能改版，或不是薪資單）");
    const dm = DATE_LABEL.exec(U.nfkc(text));
    const y = dm ? +dm[2] : 0; // 115 → ROC, 26 → 2026, 2026 as is
    const closing = dm ? U.iso(y < 100 ? y + 2000 : y < 1000 ? y + 1911 : y, +dm[3], +dm[4]) : (meta && meta.date) || null;
    const earn = rows.filter((x) => x.amount > 0).reduce((a, x) => a + x.amount, 0);
    const ded = -rows.filter((x) => x.amount < 0).reduce((a, x) => a + x.amount, 0);
    const warn = [];
    if (totals.gross != null && totals.gross !== earn) warn.push(`收入項目合計 ${earn}，薪資單應發 ${totals.gross}`);
    if (totals.deduct != null && totals.deduct !== ded) warn.push(`扣項合計 ${ded}，薪資單應扣 ${totals.deduct}`);
    if (totals.net == null) warn.push(totals.gross == null && totals.deduct == null ? "找不到應發／應扣／實發合計" : "找不到實發金額");
    if (!closing) warn.push("找不到發薪日期");
    // expected 實發: printed, else 應發 − 應扣 when both are printed (so the items are still checked), else the items
    const cur = totals.net != null ? totals.net : totals.gross != null && totals.deduct != null ? totals.gross - totals.deduct : earn - ded;
    const st = { closing, prev: 0, cur,
      rows: rows.map((x) => ({ date: closing, desc: x.desc, amount: x.amount })),
      gross: totals.gross ?? null, deduct: totals.deduct ?? null, net: totals.net ?? null, earn, ded };
    if (warn.length) st.warn = warn.join("；");
    return st;
  };

  /* ------------------------------ rows ------------------------------ */
  const conf = (s) => (s && s.payslip) || {};
  /** Company from settings.payslip.companies keywords (text, subject or sender); default name 薪資單. */
  P.detect = (text, meta, s) => {
    const hay = [text, meta && meta.subject, meta && meta.from].filter(Boolean).join("\n");
    const c = (conf(s).companies || []).find((x) => (x.keys || []).some((k) => k && hay.includes(k)));
    return { id: "payslip", name: (c && c.name) || "薪資單", card: (c && c.account) || conf(s).account || "" };
  };
  /** Deposit account for a detected source, re-read from settings so a changed account applies on rebuild. */
  const accountOf = (src, s) => {
    const c = (conf(s).companies || []).find((x) => x.name && x.name === src.name);
    return (c && c.account) || conf(s).account || "";
  };
  P.incomeTypes = (s) => ((s && s.incomeTypes) || []).slice();
  P.bankTargets = (s) => ((s && s.bankTargets) || []).slice();

  /** Type from learned (both sheets share it) or a rule; a type of the wrong side falls back to the default (guess). */
  const typeOf = (desc, income, s) => {
    const n = U.norm(desc), inc = P.incomeTypes(s);
    const hist = (s && s.learned) || {};
    let t = null, guess = false;
    if (Object.prototype.hasOwnProperty.call(hist, n)) { t = hist[n].type; guess = !!hist[n].conflict; }
    else if (!income) {
      const r = ((s && s.rules) || []).find((x) => (x.words || []).some((w) => n.includes(U.norm(w))));
      if (r) t = r.type;
    }
    if (!t || inc.includes(t) !== income) return { type: income ? inc[0] || P.INCOME_TYPE : P.DEDUCT_TYPE, guess: true };
    return { type: t, guess };
  };

  /** Statement rows → OutRows. Deductions are written positive, like the user's 固定 and 轉帳 sheets. */
  P.process = (st, src, s, file) => {
    const card = accountOf(src || {}, s);
    return (st.rows || []).map((x, i) => {
      const income = x.amount > 0, desc = String(x.desc || "").trim();
      const { type, guess } = typeOf(desc, income, s), r = { kind: income ? "income" : "deduct" };
      return {
        id: (file || "payslip") + "#" + i, file: file || "", bank: "payslip",
        sheet: P.sheetFor(r, type, s), date: st.closing || null, type, desc, descRaw: desc,
        card, inst: null, amount: Math.abs(CC.classify.pyRound(x.amount)), kind: r.kind,
        guess, ocr: false, confirmed: false, crop: null,
      };
    });
  };
  /** Sheet for a row after the user picks a type: income rows always stay on 收入; a deduction typed with a
   *  轉入銀行 goes to 轉帳. Card rows (other kinds) never do. */
  P.sheetFor = (r, type, s) => (r.kind === "income" ? P.INCOME_SHEET
    : r.kind === "deduct" && P.bankTargets(s).includes(type) ? P.BANK_SHEET : CC.classify.sheetOf(type, s));
})(globalThis);
