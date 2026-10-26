# 信用卡帳單轉換 SPA — module contract (lead: read before writing code)

Goal: a single-page app (published as a claude.ai Artifact) that turns credit-card PDF statements into rows
for the user's Excel workbook. Port of the validated Python tool `../python/convert.py` (a private copy with personal settings may live at `test/fixtures/convert_reference.py`, gitignored).
All processing in the browser; PDFs and passwords never leave the tab.

## Layout
```
src/core.js        lead      — CC.util, CC.pdf (DONE; do not edit — ask the lead for changes)
src/banks.js       agent A   — CC.banks
src/ocr.js         agent B   — CC.ocr
src/settings.js    agent C   — CC.settings
src/classify.js    agent C   — CC.classify, CC.reconcile
src/payslip.js                — CC.payslip (payslip e-mails / pasted text; loads after classify.js)
src/export.js      agent C   — CC.exporter
src/app.js         agent D   — UI controller
src/template.html  agent D   — page markup (placeholders /*__CSS__*/ and /*__JS__*/)
src/styles.css     agent D
build.py           lead      — python3 build.py -> dist/index.html (+ dist/test.html, support files)
test/              each agent adds its own test file; shared helpers: node_env.cjs, serve.cjs, dump_lines.cjs
test/fixtures/pdf/*.pdf      real statements, one per bank (BOT CTBC FIRST FUBON MEGA TCB TSB) — PRIVATE, gitignored
test/fixtures/expected.json  reference output of the Python tool per file (raw rows + final output rows) — PRIVATE
                             (regenerate: python3 scripts/make_expected.py [path/to/convert.py])
test/fixtures/分類參考.xlsx   the owner's workbook (sheets 固定/浮動/工作表1) used to learn 摘要→類型 — PRIVATE
test/fixtures/personal-settings.json  optional owner settings JSON, imported before comparing to expected.json — PRIVATE
test/fixtures/*.eml          real payslip e-mails — PRIVATE (*.eml is gitignored everywhere)
test/fixtures/帳本.xlsx       owner workbook with 收入 / 轉帳 sheets, for payslip.test — PRIVATE
test/out/                    screenshots from e2e — PRIVATE (show statement contents)
                             Tests needing any of these print `SKIP (private fixtures not present: …)` and exit 0.
scripts/fetch_vendor.sh      recreates vendor/ from npm + the rapidocr wheel
vendor/            local copies of pdf.js, onnxruntime-web, exceljs, models (tests only; page loads CDNs)
```
Every module is a classic script: `(function (g) { const CC = (g.CC = g.CC || {}); ... })(globalThis);`
No ES `import`/`export`, no `</script` inside code. Must load in Node too (tests) unless it needs the DOM.
Dates are ISO strings `'YYYY-MM-DD'`. Amounts are numbers (TWD). User-facing strings are Traditional Chinese.

## Runtime environment of the published page
- External scripts ONLY from these exact URLs (loaded by template.html before the inline script):
  - https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js   (global `pdfjsLib`)
  - https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/ort.min.js (global `ort`)
  - https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js      (global `ExcelJS`)
- Files published next to the page, fetched with RELATIVE urls: `pdf.worker.min.js`, `ort-wasm-simd.wasm`,
  `rec.onnx.b64.txt` (PP-OCRv3 rec model, base64 text), `keys.txt` (6623-char dictionary, one per line).
- No other network. No page-initiated downloads: saving a file goes through
  `const dl = await window.claude?.use?.("downloads")` → `await dl.save({filename, data})` (viewer confirms;
  rejects with `{code}`: 'declined', 'unavailable', 'rate_limited', ...). `dl` may be null → hide save, keep copy.
- alert/confirm/prompt do nothing. Clipboard write works only inside a click handler.
- localStorage may throw → wrap in try/catch.

## core.js (done)
- `CC.util`: `nfkc, norm, isNum, toNum, roc('115/03/14'|'115?03?14')→iso|null, mdDate('09/29', closingIso)→iso|null, iso(y,m,d)`
- `CC.pdf.open(arrayBuffer, passwords[])` → `{doc, password}`; rejects Error `.code='password'`.
- `CC.pdf.read(doc)` → `{swapped, text, pages:[{num,width,height,page,items:[{s,x,x1,w,y,h}]}]}`
  (PDF points, origin top-left, y = vertical centre; `text` = NFKC lower-case of everything, for detection;
  byte-swapped fonts already fixed, '0' restored: pdf.js treats that font's '0' as whitespace, so every zero is
  re-inserted from the glyphs in the page's operator list (`CC.pdf.zeroGlyphs(page, height)`); such pages get
  `glyphZeros:true`. Non-swapped docs are unaffected).
