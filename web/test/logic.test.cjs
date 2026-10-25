// node test/logic.test.cjs — settings / classify / reconcile / export (agent C)
const path = require('path');
const fs = require('fs');
const assert = require('assert');

globalThis.pdfjsLib = globalThis.pdfjsLib || {}; // not needed here; skips pdf.js load in node_env
globalThis.ExcelJS = require(path.join(__dirname, '../vendor/exceljs.min.js'));
const CC = require('./node_env.cjs')(['core.js', 'settings.js', 'classify.js', 'export.js']);

const { FIX, need } = require('./private.cjs');
// Private fixtures (gitignored): the Python reference output, the owner's workbook and settings JSON.
const HAVE_EXP = need(['expected.json', '分類參考.xlsx'], 'logic.test: process() vs expected.json (Python reference)');
const HAVE_WB = HAVE_EXP || need(['分類參考.xlsx'], 'logic.test: importWorkbook on the owner workbook');
const PERSONAL = path.join(FIX, 'personal-settings.json');
const expected = HAVE_EXP ? JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8')) : {};
const BANK_ID = { 台北富邦: 'fubon', 中國信託: 'ctbc', 兆豐: 'mega', 台新: 'tsb', 第一銀行: 'first', 合作金庫: 'tcb', 臺灣銀行: 'bot' };
const BANK_NAME = Object.fromEntries(Object.entries(BANK_ID).map(([n, id]) => [id, n]));
const KEYS = ['sheet', 'date', 'type', 'desc', 'card', 'amount', 'guess', 'ocr'];

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).toString().split('\n').slice(0, 6).join('\n       ')); }
}
const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

