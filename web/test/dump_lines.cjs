// node test/dump_lines.cjs FIRST.pdf [pageNum]  -> prints lines with segment x positions
const fs = require('fs'), path = require('path');
const CC = require('./node_env.cjs')(['core.js']);
(async () => {
  const f = process.argv[2], only = +process.argv[3] || 0;
  if (!f) { console.log('usage: node test/dump_lines.cjs <file in test/fixtures/pdf> [pageNum]'); return; }
  require('./private.cjs').skipUnless(['pdf/' + f], 'dump_lines');
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures/pdf', f));
  const { doc } = await CC.pdf.open(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const r = await CC.pdf.read(doc);
  console.log('swapped', r.swapped, 'pages', r.pages.length);
  for (const pg of r.pages) {
    if (only && pg.num !== only) continue;
    console.log('##### page', pg.num);
    for (const L of CC.pdf.lines(pg.items)) console.log(Math.round(L.y), L.segs.map(s => Math.round(s.x0) + ':' + s.t).join(' || ').slice(0, 220));
  }
})().catch(e => { console.error(e); process.exit(1); });