- `CC.pdf.lines(items, {ytol=2.5, gap=5, filter})` → `[{y, segs:[{t,x0,x1}], text}]`; `CC.pdf.segsIn(line, x0, x1)`.
- Inspect any fixture: `node test/dump_lines.cjs FIRST.pdf 2`.

## banks.js (agent A)
```
CC.banks.list: [{ id, name, card, keys:[...unique strings...], ocr:bool, parse(read) → Statement0 }]
CC.banks.detect(read) → bank | null     // score = number of keys found in read.text; unique max wins; tie/0 → null
Statement0 = { closing:iso, prev:number, cur:number, rows: Row0[], warn?:string, due?:iso }
// due: 繳款截止日, only when found and 7–35 days after closing; missing never fails the parse (docs/BANKS.md)
// warn: optional, human-readable 中文 (e.g. 合庫 '合庫金額位置不一致，請人工核對'); the UI shows st.warn and treats the file as needing review
Row0 = { date:iso|null, post:iso|null, desc:string, amount:number, last4:string,
         ocr: null | { page:num, y, x0, x1 } }   // OCR banks: desc '' and ocr = where the 說明 cell is
```
ids/names/cards (neutral default card names; users rename cards in 設定 or their settings JSON):
fubon 台北富邦 台北富邦信用卡 · ctbc 中國信託 中國信託信用卡 · mega 兆豐 兆豐信用卡 · tsb 台新 台新信用卡 ·
first 第一銀行 第一銀行信用卡 · tcb 合作金庫 合庫信用卡 · bot 臺灣銀行 臺銀信用卡.
Python detection keys: tcb `tcb-bank.com.tw`,`2227-3131` · ctbc `ctbc.tw`,`2745-8080` · bot `ecard.bot.com.tw`,`2182-1901` ·
tsb `taishinbank.com.tw`,`2655-3355` · first `firstbank.com.tw`,`2173-2999` · fubon `fubon.com`,`8751-1313` ·
mega `megabank.com.tw`,`(02)89820000`,`8982-0000`. pdf.js text differs from pdfplumber — verify against fixtures;
合庫's text layer is mostly '?' so use `read.swapped` + digits that survive (e.g. a phone number) or another robust signal.
Missing totals → throw Error('找不到上期／本期總額（可能改版）').
`row.date` = consumption date, falls back to post date (as Python `row()` does).

## ocr.js (agent B)
```
CC.ocr.DEFAULT_FIX: [[from,to], ...]           // Python OCR_FIX table + ['連二','連＿'],['连二','連＿']
CC.ocr.ensure(onProgress?) → Promise<void>      // fetch keys.txt + rec.onnx.b64.txt, decode, cache bytes in IndexedDB
                                                //   (db 'cc-ocr', store 'models', key 'rec-v3'), create ort session
                                                //   (wasm, numThreads 1, wasmPaths = page directory). Idempotent.
CC.ocr.recognize(pdfPage, reqs:[{y,x0,x1}]) → Promise<[{text, conf, crop}]>   // crop = PNG dataURL of the cell
CC.ocr.cleanup(text, fixList) → string
```
Rendering at 300 dpi, crop around y, tighten to the ink of that one text line, resize to h=48, BGR, (x/255-.5)/.5,
CTC decode (index 0 blank, 1..6623 dict, 6624 space). (Ported from an earlier working single-file prototype.)

