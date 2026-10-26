/* classify.js — CC.classify, CC.reconcile (owner: agent C)
 * Faithful port of classify()/fix_ocr()/is_payment() and the main loop of convert_reference.py.
 */
(function (g) {
  "use strict";
  const CC = (g.CC = g.CC || {});
  const C = (CC.classify = {});
  const norm = (s) => CC.util.norm(s);

  C.PAYMENT_WORDS = ["扣繳", "授扣繳款", "已繳款", "繳款", "扣款", "感謝您", "本行扣", "轉帳扣", "转帐", "自動轉帳"];
  C.FEE_WORDS = ["國外交易服務費", "海外簽帳手續費", "國外交易手續費"];
  C.REWARD_WORDS = ["回饋", "刷卡金", "折抵", "回馈"];

  const has = (s, words) => words.some((w) => s.includes(w));

  /* ------------------- difflib.SequenceMatcher (isjunk=None) ------------------- */

  /** Python difflib.SequenceMatcher(None, a, b).ratio(), code-point based, incl. autojunk (n ≥ 200). */
  C.ratio = (a, b) => {
    a = Array.from(String(a)); b = Array.from(String(b));
    const la = a.length, lb = b.length;
    if (la + lb === 0) return 1.0;
    // b2j
    let b2j = new Map();
    b.forEach((ch, j) => { if (!b2j.has(ch)) b2j.set(ch, []); b2j.get(ch).push(j); });
    const popular = new Set();
    if (lb >= 200) {
      const ntest = Math.floor(lb / 100) + 1;
      for (const [ch, idx] of b2j) if (idx.length > ntest) popular.add(ch);
      for (const ch of popular) b2j.delete(ch);
    }
    // no junk elements (isjunk=None); popular elements only affect b2j
    const longest = (alo, ahi, blo, bhi) => {
      let besti = alo, bestj = blo, bestsize = 0;
      let j2len = new Map();
      for (let i = alo; i < ahi; i++) {
        const newj2len = new Map();
        const idx = b2j.get(a[i]);
        if (idx) for (const j of idx) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) || 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
        }
        j2len = newj2len;
      }
      // extension loops (bjunk is empty, so only the "not junk" variants matter)
      while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) { besti--; bestj--; bestsize++; }
      while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
      return [besti, bestj, bestsize];
    };
    let matches = 0;
    const queue = [[0, la, 0, lb]];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const [i, j, k] = longest(alo, ahi, blo, bhi);
      if (k) {
        matches += k;
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    return (2.0 * matches) / (la + lb);
  };

  // Python str comparison (code points) for nlargest tie-breaks
  const cmpStr = (x, y) => {
    const a = Array.from(x, (c) => c.codePointAt(0)), b = Array.from(y, (c) => c.codePointAt(0));
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  };

  /** difflib.get_close_matches(word, possibilities, n=1, cutoff) → best match or null. */
  C.closeMatch = (word, possibilities, cutoff = 0.85) => {
    let best = null, bestScore = -1;
    for (const x of possibilities) {
      const r = C.ratio(x, word); // SequenceMatcher: seq1 = x, seq2 = word
      if (r < cutoff) continue;
      if (r > bestScore || (r === bestScore && cmpStr(x, best) > 0)) { best = x; bestScore = r; }
    }
    return best;
  };

  /** OCR 摘要：找既有紀錄裡最像的摘要取代. */
  C.fixOcr = (desc, s) => {
    const hist = (s && s.learned) || {};
    const keys = Object.keys(hist);
    if (!keys.length) return { desc, matched: false };
    const m = C.closeMatch(norm(desc), keys, 0.85);
    return m != null ? { desc: hist[m].desc, matched: true } : { desc, matched: false };
  };

  /* ------------------------------- classification ------------------------------- */

  C.isPayment = (desc, amount) => amount < 0 && has(desc, C.PAYMENT_WORDS) && !has(desc, C.REWARD_WORDS);

  C.kind = (desc, amount) => {
    desc = String(desc || "");
    if (C.isPayment(desc, amount)) return "payment";
    if (has(desc, C.FEE_WORDS)) return "fee";
    if (has(desc, C.REWARD_WORDS)) return "reward";
    return "purchase";
  };

  const defaultTypeOf = (card, s) => {
    for (const c of Object.values((s && s.cards) || {})) if (c && c.name === card && c.defaultType) return c.defaultType;
    return "日用其他";
  };

  /** 優先順序：手續費跟前一筆 → 折抵跟原消費 → 關鍵字規則 → 舊紀錄 → 卡片預設（猜的）. */
  C.classify = (desc, card, s, prevType) => {
    desc = String(desc || "");
    const n = norm(desc);
    if (has(desc, C.FEE_WORDS) && prevType) return { type: prevType, guess: false };
    const m = /折抵_(.+)$/.exec(desc);
    if (m) return C.classify(m[1], card, s, null);
    for (const r of (s && s.rules) || [])
      if ((r.words || []).some((w) => n.includes(norm(w)))) return { type: r.type, guess: false };
    const hist = (s && s.learned) || {};
    // payslip-only types (收入類型, 轉入銀行) share the learned map but never classify a card row
    const payslipOnly = (t) => ((s && s.incomeTypes) || []).includes(t) || ((s && s.bankTargets) || []).includes(t);
    if (Object.prototype.hasOwnProperty.call(hist, n) && !payslipOnly(hist[n].type)) return { type: hist[n].type, guess: !!hist[n].conflict };
    const def = defaultTypeOf(card, s);
    if (has(desc, C.REWARD_WORDS) || desc.includes("%")) return { type: def, guess: false };
    return { type: def, guess: true };
  };

  C.sheetOf = (type, s) => (((s && s.fixedTypes) || []).includes(type) ? "固定" : "浮動");

  /** Python int(round(x)) — round half to even. */
  C.pyRound = (x) => {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  };

  /**
   * Python main loop for one statement. st = Statement0, bank = bank id or bank object.
   * Re-run after OCR has filled row descs (prevType threading spans the whole statement).
   */
  C.process = (st, bank, s, file) => {
    const bankId = typeof bank === "string" ? bank : bank && bank.id;
    const byLast4 = (s && s.cardByLast4) || {};
    const cardInfo = ((s && s.cards) || {})[bankId];
    const out = [];
    let prevType = null;
    (st.rows || []).forEach((x, i) => {
      const ocr = !!x.ocr;
      let desc = String(x.desc == null ? "" : x.desc).trim();
      if (ocr && !desc) desc = "(需人工確認)";
      const descRaw = desc;
      if (C.isPayment(desc, x.amount)) return;
      const card = (x.last4 && Object.prototype.hasOwnProperty.call(byLast4, x.last4) && byLast4[x.last4]) ||
        (cardInfo && cardInfo.name) || bankId;
      if (ocr) desc = C.fixOcr(desc, s).desc;
      const { type, guess } = C.classify(desc, card, s, prevType);
      prevType = type;
      const mode = (s && s.dateMode) || "帳單日";
      const date = mode === "帳單日" ? st.closing || null : mode === "入帳日" ? x.post || x.date || null : x.date || null;
      const mi = /分期\s*(\d+\/\d+)/.exec(desc);
      out.push({
        id: (file || bankId) + "#" + i, file: file || "", bank: bankId,
        sheet: C.sheetOf(type, s), date, type, desc, descRaw, card,
        inst: mi ? mi[1] : null, amount: C.pyRound(x.amount), kind: C.kind(desc, x.amount),
        guess, ocr, confirmed: false, crop: null,
      });
    });
    return out;
  };

  const round2 = (x) => Math.round(x * 100) / 100;

  /** 明細合計(含繳款) vs 本期-上期. */
  CC.reconcile = (st) => {
    const total = round2((st.rows || []).reduce((a, x) => a + (Number(x.amount) || 0), 0));
    const have = st.cur != null && st.prev != null && Number.isFinite(st.cur) && Number.isFinite(st.prev);
    const expect = have ? round2(st.cur - st.prev) : null;
    return { total, expect, ok: expect != null && Math.abs(total - expect) < 0.01 };
  };
})(globalThis);
