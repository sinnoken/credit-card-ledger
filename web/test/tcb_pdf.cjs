// Test helper: rewrite the 合作金庫 fixture's page-2 content stream (amount column, date column) and
// return new PDF bytes, so CC.pdf.read sees exactly what pdf.js produces for such a statement
// (byte-swapped font, '0' invisible to the text layer, trailing zeros folded into wide blanks).
// The fixture stays untouched; the variant is an in-memory incremental update replacing object 39.
// TCB.pdf is a private fixture (gitignored): it is read lazily, check available() before calling variant().
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const SRC_PATH = path.join(__dirname, 'fixtures/pdf/TCB.pdf');
let SRC = null;
const available = () => fs.existsSync(SRC_PATH);
const src = () => {
  if (!SRC) {
    if (!available()) throw new Error('tcb_pdf: private fixture ' + SRC_PATH + ' not present');
    SRC = fs.readFileSync(SRC_PATH);
  }
  return SRC;
};
const OBJ = 39, CH = 4.5;
// advance of each char in the fixture's digit font at 9pt (its subset has no half-width ',': 1000 units)
const wOf = (t) => [...t].reduce((a, c) => a + (c === ',' ? 9 : CH), 0);

function contentOps() {
  const SRC = src();
  const s = SRC.toString('latin1');
  const i = s.indexOf(`\n${OBJ} 0 obj`), j = s.indexOf('stream', i) + 7;
  const len = +/\/Length (\d+)/.exec(s.slice(i, j))[1];
  const text = zlib.inflateSync(SRC.subarray(j, j + len)).toString('latin1');
  // tokens: names, hex strings, numbers, operators (the stream only uses these)
  const toks = text.match(/\/[^\s\/<>\[\]()]+|<[0-9A-Fa-f]*>|[-+]?\d*\.?\d+|[A-Za-z*'"]+/g);
  const ops = [];
  let st = [], tlm = null, font = null;
  for (const t of toks) {
    if (/^[A-Za-z*'"]+$/.test(t)) {
      if (t === 'Tm') { tlm = st.slice(-6).map(Number); ops.push({ op: 'Tm' }); }
      else if (t === 'Td') { const [x, y] = st.slice(-2).map(Number); tlm = [1, 0, 0, 1, tlm[4] + x, tlm[5] + y]; ops.push({ op: 'Tm' }); }
      else if (t === 'Tj') ops.push({ op: 'Tj', x: tlm[4], y: tlm[5], font, hex: st[st.length - 1].slice(1, -1) });
      else if (/^(TJ|TD|T\*|'|")$/.test(t)) throw new Error('tcb_pdf: unsupported operator ' + t);
      else { if (t === 'Tf') font = st[st.length - 2]; ops.push({ op: t, args: st.slice() }); }
      st = [];
    } else st.push(t);
  }
  return ops; // every Tj carries its own absolute position; Tm/Td are re-emitted per Tj
}
const ser = (ops) => ops.map((o) => o.op === 'Tm' ? '' : o.op === 'Tj'
  ? `1 0 0 1 ${+o.x.toFixed(3)} ${+o.y.toFixed(3)} Tm <${o.hex}> Tj` : `${o.args.join(' ')} ${o.op}`).filter(Boolean).join('\n');
const hexOf = (str) => Buffer.from(str, 'latin1').toString('hex').toUpperCase();
const strOf = (hex) => Buffer.from(hex, 'hex').toString('latin1');

function pdfWith(stream) {
  const SRC = src();
  const body = Buffer.from(stream, 'latin1');
  const base = SRC.toString('latin1');
  const prev = +/startxref\s+(\d+)\s+%%EOF\s*$/.exec(base)[1];
  const trailer = /trailer\s*<<([\s\S]*?)>>\s*startxref/.exec(base.slice(base.lastIndexOf('trailer')))[1];
  const size = /\/Size (\d+)/.exec(trailer)[1];
  const off = SRC.length + 1;
  const obj = Buffer.concat([Buffer.from(`\n${OBJ} 0 obj\n<< /Length ${body.length} >>\nstream\n`, 'latin1'), body,
    Buffer.from('\nendstream\nendobj\n', 'latin1')]);
  const xref = off + obj.length - 1;
  const tail = `xref\n${OBJ} 1\n${String(off).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${size} /Root 1 0 R /Info 2 0 R /Prev ${prev} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([SRC, obj.subarray(1).length ? Buffer.from('\n') : Buffer.alloc(0), obj.subarray(1), Buffer.from(tail, 'latin1')]);
}

/** Amount lines on page 2, top to bottom (PDF y of the digits run). */
const isAmt = (o) => o.op === 'Tj' && o.x >= 300 && o.x < 345 && /^[0-9,]+$/.test(strOf(o.hex));
const isSign = (o) => o.op === 'Tj' && o.x >= 300 && o.x < 345 && strOf(o.hex) === '-';
const isDate = (o) => o.op === 'Tj' && o.x >= 25 && o.x < 85;

/**
 * variant({amounts, amtDx, dateDx, drop}) -> PDF bytes.
 * amounts: values for the 8 amount lines (null keeps a line as is; 'del' removes the line's amount
 * and every other item of that line); amtDx / dateDx: move the whole column; drop(i) -> true removes
 * the i-th line entirely (all its text).
 */
function variant({ amounts = [], amtDx = 0, dateDx = 0, drop = () => false } = {}) {
  let ops = contentOps();
  const rows = [...new Set(ops.filter(isAmt).map((o) => o.y))].sort((a, b) => b - a);
  const R = Math.max(...ops.filter(isAmt).map((o) => o.x + wOf(strOf(o.hex))));
  const lineOf = (o) => rows.findIndex((y) => Math.abs(o.y - y) < 1.2);
  ops = ops.filter((o) => !(o.op === 'Tj' && lineOf(o) >= 0 && drop(lineOf(o))));
  rows.forEach((y, i) => {
    const v = amounts[i];
    if (v == null || drop(i)) return;
    const sign = ops.find((o) => isSign(o) && Math.abs(o.y - y) < 1.2);
    const dig = ops.find((o) => isAmt(o) && Math.abs(o.y - y) < 1.2);
    const t = Math.abs(v).toLocaleString('en-US');
    dig.hex = hexOf(t); dig.x = R - wOf(t);
    if (v < 0) {
      if (sign) { sign.x = dig.x - 4.3; sign.y = dig.y; }
      else ops.splice(ops.indexOf(dig), 0, { ...dig, hex: '2D', x: dig.x - 4.3, font: '/F20' },
        { op: 'Tf', args: [dig.font, '9'] }), ops.splice(ops.indexOf(dig) - 1, 0, { op: 'Tf', args: ['/F20', '9'] });
    } else if (sign) ops.splice(ops.indexOf(sign), 1);
  });
  for (const o of ops) {
    if (isAmt(o) || isSign(o)) o.x += amtDx;
    else if (isDate(o)) o.x += dateDx;
  }
  return pdfWith(ser(ops));
}
module.exports = { variant, CH, available, SRC_PATH };