## settings.js / classify.js / export.js (agent C)
```
CC.settings.DEFAULTS = { version:1, dateMode:'帳單日'|'消費日'|'入帳日',
  cards: { [bankId]: { name, defaultType } }, cardByLast4: { '1234': '卡名' },
  rules: [{ words:[...], type }], learned: { [normKey]: { desc, type, conflict?:true, src:'manual'|'workbook' } },   // missing src ⇒ 'workbook'
  fixedTypes:[...], floatingTypes:[...], ocrFix:[[a,b]],
  incomeTypes:[...],                                           // 收入類型 for 收入; default 薪資 薪資加給 節日績效獎金 各類補助 勞務兼差收入 非勞務收入
  bankTargets:[...],                                           // 轉入銀行 learned from the 轉帳 sheet; a payslip deduction typed with one goes to 轉帳
  payslip: { account:'', companies:[{ name, keys:[...], account? }] } }   // account = 收入形式/消費方式 of payslip rows (drawer 薪資入帳帳戶);
                                                               // companies only via settings JSON      // neutral starter defaults: card names '<bank>信用卡', defaultType '日用其他',
                                                               // generic rules only; types from 工作表1
CC.settings.load() / save(s)                     // localStorage 'cc-settings-v1', try/catch, merge with DEFAULTS
CC.settings.exportJSON(s) → string ; importJSON(str, current?) → settings (validated) | throws Error(中文)
  // with current: learned is MERGED into current.learned (incoming manual wins; incoming workbook never replaces manual; other keys kept); fields present in the import replace, absent fields come from current
CC.settings.importWorkbook(arrayBuffer) → Promise<{learned, count, conflicts, fixedTypes, incomeTypes, bankTargets}>   // ExcelJS; sheets 固定 + Spend2 (read as 固定) / 浮動 (+ 收入, or the older name Incomes; 轉帳, or the older name Bank), col B 類型, col C 摘要;
                                                 //   轉帳: col C 摘要 → col E 轉入銀行 (learned like a type, collected into bankTargets)
CC.settings.learn(s, desc, type) → s             // the "套用到同摘要" action; writes src:'manual'
CC.settings.applyWorkbook(s, res) → s            // adds res.learned as src:'workbook'; never overwrites a src:'manual' entry;
                                                 //   unions res.fixedTypes / incomeTypes / bankTargets into s
CC.classify.isPayment(desc, amount) ; kind(desc, amount) → 'payment'|'reward'|'fee'|'purchase'
CC.classify.fixOcr(desc, s) → {desc, matched}    // closest learned desc with difflib-ratio ≥ 0.85
CC.classify.classify(desc, card, s, prevType) → {type, guess}      // same order as Python classify()
CC.classify.sheetOf(type, s) → '固定'|'浮動'
CC.classify.process(st, bank, s, file) → OutRow[]  // Python main loop: skip payments, card name, fixOcr for OCR rows,
                                                   //   classify with prevType, sheet, date by dateMode, inst (分期 n/m)
OutRow = { id, file, bank:bankId, sheet, date, type, desc, descRaw, card, inst, amount:int, kind,
           guess:bool, ocr:bool, confirmed:false, crop:null }
           // kind: classify.kind() for statements; 'income' | 'deduct' for payslip rows (sheet 收入 | 固定/浮動 | 轉帳)
CC.reconcile(st) → { total, expect, ok }           // total = Σ all rows incl. payments; expect = cur - prev; |Δ|<0.01
                                                   //   payslip: prev 0, cur 實發 ⇒ Σ(earnings − deductions) = 實發
CC.exporter.toTSV(rows) → string                   // header 日期 消費類型 摘要 消費方式 分期數 金額; date yyyy/m/d
CC.exporter.toXlsx(rows, checks) → Promise<ArrayBuffer>  // sheets 固定, 浮動, 核對結果 like convert.py, then 繳費 (fills, widths, numFmt),
                                                         //   then 收入 (日期 收入類型 摘要 收入形式 金額) only when a row has sheet 收入,
                                                         //   then 轉帳 (帳戶名稱 日期 摘要 存/提/轉 轉入銀行 金額 手續費) only when a row has sheet 轉帳
CC.exporter.payRows(checks) → [{card, due, method, amount}]  // statements with cur > 0 and kind ≠ 'payslip', by due then card
CC.exporter.payTSV(checks) → string                // header 信用卡名稱 日期 摘要 繳款方式 還款金額 (same columns as 繳費)
CC.exporter.incomeTSV(rows) → string              // 收入 rows; header 日期 收入類型 摘要 收入形式 金額 (複製收入)
CC.exporter.bankTSV(rows) → string                // 轉帳 rows; 帳戶名稱=card, 存/提/轉=轉帳, 轉入銀行=type, 手續費 empty (複製轉帳)
CC.exporter.save(filename, arrayBuffer) → Promise<'saved'>   // via downloads capability; rejects {code}
```
`checks` row: `{file, bank, closing, prev, cur, total, expect, ok, count, error?, due?, card?, kind?}` (kind 'payslip' | 'statement'). 核對結果 has one column more
than convert.py: 繳款截止日 last (`CC.exporter.dueOf(cur, due)`: 無需繳款 when cur ≤ 0, else the date or empty).
Python ratio = difflib.SequenceMatcher(None, a, b).ratio() on norm() keys — reproduce it (Ratcliff/Obershelp
with autojunk=false is fine for these short strings).

