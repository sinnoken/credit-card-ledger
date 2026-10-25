// node test/banks_edge.test.cjs — CC.banks edge cases on synthetic reads (regressions from code review)
const fs = require('fs'), path = require('path');
const w = console.warn, l = console.log;
console.warn = () => {};
const CC = require('./node_env.cjs')(['core.js', 'banks.js']);
console.warn = w;
const U = CC.util;

let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; l('  FAIL ' + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const throwsMsg = (fn, re, msg) => {
  try { fn(); ok(false, `${msg}: did not throw`); } catch (e) { ok(re.test(e.message), `${msg}: threw '${e.message}'`); }
};
const item = (s, x, y, cw = 9) => ({ s, x, x1: x + cw * s.length, w: cw * s.length, y, h: 9 });

async function readFixture(file) {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures/pdf', file));
  console.warn = () => {}; console.log = () => {};
  try {
    const { doc } = await CC.pdf.open(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    return await CC.pdf.read(doc);
  } finally { console.warn = w; console.log = l; }
}
const clone = (read) => ({
  swapped: read.swapped, text: read.text,
  pages: read.pages.map((pg) => ({ num: pg.num, width: pg.width, height: pg.height, glyphZeros: pg.glyphZeros, items: pg.items.map((it) => ({ ...it })) })),
});

/* ---------- 合作金庫: zeros invisible to the text layer ----------
 * The digit '0' of the byte-swapped font is whitespace to pdf.js: '3,000' arrives as '3,' plus a wide
 * blank (or nothing, at the end of a line). tcb_pdf.cjs rewrites the fixture's page-2 content stream
 * (values / column positions) so these cases go through the real pdf.js + CC.pdf.read. Amount lines,
 * top to bottom: 上期 total, payment, 3 purchases, subtotal, adjustment, 本期 total. */
const { variant } = require('./tcb_pdf.cjs');
const { need } = require('./private.cjs');
async function readBytes(buf, patch) {
  console.warn = () => {}; console.log = () => {};
  try {
    const { doc } = await CC.pdf.open(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    return await CC.pdf.read(patch ? patch(doc) : doc);
  } finally { console.warn = w; console.log = l; }
}
const tcb = CC.banks.byId('tcb');
const amounts = (st) => st.rows.map((r) => r.amount);

async function tcbFixtureCases() {
  const base = await readFixture('TCB.pdf');
  const real = tcb.parse(clone(base));
  const exp = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/expected.json'), 'utf8'))['TCB.pdf'];

  eq([real.prev, real.cur, amounts(real), real.warn], [exp.prev, exp.cur, exp.rows.map((r) => r.amount), undefined], 'tcb fixture');
  eq(real.rows.map((r) => r.post), exp.rows.map((r) => r.post), 'tcb fixture: post dates read whole');

  // The fixture's 8 amount lines, top to bottom: 上期 total, payment, 3 purchases, subtotal, adjustment,
  // 本期 total (taken from expected.json, so no statement amounts live in this file).
  const xr = exp.rows.map((r) => r.amount);
  ok(xr.length === 5, 'tcb fixture layout: payment, 3 purchases, adjustment');
  const ORIG = [exp.prev, xr[0], xr[1], xr[2], xr[3], xr[1] + xr[2] + xr[3], xr[4], exp.cur];
  // every case must give the true amounts; a warn is acceptable only together with them (never a
  // silently wrong statement, never x10 / x100)
  const ALL0 = [3000, -3000, 1000, 500, 1500, 3000, -1000, 2000];
  const MIX = [3000, -3000, 1000, 500, 1520, 3020, -3, 3017];
  const INNER = [10050, -1005, 100, 2000, 7900, 10050, -100, 10000];
  const want = (v) => [v[0], v[7], [v[1], v[2], v[3], v[4], v[6]]];
  const check = async (label, spec, v, needWarn = false) => {
    const st = tcb.parse(await readBytes(variant({ ...spec, amounts: v === ORIG ? [] : v })));
    eq([st.prev, st.cur, amounts(st)], want(v), label);
    eq(st.rows.map((r) => [r.date, r.post]), exp.rows.map((r) => [r.date, r.post]), label + ': dates');
    if (needWarn) ok(st.warn === '合庫金額位置不一致，請人工核對', label + ': warn expected');
    else ok(st.warn === undefined, `${label}: unexpected warn ${st.warn}`);
    return st;
  };
  await check('tcb rewritten, same values', {}, ORIG);
  await check('tcb all end in 0', {}, ALL0);
  await check('tcb mix', {}, MIX);
  await check('tcb inner + trailing zeros', {}, INNER);
  await check('tcb 上期 total is 0 (lone zero)', {}, [0, -3000, 1000, 500, 1500, 3000, -1000, 2000]);
  for (const dx of [-3.5, -4, -4.5, -5, -8, -9, 3]) {
    await check(`tcb amount column dx=${dx}`, { amtDx: dx }, ORIG);
    await check(`tcb amount column dx=${dx}, all end in 0`, { amtDx: dx }, ALL0);
    await check(`tcb amount column dx=${dx}, mix`, { amtDx: dx }, MIX);
  }
  await check('tcb date column dx=4', { dateDx: 4 }, ORIG);
  await check('tcb date column dx=4, all end in 0', { dateDx: 4 }, ALL0);
  await check('tcb date column dx=4, amounts dx=-4.5, all end in 0', { dateDx: 4, amtDx: -4.5 }, ALL0);

  // no transactions this month: table + END rule present, only the totals lines
  for (const [v, dx] of [[ORIG[0], 0], [1200, 0], [1200, -4.5], [3000, -9], [0, 3]]) {
    const st = tcb.parse(await readBytes(variant({ amounts: [v, , , , , , , v], amtDx: dx, drop: (i) => i > 0 && i < 7 })));
    eq([st.closing, st.prev, st.cur, st.rows.length, st.warn], [exp.closing, v, v, 0, undefined], `tcb no transactions ${v} dx=${dx}`);
  }

  // the sanity check only flags: a zero still missing from one amount (right edges disagree)
  let bad = clone(base);
  const p1 = String(ORIG[2]), cut = p1.slice(0, -1); // first purchase, last digit dropped (as if it were a lost zero)
  const aP1 = bad.pages[1].items.find((it) => it.s === p1);
  Object.assign(aP1, { s: cut, x1: aP1.x1 - 4.5, w: aP1.w - 4.5 });
  let st = tcb.parse(bad);
  eq([st.prev, st.cur, amounts(st), st.warn], [exp.prev, exp.cur, [xr[0], +cut, xr[2], xr[3], xr[4]], '合庫金額位置不一致，請人工核對'], 'tcb lost zero is flagged, not rescaled');
  // the whole column shifted after reading: nothing rescaled, no warn
  bad = clone(base);
  for (const it of bad.pages[1].items) if (it.x >= 290 && it.x < 350 && /^[0-9,\-]+$/.test(it.s)) { it.x -= 4.5; it.x1 -= 4.5; }
  st = tcb.parse(bad);
  eq([st.prev, st.cur, amounts(st), st.warn], [exp.prev, exp.cur, xr, undefined], 'tcb shifted after read');
  // operator list unreadable: core falls back to the narrow-blank rule, the statement is flagged
  const noOps = (doc) => ({ numPages: doc.numPages, getPage: async (n) => {
    const p = await doc.getPage(n);
    return { getViewport: (o) => p.getViewport(o), getTextContent: (o) => p.getTextContent(o), getOperatorList: async () => { throw new Error('x'); } };
  } });
  const fb = await readBytes(variant({ amounts: ALL0 }), noOps);
  ok(fb.swapped && fb.pages.every((pg) => !pg.glyphZeros), 'tcb fallback read has no glyphZeros');
  st = tcb.parse(fb);
  eq(st.warn, '合庫的 0 無法辨識，請人工核對', 'tcb fallback read flagged');
  // operator list readable but yields no zero glyph (empty, or a font whose '0' is not U+3000) while the
  // text layer has blanks: treated as unreadable -> fallback rule + warn, never silently /10
  const emptyOps = (doc) => ({ numPages: doc.numPages, getPage: async (n) => {
    const p = await doc.getPage(n);
    return { getViewport: (o) => p.getViewport(o), getTextContent: (o) => p.getTextContent(o),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }), commonObjs: p.commonObjs };
  } });
  const eo = await readBytes(variant({ amounts: [1230, -1230, 4560, 7890, 2340, 13560, -10, 13550] }), emptyOps);
  ok(eo.swapped && eo.pages.every((pg) => !pg.glyphZeros), 'tcb empty operator list: no glyphZeros');
  st = tcb.parse(eo);
  eq(st.warn, '合庫的 0 無法辨識，請人工核對', 'tcb empty operator list flagged');
  eq(amounts(st), [-123, 456, 789, 234, -1], 'tcb empty operator list: blank-item fallback used');
  // page structure missing (no END rule, no amounts at all) -> still 可能改版
  const broken = clone(base);
  broken.pages[1].items = broken.pages[1].items.filter((it) => !/^-{5}/.test(it.s) && !/^[0-9,\-]+$/.test(it.s));
  throwsMsg(() => tcb.parse(broken), /可能改版/, 'tcb no structure');
  eq((CC.banks.detect(base) || {}).id, 'tcb', 'detect(TCB fixture)');
}

(async () => {
  let st;
  if (need(['expected.json', 'pdf/TCB.pdf'], 'banks_edge: 合作金庫 cases built from the real TCB.pdf')) await tcbFixtureCases();

  /* ---------- 台北富邦: first-match closing / totals, missing closing ---------- */
  const fubon = CC.banks.byId('fubon');
  const fubonPage1 = () => [
    item('帳單年月', 25, 257), item('帳單結帳日', 215, 257), item('繳款截止日', 275, 257),
    item('115/03', 30, 276, 5), item('115/03/22', 218, 276, 5), item('115/04/09', 280, 276, 5),
    item('前期應繳總額', 23, 334), item('繳(退)金額', 100, 334), item('本期應繳總額', 297, 334),
    ...['25', '410', '0', '57', '-328'].map((s, i) => item(s, 50 + 70 * i, 355, 5)),
    item('115/03/02', 28, 559, 5), item('刷卡金入帳', 80, 559), item('115/03/02', 288, 559, 5), item('-410', 554, 559, 5),
  ];
  const fubonPage2 = [ // notes on a later page: label + other dates / numbers right below
    item('提醒您帳單結帳日如遇連續假日，本行將提前至該連續假日首日結算。', 20, 100),
    item('115/12/01', 218, 112, 5), item('115/12/31', 300, 112, 5),
    item('註：繳(退)金額', 20, 140),
    ...['1', '2', '3', '4', '5'].map((s, i) => item(s, 50 + 70 * i, 152, 5)),
  ];
  st = fubon.parse({ pages: [{ num: 1, items: fubonPage1() }, { num: 2, items: fubonPage2 }] });
  eq([st.closing, st.prev, st.cur, amounts(st)], ['2026-03-22', 25, -328, [-410]], 'fubon first match');
  throwsMsg(() => fubon.parse({ pages: [{ num: 1, items: fubonPage1().filter((it) => it.s !== '帳單結帳日') }] }),
    /^找不到結帳日（可能改版）$/, 'fubon missing closing');

  /* ---------- finish(): missing closing on 第一銀行 / 臺灣銀行 ---------- */
  const first = CC.banks.byId('first');
  const firstItems = (withDate) => {
    const segs = ['新臺幣', '100', '100', '0', '50', '50', 'x', withDate ? '115/10/10' : '-'];
    return segs.map((s, i) => item(s, 10 + 60 * i, 50, 5));
  };
  st = first.parse({ pages: [{ num: 1, items: firstItems(true) }] });
  eq([st.closing, st.prev, st.cur], ['2026-10-10', 100, 50], 'first synthetic');
  throwsMsg(() => first.parse({ pages: [{ num: 1, items: firstItems(false) }] }), /^找不到結帳日（可能改版）$/, 'first missing closing');
  const bot = CC.banks.byId('bot');
  const botItems = [item('前期應繳總金額', 20, 50), ...['10', '10', '0', '5', '0', '5'].map((s, i) => item(s, 20 + 60 * i, 62, 5))];
  throwsMsg(() => bot.parse({ pages: [{ num: 1, items: botItems }] }), /^找不到結帳日（可能改版）$/, 'bot missing closing');
  st = bot.parse({ pages: [{ num: 1, items: [item('結帳日115/10/20', 20, 30, 5), ...botItems] }] });
  eq([st.closing, st.prev, st.cur], ['2026-10-20', 10, 5], 'bot synthetic');

  /* ---------- 繳款截止日: per-bank synthetic layouts, 無需繳款, sanity window ---------- */
  eq(fubon.parse({ pages: [{ num: 1, items: fubonPage1() }] }).due, '2026-04-09', 'fubon due under its label');
  st = fubon.parse({ pages: [{ num: 1, items: fubonPage1().map((it) => (it.s === '115/04/09' ? item('無需繳款', 280, 276) : it)) }] });
  eq([st.closing, st.due], ['2026-03-22', undefined], 'fubon 無需繳款: no due, closing unaffected');
  const botDue = (s) => bot.parse({ pages: [{ num: 1, items: [item('結帳日115/10/20', 20, 30, 5), item(s, 200, 30, 5), ...botItems] }] }).due;
  eq(botDue('繳款截止日(02)2182-115/11/05'), '2026-11-05', 'bot due after the phone number');
  eq(botDue('繳款截止日(02)2182-無須繳款'), undefined, 'bot 無須繳款');
  const tsb = CC.banks.byId('tsb');
  const tsbItems = (due) => [item('帳單結帳日', 61, 167), item('115/10/18', 175, 167, 5), item('繳款截止日', 61, 184), item(due, 175, 184, 5),
    item('上期應繳總額', 61, 200), item('3,087', 190, 200, 5), item('=本期累計應繳金額', 61, 220), item('4,703', 190, 220, 5)];
  eq(tsb.parse({ pages: [{ num: 1, items: tsbItems('115/11/02') }] }).due, '2026-11-02', 'tsb due');
  eq(tsb.parse({ pages: [{ num: 1, items: tsbItems('115/10/18') }] }).due, undefined, 'due == closing dropped');
  eq(tsb.parse({ pages: [{ num: 1, items: tsbItems('115/10/24') }] }).due, undefined, 'due 6 days after closing dropped');
  eq(tsb.parse({ pages: [{ num: 1, items: tsbItems('115/10/25') }] }).due, '2026-10-25', 'due 7 days after closing kept');
  eq(tsb.parse({ pages: [{ num: 1, items: tsbItems('115/11/22') }] }).due, '2026-11-22', 'due 35 days after closing kept');
  eq(tsb.parse({ pages: [{ num: 1, items: tsbItems('115/11/23') }] }).due, undefined, 'due 36 days after closing dropped');
  const mega = CC.banks.byId('mega');
  st = mega.parse({ pages: [{ num: 1, items: [item('結 帳 日 期', 273, 91), item('115/10/15', 271, 105, 5),
    item('上期待繳總額', 112, 177), item('已 繳 金 額', 179, 177), item('本期待繳總額', 355, 177), item('繳 款 截 止 日', 474, 177),
    ...['1,561.00', '1,561.00', '0.00', '0.00', '0.00', '0.00'].map((s, i) => item(s, 119 + 52 * i, 195, 5)), item('115/10/30', 477, 195, 5)] }] });
  eq([st.closing, st.prev, st.cur, st.due], ['2026-10-15', 1561, 0, '2026-10-30'], 'mega due at the end of the totals row');
  const firstDue = (dueY) => first.parse({ pages: [{ num: 1, items: [...firstItems(true), item('115/10/10', 517, 238, 5), item('115/10/25', 517, dueY, 5)] }] }).due;
  eq(firstDue(258), '2026-10-25', 'first due right below the closing date');
  eq(firstDue(290), undefined, 'first: a date more than 40pt below is not the due date');
  const ctbc = CC.banks.byId('ctbc');
  st = ctbc.parse({ pages: [{ num: 1, items: [item('115/11/05', 222, 216, 5), item('400,000', 527, 216, 5),
    item('115/10/18', 19, 400, 5), ...['7,681', '1,717', '0', '7,681', '0', '+1,717'].map((s, i) => item(s, 111 + 80 * i, 400, 5))] }] });
  eq([st.closing, st.cur, st.due], ['2026-10-18', 1717, '2026-11-05'], 'ctbc due on page 1');
  const tcb = CC.banks.byId('tcb');
  const tcbDue = (s) => tcb.parse({ pages: [
    { num: 1, items: [item('115/10/01', 59, 250, 5), item(s, 134, 250, 5), item('315', 276, 250, 5)] },
    { num: 2, items: [item('0', 310, 80, 5), item('115/09/20', 30, 100, 5), item('500', 300, 100, 5), item('500', 300, 120, 5), item('-----', 20, 140)] },
  ] });
  st = tcbDue('115?10?15?');
  eq([st.closing, st.prev, st.cur, st.due], ['2026-10-01', 0, 500, '2026-10-15'], 'tcb due: 年月日 read as ?');
  eq(tcbDue('315').due, undefined, 'tcb: an amount right of the closing date is not a due date');

  /* ---------- 繳款截止日 on the real statements (hand-checked against paper: fixtures/expected_due.json) ---------- */
  if (need(['pdf', 'expected_due.json'], 'banks_edge: 繳款截止日 on the real statements')) {
    const dues = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/expected_due.json'), 'utf8'));
    for (const [file, due] of Object.entries(dues)) {
      const rd = await readFixture(file);
      eq(CC.banks.detect(rd).parse(rd).due || null, due, `${file} due`);
    }
  }

  /* ---------- core.read on a synthetic swapped page: real spaces, foreign U+3000 ---------- */
  {
    const OPS = globalThis.pdfjsLib.OPS, H = 800;
    const sw = (t) => Array.from(t, (c) => String.fromCharCode(c.charCodeAt(0) << 8)).join(''); // '1' -> U+3100
    // glyph runs: [font, x, baseline, chars]; F1 = byte-swapped digits ('0' drawn as U+3000), F2 = normal CJK
    const runs = [
      ['F1', 50, 100, '12345678912345678912345'], // enough swapped text for isSwapped
      ['F1', 100, 200, '105'], // inner zero -> text layer '1 5'
      ['F1', 200, 200, '2 / 2'], // page counter with real spaces, no zero
      ['F2', 300, 200, '帳單\u3000'], // a real full-width space right after a CJK item
    ];
    const glyph = (f, c) => {
      if (f === 'F2') return { unicode: c, width: 1000, isSpace: c === '\u3000' };
      if (c === '0') return { unicode: '\u3000', width: 500, isSpace: true };
      if (c === ' ') return { unicode: '\u2000', width: 500, isSpace: true };
      return { unicode: String.fromCharCode(c.charCodeAt(0) << 8), width: 500 };
    };
    const fn = [], args = [];
    for (const [f, x, b, t] of runs) {
      fn.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText);
      args.push([], [f, 9], [1, 0, 0, 1, x, H - b], [Array.from(t, (c) => glyph(f, c))]);
    }
    const ti = (str, x, b, w) => ({ str, transform: [9, 0, 0, 9, x, H - b], width: w, height: 9 });
    const items = [ti(sw(runs[0][3]), 50, 100, 103.5), ti(sw('1') + ' ' + sw('5'), 100, 200, 13.5),
      ti(sw('2') + ' ' + sw('/') + ' ' + sw('2'), 200, 200, 22.5), ti('帳單', 300, 200, 18)];
    const page = { getViewport: () => ({ width: 600, height: H }), getTextContent: async () => ({ items }),
      getOperatorList: async () => ({ fnArray: fn, argsArray: args }), commonObjs: { get: () => { throw new Error('none'); } } };
    const zs = await CC.pdf.zeroGlyphs(page, H);
    eq(zs.map((z) => +z.x0.toFixed(2)), [104.5], 'zeroGlyphs: only the swapped font\'s U+3000');
    const rd = await CC.pdf.read({ numPages: 1, getPage: async () => page });
    const ss = rd.pages[0].items.map((it) => it.s);
    ok(rd.swapped && rd.pages[0].glyphZeros, 'synthetic swapped page read with glyph zeros');
    ok(ss.includes('105'), 'inner zero restored at its glyph: ' + ss);
    ok(ss.includes('2 / 2'), 'real spaces kept when zero positions are known: ' + ss);
    ok(ss.includes('帳單') && !ss.some((s) => /帳單0|^0$/.test(s)), 'CJK font full-width space is not a zero: ' + ss);
    eq(CC.pdf.fillZeros('1 5 7', 0, 22.5, [{ x0: 13.5, x1: 18 }]), '1 507', 'fillZeros: nearest space only');
    eq(CC.pdf.fillZeros('2 / 2', 0, 22.5, []), '2 / 2', 'fillZeros: no zeros, nothing replaced');
  }

  /* ---------- detect: byte-swapped font alone is not 合庫 ---------- */
  ok(CC.banks.detect({ swapped: true, text: 'hello world 1234-5678', pages: [] }) === null, 'detect(swapped, no keys) -> null');
  ok(CC.banks.detect({ swapped: true, text: '', pages: [] }) === null, 'detect(swapped, empty) -> null');
  eq((CC.banks.detect({ swapped: true, text: 'call 2227-3131', pages: [] }) || {}).id, 'tcb', 'detect(swapped + 1 tcb key)');
  eq((CC.banks.detect({ swapped: true, text: 'www.fubon.com', pages: [] }) || {}).id, 'fubon', 'detect(swapped + fubon key)');
  ok(CC.banks.detect({ swapped: true, text: 'tcb-bank.com.tw fubon.com', pages: [] }).id === 'tcb', 'detect(swapped breaks tcb/fubon tie)');

  l(`\n${checks - fails}/${checks} checks passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.warn = w; console.log = l; console.error(e); process.exit(1); });
