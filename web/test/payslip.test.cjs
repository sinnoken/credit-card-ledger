// node test/payslip.test.cjs — payslip e-mail / text → 收入 + 固定 rows (synthetic; real mails only when present)
const path = require('path');
const fs = require('fs');
const assert = require('assert');

globalThis.pdfjsLib = globalThis.pdfjsLib || {}; // not needed here; skips pdf.js load in node_env
globalThis.ExcelJS = require(path.join(__dirname, '../vendor/exceljs.min.js'));
const CC = require('./node_env.cjs')(['core.js', 'settings.js', 'classify.js', 'payslip.js', 'export.js']);
const { FIX, need } = require('./private.cjs');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).toString().split('\n').slice(0, 6).join('\n       ')); }
}
const P = CC.payslip, E = CC.exporter, S = CC.settings;
const sums = (st) => [st.earn, st.ded, st.gross, st.deduct, st.net];

// All names and amounts below are made up.
const CODED = [
  '範例公司員工電子薪資單', '115/10月薪 (發薪日期：115/09/30)', '員工編號', 'A12345', '薪資項目', '金額', '說明',
  'A1(本薪)', '30,000', '薪資所得', 'B2(伙食津貼)', '2,400', 'C3(勞保費)', '-700', '投保薪資：30300',
  'C4(健保費)', '-450', 'C4(健保費)', '-450', '眷屬', '勞退新制', '提繳工資', '30,300', '公司提繳', '1,818',
  '應發扣合計', '應發數小計', '32,400', '存款帳號', '123****4567', '應扣數小計', '1,600', '實發金額', '$30,800',
].join('\n');

const HTML = `<html><head><style>td{color:red}</style></head><body><p>範例公司 薪資明細</p>
<table><tr><td>給付日期</td><td>2026/10/05</td></tr>
<tr><td>本薪</td><td>30,000</td><td>勞保費</td><td>700</td></tr>
<tr><td>伙食津貼</td><td>2,400</td><td>健保費</td><td>450</td></tr>
<tr><td>應發合計</td><td>32,400</td><td>應扣合計</td><td>1,150</td></tr>
<tr><td>實發金額</td><td>NT$31,250</td></tr></table></body></html>`;

const eml = (headers, body) => Buffer.from(headers.join('\r\n') + '\r\n\r\n' + body, 'binary');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');