## payslip.js
No employer names in code; settings.payslip maps keywords → company / account.
```
CC.payslip.fromEml(bytes) → {subject, from, date, text}   // multipart, base64 / quoted-printable, charset incl. Big5;
                                                          //   text/plain preferred, else HTML → text (cells → tabs); no body → Error('…找不到內文…')
CC.payslip.parse(text, meta?) → { closing, prev:0, cur:實發, rows:[{desc, amount}], gross, deduct, net, earn, ded, warn? }
  // closing = 發薪日期 (ROC or AD), fallback meta.date; rows: earnings +, deductions −
  // items: employer code layout 代碼(名稱) then amount (e.g. A1(本薪) 30,000), else generic label/amount pairs
  //   (same or next cell, CJK label, SKIP_WORDS ignored, DEDUCT_WORDS make a positive amount a deduction)
  // totals by keyword (TOTALS.gross 應發… / deduct 應扣… / net 實發…); subtotal mismatch, missing totals or date → warn (需核對)
  // no items → throw Error('找不到薪資項目（可能改版，或不是薪資單）')
CC.payslip.detect(text, meta, s) → { id:'payslip', name, card }   // first settings.payslip.companies entry whose keys match; default name 薪資單
CC.payslip.process(st, src, s, file) → OutRow[]   // earnings: sheet '收入', type from incomeTypes, kind 'income';
                                                  // deductions: positive amount, sheet 固定/浮動 by type, kind 'deduct'
                                                  //   (sheet '轉帳' when the type is in bankTargets: money moved to another account);
                                                  // card = company account || payslip.account; date = st.closing
  // type: learned or rule; unknown or wrong side (income type on a deduction or vice versa) → 薪資 / 保險(壽險/勞保/健保), guess:true
CC.payslip.sheetFor(r, type, s) → '收入' | '轉帳' | '固定' | '浮動'   // used when the user retypes a row; 轉帳 only for kind 'deduct'
CC.payslip.incomeTypes(s) / bankTargets(s) → string[]   // copies of the settings lists (type pickers)
```
UI: .eml files go into the same drop zone as PDFs; step 1 has 貼上薪資單內文 (text kept in memory only, cleared after 加入).
Payslip rows pick types from incomeTypes (earnings) or fixed+floating plus bankTargets (deductions); 套用到同摘要 never crosses sides
and applies a 轉入銀行 only to payslip deductions (card rows never go to 轉帳). Unknown deductions stay 固定 with guess:true.

## app.js / template.html / styles.css (agent D)
UI per the design doc (tab "SPA 設計"): one page, three steps 放入 → 確認 → 匯出, settings drawer.
Pipeline per file: open (passwords) → read → detect → parse → reconcile → process (non-OCR rows immediately);
then for OCR banks: ensure model → recognize → cleanup → fixOcr → classify → update rows.
One failing file never blocks others. Review table defaults to 待確認 (guess || ocr || statement not ok) and supports
inline edit of 類型 (from fixed+floating types; payslip rows see payslip.js) and 摘要, confirm (Enter), 套用到同摘要, keyboard ↑↓/Enter/T/E/Space.
Export: 存成 Excel (downloads capability), 複製固定 / 複製浮動 / 複製繳費 / 複製收入 / 複製轉帳 (TSV to clipboard), gate when any statement not ok.

## Tests every module must pass before reporting done
- A: `node test/banks.test.cjs` — all 7 detected; closing/prev/cur equal; every row's date/post/amount/last4 equal,
  desc equal for non-OCR banks; OCR banks have rows.ocr set for exactly the rows Python OCR'd.
- B: `node test/ocr.test.cjs` (Playwright, Chromium preinstalled: `require('playwright')`) — CTBC and TCB 說明 cells
  recognised; after cleanup each equals or is ≥ 0.8 similar to the Python desc in expected.json.
- C: `node test/logic.test.cjs` — feeding expected.json raw rows (+ learned from 分類參考.xlsx) through process()
  (after importing test/fixtures/personal-settings.json when present) reproduces expected.json `output` exactly (sheet,date,type,desc,card,amount,guess,ocr); xlsx round-trips via ExcelJS.
- `node test/payslip.test.cjs` — synthetic coded / HTML / generic payslips and MIME decoding; a synthetic workbook with Spend2 / 轉帳
  sheets (learned bankTargets, deduction → 轉帳 row, bankTSV and xlsx 轉帳 sheet); real `test/fixtures/*.eml` reconcile
  with no warning (and classify with `帳本.xlsx`, rows on `sheetFor`'s sheet, some deduction on 轉帳 when it has a 轉帳 sheet) only when present. Runs in CI with the other synthetic tests.
- D: `node test/e2e.test.cjs` after `python3 build.py` — all fixture PDFs dropped, row counts as in expected.json, every statement OK,
  export produces an xlsx (mock window.claude.use('downloads')).
- Without the private fixtures every test still runs its synthetic checks; the fixture-based parts print
  `SKIP (private fixtures not present: …)` (helper `test/private.cjs`) and the process exits 0.
