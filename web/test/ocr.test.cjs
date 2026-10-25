// node test/ocr.test.cjs — CC.ocr in Playwright Chromium against CTBC.pdf / TCB.pdf (expected.json Python desc).
const path = require('path'), fs = require('fs'), assert = require('assert');
const { chromium } = require('playwright');
const { serve, routeCdn } = require('./serve.cjs');

const ROOT = path.join(__dirname, '..'), V = path.join(ROOT, 'vendor');
const { need } = require('./private.cjs');
// Recognising real 說明 cells needs the private statements + Python output; model load / cache / failure paths do not.
const HAVE = need(['expected.json', 'pdf/CTBC.pdf', 'pdf/TCB.pdf'], 'ocr.test: recognise CTBC/TCB 說明 cells vs expected.json');
const expected = HAVE ? JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/expected.json'), 'utf8')) : {};
const BANKS = {
  'CTBC.pdf': { date: [0, 110], amt: [230, 310], desc: [100, 230] },
  'TCB.pdf': { date: [25, 140], amt: [290, 350], desc: [140, 300] },
};

// ---- Node side: module loads without a DOM; cleanup works ----
require(path.join(ROOT, 'src/core.js'));
require(path.join(ROOT, 'src/ocr.js'));
const CC = globalThis.CC;
assert.strictEqual(CC.ocr.cleanup(' 转帐费 连二 ', CC.ocr.DEFAULT_FIX), '轉帳費 連＿');
assert.strictEqual(CC.ocr.cleanup('P i一國内'), 'Pi－國內');
assert.ok(CC.ocr.DEFAULT_FIX.length === 15);

// idbOpen: success arriving after onblocked must close the orphaned connection
{
  let rq, closed = 0;
  globalThis.indexedDB = { open: () => (rq = {}) };
  const pr = CC.ocr._idbOpen();
  rq.onblocked();
  rq.result = { close: () => closed++ };
  rq.onsuccess();
  pr.then((v) => {
    assert.strictEqual(v, null, 'blocked open resolves null');
    assert.strictEqual(closed, 1, 'late onsuccess closes the db');
    delete globalThis.indexedDB;
    console.log('idbOpen blocked->success: closed late connection');
  });
}

// difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()
function ratio(a, b) {
  a = Array.from(a); b = Array.from(b);
  const match = (alo, ahi, blo, bhi) => {
    let bi = 0, bj = 0, bk = 0, j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const nj = new Map();
      for (let j = blo; j < bhi; j++) if (a[i] === b[j]) {
        const k = (j2len.get(j - 1) || 0) + 1; nj.set(j, k);
        if (k > bk) { bi = i - k + 1; bj = j - k + 1; bk = k; }
      }
      j2len = nj;
    }
    if (!bk) return 0;
    return bk + match(alo, bi, blo, bj) + match(bi + bk, ahi, bj + bk, bhi);
  };
  const t = a.length + b.length;
  return t ? (2 * match(0, a.length, 0, b.length)) / t : 1;
}
assert.ok(Math.abs(ratio('abcd', 'bcde') - 0.75) < 1e-9);

