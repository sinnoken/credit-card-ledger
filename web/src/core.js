/* core.js — shared utilities + PDF text layer (owner: lead)
 * Classic script. Attaches to globalThis.CC. Works in the browser (global pdfjsLib)
 * and in Node tests (set globalThis.pdfjsLib = require(legacy build) before loading).
 * Dates are ISO strings 'YYYY-MM-DD' everywhere (no Date objects, no time zones).
 */
(function (g) {
  "use strict";
  const CC = (g.CC = g.CC || {});
  const U = (CC.util = {});

  U.nfkc = (s) => String(s == null ? "" : s).normalize("NFKC");
  /** Comparison key: NFKC (full-width -> half-width), no whitespace, upper case. */
  U.norm = (s) => U.nfkc(s).replace(/\s+/g, "").toUpperCase();

  U.NUM_RE = /^[+-]?\$?[\d,]+(\.\d+)?元?$/;
  U.ROC_RE = /^(\d{3})[\/?](\d{2})[\/?](\d{2})$/;
  U.MD_RE = /^(\d{2})\/(\d{2})$/;

  U.isNum = (s) => U.NUM_RE.test(U.nfkc(s).replace(/ /g, ""));
  /** '1,234.00' / '+1,234' / '-5,678' / '$42' / '250元' -> number. */
  U.toNum = (s) => {
    const t = U.nfkc(s).replace(/[,\s$元]/g, "").replace(/^\+/, "");
    const v = Number(t);
    if (!Number.isFinite(v)) throw new Error("不是數字：" + s);
    return v;
  };

  const pad = (n) => String(n).padStart(2, "0");
  /** Valid calendar date -> 'YYYY-MM-DD', else null. */
  U.iso = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  };
  /** ROC date '115/03/14' (or '115?03?14') -> '2026-03-14'; invalid -> null. */
  U.roc = (s) => {
    const m = U.ROC_RE.exec(String(s || "").trim());
    return m ? U.iso(+m[1] + 1911, +m[2], +m[3]) : null;
  };
  /** 'MM/DD' without year; year from closing date, previous year if month > closing month. */
  U.mdDate = (s, closingIso) => {
    const m = U.MD_RE.exec(String(s || "").trim());
    if (!m || !closingIso) return null;
    const cy = +closingIso.slice(0, 4), cm = +closingIso.slice(5, 7), mo = +m[1];
    return U.iso(mo <= cm ? cy : cy - 1, mo, +m[2]);
  };

  /* ------------------------------ PDF ------------------------------ */
  const P = (CC.pdf = {});

  /** Some fonts (合作金庫) decode byte-swapped in pdf.js: U+3100 is really '1'. */
  P.unswap = (str) =>
    Array.from(str, (ch) => {
      const c = ch.charCodeAt(0);
      return c > 0xff && (c & 0xff) === 0 ? String.fromCharCode(c >> 8) : ch;
    }).join("");
  P.isSwapped = (rawItems) => {
    let sw = 0, tot = 0;
    for (const it of rawItems)
      for (const ch of it.str) {
        const c = ch.charCodeAt(0);
        if (c > 0x20) { tot++; if (c > 0xff && (c & 0xff) === 0) sw++; }
      }
    return tot > 20 && sw / tot > 0.3;
  };

  /**
   * Open a PDF. Tries no password, then each password in order.
   * Resolves {doc, password}. Rejects Error with .code = 'password' when none works.
   */
  P.open = async (arrayBuffer, passwords = []) => {
    const tries = [undefined, ...passwords.filter(Boolean)];
    let needPw = false;
    for (const pw of tries) {
      try {
        const task = g.pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer.slice(0)), password: pw, isEvalSupported: false });
        const doc = await task.promise;
        return { doc, password: pw || null };
      } catch (e) {
        if (e && e.name === "PasswordException") { needPw = true; continue; }
        throw e;
      }
    }
    const err = new Error(needPw ? "需要密碼，或密碼都不對" : "無法開啟");
    err.code = "password";
    throw err;
  };

  /**
   * Byte-swapped docs: the digit '0' (0x30) decodes as U+3000, which pdf.js classifies as whitespace, so
   * getTextContent never has it in a string. An inner zero shows up as ' ' or a blank item, but a trailing
   * zero is folded into the blank item that spans to the next glyph (`3,000` + gap -> '3,' + one wide
   * blank), or vanishes entirely at the end of a line. The operator list still carries every glyph, so
   * this replays the text state (Tm/Td/TL/Tc/Tw/Tz/cm/forms) and returns where each zero glyph was
   * drawn: [{x0, x1, base, h}] in the same coordinates as P.read (origin top-left, base = baseline).
   * Upright horizontal text only; anything else is skipped. Only U+3000 drawn with a font whose other
   * glyphs are byte-swapped counts (a normal CJK font's U+3000 is a real full-width space).
   */
  P.zeroGlyphs = async (page, height) => {
    const ol = await page.getOperatorList();
    const O = g.pdfjsLib.OPS;
    const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2],
      m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
    const ID = [1, 0, 0, 1, 0, 0];
    const fms = {};
    const fontScale = (name) => {
      if (!(name in fms)) {
        let fm = 0.001;
        try { const f = page.commonObjs.get(name); if (f && f.fontMatrix) fm = f.fontMatrix[0]; } catch (e) { /* default */ }
        fms[name] = fm;
      }
      return fms[name];
    };
    let ctm = ID.slice(), tm = ID.slice(), tlm = ID.slice();
    let fs = 0, fm = 0.001, tc = 0, tw = 0, th = 1, tl = 0, font = "";
    const stack = [], out = [], fst = {}; // fst[font] = {sw, tot}: printable non-U+3000 glyphs, byte-swapped ones
    const move = (x, y) => { tlm = mul([1, 0, 0, 1, x, y], tlm); tm = tlm.slice(); };
    const show = (glyphs) => {
      const M = mul(tm, ctm);
      const upright = Math.abs(M[1]) < 1e-6 && Math.abs(M[2]) < 1e-6 && M[0] > 0;
      let tx = 0;
      for (const gl of glyphs || []) {
        if (typeof gl === "number") { tx -= (gl * 0.001 * fs) * th; continue; }
        if (!gl) continue;
        const gw = (gl.width || 0) * fm * fs * th;
        const u = gl.unicode || "", c = u.length === 1 ? u.charCodeAt(0) : 0;
        if (u === "\u3000") {
          if (upright) out.push({ font, x0: M[0] * tx + M[4], x1: M[0] * (tx + gw) + M[4], base: height - M[5], h: Math.abs(M[3]) * fs });
        } else if (c > 0x20) {
          const f = fst[font] || (fst[font] = { sw: 0, tot: 0 });
          f.tot++; if (c > 0xff && (c & 0xff) === 0) f.sw++;
        }
        tx += gw + (tc + (gl.isSpace ? tw : 0)) * th;
      }
      tm = mul([1, 0, 0, 1, tx, 0], tm);
    };
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i], a = ol.argsArray[i] || [];
      switch (fn) {
        case O.save: stack.push(ctm); break;
        case O.restore: if (stack.length) ctm = stack.pop(); break;
        case O.transform: ctm = mul(a, ctm); break;
        case O.paintFormXObjectBegin: stack.push(ctm); if (Array.isArray(a[0]) && a[0].length === 6) ctm = mul(a[0], ctm); break;
        case O.paintFormXObjectEnd: if (stack.length) ctm = stack.pop(); break;
        case O.beginText: tm = ID.slice(); tlm = ID.slice(); break;
        case O.setFont: fs = +a[1] || 0; fm = fontScale(a[0]); font = String(a[0]); break;
        case O.setCharSpacing: tc = +a[0] || 0; break;
        case O.setWordSpacing: tw = +a[0] || 0; break;
        case O.setHScale: th = (+a[0] || 100) / 100; break;
        case O.setLeading: tl = +a[0] || 0; break;
        case O.setTextMatrix: tlm = (a.length === 6 ? a : a[0]).slice(); tm = tlm.slice(); break;
        case O.moveText: move(a[0], a[1]); break;
        case O.setLeadingMoveText: tl = -a[1]; move(a[0], a[1]); break;
        case O.nextLine: move(0, -tl); break;
        case O.showText: case O.showSpacedText: show(a[0]); break;
        case O.nextLineShowText: move(0, -tl); show(a[0]); break;
        case O.nextLineSetSpacingShowText: tw = a[0]; tc = a[1]; move(0, -tl); show(a[2]); break;
        default: break;
      }
    }
    const swappedFont = (f) => fst[f] && fst[f].sw > 0 && fst[f].sw / fst[f].tot > 0.5;
    return out.filter((z) => swappedFont(z.font)).map(({ font, ...z }) => z);
  };

  /**
   * Turn into '0' the spaces of item string s (drawn from x to x1) that sit where a zero glyph was drawn.
   * Each zero claims the nearest unclaimed space by estimated position (char index scaled to the width).
   */
  P.fillZeros = (s, x, x1, zs) => {
    const ch = Array.from(s);
    const sp = ch.map((c, i) => (c === " " ? i : -1)).filter((i) => i >= 0);
    if (!sp.length || !zs.length) return s;
    if (zs.length >= sp.length) return s.replace(/ /g, "0");
    const cw = (x1 - x) / ch.length;
    for (const z of zs) {
      const at = ((z.x0 + z.x1) / 2 - x) / cw - 0.5;
      let best = -1;
      for (const i of sp) if (ch[i] === " " && (best < 0 || Math.abs(i - at) < Math.abs(best - at))) best = i;
      if (best >= 0 && Math.abs(best - at) <= 1) ch[best] = "0"; // only a space at the zero's own position
    }
    return ch.join("");
  };

  /**
   * Read every page's text layer.
   * Returns { swapped, text, pages:[{num, width, height, page, items}] } where
   * items = [{s, x, x1, y, w, h}] in PDF points, origin top-left, y = vertical centre of the text.
   * For byte-swapped docs, strings are un-swapped and every '0' is restored from the zero glyphs the
   * operator list carries (P.zeroGlyphs): a zero touching an item's right end is appended to it (so
   * '3,000' and '115/03/30' arrive complete), any other run of zeros becomes its own item, and blank
   * items are dropped (their width mixes zeros with layout gaps, so it is not evidence). If the operator
   * list cannot be read, the old rule applies: narrow blank items (<= 6.5pt) become '0'.
   * `text` = all strings joined, NFKC + lower case (for bank detection).
   */
  P.read = async (doc) => {
    const pages = [], raw = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      pages.push({ num: n, width: vp.width, height: vp.height, page, rawItems: tc.items });
      raw.push(...tc.items);
    }
    const swapped = P.isSwapped(raw);
    let text = "";
    for (const pg of pages) {
      pg.items = [];
      let zeros = null;
      if (swapped) {
        try { zeros = await P.zeroGlyphs(pg.page, pg.height); } catch (e) { zeros = null; }
        // no zero glyph found, yet the text layer has blanks: the zeros are there but unrecognised
        // (operator list empty, or a font that does not draw '0' as U+3000) -> fallback rule + warn
        // ...but only on a page that carries swapped digits at all (a notes page with wide gaps is not evidence)
        const swDigit = (str) => Array.from(str).some((ch) => { const c = ch.charCodeAt(0); return c > 0xff && (c & 0xff) === 0 && (c >> 8) >= 0x31 && (c >> 8) <= 0x39; });
        if (zeros && !zeros.length && pg.rawItems.some((it) => it.transform && swDigit(it.str))
            && pg.rawItems.some((it) => it.transform && !it.str.trim() && it.width > 0)) zeros = null;
      }
      const used = new Set();
      const touching = (x1, base) =>
        zeros.find((z) => !used.has(z) && Math.abs(z.base - base) < 1 && Math.abs(z.x0 - x1) < 0.6);
      for (const it of pg.rawItems) {
        if (!it.transform) continue;
        const h = Math.hypot(it.transform[2], it.transform[3]) || it.height || 8;
        const x = it.transform[4], base = pg.height - it.transform[5];
        let s = swapped ? P.unswap(it.str) : it.str, x1 = x + it.width;
        if (!s.trim()) {
          if (swapped && !zeros && it.width > 0 && it.width <= 6.5) s = "0"; // digit 0 decoded as a narrow blank
          else continue;
        } else if (swapped) {
          if (!zeros) s = s.replace(/ /g, "0");
          else {
            // inner zeros arrive as ' ': only a ' ' where a zero glyph was drawn becomes '0' (a real
            // space, e.g. '2 / 2', stays); trailing zeros are appended
            const inner = zeros.filter((z) => !used.has(z) && Math.abs(z.base - base) < 1 && z.x0 >= x - 0.6 && z.x1 <= x1 + 0.6);
            inner.forEach((z) => used.add(z));
            s = P.fillZeros(s, x, x1, inner);
            for (let z; (z = touching(x1, base)); ) { used.add(z); s += "0"; x1 = z.x1; }
          }
        }
        pg.items.push({ s, x, x1, w: x1 === x + it.width ? it.width : x1 - x, y: base - h * 0.35, h });
        text += s + " ";
      }
      if (zeros) {
        // zeros not touching an item's right end (a lone '0' amount, the '0' of '09' after a gap):
        // contiguous runs become items of their own
        const rest = zeros.filter((z) => !used.has(z)).sort((a, b) => a.base - b.base || a.x0 - b.x0);
        for (let i = 0; i < rest.length; ) {
          const z0 = rest[i];
          let x1 = z0.x1, n = 1;
          while (i + n < rest.length && Math.abs(rest[i + n].base - z0.base) < 1 && Math.abs(rest[i + n].x0 - x1) < 0.6)
            x1 = rest[i + n++].x1;
          const s = "0".repeat(n);
          pg.items.push({ s, x: z0.x0, x1, w: x1 - z0.x0, y: z0.base - z0.h * 0.35, h: z0.h });
          text += s + " ";
          i += n;
        }
      }
      if (zeros) pg.glyphZeros = true;
      delete pg.rawItems;
    }
    return { swapped, text: U.nfkc(text).toLowerCase(), pages };
  };

  /**
   * Group items into lines (|dy| <= ytol) and merge horizontally adjacent items
   * (gap <= gap) into segments, inserting one space when gap > 1.2pt.
   * opts.filter(item) -> false drops an item first.
   * Returns [{y, segs:[{t, x0, x1}], text}] sorted top to bottom; segs left to right.
   */
  P.lines = (items, opts = {}) => {
    const ytol = opts.ytol ?? 2.5, gap = opts.gap ?? 5, filter = opts.filter;
    const pts = items.filter((it) => !filter || filter(it)).slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    for (const it of pts) {
      const r = rows.find((r) => Math.abs(r.y - it.y) <= ytol);
      if (r) r.items.push(it); else rows.push({ y: it.y, items: [it] });
    }
    rows.sort((a, b) => a.y - b.y);
    return rows.map((r) => {
      r.items.sort((a, b) => a.x - b.x);
      const segs = [];
      for (const it of r.items) {
        const cur = segs[segs.length - 1];
        const dx = cur ? it.x - cur.x1 : Infinity;
        if (cur && dx <= gap) { cur.t += (dx > 1.2 ? " " : "") + it.s; cur.x1 = Math.max(cur.x1, it.x1); }
        else segs.push({ t: it.s, x0: it.x, x1: it.x1 });
      }
      segs.forEach((s) => (s.t = s.t.trim()));
      return { y: r.y, segs, text: segs.map((s) => s.t).join(" ") };
    });
  };

  /** Segments of a line whose left edge is in [x0, x1). */
  P.segsIn = (line, x0, x1) => line.segs.filter((s) => s.x0 >= x0 && s.x0 < x1);
})(typeof globalThis !== "undefined" ? globalThis : this);