(async () => {
  console.log('payslip.test');

  await t('coded layout: code(name) + next-line amount, totals, ROC 發薪日期, non-money numbers ignored', () => {
    const st = P.parse(CODED);
    assert.deepStrictEqual(st.rows.map((r) => [r.desc, r.amount]),
      [['A1(本薪)', 30000], ['B2(伙食津貼)', 2400], ['C3(勞保費)', -700], ['C4(健保費)', -450], ['C4(健保費)', -450]]);
    assert.deepStrictEqual(sums(st), [32400, 1600, 32400, 1600, 30800]);
    assert.strictEqual(st.closing, '2026-09-30');
    assert.strictEqual(st.warn, undefined);
    assert.ok(CC.reconcile(st).ok);
  });

  await t('generic HTML table (side by side, deductions printed positive) via htmlToText', () => {
    const st = P.parse(P.htmlToText(HTML));
    assert.deepStrictEqual(st.rows.map((r) => [r.desc, r.amount]),
      [['本薪', 30000], ['勞保費', -700], ['伙食津貼', 2400], ['健保費', -450]]);
    assert.deepStrictEqual(sums(st), [32400, 1150, 32400, 1150, 31250]);
    assert.strictEqual(st.closing, '2026-10-05');
    assert.ok(CC.reconcile(st).ok && !st.warn);
  });

  await t('generic list and one-line pairs, full-width digits, skip words', () => {
    const list = P.parse('發放日期：2026年10月5日\n工號：12345\n加班時數：8\n本薪：３０，０００\n勞保費：700\n實發：29,300');
    assert.deepStrictEqual(list.rows.map((r) => [r.desc, r.amount]), [['本薪', 30000], ['勞保費', -700]]);
    assert.strictEqual(list.closing, '2026-10-05');
    assert.strictEqual(list.net, 29300);
    assert.ok(CC.reconcile(list).ok);
    const line = P.parse('本薪 30,000 勞保費 700 應發合計 30,000\n實發金額 29,300');
    assert.deepStrictEqual(line.rows.map((r) => [r.desc, r.amount]), [['本薪', 30000], ['勞保費', -700]]);
    assert.strictEqual(line.gross, 30000);
    const acct = P.parse('本薪\n30,000\n帳號\n12345678901\n實發\n30,000');
    assert.deepStrictEqual(acct.rows.map((r) => r.desc), ['本薪']);
  });

  await t('mismatches and missing totals become warn; no items throws', () => {
    const bad = P.parse(CODED.replace('$30,800', '$30,000'));
    assert.ok(!CC.reconcile(bad).ok);
    const off = P.parse(CODED.replace('應扣數小計\n1,600', '應扣數小計\n1,700'));
    assert.match(off.warn, /扣項合計 1600，薪資單應扣 1700/);
    const bare = P.parse('A1(本薪)\n30,000');
    assert.match(bare.warn, /找不到應發／應扣／實發合計/);
    assert.match(bare.warn, /找不到發薪日期/);
    assert.strictEqual(P.parse('本薪\n100', { date: '2026-10-01' }).closing, '2026-10-01'); // e-mail date fallback
    assert.throws(() => P.parse('您好，附件是本月薪資單。'), /找不到薪資項目/);
  });

  await t('fromEml: multipart, base64 text/plain preferred, encoded-word subject, QP html fallback', () => {
    const m = P.fromEml(eml([
      'From: =?utf-8?B?' + Buffer.from('範例公司').toString('base64') + '?= <hr@example.com>',
      'Subject: =?utf-8?B?' + Buffer.from('10月薪資單').toString('base64') + '?=',
      'Date: Thu, 1 Oct 2026 01:06:15 +0000', 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="b1"',
    ], ['--b1', 'Content-Type: text/plain; charset="utf-8"', 'Content-Transfer-Encoding: base64', '', b64(CODED),
      '--b1', 'Content-Type: text/html; charset="utf-8"', 'Content-Transfer-Encoding: quoted-printable', '', '<p>x</p>', '--b1--', ''].join('\r\n')));
    assert.strictEqual(m.subject, '10月薪資單');
    assert.match(m.from, /^範例公司 <hr@example.com>$/);
    assert.strictEqual(m.date, '2026-10-01');
    assert.deepStrictEqual(sums(P.parse(m.text, m)), [32400, 1600, 32400, 1600, 30800]);
    const qp = Buffer.from(HTML, 'utf8').toString('binary').replace(/[=\x80-\xff]/g, (c) => '=' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
    const h = P.fromEml(eml(['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable'], qp));
    assert.strictEqual(P.parse(h.text).net, 31250);
    assert.throws(() => P.fromEml(eml(['Content-Type: multipart/mixed; boundary=z'], '--z\r\nContent-Type: image/png\r\n\r\nxx\r\n--z--')), /找不到內文/);
  });

  await t('detect: company keywords from settings; otherwise 薪資單 with the default account', () => {
    const s = S.defaults();
    s.payslip = { account: '預設帳戶', companies: [{ name: '甲公司', keys: ['example.com'], account: '甲銀行' }] };
    assert.deepStrictEqual(P.detect('x', { from: 'hr@example.com' }, s), { id: 'payslip', name: '甲公司', card: '甲銀行' });
    assert.deepStrictEqual(P.detect('x', {}, s), { id: 'payslip', name: '薪資單', card: '預設帳戶' });
  });

  await t('process: earnings → 收入, deductions → positive expense rows; learned types win, unknown are guesses', () => {
    const s = S.defaults();
    s.payslip = { account: '甲銀行', companies: [] };
    S.learn(s, 'B2(伙食津貼)', '各類補助');
    S.learn(s, 'C3(勞保費)', '保險(個人/汽機車/房屋)');
    S.learn(s, 'C4(健保費)', '外食'); // a learned floating type keeps the row on 浮動
    const rows = P.process(P.parse(CODED), { id: 'payslip', name: '薪資單' }, s, 'a.eml');
    assert.deepStrictEqual(rows.map((r) => [r.sheet, r.type, r.desc, r.card, r.amount, r.guess, r.kind]), [
      ['收入', '薪資', 'A1(本薪)', '甲銀行', 30000, true, 'income'],
      ['收入', '各類補助', 'B2(伙食津貼)', '甲銀行', 2400, false, 'income'],
      ['固定', '保險(個人/汽機車/房屋)', 'C3(勞保費)', '甲銀行', 700, false, 'deduct'],
      ['浮動', '外食', 'C4(健保費)', '甲銀行', 450, false, 'deduct'],
      ['浮動', '外食', 'C4(健保費)', '甲銀行', 450, false, 'deduct'],
    ]);
    assert.ok(rows.every((r) => r.date === '2026-09-30' && r.id.startsWith('a.eml#')));
    // an expense type learned for an earning (or the reverse) is not used
    S.learn(s, 'A1(本薪)', '外食');
    assert.deepStrictEqual(P.process(P.parse('A1(本薪)\n100'), { name: '薪資單' }, s, '')[0].type, '薪資');
    assert.strictEqual(P.sheetFor({ kind: 'income' }, '外食', s), '收入');
    assert.strictEqual(P.sheetFor({ kind: 'deduct' }, '外食', s), '浮動');
  });

  await t('export: incomeTSV and the 收入 sheet share columns; no 收入 sheet without earnings; payslips not in 繳費', async () => {
    const s = S.defaults(); s.payslip = { account: '甲銀行', companies: [] };
    const rows = P.process(P.parse(CODED), { name: '薪資單' }, s, 'a.eml');
    const inc = rows.filter((r) => r.sheet === E.INCOME_SHEET);
    const lines = E.incomeTSV(inc).split('\n');
    assert.strictEqual(lines[0], '日期\t收入類型\t摘要\t收入形式\t金額');
    assert.strictEqual(lines[1], '2026/9/30\t薪資\tA1(本薪)\t甲銀行\t30000');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await E.toXlsx(rows, []));
    const ws = wb.getWorksheet('收入');
    assert.deepStrictEqual(ws.getRow(1).values.slice(1), E.INCOME_HEAD);
    assert.strictEqual(ws.rowCount, 3);
    assert.strictEqual(ws.getRow(2).getCell(2).fill.fgColor.argb, 'FF' + E.FILL_GUESS); // guessed 收入類型
    assert.strictEqual(ws.getRow(3).getCell(5).value, 2400);
    assert.strictEqual(wb.getWorksheet('固定').rowCount + wb.getWorksheet('浮動').rowCount - 2, 3);
    const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(await E.toXlsx(rows.filter((r) => r.kind !== 'income'), []));
    assert.ok(!wb2.getWorksheet('收入'));
    assert.strictEqual(E.payRows([{ kind: 'payslip', bank: '薪資單', cur: 30800 }]).length, 0);
  });

  await t('settings: payslip / incomeTypes validated on import; workbook 收入 (or older Incomes) sheet is learned', async () => {
    const s = S.importJSON(JSON.stringify({ payslip: { account: '甲銀行', companies: [{ name: '甲', keys: ['k'], extra: 1 }] }, incomeTypes: ['薪資', '獎金'] }));
    assert.deepStrictEqual(s.payslip, { account: '甲銀行', companies: [{ name: '甲', keys: ['k'] }] });
    assert.deepStrictEqual(s.incomeTypes, ['薪資', '獎金']);
    assert.throws(() => S.importJSON('{"payslip":{"companies":[{"name":1}]}}'), /第 1 家公司格式錯誤/);
    assert.throws(() => S.importJSON('{"incomeTypes":"薪資"}'), /incomeTypes/);
    assert.deepStrictEqual(S.importJSON('{"payslip":{"companies":[{"name":"__proto__","keys":[]}]}}').payslip.companies[0].name, '__proto__');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('固定').addRows([['日期', '消費類型', '摘要'], [null, '保險(個人/汽機車/房屋)', 'C3(勞保費)']]);
    wb.addWorksheet('Incomes').addRows([['日期', '收入類型', '摘要'], [null, '自訂收入', 'A1(本薪)']]); // older sheet name still read
    const res = await S.importWorkbook(await wb.xlsx.writeBuffer());
    assert.deepStrictEqual(res.incomeTypes, ['自訂收入']);
    const s2 = S.applyWorkbook(S.defaults(), res);
    assert.ok(s2.incomeTypes.includes('自訂收入') && s2.incomeTypes.includes('薪資'));
    const r = P.process(P.parse('A1(本薪)\n100\nC3(勞保費)\n-10'), { name: '薪資單' }, s2, '');
    assert.deepStrictEqual(r.map((x) => [x.sheet, x.type, x.guess]), [['收入', '自訂收入', false], ['固定', '保險(個人/汽機車/房屋)', false]]);
  });

  await t('轉帳: workbook 轉帳 / Spend2 sheets are learned; a deduction typed with a 轉入銀行 is a transfer row', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Spend2').addRows([['日期', '消費類型', '摘要'], [null, '保險(個人/汽機車/房屋)', 'C3(勞保費)']]);
    wb.addWorksheet('Bank').addRows([['帳戶名稱', // older sheet name still read
      '日期', '摘要', '存/提/轉', '轉入銀行', '金額', '手續費'],
      ['甲銀行', null, 'D5(儲蓄提存)', '轉帳', '儲蓄帳戶', 1000, null]]);
    wb.addWorksheet('Spend1').addRows([['日期', '消費類型', '摘要'], [null, '外食', 'E1(餐費代扣)']]);
    const res = await S.importWorkbook(await wb.xlsx.writeBuffer());
    assert.deepStrictEqual(res.bankTargets, ['儲蓄帳戶']);
    assert.strictEqual(res.learned[CC.util.norm('E1(餐費代扣)')].type, '外食'); // Spend1 = 浮動
    assert.strictEqual(S.sheetLabel('浮動'), '浮動（Spend1）');
    assert.strictEqual(S.sheetLabel('繳費'), '繳費');
    const empty = new ExcelJS.Workbook(); empty.addWorksheet('其他');
    await assert.rejects(S.importWorkbook(await empty.xlsx.writeBuffer()), /找不到「固定（Spend2）」「浮動（Spend1）」「收入（Incomes）」「轉帳（Bank）」任何一張工作表/);
    assert.ok(res.fixedTypes.includes('保險(個人/汽機車/房屋)'));
    const s = S.applyWorkbook(S.defaults(), res);
    s.payslip = { account: '甲銀行', companies: [] };
    const rows = P.process(P.parse('發薪日期：115/10/01\nA1(本薪)\n30,000\nC3(勞保費)\n-700\nD5(儲蓄提存)\n-1,000\n實發金額\n28,300'), { name: '薪資單' }, s, 'a.eml');
    assert.deepStrictEqual(rows.map((r) => [r.sheet, r.type, r.amount, r.guess]),
      [['收入', '薪資', 30000, true], ['固定', '保險(個人/汽機車/房屋)', 700, false], ['轉帳', '儲蓄帳戶', 1000, false]]);
    assert.strictEqual(P.sheetFor({ kind: 'purchase' }, '儲蓄帳戶', s), '浮動', 'card rows never go to 轉帳');
    assert.strictEqual(P.sheetFor({ kind: 'deduct' }, '儲蓄帳戶', s), '轉帳');
    const bank = rows.filter((r) => r.sheet === E.BANK_SHEET);
    const lines = E.bankTSV(bank).split('\n');
    assert.strictEqual(lines[0], '帳戶名稱\t日期\t摘要\t存/提/轉\t轉入銀行\t金額\t手續費');
    assert.strictEqual(lines[1], '甲銀行\t2026/10/1\tD5(儲蓄提存)\t轉帳\t儲蓄帳戶\t1000\t');
    const out = new ExcelJS.Workbook(); await out.xlsx.load(await E.toXlsx(rows, []));
    const ws = out.getWorksheet('轉帳');
    assert.deepStrictEqual(ws.getRow(1).values.slice(1), E.BANK_HEAD);
    assert.deepStrictEqual(ws.getRow(2).values.slice(1).map((v) => (v instanceof Date ? 'D' : v)), ['甲銀行', 'D', 'D5(儲蓄提存)', '轉帳', '儲蓄帳戶', 1000]);
    assert.strictEqual(out.getWorksheet('固定').rowCount, 2);
    assert.throws(() => S.importJSON('{"bankTargets":"x"}'), /bankTargets/);
    // a card purchase with the same 摘要 never takes a 轉入銀行 / 收入類型 as its type
    S.learn(s, 'A1(本薪)', '薪資');
    for (const d of ['D5(儲蓄提存)', 'A1(本薪)']) {
      const c = CC.classify.classify(d, '甲卡', s, null);
      assert.ok(c.guess && c.type !== '儲蓄帳戶' && c.type !== '薪資', d);
    }
    // a backup without the target keeps it while a learned entry still uses it
    const back = S.importJSON(JSON.stringify({ bankTargets: [] }), s);
    assert.ok(back.bankTargets.includes('儲蓄帳戶'));
    assert.strictEqual(P.sheetFor({ kind: 'deduct' }, '儲蓄帳戶', back), '轉帳');
  });

  // ---- review regressions ----
  await t('fromEml: sender-local Date (no UTC shift), "open in HTML" plain stub falls back to HTML, forwarded rfc822', () => {
    const d = P.fromEml(eml(['Date: Thu, 1 Oct 2026 07:00:00 +0800', 'Content-Type: text/plain; charset=utf-8'], 'x'));
    assert.strictEqual(d.date, '2026-10-01');
    const alt = P.fromEml(eml(['Content-Type: multipart/alternative; boundary=a'], ['--a', 'Content-Type: text/plain; charset=utf-8', '',
      '請用 HTML 檢視', '--a', 'Content-Type: text/html; charset=utf-8', '', Buffer.from(HTML, 'utf8').toString('binary'), '--a--', ''].join('\r\n')));
    assert.strictEqual(P.parse(alt.text).net, 31250);
    const fwd = P.fromEml(eml(['Content-Type: multipart/mixed; boundary=m'], ['--m', 'Content-Type: text/plain; charset=utf-8', '', 'FYI',
      '--m', 'Content-Type: message/rfc822', 'Content-Disposition: attachment', '',
      'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(CODED), '--m--', ''].join('\r\n')));
    assert.strictEqual(P.parse(fwd.text).net, 30800);
  });

  await t('fromEml: cp950 label and unlabelled Big5 decode as Big5; raw 8-bit UTF-8 Subject decoded', () => {
    const want = '本薪\n30,000\n實發\n30,000', rev = {};
    const dec = new TextDecoder('big5');
    for (let a = 0x81; a <= 0xfe; a++) for (let b = 0x40; b <= 0xfe; b++) {
      const ch = dec.decode(Uint8Array.of(a, b));
      if (want.includes(ch) && !(ch in rev)) rev[ch] = [a, b];
    }
    const big5 = Buffer.from([...want].flatMap((ch) => rev[ch] || [ch.charCodeAt(0)])).toString('binary');
    for (const ct of ['text/plain; charset=cp950', 'text/plain']) {
      const m = P.fromEml(eml(['Content-Type: ' + ct], big5));
      assert.strictEqual(P.parse(m.text).rows[0].desc, '本薪', ct);
    }
    const raw = P.fromEml(eml(['Subject: ' + Buffer.from('薪資單', 'utf8').toString('binary'), 'Content-Type: text/plain'], 'x'));
    assert.strictEqual(raw.subject, '薪資單');
    assert.strictEqual(P.htmlToText('a&#99999999;b&#x41;'), 'abA');
  });

  await t('parse: 應發 − 應扣 is the check when 實發 is missing; skip words; positive coded deductions; amount forms', () => {
    const noNet = P.parse('本薪：30,000\n勞保費：700\n分機 1234\n薪資月份\t9\n應發合計：30,000\n應扣合計：700');
    assert.deepStrictEqual(noNet.rows.map((r) => [r.desc, r.amount]), [['本薪', 30000], ['勞保費', -700]]);
    assert.strictEqual(noNet.cur, 29300);
    assert.ok(CC.reconcile(noNet).ok);
    const junk = P.parse('本薪：30,000\n交通費：500\n應發合計：30,000\n應扣合計：0');
    assert.ok(!CC.reconcile(junk).ok, 'an extra item no longer passes silently');
    const pos = P.parse('A1(本薪)\n30,000\nC3(勞保費)\n700\n實發金額\n29,300');
    assert.deepStrictEqual(pos.rows.map((r) => r.amount), [30000, -700]);
    const forms = P.parse('A1(本薪)\n30,000元\nC3(勞保費)\n(700)\nC4(健保費)\n450-\n實發金額\n28,850');
    assert.deepStrictEqual(forms.rows.map((r) => r.amount), [30000, -700, -450]);
    assert.ok(CC.reconcile(forms).ok);
    assert.deepStrictEqual(P.parse('本薪30,000元 勞保費 700元').rows.map((r) => [r.desc, r.amount]), [['本薪', 30000], ['勞保費', -700]]);
    assert.strictEqual(P.parse('給付日期 26/10/05\n本薪\n100').closing, '2026-10-05');
    assert.strictEqual(P.parse('A1(本薪)\n100\nC3(借支)\n-300\n實發金額\n-200').net, -200);
  });

  // ---- private: the owner's real payslip e-mails and workbook (gitignored; no names or amounts in this file) ----
  const emls = fs.existsSync(FIX) ? fs.readdirSync(FIX).filter((f) => /\.eml$/i.test(f)) : [];
  if (!emls.length) console.log('SKIP payslip.test: real e-mails (private fixtures not present: test/fixtures/*.eml)');
  for (const f of emls)
    await t('real e-mail #' + (emls.indexOf(f) + 1) + ' parses and reconciles with no warning', () => {
      const m = P.fromEml(fs.readFileSync(path.join(FIX, f)));
      const st = P.parse(m.text, m);
      assert.ok(st.rows.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(st.closing));
      assert.strictEqual(st.warn, undefined, st.warn);
      assert.ok(CC.reconcile(st).ok);
      assert.ok(st.gross === st.earn && st.deduct === st.ded && st.net === st.earn - st.ded);
    });
  if (emls.length && need(['帳本.xlsx'], 'payslip.test: real e-mails classified with the owner workbook')) {
    await t('real e-mails + workbook: items already in the ledger get its type and sheet', async () => {
      const res = await S.importWorkbook(fs.readFileSync(path.join(FIX, '帳本.xlsx')));
      const s = S.applyWorkbook(S.defaults(), res);
      let known = 0, bank = 0;
      for (const f of emls) {
        const m = P.fromEml(fs.readFileSync(path.join(FIX, f)));
        for (const r of P.process(P.parse(m.text, m), P.detect(m.text, m, s), s, f)) {
          const hit = s.learned[CC.util.norm(r.desc)];
          if (!hit || hit.conflict || s.incomeTypes.includes(hit.type) !== (r.kind === 'income')) continue;
          known++;
          assert.strictEqual(r.type, hit.type, r.desc);
          assert.strictEqual(r.guess, false);
          assert.strictEqual(r.sheet, P.sheetFor(r, hit.type, s));
          if (s.bankTargets.includes(hit.type)) bank++;
        }
      }
      assert.ok(known > 0, 'no payslip item matched the workbook');
      if (res.bankTargets.length) assert.ok(bank > 0, 'the workbook has a 轉帳 sheet but no deduction went to 轉帳');
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