(async () => {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const server = await serve(ROOT, port);
  const browser = await chromium.launch();
  let failed = 0;
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await routeCdn(page);
    for (const f of ['keys.txt', 'rec.onnx.b64.txt', 'ort-wasm-simd.wasm', 'ort-wasm.wasm', 'pdf.worker.min.js'])
      await page.route(`http://127.0.0.1:${port}/test/${f}`, (r) =>
        fs.existsSync(path.join(V, f)) ? r.fulfill({ path: path.join(V, f) }) : r.fulfill({ status: 404, body: '' }));
    const url = `http://127.0.0.1:${port}/test/ocr_harness.html`;
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById('status').textContent === 'ready');

    const ensureRun = () => page.evaluate(async () => {
      const stages = {}, t0 = performance.now();
      await CC.ocr.ensure((p) => { stages[p.stage] = (stages[p.stage] || 0) + 1; });
      const first = performance.now() - t0, t1 = performance.now();
      await CC.ocr.ensure();
      return { first, second: performance.now() - t1, stages, fromCache: CC.ocr.fromCache };
    });
    const e1 = await ensureRun();
    console.log(`ensure #1 (network): ${(e1.first / 1000).toFixed(2)} s, repeat call ${e1.second.toFixed(1)} ms, progress events`, JSON.stringify(e1.stages));
    assert.ok(e1.stages.download > 1, 'download progress reported');
    assert.ok(e1.second < 50, 'second ensure() is instant');

    for (const [file, cfg] of Object.entries(HAVE ? BANKS : {})) {
      const res = await page.evaluate(async ({ file, cfg }) => {
        const pages = await window.findRows('fixtures/pdf/' + file, cfg);
        const rows = [];
        let ms = 0;
        for (const p of pages) {
          const t0 = performance.now();
          const out = await CC.ocr.recognize(p.page, p.reqs);
          ms += performance.now() - t0;
          out.forEach((o, i) => rows.push({ ...p.meta[i], raw: o.text, text: CC.ocr.cleanup(o.text, CC.ocr.DEFAULT_FIX),
            norm: CC.util.norm(CC.ocr.cleanup(o.text, CC.ocr.DEFAULT_FIX)), conf: o.conf, crop: o.crop ? o.crop.slice(0, 22) : null, cropLen: o.crop ? o.crop.length : 0 }));
        }
        const empty = pages.length ? await CC.ocr.recognize(pages[0].page, [{ y: 100, x0: 50, x1: 50.2 }, { y: 99999, x0: 0, x1: 100 }]) : [];
        return { rows, ms, empty, normOf: null };
      }, { file, cfg });
      const exp = expected[file].rows.filter((r) => r.ocr);
      console.log(`\n${file}: ${res.rows.length} rows, recognize ${(res.ms / 1000).toFixed(2)} s (${(res.ms / Math.max(1, res.rows.length)).toFixed(0)} ms/row incl. 300 dpi render)`);
      assert.strictEqual(res.rows.length, exp.length, file + ' row count');
      for (const r of res.rows) {
        const e = exp.find((x) => x.amount === r.amount && x.date === r.date);
        assert.ok(e, `${file} row ${r.date} ${r.amount} in expected`);
        const en = await page.evaluate((s) => CC.util.norm(s), e.desc);
        const sim = ratio(r.norm, en);
        const ok = r.norm === en || sim >= 0.8;
        if (!ok) failed++;
        console.log(`  ${ok ? 'OK ' : 'BAD'} ${r.date} ${String(r.amount).padStart(7)}  ocr="${r.text}"  python="${e.desc}"  sim=${sim.toFixed(2)} conf=${r.conf.toFixed(2)} crop=${(r.cropLen / 1024).toFixed(1)}KB`);
        assert.ok(r.crop && r.crop.startsWith('data:image/png;base64'), 'crop is a PNG dataURL');
        assert.ok(r.cropLen < 60000, 'crop kept small');
      }
      assert.deepStrictEqual(res.empty.map((x) => x.text), ['', ''], 'no-ink requests give empty text');
    }

    // reload: model must now come from IndexedDB
    await page.reload();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'ready');
    const e2 = await ensureRun();
    console.log(`\nensure after reload (IndexedDB): ${(e2.first / 1000).toFixed(2)} s, fromCache=${e2.fromCache}`);
    assert.strictEqual(e2.fromCache, true, 'model bytes cached in IndexedDB');
    assert.ok(!e2.stages.download, 'no download after cache');

    // failure path: missing model and no cache -> Chinese error with code
    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    await routeCdn(p2);
    await p2.route(`http://127.0.0.1:${port}/test/rec.onnx.b64.txt`, (r) => r.fulfill({ status: 404, body: '' }));
    await p2.route(`http://127.0.0.1:${port}/test/keys.txt`, (r) => r.fulfill({ path: path.join(V, 'keys.txt') }));
    await p2.goto(url);
    await p2.waitForFunction(() => document.getElementById('status').textContent === 'ready');
    const err = await p2.evaluate(() => CC.ocr.ensure().then(() => null, (e) => ({ m: e.message, code: e.code })));
    console.log('failure path:', JSON.stringify(err));
    assert.ok(err && err.code === 'network' && /[一-鿿]/.test(err.m));
    await ctx2.close();
  } finally {
    await browser.close();
    server.close();
  }
  if (failed) { console.log(`\nFAIL: ${failed} row(s) below similarity 0.8`); process.exit(1); }
  console.log('\nocr.test: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
