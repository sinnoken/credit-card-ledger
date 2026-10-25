// End-to-end: node test/e2e.test.cjs  (after `python3 build.py`). Env E2E_DIST overrides the served dir.
const path = require('path'), fs = require('fs');
const { chromium } = require('playwright');
const { serve, routeCdn } = require('./serve.cjs');

const DIST = path.resolve(process.env.E2E_DIST || path.join(__dirname, '../dist'));
const FIX = path.join(__dirname, 'fixtures');
const OUT = path.join(__dirname, 'out');
// The whole flow runs on the private statements (gitignored); a public checkout skips it.
require('./private.cjs').skipUnless(['pdf', 'expected.json', '分類參考.xlsx'], 'e2e.test');
const PERSONAL = path.join(FIX, 'personal-settings.json');
const OUTS = Object.values(JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'))).flatMap((v) => v.output);
const N_ALL = OUTS.length, N_FIX = OUTS.filter((o) => o.sheet === '固定').length, N_FLOAT = N_ALL - N_FIX;
let pass = 0, fail = 0;
// Path-based setInputFiles silently fails for these (mode 600, CJK names), so send buffers.
const payload = (f, mimeType) => ({ name: path.basename(f), mimeType, buffer: fs.readFileSync(f) });
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };

const idle = (p) => p.waitForFunction(() => document.querySelector('#app').dataset.busy === '0' &&
  [...document.querySelectorAll('#file-list li.file')].every((x) => ['ok', 'bad', 'pw', 'unknown', 'error'].includes(x.dataset.status)), null, { timeout: 120000 });
const pdf = (n) => payload(path.join(FIX, 'pdf', n), 'application/pdf');
const junk = (n, body) => ({ name: n, mimeType: 'application/pdf', buffer: Buffer.from(body) });
const statusOf = (p, name) => p.$$eval('#file-list li.file', (l, n) => l.filter((x) => x.querySelector('.fname').textContent === n).map((x) => x.dataset.status), name);