(async () => {
  console.log('logic.test');
  const S = CC.settings, C = CC.classify;

  // ---------------- ratio vs difflib ----------------
  await t('ratio() matches difflib.SequenceMatcher', () => {
    const cases = [
      ['abcd', 'bcde', 0.75],
      ['PI－好好付星光商城', 'PI－好好付＿星光商城', 0.9523809523809523],
      ['kitten', 'sitting', 0.6153846153846154],
      ['松竹石油-青田路站自助加油(A7', '松竹石油－青田路站自助加油（A7', 0.875],
      ['aaabbb', 'ababab', 0.6666666666666666],
      ['', 'x', 0.0],
      ['private Thread', 'private volatile Thread', 0.7567567567567568],
      ['ab'.repeat(120) + 'xyz', 'ba'.repeat(110) + 'xyzq' + 'a'.repeat(10), 0.012578616352201259], // autojunk
    ];
    for (const [a, b, r] of cases) assert.strictEqual(C.ratio(a, b), r, `${a} / ${b}`);
  });

  // ---------------- settings ----------------
  let s;
  await t('load() without localStorage returns defaults', () => {
    s = S.load();
    assert.strictEqual(s.dateMode, '帳單日');
    assert.strictEqual(s.cards.tcb.name, '合庫信用卡');
    assert.strictEqual(s.cards.mega.name, '兆豐信用卡');
    assert.strictEqual(s.cards.ctbc.name, '中國信託信用卡');
    assert.strictEqual(Object.keys(s.cards).length, 7);
    for (const [id, c] of Object.entries(s.cards)) {
      assert.ok(/^\S+信用卡$/.test(c.name), id + ' neutral card name');
      assert.strictEqual(c.defaultType, '日用其他', id + ' neutral defaultType');
    }
    assert.deepStrictEqual(s.cardByLast4, {}); assert.deepStrictEqual(s.learned, {});
    const words = s.rules.flatMap((r) => r.words);
    for (const w of ['7-ELEVEN', '台灣電力', 'MOMO', 'ETAG', '中油']) assert.ok(words.includes(w), 'generic rule ' + w);
    assert.ok(s.rules.every((r) => s.fixedTypes.includes(r.type) || s.floatingTypes.includes(r.type)), 'rule types are known types');
    assert.strictEqual(s.fixedTypes.length, 21);
    assert.strictEqual(s.floatingTypes.length, 24);
    assert.deepStrictEqual(s.ocrFix.slice(-2), [['連二', '連＿'], ['连二', '連＿']]);
    assert.strictEqual(S.save(s), false);
  });

  await t('load()/save() with a throwing localStorage do not throw', () => {
    globalThis.localStorage = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
    assert.strictEqual(S.load().dateMode, '帳單日');
    assert.strictEqual(S.save(s), false);
    const mem = {};
    globalThis.localStorage = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); } };
    const s2 = S.load(); s2.dateMode = '入帳日'; s2.cardByLast4 = { 1234: '我的副卡' };
    assert.strictEqual(S.save(s2), true);
    const s3 = S.load();
    assert.strictEqual(s3.dateMode, '入帳日'); assert.strictEqual(s3.cardByLast4['1234'], '我的副卡');
    mem['cc-settings-v1'] = '{broken';
    assert.strictEqual(S.load().dateMode, '帳單日');
    delete globalThis.localStorage;
  });

  // Settings for the fixture comparison: the owner's personal settings (when present) + the owner's workbook.
  let wbRes, sx = S.defaults();
  if (fs.existsSync(PERSONAL)) {
    await t('personal-settings.json imports via importJSON', () => {
      sx = S.importJSON(fs.readFileSync(PERSONAL, 'utf8'));
      assert.ok(sx && sx.cards && Array.isArray(sx.rules));
    });
  } else if (HAVE_EXP) console.log('  note test/fixtures/personal-settings.json absent: comparing with the neutral defaults');
  if (HAVE_WB) await t('importWorkbook learns from 分類參考.xlsx', async () => {
    wbRes = await S.importWorkbook(toAB(fs.readFileSync(path.join(FIX, '分類參考.xlsx'))));
    assert.strictEqual(wbRes.count, 47); // Python load_history: 47 keys, 0 conflicts
    assert.strictEqual(wbRes.conflicts, 0);
    assert.strictEqual(wbRes.count, Object.keys(wbRes.learned).length);
    assert.strictEqual(wbRes.conflicts, Object.values(wbRes.learned).filter((v) => v.conflict).length);
    S.applyWorkbook(sx, wbRes);
    for (const [k, v] of Object.entries(wbRes.learned)) {
      assert.strictEqual(k, CC.util.norm(v.desc), 'learned key is norm(desc)');
      assert.deepStrictEqual(sx.learned[k], { desc: v.desc, type: v.type, src: 'workbook' });
    }
    console.log(`       (${wbRes.count} 摘要, ${wbRes.conflicts} conflicts)`);
  });

  await t('importWorkbook rejects garbage with Chinese message', async () => {
    await assert.rejects(S.importWorkbook(new ArrayBuffer(8)), (e) => /[一-鿿]/.test(e.message));
  });

  await t('importWorkbook marks conflicts; learn() clears them; 固定 types added', async () => {
    const wb = new ExcelJS.Workbook();
    const f = wb.addWorksheet('固定'), v = wb.addWorksheet('浮動');
    for (const ws of [f, v]) ws.addRow(['日期', '消費類型', '摘要']);
    f.addRow([new Date(), '自訂固定', '某某　社區']);
    v.addRow([new Date(), '外食', { richText: [{ text: 'ＡＢＣ' }, { text: ' 小吃' }] }]);
    v.addRow([new Date(), '點心', 'abc小吃']);
    v.addRow([new Date(), null, '沒類型']);
    const res = await S.importWorkbook(await wb.xlsx.writeBuffer());
    assert.strictEqual(res.count, 2); assert.strictEqual(res.conflicts, 1);
    assert.deepStrictEqual(res.learned['ABC小吃'], { desc: 'abc小吃', type: '點心', conflict: true });
    assert.strictEqual(S.applyWorkbook(S.defaults(), res).learned['ABC小吃'].src, 'workbook');
    assert.ok(res.fixedTypes.includes('自訂固定') && res.fixedTypes.includes('電費'));
    const s2 = S.applyWorkbook(S.defaults(), res);
    assert.deepStrictEqual(C.classify('ABC 小吃', 'x', s2, null), { type: '點心', guess: true });
    assert.strictEqual(C.sheetOf('自訂固定', s2), '固定');
    S.learn(s2, 'abc小吃', '外食');
    assert.deepStrictEqual(C.classify('ABC 小吃', 'x', s2, null), { type: '外食', guess: false });
  });

  // ---------------- process vs Python (private fixtures) ----------------
  let allRows = [], checks = [];
  for (const [file, v] of Object.entries(expected)) {
    await t(`process ${file} == Python output`, () => {
      const bank = BANK_ID[v.bank]; assert.ok(bank, v.bank);
      const st = { closing: v.closing, prev: v.prev, cur: v.cur, rows: v.rows.map((r) => ({ ...r, ocr: r.ocr ? { page: 1, y: 0, x0: 0, x1: 0 } : null })) };
      const out = C.process(st, bank, sx, file);
      const got = out.map((o) => Object.fromEntries(KEYS.map((k) => [k, o[k]])));
      const want = v.output.map((o) => Object.fromEntries(KEYS.map((k) => [k, o[k]])));
      if (process.env.DBG) console.log(JSON.stringify(got), JSON.stringify(want));
      assert.deepStrictEqual(got, want);
      for (const o of out) {
        assert.strictEqual(o.bank, bank); assert.strictEqual(o.file, file); assert.strictEqual(o.confirmed, false);
        assert.ok(['payment', 'reward', 'fee', 'purchase'].includes(o.kind));
      }
      const rc = CC.reconcile(st);
      assert.ok(rc.ok, `reconcile ${JSON.stringify(rc)}`);
      allRows.push(...out);
      checks.push({ file, bank, closing: v.closing, prev: v.prev, cur: v.cur, total: rc.total, expect: rc.expect, ok: rc.ok, count: out.length });
    });
  }
  if (HAVE_EXP) await t('totals match expected.json (rows, 固定 / 浮動)', () => {
    const outs = Object.values(expected).flatMap((v) => v.output);
    assert.strictEqual(allRows.length, outs.length);
    assert.strictEqual(allRows.filter((r) => r.sheet === '固定').length, outs.filter((o) => o.sheet === '固定').length);
    assert.strictEqual(allRows.filter((r) => r.sheet === '浮動').length, outs.filter((o) => o.sheet === '浮動').length);
    assert.ok(allRows.some((r) => r.sheet === '固定') && allRows.some((r) => r.sheet === '浮動') && allRows.some((r) => r.ocr));
    const ck = Object.keys(sx.learned).find((k) => sx.learned[k].conflict);
    if (ck) {
      assert.strictEqual(C.classify(sx.learned[ck].desc, 'x', sx, null).guess, true);
      const s2 = S.learn(JSON.parse(JSON.stringify(sx)), sx.learned[ck].desc, '書籍');
      assert.deepStrictEqual(C.classify(sx.learned[ck].desc, 'x', s2, null), { type: '書籍', guess: false });
    }
  });

  // ---------------- synthetic statements (invented merchants / amounts) ----------------
  // su: neutral defaults + two customised cards + an invented learned history with one conflict.
  const su = S.defaults();
  su.cards.mega.defaultType = '外食'; su.cards.tcb.defaultType = '加油';
  S.applyWorkbook(su, { learned: {
    [CC.util.norm('好好付＿星光商城')]: { desc: '好好付＿星光商城', type: '日用其他' },
    [CC.util.norm('雙面小館')]: { desc: '雙面小館', type: '外食', conflict: true },
  }, fixedTypes: [] });
  const synth = [
    { file: 'bot-synthetic.pdf', bank: 'bot', st: { closing: '2026-03-20', prev: 1000, cur: 640, rows: [
      { date: '2026-03-02', post: '2026-03-02', desc: '感謝您以自動授扣繳款', amount: -1000, last4: '', ocr: null },
      { date: '2026-03-05', post: '2026-03-06', desc: '星光小吃店', amount: 250, last4: '0001', ocr: null },
      { date: '2026-03-07', post: '2026-03-09', desc: '台灣電力公司', amount: 390, last4: '0001', ocr: null },
    ] } },
    { file: 'ctbc-synthetic.pdf', bank: 'ctbc', st: { closing: '2026-03-18', prev: 0, cur: 520, rows: [
      { date: '2026-03-01', post: '2026-03-03', desc: '好好付二星光商城', amount: 300, last4: '0002', ocr: { page: 1, y: 0, x0: 0, x1: 0 } },
      { date: '2026-03-04', post: '2026-03-05', desc: '7-ELEVEN 青田門市', amount: 120, last4: '0002', ocr: null },
      { date: '2026-03-08', post: '2026-03-10', desc: '中華電信0912', amount: 100, last4: '0002', ocr: null },
    ] } },
  ];
  const synRows = [], synChecks = [];
  await t('process() on synthetic statements', () => {
    for (const { file, bank, st } of synth) {
      const out = C.process(st, bank, su, file), rc = CC.reconcile(st);
      assert.ok(rc.ok, `reconcile ${file}`);
      synRows.push(...out);
      synChecks.push({ file, bank, closing: st.closing, prev: st.prev, cur: st.cur, total: rc.total, expect: rc.expect, ok: rc.ok, count: out.length });
    }
    const got = synRows.map((o) => [o.sheet, o.date, o.type, o.desc, o.card, o.amount, o.guess, o.ocr]);
    assert.deepStrictEqual(got, [
      ['浮動', '2026-03-20', '日用其他', '星光小吃店', '臺銀信用卡', 250, true, false],
      ['固定', '2026-03-20', '電費', '台灣電力公司', '臺銀信用卡', 390, false, false],
      ['浮動', '2026-03-18', '日用其他', '好好付＿星光商城', '中國信託信用卡', 300, false, true],
      ['浮動', '2026-03-18', '外食', '7-ELEVEN 青田門市', '中國信託信用卡', 120, false, false],
      ['固定', '2026-03-18', '電話費(行動)', '中華電信0912', '中國信託信用卡', 100, false, false],
    ]);
  });
  if (!HAVE_EXP) { allRows = synRows; checks = synChecks; } // export tests below use whichever set is available

  // ---------------- classify unit checks ----------------
  await t('classify order / guesses / kind / dateMode / inst', () => {
    const cl = (d, card = '中國信託信用卡', p = null) => C.classify(d, card, su, p);
    assert.deepStrictEqual(cl('國外交易服務費', 'x', '娛樂費'), { type: '娛樂費', guess: false });
    assert.deepStrictEqual(cl('折抵_台灣電力公司'), { type: '電費', guess: false });
    assert.deepStrictEqual(cl('ｍｏｍｏ購物網'), { type: '日用其他', guess: false });
    assert.deepStrictEqual(cl('完全沒看過的店', '兆豐信用卡'), { type: '外食', guess: true });
    assert.deepStrictEqual(cl('完全沒看過的店', '自訂卡'), { type: '日用其他', guess: true });
    assert.deepStrictEqual(cl('完全沒看過的店'), { type: '日用其他', guess: true });
    assert.deepStrictEqual(cl('現金回饋 1%', '合庫信用卡'), { type: '加油', guess: false });
    assert.deepStrictEqual(C.classify('完全沒看過的店', '兆豐信用卡', S.defaults(), null), { type: '日用其他', guess: true });
    assert.deepStrictEqual(cl('雙面小館'), { type: '外食', guess: true }); // conflict → still a guess
    const s2 = S.learn(JSON.parse(JSON.stringify(su)), '雙面小館', '書籍');
    assert.deepStrictEqual(C.classify('雙面小館', 'x', s2, null), { type: '書籍', guess: false });
    assert.strictEqual(C.isPayment('感謝您以自動授扣繳款', -4321), true);
    assert.strictEqual(C.kind('感謝您以自動授扣繳款', -4321), 'payment');
    assert.strictEqual(C.kind('現金回饋', -3), 'reward');
    assert.strictEqual(C.kind('國外交易服務費', 5), 'fee');
    assert.strictEqual(C.kind('星光超市', 50), 'purchase');
    assert.strictEqual(C.pyRound(2.5), 2); assert.strictEqual(C.pyRound(3.5), 4); assert.strictEqual(C.pyRound(-2.5), -2);
    assert.strictEqual(C.pyRound(-2.6), -3);
    const st = { closing: '2026-10-18', prev: 0, cur: 100, rows: [{ date: '2026-09-01', post: '2026-09-03', desc: '某店 分期 2/6', amount: 100, last4: '1234', ocr: null }] };
    const s3 = JSON.parse(JSON.stringify(su)); s3.cardByLast4 = { 1234: '我的副卡' };
    for (const [m, d] of [['帳單日', '2026-10-18'], ['入帳日', '2026-09-03'], ['消費日', '2026-09-01']]) {
      s3.dateMode = m;
      const [o] = C.process(st, 'fubon', s3, 'f.pdf');
      assert.strictEqual(o.date, d); assert.strictEqual(o.inst, '2/6'); assert.strictEqual(o.card, '我的副卡');
    }
    assert.deepStrictEqual(C.fixOcr('完全不同的東西', su), { desc: '完全不同的東西', matched: false });
    assert.deepStrictEqual(C.fixOcr('好好付二星光商城', su), { desc: '好好付＿星光商城', matched: true });
    assert.deepStrictEqual(C.fixOcr('x', { learned: {} }), { desc: 'x', matched: false });
    assert.strictEqual(CC.reconcile({ rows: [{ amount: 1 }], prev: null, cur: 1 }).ok, false);
  });

  // ---------------- settings JSON ----------------
  await t('exportJSON → importJSON round-trip; validation', () => {
    for (const x of [s, su, sx]) {
      const back = S.importJSON(S.exportJSON(x));
      assert.deepStrictEqual(back, JSON.parse(JSON.stringify(x)));
    }
    const zh = (e) => e instanceof Error && /[一-鿿]/.test(e.message);
    assert.throws(() => S.importJSON('garbage'), zh);
    assert.throws(() => S.importJSON('[1,2]'), zh);
    assert.throws(() => S.importJSON('{"dateMode":"明天"}'), zh);
    assert.throws(() => S.importJSON('{"rules":[{"words":"x","type":"y"}]}'), zh);
    assert.throws(() => S.importJSON('{"learned":{"A":1}}'), zh);
    assert.strictEqual(S.importJSON('{"dateMode":"消費日"}').cards.ctbc.name, '中國信託信用卡');
  });

  // ---------------- export ----------------
  await t('toTSV header and rows', () => {
    const tsv = CC.exporter.toTSV(allRows.filter((r) => r.sheet === '固定'));
    const lines = tsv.split('\n');
    assert.strictEqual(lines[0], '日期\t消費類型\t摘要\t消費方式\t分期數\t金額');
    assert.strictEqual(lines.length, allRows.filter((r) => r.sheet === '固定').length + 1);
    assert.ok(lines.length > 1);
    assert.ok(/^\d{4}\/\d{1,2}\/\d{1,2}\t/.test(lines[1]), lines[1]);
    assert.ok(lines.every((l) => l.split('\t').length === 6));
  });

  await t('toXlsx round-trips via ExcelJS', async () => {
    const rows = allRows.map((r) => ({ ...r }));
    rows.find((r) => r.sheet === '浮動').guess = true; // force one yellow cell
    const bad = checks.map((c) => ({ ...c })); bad[0].ok = false;
    const buf = await CC.exporter.toXlsx(rows, bad);
    assert.ok(buf instanceof ArrayBuffer);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ['固定', '浮動', '核對結果']);
    const fx = wb.getWorksheet('固定'), fl = wb.getWorksheet('浮動'), ck = wb.getWorksheet('核對結果');
    assert.strictEqual(fx.rowCount - 1, rows.filter((r) => r.sheet === '固定').length);
    assert.strictEqual(fl.rowCount - 1, rows.filter((r) => r.sheet === '浮動').length);
    assert.strictEqual(fx.getRow(1).getCell(1).value, '日期'); assert.strictEqual(fx.getRow(1).getCell(1).font.bold, true);
    const d = fl.getRow(2).getCell(1);
    assert.ok(d.value instanceof Date, 'date cell'); assert.strictEqual(d.numFmt, 'yyyy/m/d');
    const sorted = CC.exporter.sortRows(rows.filter((r) => r.sheet === '浮動'));
    assert.strictEqual(d.value.toISOString().slice(0, 10), sorted[0].date);
    assert.strictEqual(fl.getRow(2).getCell(4).value, sorted[0].card);
    assert.strictEqual(fl.getRow(2).getCell(6).value, sorted[0].amount);
    sorted.forEach((x, i) => {
      const r = fl.getRow(i + 2);
      const f2 = r.getCell(2).fill, f3 = r.getCell(3).fill;
      assert.strictEqual(!!(f2 && f2.fgColor && f2.fgColor.argb === 'FFFFF2CC'), !!x.guess, 'guess fill row ' + (i + 2));
      assert.strictEqual(!!(f3 && f3.fgColor && f3.fgColor.argb === 'FFDDEBF7'), !!x.ocr, 'ocr fill row ' + (i + 2));
    });
    assert.strictEqual(sorted.filter((x) => x.ocr).length, rows.filter((r) => r.sheet === '浮動' && r.ocr).length);
    assert.ok(sorted.some((x) => x.ocr));
    assert.strictEqual(fl.getColumn(3).width, 45);
    assert.strictEqual(fl.views[0].state, 'frozen');
    assert.strictEqual(ck.getRow(1).getCell(6).value, '明細合計(含繳款)');
    assert.strictEqual(ck.getRow(2).getCell(8).value, '不符，請檢查');
    assert.strictEqual(ck.getRow(2).getCell(1).fill.fgColor.argb, 'FFF8CBAD');
    assert.strictEqual(ck.getRow(2).getCell(2).value, BANK_NAME[bad[0].bank]);
    assert.ok(ck.getRow(2).getCell(3).value instanceof Date);
    assert.strictEqual(ck.getRow(3).getCell(8).value, 'OK');
    assert.ok(!ck.getRow(3).getCell(1).fill || ck.getRow(3).getCell(1).fill.type !== 'pattern');
    assert.ok(String(ck.getRow(bad.length + 3).getCell(1).value).startsWith('說明：'));
    // confirmed rows lose their highlight
    const buf2 = await CC.exporter.toXlsx(rows.map((r) => ({ ...r, confirmed: true })), checks);
    const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(buf2);
    const ws2 = wb2.getWorksheet('浮動');
    for (let i = 2; i <= ws2.rowCount; i++) assert.ok(!ws2.getRow(i).getCell(3).fill || ws2.getRow(i).getCell(3).fill.type !== 'pattern');
  });

  await t('核對結果: 繳款截止日 appended last (date / 無需繳款 / empty)', async () => {
    const E = CC.exporter;
    assert.strictEqual(E.dueOf(100, '2026-11-02'), '2026-11-02');
    assert.strictEqual(E.dueOf(0, '2026-10-30'), '無需繳款');
    assert.strictEqual(E.dueOf(-240, undefined), '無需繳款');
    assert.strictEqual(E.dueOf(100, undefined), null);
    assert.strictEqual(E.dueOf(null, undefined), null); // failed statement
    const base = { bank: 'tsb', closing: '2026-10-18', prev: 0, total: 0, expect: 0, ok: true, count: 0 };
    const buf = await E.toXlsx([], [{ ...base, file: 'a.pdf', cur: 100, due: '2026-11-02' },
      { ...base, file: 'b.pdf', cur: -5, due: undefined }, { ...base, file: 'c.pdf', cur: 100 }]);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    const ck = wb.getWorksheet('核對結果');
    assert.strictEqual(ck.getRow(1).getCell(9).value, '輸出筆數'); // older columns stay put
    assert.strictEqual(ck.getRow(1).getCell(10).value, '繳款截止日');
    const d = ck.getRow(2).getCell(10);
    assert.ok(d.value instanceof Date); assert.strictEqual(d.value.toISOString().slice(0, 10), '2026-11-02');
    assert.strictEqual(d.numFmt, 'yyyy/m/d');
    assert.strictEqual(ck.getRow(3).getCell(10).value, '無需繳款');
    assert.strictEqual(ck.getRow(4).getCell(10).value, null);
    assert.strictEqual(ck.getColumn(10).width, 11);
  });

  await t('toTSV: 分期數 pasted as text ="3/12"; amounts stay numeric', () => {
    const E = CC.exporter;
    const rows = [
      { date: '2026-10-18', type: '外食', desc: '某店', card: '卡', inst: '3/12', amount: 100 },
      { date: '2026-10-18', type: '外食', desc: '回饋', card: '卡', inst: null, amount: -3 },
      { date: '2026-10-18', type: '外食', desc: '怪', card: '卡', inst: '=1+1', amount: 0.5 },
    ];
    const cells = E.toTSV(rows).split('\n').slice(1).map((l) => l.split('\t'));
    assert.strictEqual(cells[0][4], '="3/12"');
    assert.strictEqual(cells[0][5], '100');
    assert.strictEqual(cells[1][4], ''); assert.strictEqual(cells[1][5], '-3'); // negative amount NOT prefixed
    assert.strictEqual(cells[2][4], "'=1+1"); assert.strictEqual(cells[2][5], '0.5');
    assert.strictEqual(E.instCell(' 2/6 '), '="2/6"');
  });

  await t('toTSV neutralises formula-looking text cells (CSV injection)', () => {
    const E = CC.exporter;
    for (const d of ['=HYPERLINK("http://x","y")', '+1', '-2+3', '@SUM(A1)', '  =1', '\t=1', '\r=1'])
      assert.ok(E.textCell(d).startsWith("'"), JSON.stringify(d));
    for (const d of ['星光超市', 'a=b', '7-ELEVEN', '', null]) assert.ok(!E.textCell(d).startsWith("'"), String(d));
    const tsv = E.toTSV([{ date: '2026-10-01', type: '+外食', desc: '=cmd|"/c calc"!A0', card: '@卡', inst: null, amount: -5 }]);
    const c = tsv.split('\n')[1].split('\t');
    assert.strictEqual(c.length, 6);
    assert.deepStrictEqual(c.slice(1), ["'+外食", `'=cmd|"/c calc"!A0`, "'@卡", '', '-5']);
  });

  await t('textCell → unTSV round-trip over risky leading chars; plain apostrophes untouched', () => {
    const E = CC.exporter, flat = (x) => x.replace(/[\t\r\n]+/g, ' ');
    const leads = ['=', '+', '-', '@', '\t', '\r', ' ', '  ', ' =', '\t=', '\r-', '\t\t'];
    for (const a of leads) for (const b of ['', 'foo', '退款', "'x", '=1', "Domino's"]) {
      const raw = a + b, cell = E.textCell(raw);
      assert.ok(cell.startsWith("'") || !/^[\t\r\s]*[=+\-@]/.test(raw), JSON.stringify(raw));
      assert.strictEqual(S.unTSV(cell), flat(raw), JSON.stringify(raw));
    }
    for (const d of ["Domino's", "'quoted'", "'", "''", "McDonald's 麥當勞", '星光超市', 'a=b'])
      assert.strictEqual(S.unTSV(d), d, d);
    assert.strictEqual(S.unTSV(E.textCell('\tfoo')), ' foo');
  });

  await t('importJSON(str, current) merges cards per bank and field onto current', () => {
    const cur = S.defaults();
    cur.cards.fubon.defaultType = '娛樂'; cur.cards.tcb.name = '我的合庫';
    cur.cards.mine = { name: '自訂卡', defaultType: '外食' };
    const out = S.importJSON('{"cards":{"tcb":{"defaultType":"停車"}}}', cur);
    assert.strictEqual(out.cards.fubon.defaultType, '娛樂');
    assert.strictEqual(out.cards.tcb.name, '我的合庫');
    assert.strictEqual(out.cards.tcb.defaultType, '停車');
    assert.deepStrictEqual(out.cards.mine, { name: '自訂卡', defaultType: '外食' });
    const out2 = S.importJSON('{"cards":{"tcb":{"name":"新名"},"new":{"name":"N"}}}', cur);
    assert.strictEqual(out2.cards.tcb.name, '新名'); assert.strictEqual(out2.cards.tcb.defaultType, cur.cards.tcb.defaultType);
    assert.strictEqual(out2.cards.new.name, 'N');
    // without current: still merged onto defaults
    assert.strictEqual(S.importJSON('{"cards":{"tcb":{"defaultType":"停車"}}}').cards.fubon.defaultType, S.defaults().cards.fubon.defaultType);
  });

  await t('toXlsx writes formula-looking 摘要 / 分期數 as plain strings, amounts as numbers', async () => {
    const rows = [{ sheet: '浮動', date: '2026-10-01', type: '外食', desc: '=1+1', card: '卡', inst: '3/12', amount: -3 }];
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await CC.exporter.toXlsx(rows, []));
    const r = wb.getWorksheet('浮動').getRow(2);
    assert.strictEqual(r.getCell(3).value, '=1+1'); assert.strictEqual(r.getCell(3).type, ExcelJS.ValueType.String);
    assert.strictEqual(r.getCell(5).value, '3/12'); assert.strictEqual(r.getCell(5).type, ExcelJS.ValueType.String);
    assert.strictEqual(r.getCell(6).value, -3);
  });

  await t('learned src: learn()=manual, applyWorkbook never overwrites manual', () => {
    const s1 = S.defaults();
    S.learn(s1, '某店', '外食');
    assert.deepStrictEqual(s1.learned['某店'], { desc: '某店', type: '外食', src: 'manual' });
    S.applyWorkbook(s1, { learned: { 某店: { desc: '某店', type: '書籍' }, 別店: { desc: '別店', type: '點心', conflict: true } }, fixedTypes: [] });
    assert.strictEqual(s1.learned['某店'].type, '外食'); assert.strictEqual(s1.learned['某店'].src, 'manual');
    assert.deepStrictEqual(s1.learned['別店'], { desc: '別店', type: '點心', conflict: true, src: 'workbook' });
    S.applyWorkbook(s1, { learned: { 別店: { desc: '別店', type: '外食' } } });
    assert.deepStrictEqual(s1.learned['別店'], { desc: '別店', type: '外食', src: 'workbook' }); // workbook over workbook
    assert.deepStrictEqual(C.classify('某店', 'x', s1, null), { type: '外食', guess: false });
    // legacy entries without src load as 'workbook'
    const legacy = S.importJSON('{"learned":{"A":{"desc":"a","type":"外食"}}}');
    assert.deepStrictEqual(legacy.learned.A, { desc: 'a', type: '外食', src: 'workbook' });
    assert.throws(() => S.importJSON('{"learned":{"A":{"desc":"a","type":"x","src":"evil"}}}'), /格式錯誤/);
  });

  await t('importJSON(str, current) merges learned; other fields from import', () => {
    const cur = S.defaults();
    cur.fixedTypes.push('自訂固定');
    put(cur, '新規則', { desc: '新規則', type: '外食', src: 'workbook' });            // only in current → kept
    put(cur, '手改', { desc: '手改', type: '書籍', src: 'manual' });               // manual vs incoming workbook → kept
    put(cur, '舊WB', { desc: '舊WB', type: '外食', src: 'workbook' });             // workbook vs incoming manual → incoming
    put(cur, '雙手', { desc: '雙手', type: '外食', src: 'manual' });               // manual vs manual → incoming
    put(cur, '社區', { desc: '社區', type: '自訂固定', src: 'workbook' });
    function put(s, k, v) { s.learned[k] = v; }
    const backup = JSON.stringify({ version: 1, dateMode: '消費日', learned: {
      手改: { desc: '手改', type: '點心' },
      舊WB: { desc: '舊WB', type: '加油', src: 'manual' },
      雙手: { desc: '雙手', type: '點心', src: 'manual' },
      只在備份: { desc: '只在備份', type: '停車' },
    } });
    const out = S.importJSON(backup, cur);
    assert.strictEqual(out.dateMode, '消費日');
    assert.strictEqual(out.learned['新規則'].type, '外食');
    assert.deepStrictEqual(out.learned['手改'], { desc: '手改', type: '書籍', src: 'manual' });
    assert.deepStrictEqual(out.learned['舊WB'], { desc: '舊WB', type: '加油', src: 'manual' });
    assert.strictEqual(out.learned['雙手'].type, '點心');
    assert.deepStrictEqual(out.learned['只在備份'], { desc: '只在備份', type: '停車', src: 'workbook' });
    assert.ok(out.fixedTypes.includes('自訂固定'), 'fixed type of a kept entry survives');
    assert.strictEqual(C.sheetOf('自訂固定', out), '固定');
    // without current: as before (replace), still validated
    assert.strictEqual(Object.keys(S.importJSON(backup).learned).length, 4);
    assert.throws(() => S.importJSON('{"learned":5}', cur), /格式錯誤/);
    assert.strictEqual(cur.learned['手改'].type, '書籍'); // current not mutated
  });

  await t('importJSON: "__proto__" / "constructor" keys cannot pollute or break lookups', () => {
    const evil = '{"learned":{"__proto__":{"desc":"p","type":"外食","polluted":1},"constructor":{"desc":"c","type":"點心"},"__PROTO__":{"desc":"P","type":"加油"}},' +
      '"cardByLast4":{"__proto__":"X卡","1234":"Y卡"},"cards":{"__proto__":{"name":"Z卡","defaultType":"加油"}}}';
    for (const out of [S.importJSON(evil), S.importJSON(evil, S.defaults())]) {
      assert.strictEqual({}.polluted, undefined); assert.strictEqual(Object.prototype.desc, undefined);
      assert.strictEqual(Object.getPrototypeOf(out.learned), Object.prototype);
      assert.strictEqual(Object.getPrototypeOf(out.cardByLast4), Object.prototype);
      assert.strictEqual(Object.getPrototypeOf(out.cards), Object.prototype);
      assert.deepStrictEqual(Object.keys(out.learned).sort(), ['__PROTO__', '__proto__', 'constructor']);
      assert.strictEqual(out.learned['constructor'].type, '點心');
      assert.strictEqual(out.cardByLast4['1234'], 'Y卡');
      assert.strictEqual(out.learned['__proto__'].type, '外食');
      // norm() upper-cases, so '__proto__' looks up the own key '__PROTO__'; 'constructor' → 'CONSTRUCTOR' (absent)
      assert.deepStrictEqual(C.classify('__proto__', 'x', out, null), { type: '加油', guess: false });
      assert.strictEqual(C.classify('constructor', '中國信託信用卡', out, null).guess, true);
      assert.strictEqual(C.classify('toString', '中國信託信用卡', out, null).guess, true); // inherited names are not hits
      S.learn(out, '__proto__', '書籍');
      assert.strictEqual(Object.getPrototypeOf(out.learned), Object.prototype);
      assert.strictEqual(out.learned['__PROTO__'].type, '書籍');
      const back = S.importJSON(S.exportJSON(out));
      assert.strictEqual(back.learned['__PROTO__'].src, 'manual');
      assert.strictEqual(back.learned['__proto__'].desc, 'p');
      assert.deepStrictEqual(C.fixOcr('__PROTO_', back), { desc: '__proto__', matched: true });
    }
    assert.strictEqual({}.polluted, undefined);
  });

  await t('importWorkbook strips a pasted anti-formula apostrophe; ="3/12" never learned', async () => {
    const rows = [{ date: '2026-01-02', type: '外食', desc: '-退款', card: 'c', inst: '3/12', amount: -3 },
      { date: '2026-01-03', type: '+加值', desc: '@家', card: 'c', inst: '', amount: 5 }];
    const tsv = CC.exporter.toTSV(rows).split('\n').slice(1).map((l) => l.split('\t'));
    assert.ok(tsv.some((r) => r[2] === "'-退款" && r[4] === '="3/12"'));
    const wb = new ExcelJS.Workbook();
    const v = wb.addWorksheet('浮動'); v.addRow(['日期', '消費類型', '摘要', '卡別', '分期數', '金額']);
    for (const r of tsv) v.addRow(r);                                      // apostrophes kept as literal text
    v.addRow(['x', '外食', "'=SUM(1)", 'c', { formula: '"3/12"', result: '3/12' }, 1]);
    v.addRow(['x', '點心', "''-雙引號", 'c', '="3/12"', 1]);               // '' is not textCell output
    v.addRow(['x', '點心', "'abc", 'c', '', 1]);                           // ' not before a formula char → kept
    const res = await S.importWorkbook(await wb.xlsx.writeBuffer());
    assert.deepStrictEqual(res.learned[CC.util.norm('-退款')], { desc: '-退款', type: '外食' });
    assert.strictEqual(res.learned[CC.util.norm('@家')].type, '+加值');
    assert.strictEqual(res.learned[CC.util.norm('=SUM(1)')].desc, '=SUM(1)');
    assert.strictEqual(res.learned[CC.util.norm("''-雙引號")].desc, "''-雙引號");    // not our prefix → untouched
    assert.ok(res.learned[CC.util.norm("'abc")]);
    assert.ok(!Object.keys(res.learned).some((k) => /^'[=+\-@]/.test(k)));
    const all = JSON.stringify(res.learned);
    assert.ok(!all.includes('3/12'), 'col E (分期數) never flows into learned');
    assert.strictEqual(S.unTSV("'\t-x"), "\t-x"); assert.strictEqual(S.unTSV("' =1"), ' =1'); assert.strictEqual(S.unTSV("'x"), "'x");
  });

  await t('importJSON(partial, current) keeps absent fields from current', () => {
    const cur = S.defaults();
    cur.rules = [{ words: ['X'], type: '外食' }]; cur.cardByLast4 = { 1234: 'My' }; cur.dateMode = '消費日';
    cur.cards.fubon.defaultType = '書籍'; cur.cards.mine = { name: '自訂卡', defaultType: '加油' };
    cur.fixedTypes = cur.fixedTypes.concat('自訂固定'); cur.floatingTypes = ['外食']; cur.ocrFix = [['a', 'b']];
    S.learn(cur, 'abc', '外食');
    const out = S.importJSON('{"learned":{"OLD":{"desc":"old","type":"外食"}}}', cur);
    assert.deepStrictEqual(out.rules, cur.rules); assert.deepStrictEqual(out.cardByLast4, { 1234: 'My' });
    assert.strictEqual(out.dateMode, '消費日'); assert.strictEqual(out.cards.fubon.defaultType, '書籍');
    assert.deepStrictEqual(out.cards.mine, { name: '自訂卡', defaultType: '加油' });
    assert.ok(out.fixedTypes.includes('自訂固定')); assert.deepStrictEqual(out.floatingTypes, ['外食']);
    assert.deepStrictEqual(out.ocrFix, [['a', 'b']]);
    assert.deepStrictEqual(Object.keys(out.learned).sort(), ['ABC', 'OLD']);
    // present fields replace
    const out2 = S.importJSON('{"rules":[],"dateMode":"入帳日","cardByLast4":{"9":"Z"}}', cur);
    assert.deepStrictEqual(out2.rules, []); assert.strictEqual(out2.dateMode, '入帳日');
    assert.deepStrictEqual(out2.cardByLast4, { 9: 'Z' }); assert.ok(out2.learned['ABC']);
    // without current: absent = defaults
    assert.strictEqual(S.importJSON('{"learned":{}}').rules.length, S.DEFAULTS.rules.length);
    out.rules[0].words.push('Y'); assert.deepStrictEqual(cur.rules[0].words, ['X']); // no aliasing
  });

  await t('importJSON: nested "__proto__" in cards/rules/learned is dropped, fields type-checked', () => {
    const evil = '{"cards":{"zzz":{"__proto__":{"name":123,"defaultType":["x"]}},"fubon":{"__proto__":{"name":1},"name":"新名","extra":5}},' +
      '"rules":[{"words":["A"],"type":"外食","__proto__":{"type":7}}],' +
      '"learned":{"k":{"desc":"k","type":"外食","__proto__":{"conflict":true}}},"cardByLast4":{"1":"A"}}';
    for (const out of [S.importJSON(evil), S.importJSON(evil, S.defaults())]) {
      const z = out.cards.zzz;
      assert.strictEqual(Object.getPrototypeOf(z), Object.prototype);
      assert.strictEqual(z.name, undefined); assert.strictEqual(z.defaultType, undefined);
      assert.deepStrictEqual(Object.keys(z), []);
      assert.deepStrictEqual(out.cards.fubon, { name: '新名', defaultType: '日用其他' });
      assert.deepStrictEqual(Object.keys(out.rules[0]).sort(), ['type', 'words']);
      assert.strictEqual(Object.getPrototypeOf(out.rules[0]), Object.prototype);
      assert.deepStrictEqual(out.learned.k, { desc: 'k', type: '外食', src: 'workbook' });
      assert.strictEqual(Object.getPrototypeOf(out.learned.k), Object.prototype);
      assert.strictEqual(({}).name, undefined);
    }
    // trusted-path merge (load) also drops non-string / malformed entries
    const m = S.merge({ cards: { a: { name: 5, defaultType: '外食' } }, cardByLast4: { 1: 2, 3: 'C' },
      rules: [{ words: 'x', type: 'y' }, { words: ['ok'], type: '外食' }], learned: { a: { desc: 1, type: 'x' }, b: { desc: 'b', type: '外食' } },
      ocrFix: [['a'], ['b', 'c']] });
    assert.deepStrictEqual(m.cards.a, { defaultType: '外食' }); assert.deepStrictEqual(m.cardByLast4, { 3: 'C' });
    assert.deepStrictEqual(m.rules, [{ words: ['ok'], type: '外食' }]); assert.deepStrictEqual(Object.keys(m.learned), ['b']);
    assert.deepStrictEqual(m.ocrFix, [['b', 'c']]);
    assert.throws(() => S.importJSON('{"cards":{"x":{"name":5}}}'), /格式錯誤/);
  });

  await t('save() via downloads capability', async () => {
    delete globalThis.claude;
    await assert.rejects(CC.exporter.save('a.xlsx', new ArrayBuffer(1)), (e) => e.code === 'unavailable');
    let got;
    globalThis.claude = { use: async (n) => (n === 'downloads' ? { save: async (o) => { got = o; return { status: 'saved' }; } } : null) };
    assert.strictEqual(await CC.exporter.save('a.xlsx', new ArrayBuffer(3)), 'saved');
    assert.strictEqual(got.filename, 'a.xlsx'); assert.ok(got.data instanceof Blob); assert.strictEqual(got.data.size, 3);
    globalThis.claude = { use: async () => ({ save: async () => { throw { code: 'declined' }; } }) };
    await assert.rejects(CC.exporter.save('a.xlsx', new ArrayBuffer(1)), (e) => e.code === 'declined');
    globalThis.claude = { use: async () => null };
    await assert.rejects(CC.exporter.save('a.xlsx', new ArrayBuffer(1)), (e) => e.code === 'unavailable');
    delete globalThis.claude;
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
