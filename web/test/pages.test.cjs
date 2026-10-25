// Standalone site (dist/site, what GitHub Pages serves): no window.claude, ordinary browser download.
// Run after `python3 build.py`. The statement part needs the private fixtures; without them only the
// page-load / no-capability checks run.
const path = require('path'), fs = require('fs');
const { chromium } = require('playwright');
const { serve, routeCdn } = require('./serve.cjs');
const { FIX, need } = require('./private.cjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };
const payload = (f, mimeType) => ({ name: path.basename(f), mimeType, buffer: fs.readFileSync(f) });

(async () => {
  const SITE = path.join(__dirname, '../dist/site');
  if (!fs.existsSync(path.join(SITE, 'index.html'))) { console.log('dist/site missing: run python3 build.py'); process.exit(1); }
  const srv = await serve(SITE, 8791);
  // UTF-8 locale so Chromium keeps a non-ASCII download filename (a bare POSIX locale turns it into 'download')
  const browser = await chromium.launch({ env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await routeCdn(page);
  await page.goto('http://127.0.0.1:8791/index.html'); // GitHub Pages serves index.html for /
  await page.waitForSelector('#app');

  ok(await page.evaluate(() => document.compatMode) === 'CSS1Compat', 'standards mode (doctype present)');
  ok(await page.evaluate(() => typeof window.claude) === 'undefined', 'no window.claude on a plain host');
  ok(!(await page.isHidden('#btn-xlsx')), '存成 Excel visible without the downloads capability');

  if (need(['pdf'], 'pages.test statements')) {
    const pdfs = fs.readdirSync(path.join(FIX, 'pdf')).filter((f) => f.endsWith('.pdf')).map((f) => path.join(FIX, 'pdf', f));
    await page.setInputFiles('#file-input', pdfs.map((f) => payload(f, 'application/pdf')));
    await page.waitForFunction((n) => {
      const li = [...document.querySelectorAll('#file-list li.file')];
      return li.length === n && document.querySelector('#app').dataset.busy === '0' &&
        li.every((x) => ['ok', 'bad', 'pw', 'unknown', 'error'].includes(x.dataset.status));
    }, pdfs.length, { timeout: 240000 });
    const st = await page.$$eval('#file-list li.file', (l) => l.map((x) => x.dataset.status));
    ok(st.every((s) => s === 'ok'), `${pdfs.length} statements pass (OCR model + wasm load from the site folder)`);
    const ocrRows = await page.$$eval('#review td', (t) => t.map((x) => x.textContent).filter((s) => /需人工確認/.test(s)).length);
    ok(ocrRows === 0, 'OCR filled every description (no 需人工確認)');
    // export: tick the gate if shown, then a real browser download
    if (await page.isVisible('#gate-ack')) await page.check('#gate-ack');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#btn-xlsx')]);
    const file = path.join(require('os').tmpdir(), 'pages-test-' + Date.now() + '.xlsx');
    await dl.saveAs(file);
    const size = fs.statSync(file).size;
    ok(/\.xlsx$/.test(dl.suggestedFilename()) && size > 5000, `browser download ${dl.suggestedFilename()} (${size} bytes)`);
    fs.unlinkSync(file);
  }
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close(); srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