// Failure recovery, per-file password box, export gate. Fresh page.
async function recovery(page, url) {
  await page.goto(url);
  await page.waitForSelector('#app');
  const openRow = (n) => page.click(`#file-list li.file:has(.fname:text-is("${n}")) .file-row`);

  // 1) classify throws after parsing -> 錯誤; 重試 rebuilds from the parsed statement (file bytes already released)
  await page.evaluate(() => { window.__proc = CC.classify.process; CC.classify.process = () => { throw new Error('boom'); }; });
  await page.setInputFiles('#file-input', [pdf('MEGA.pdf')]);
  await idle(page);
  ok((await statusOf(page, 'MEGA.pdf'))[0] === 'error', 'classify failure shows 錯誤');
  await page.evaluate(() => { CC.classify.process = window.__proc; });
  await openRow('MEGA.pdf');
  await page.click('#file-list li.file:has(.fname:text-is("MEGA.pdf")) [data-retry]');
  await idle(page);
  ok((await statusOf(page, 'MEGA.pdf'))[0] === 'ok', '重試 recovers a statement whose classify step threw');

  // 2) re-dropping a failed file replaces the entry instead of being ignored as duplicate
  await page.evaluate(() => { CC.classify.process = () => { throw new Error('boom'); }; });
  await page.setInputFiles('#file-input', [pdf('FUBON.pdf')]);
  await idle(page);
  await page.evaluate(() => { CC.classify.process = window.__proc; });
  ok((await statusOf(page, 'FUBON.pdf'))[0] === 'error', 'second file failed');
  await page.setInputFiles('#file-input', [pdf('FUBON.pdf')]);
  await idle(page);
  const fu = await statusOf(page, 'FUBON.pdf');
  ok(fu.length === 1 && fu[0] === 'ok', 're-drop of a failed file reprocesses it in place (' + fu + ')');

  // 3+4) per-file password box keeps a half-typed value across re-renders; the password becomes a chip
  await page.evaluate(() => {
    const o = window.__open = CC.pdf.open;
    CC.pdf.open = async (b, pw) => { if (!pw.includes('s3cret')) throw Object.assign(new Error('password'), { code: 'password' }); return o(b, []); };
  });
  await page.setInputFiles('#file-input', [pdf('BOT.pdf')]);
  await idle(page);
  ok((await statusOf(page, 'BOT.pdf'))[0] === 'pw', 'password-gated file asks for a password');
  const pwSel = '#file-list li.file:has(.fname:text-is("BOT.pdf")) [data-retry-pw]';
  await page.click(pwSel);
  await page.keyboard.type('s3c');
  await page.setInputFiles('#file-input', [junk('junk1.pdf', 'not a pdf')]); // re-renders the list several times
  await idle(page);
  await page.keyboard.type('ret');
  ok(await page.inputValue(pwSel) === 's3cret', 'half-typed per-file password and caret survive re-render (' + await page.inputValue(pwSel) + ')');
  await page.keyboard.press('Enter');
  await idle(page);
  ok(await page.$$eval('#pw-chips li', (l) => l.length) === 1, 'per-file password shows up as a chip');
  ok((await statusOf(page, 'BOT.pdf'))[0] === 'ok', 'per-file password unlocks the file');
  await page.evaluate(() => { CC.pdf.open = window.__open; });

  // 1-HIGH) the 「仍要匯出」 ack is for the problems listed at the time; a new problem gates export again
  ok(await page.isVisible('#gate') && await page.isDisabled('#btn-xlsx'), 'junk file gates export');
  await page.check('#gate-ack');
  ok(await page.isEnabled('#btn-xlsx'), 'ack enables export');
  await page.setInputFiles('#file-input', [junk('junk2.pdf', 'also not a pdf!!')]);
  await idle(page);
  ok(!(await page.isChecked('#gate-ack')) && await page.isDisabled('#btn-xlsx'), 'new problem after ack clears the ack and gates export');

  // R1) a DIFFERENT broken file with the same name (different size) is a new problem: gate again
  await page.check('#gate-ack');
  ok(await page.isEnabled('#btn-xlsx'), 'ack enables export (before same-name drop)');
  await page.setInputFiles('#file-input', [junk('junk2.pdf', 'a different broken file, same name')]);
  await idle(page);
  ok((await statusOf(page, 'junk2.pdf')).length === 2, 'same-name different-size drop is a new entry');
  ok(!(await page.isChecked('#gate-ack')) && await page.isDisabled('#btn-xlsx'), 'same-name different broken file clears the ack');

  // R1b) re-dropping the SAME failing file (same name+size) restarts it under a new id: the old ack does not carry over
  await page.setInputFiles('#file-input', [junk('junk3.pdf', 'broken bytes')]);
  await idle(page);
  await page.check('#gate-ack');
  ok(await page.isEnabled('#btn-xlsx'), 'ack enables export (before same-file re-drop)');
  const j3a = await page.evaluate(() => CC.app.state.files.find((f) => f.name === 'junk3.pdf').id);
  await page.setInputFiles('#file-input', [junk('junk3.pdf', 'broken bytes')]);
  await idle(page);
  const j3b = await page.evaluate(() => CC.app.state.files.filter((f) => f.name === 'junk3.pdf').map((f) => f.id));
  ok(j3b.length === 1 && j3b[0] !== j3a, 're-dropped failed file gets a new id (' + j3a + ' -> ' + j3b + ')');
  ok(!(await page.isChecked('#gate-ack')) && await page.isDisabled('#btn-xlsx'), 're-dropped still-failing file clears the ack and gates export');

  // R2) fewer (需人工確認) rows keep the ack; more rows ask again
  const MAN = '(需人工確認)';
  await page.evaluate((m) => { CC.app.state.rows.filter((r) => r.fid === CC.app.state.files.find((f) => f.name === 'MEGA.pdf').id).slice(0, 3).forEach((r) => { r.desc = m; }); }, MAN);
  await page.click('[data-filter="all"]');
  ok((await page.$$eval('#gate-list li', (l) => l.map((x) => x.textContent))).some((t) => t.startsWith('3 筆摘要')), 'gate lists 3 manual rows');
  await page.check('#gate-ack');
  const manId = await page.evaluate((m) => CC.app.state.rows.find((r) => r.desc === m).id, MAN);
  await page.click(`tr.row[data-id="${manId}"] [data-act="desc"]`);
  await page.fill('#edit-desc', '午餐');
  await page.keyboard.press('Enter');
  ok((await page.$$eval('#gate-list li', (l) => l.map((x) => x.textContent))).some((t) => t.startsWith('2 筆摘要')), 'gate now lists 2 manual rows');
  ok(await page.isChecked('#gate-ack') && await page.isEnabled('#btn-xlsx'), 'fixing a manual row keeps the ack');
  await page.evaluate((m) => { CC.app.state.rows.find((r) => r.desc !== m && r.desc !== '午餐').desc = m; }, MAN);
  await page.click('[data-filter="all"]');
  ok(!(await page.isChecked('#gate-ack')) && await page.isDisabled('#btn-xlsx'), 'a new manual row clears the ack');
  await page.evaluate((m) => { CC.app.state.rows.forEach((r) => { if (r.desc === m) { r.desc = 'x'; r.user = Object.assign({}, r.user, { desc: 'x' }); } }); }, MAN);

  // R3) classify throws during a rebuild (settings change): 重試 restores the user's edits
  const fuId = await page.evaluate(() => {
    const S = CC.app.state, f = S.files.find((x) => x.name === 'FUBON.pdf'), r = S.rows.find((x) => x.fid === f.id);
    r.type = '房租'; r.user = Object.assign({}, r.user, { type: '房租' }); r.confirmed = true;
    const p = CC.classify.process; let once = true;
    CC.classify.process = function (st, bank, set, name) { if (once && name === 'FUBON.pdf') { once = false; throw new Error('boom'); } return p.apply(this, arguments); };
    window.__restoreProc = () => { CC.classify.process = p; };
    return r.id;
  });
  await page.click('#btn-settings');
  const dm = await page.evaluate(() => CC.app.state.settings.dateMode);
  await page.check(dm === '消費日' ? '#dm-post' : '#dm-buy');
  await page.click('#set-close');
  await page.evaluate(() => window.__restoreProc());
  const fuSt = await statusOf(page, 'FUBON.pdf');
  ok(fuSt[0] === 'error' && !(await page.evaluate((id) => CC.app.state.rows.some((r) => r.id === id), fuId)), 'classify error on rebuild marks the file 錯誤 (' + fuSt + ')');
  await openRow('FUBON.pdf');
  await page.click('#file-list li.file:has(.fname:text-is("FUBON.pdf")) [data-retry]');
  await idle(page);
  const back = await page.evaluate((id) => { const r = CC.app.state.rows.find((x) => x.id === id); return r && [r.type, r.sheet, r.confirmed]; }, fuId);
  ok((await statusOf(page, 'FUBON.pdf'))[0] === 'ok' && back && back[0] === '房租' && back[1] === '固定' && back[2] === true, '重試 after a failed rebuild restores the edited type (' + back + ')');

  // R4) a parser warning (st.warn) shows 需核對 and gates export
  await page.check('#gate-ack');
  await page.evaluate(() => {
    const d = window.__detect = CC.banks.detect;
    CC.banks.detect = (read) => { const b = d(read); return b && Object.assign({}, b, { parse: (x) => Object.assign(b.parse(x), { warn: '金額位置不一致，請人工核對' }) }); };
  });
  await page.setInputFiles('#file-input', [pdf('TSB.pdf')]);
  await idle(page);
  await page.evaluate(() => { CC.banks.detect = window.__detect; });
  const chip = await page.textContent('#file-list li.file:has(.fname:text-is("TSB.pdf")) .st');
  ok(chip === '需核對', 'statement warn shows a 需核對 chip (' + chip + ')');
  await openRow('TSB.pdf');
  ok(/金額位置不一致/.test(await page.textContent('#file-list li.file:has(.fname:text-is("TSB.pdf")) .file-more')), 'expanded file shows the warn text');
  ok((await page.$$eval('#gate-list li', (l) => l.map((x) => x.textContent))).some((t) => /TSB\.pdf：需核對，金額位置不一致/.test(t)), 'gate lists the statement warn');
  ok(!(await page.isChecked('#gate-ack')) && await page.isDisabled('#btn-xlsx'), 'statement warn clears the ack and gates export');
  // R5) an expanded row of a warn-only statement shows 需核對：<warn>, not the 不符 wording
  await page.click('[data-filter="all"]');
  const tsbRow = await page.evaluate(() => { const S = CC.app.state, f = S.files.find((x) => x.name === 'TSB.pdf'); return S.rows.find((r) => r.fid === f.id && !r.confirmed).id; });
  await page.click(`tr.row[data-id="${tsbRow}"] [data-act="expand"]`);
  const det = await page.textContent(`tr.detail[data-for="${tsbRow}"] dl`);
  ok(/需核對：金額位置不一致/.test(det) && !/不符|通過/.test(det), 'warn-only row detail shows 需核對 with the warn text (' + det.replace(/\s+/g, ' ').slice(-60) + ')');
  // R6) 核對結果 gets the warn text as the check's error/note
  await page.check('#gate-ack');
  await page.evaluate(() => { const o = CC.exporter.toXlsx; window.__saved = null; CC.exporter.toXlsx = (r, c) => { window.__checks = c; return o(r, c); }; });
  await page.click('#btn-xlsx');
  await page.waitForFunction(() => window.__saved, null, { timeout: 30000 });
  const tck = await page.evaluate(() => window.__checks.find((c) => c.file === 'TSB.pdf'));
  ok(tck && tck.ok === false && /金額位置不一致/.test(tck.error || ''), '核對結果 note carries the statement warn (' + (tck && tck.error) + ')');
  const mck = await page.evaluate(() => window.__checks.find((c) => c.file === 'MEGA.pdf'));
  ok(mck && mck.ok === true && mck.error === undefined, 'a clean statement has no 核對結果 note');
  await page.screenshot({ path: path.join(OUT, 'e2e-recovery.png'), fullPage: true });
  await page.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const port = 8800 + Math.floor(Math.random() * 100);
  const srv = await serve(DIST, port);
  const browser = await chromium.launch();
  const errors = [];
  const setup = async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await routeCdn(page);
  await page.addInitScript(() => {
    window.claude = {
      use: async (n) => n === 'downloads' ? {
        save: async ({ filename, data }) => {
          const size = data && (data.size ?? data.byteLength ?? data.length);
          window.__saved = { filename, size };
          return { status: 'saved' };
        },
      } : null,
    };
  });
  return page;
  };
  const page = await setup();
  try {
    await page.goto(`http://127.0.0.1:${port}/test.html`);
    await page.waitForSelector('#app');
    ok(await page.isVisible('#files-empty'), 'empty state visible before any file');

    // settings: the owner's personal settings JSON (when present), then the workbook
    await page.click('#btn-settings');
    if (fs.existsSync(PERSONAL)) {
      await page.setInputFiles('#set-import', payload(PERSONAL, 'application/json'));
      await page.waitForFunction(() => /已匯入設定/.test(document.querySelector('#set-msg').textContent), null, { timeout: 30000 });
      ok(true, 'personal settings JSON imported');
    }
    await page.setInputFiles('#set-workbook', payload(path.join(FIX, '分類參考.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
    await page.waitForFunction(() => /學到/.test(document.querySelector('#set-wb-msg').textContent), null, { timeout: 30000 });
    console.log('  ..', await page.textContent('#set-wb-msg'));
    ok(/已學會 \d+/.test(await page.textContent('#learned-count')), 'learned count shown');
    await page.click('#set-close');

    // drop all 7 PDFs
    const pdfs = fs.readdirSync(path.join(FIX, 'pdf')).filter((f) => f.endsWith('.pdf')).map((f) => path.join(FIX, 'pdf', f));
    await page.setInputFiles('#file-input', pdfs.map((f) => payload(f, 'application/pdf')));
    await page.waitForFunction((n) => {
      const li = [...document.querySelectorAll('#file-list li.file')];
      return li.length === n && document.querySelector('#app').dataset.busy === '0' &&
        li.every((x) => ['ok', 'bad', 'pw', 'unknown', 'error'].includes(x.dataset.status));
    }, pdfs.length, { timeout: 240000 });
    const st = await page.$$eval('#file-list li.file', (l) => l.map((x) => x.querySelector('.fname').textContent + ':' + x.querySelector('.st').textContent));
    console.log('  ..', st.join(' '));
    ok(st.length === pdfs.length && st.every((s) => s.endsWith(':通過')), `${pdfs.length} statements 通過`);
    const n = async (s) => +(await page.textContent(s));
    ok(await n('#count-total') === N_ALL, `total rows ${N_ALL} (got ` + await n('#count-total') + ')');
    ok(await n('#count-fixed') === N_FIX, `固定 ${N_FIX} (got ` + await n('#count-fixed') + ')');
    ok(await n('#count-float') === N_FLOAT, `浮動 ${N_FLOAT} (got ` + await n('#count-float') + ')');
    const pendingBtn = await page.textContent('#filter-pending');
    const pending0 = +(await page.textContent('#filter-pending .ct'));
    console.log('  ..', 'filter:', pendingBtn);
    ok(pending0 > 0, 'pending count shown on 待確認 button');
    const rowsShown = await page.$$eval('#review-body tr.row', (l) => l.length);
    ok(rowsShown === pending0, 'review table shows pending rows by default');

    await page.screenshot({ path: path.join(OUT, 'e2e-1280.png'), fullPage: true });

    // keyboard: move down, edit type via T, pick a fixed type, then confirm the next row with Enter
    await page.focus('#review-wrap');
    await page.evaluate(() => { window.__keepRows = [...document.querySelectorAll('#review-body tr.row')]; });
    await page.keyboard.press('ArrowDown');
    const moved = await page.evaluate(() => {
      const now = [...document.querySelectorAll('#review-body tr.row')], c = document.querySelectorAll('#review-body tr.row.cur');
      return now.length === window.__keepRows.length && now.every((x, i) => x === window.__keepRows[i]) &&
        c.length === 1 && c[0] === now[1] && c[0].getAttribute('aria-selected') === 'true' && now[0].getAttribute('aria-selected') === 'false';
    });
    ok(moved, 'ArrowDown moves the cursor in place (no table re-render)');
    const curId = await page.getAttribute('#review-body tr.row.cur', 'data-id');
    await page.keyboard.press('t');
    await page.waitForSelector('#edit-type');
    await page.keyboard.type('房租');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#edit-type', { state: 'detached' });
    const edited = await page.evaluate((id) => { const r = CC.app.state.rows.find((x) => x.id === id); return r && [r.type, r.sheet, r.confirmed]; }, curId);
    ok(edited && edited[0] === '房租' && edited[1] === '固定' && edited[2], 'type edited via keyboard, moved to 固定 (' + edited + ')');
    ok(await n('#count-fixed') === N_FIX + 1, `固定 now ${N_FIX + 1}`);
    const pending1 = +(await page.textContent('#filter-pending .ct'));
    ok(pending1 === pending0 - 1, 'edited row left 待確認');

    await page.focus('#review-wrap');
    const cur2 = await page.getAttribute('#review-body tr.row.cur', 'data-id');
    await page.keyboard.press('Enter');
    const conf = await page.evaluate((id) => CC.app.state.rows.find((x) => x.id === id).confirmed, cur2);
    ok(conf === true, 'Enter confirms the current row');
    ok(+(await page.textContent('#filter-pending .ct')) === pending0 - 2, 'pending count decremented');
    const cur3 = await page.getAttribute('#review-body tr.row.cur', 'data-id');
    ok(cur3 && cur3 !== cur2, 'cursor jumped to next pending');

    // space expands, detail visible
    await page.keyboard.press(' ');
    ok(await page.isVisible('#review-body tr.detail'), 'Space expands the row');

    // 套用到同摘要 under 待確認: the row leaves the view but the confirmation stays visible until the next action
    await page.click('#review-body tr.detail [data-act="apply"]');
    ok(await page.isVisible('#review-flash') && /已套用/.test(await page.textContent('#review-flash')), 'apply confirmation shown in status line');
    await page.focus('#review-wrap');
    await page.keyboard.press('ArrowDown');
    ok(!(await page.isVisible('#review-flash')), 'apply confirmation cleared on next action');

    // export
    ok(await page.isEnabled('#btn-xlsx'), 'export enabled');
    await page.click('#btn-xlsx');
    await page.waitForFunction(() => window.__saved, null, { timeout: 30000 });
    const saved = await page.evaluate(() => window.__saved);
    console.log('  ..', JSON.stringify(saved));
    ok(saved.filename.endsWith('.xlsx') && saved.size > 1000, 'xlsx saved via downloads');

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(OUT, 'e2e-1280-after.png'), fullPage: true });
    await page.setViewportSize({ width: 400, height: 860 });
    await page.waitForTimeout(200);
    const sw = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    ok(sw[0] <= sw[1], 'no horizontal page scroll at 400px (' + sw + ')');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(OUT, 'e2e-400.png'), fullPage: true });

    await recovery(await setup(), `http://127.0.0.1:${port}/test.html`);
    ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } catch (e) {
    fail++; console.log('  FAIL exception', e);
    await page.screenshot({ path: path.join(OUT, 'e2e-fail.png'), fullPage: true }).catch(() => {});
  } finally {
    await browser.close(); srv.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
