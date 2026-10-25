// node test/banks.test.cjs — CC.banks against test/fixtures/expected.json (Python reference output)
const fs = require('fs'), path = require('path');
const w = console.warn, l = console.log;
const CC = require('./node_env.cjs')(['core.js', 'banks.js']);
const { need } = require('./private.cjs');

const HAVE = need(['expected.json', 'pdf'], 'banks.test: parse real statements vs expected.json');
const exp = HAVE ? JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/expected.json'), 'utf8')) : {};
let fails = 0, checks = 0, normNotes = [];
const ok = (cond, msg) => { checks++; if (!cond) { fails++; l('  FAIL ' + msg); } };
const num = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.005;

(async () => {
  // negative: no keys -> null
  ok(CC.banks.detect({ swapped: false, text: 'hello world 1234-5678', pages: [] }) === null, 'detect(no keys) should be null');
  ok(CC.banks.detect({ swapped: false, text: '', pages: [] }) === null, 'detect(empty) should be null');
  // tie -> null
  ok(CC.banks.detect({ swapped: false, text: 'fubon.com megabank.com.tw', pages: [] }) === null, 'detect(tie) should be null');

  for (const [file, e] of Object.entries(exp)) {
    const buf = fs.readFileSync(path.join(__dirname, 'fixtures/pdf', file));
    console.warn = () => {}; console.log = () => {};   // silence pdf.js font warnings
    let read;
    try {
      const { doc } = await CC.pdf.open(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
      read = await CC.pdf.read(doc);
    } finally { console.warn = w; console.log = l; }
    const bank = CC.banks.detect(read);
    l(`${file}: detected ${bank ? bank.name : null} (expected ${e.bank})`);
    ok(bank && bank.name === e.bank, `${file} detect`);
    if (!bank) continue;
    let st;
    try { st = bank.parse(read); } catch (err) { ok(false, `${file} parse threw ${err.message}`); continue; }
    ok(st.closing === e.closing, `${file} closing ${st.closing} != ${e.closing}`);
    ok(num(st.prev, e.prev), `${file} prev ${st.prev} != ${e.prev}`);
    ok(num(st.cur, e.cur), `${file} cur ${st.cur} != ${e.cur}`);
    ok(st.rows.length === e.rows.length, `${file} rows ${st.rows.length} != ${e.rows.length}`);
    const n = Math.min(st.rows.length, e.rows.length);
    for (let i = 0; i < n; i++) {
      const a = st.rows[i], b = e.rows[i], tag = `${file} row ${i}`;
      ok(a.date === b.date, `${tag} date ${a.date} != ${b.date}`);
      ok(a.post === b.post, `${tag} post ${a.post} != ${b.post}`);
      ok(num(a.amount, b.amount), `${tag} amount ${a.amount} != ${b.amount}`);
      ok(a.last4 === b.last4, `${tag} last4 '${a.last4}' != '${b.last4}'`);
      if (b.ocr) {
        ok(bank.ocr && a.ocr && a.desc === '' && a.ocr.page >= 1 && Number.isFinite(a.ocr.y) && a.ocr.x1 > a.ocr.x0,
          `${tag} ocr cell missing`);
      } else {
        ok(!a.ocr, `${tag} unexpected ocr`);
        if (a.desc !== b.desc) {
          const same = CC.util.norm(a.desc) === CC.util.norm(b.desc);
          ok(same, `${tag} desc '${a.desc}' != '${b.desc}'`);
          if (same) normNotes.push(`${tag}: '${a.desc}' ~ '${b.desc}'`);
        }
      }
    }
  }
  if (normNotes.length) l('desc equal only after CC.util.norm:\n  ' + normNotes.join('\n  '));
  l(`\n${checks - fails}/${checks} checks passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.warn = w; console.log = l; console.error(e); process.exit(1); });
