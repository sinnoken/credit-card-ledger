# 帳單轉帳本

把台灣信用卡的 PDF 電子帳單，轉成記帳活頁簿「固定」「浮動」工作表格式的明細。每份帳單都會核對金額，核對不過的不能直接匯出。薪資單電子郵件也能一起轉：收入項目進「收入」表，扣項記成固定支出，轉到其他帳戶的提存則記到「轉帳」表。

全部在你的瀏覽器裡處理：PDF、薪資單、密碼和明細都不會上傳到任何地方。

| 支援銀行 | 讀取方式 |
| --- | --- |
| 台北富邦、兆豐、台新、第一銀行、臺灣銀行 | PDF 文字層 |
| 中國信託、合作金庫 | 金額取自文字層；說明欄用瀏覽器內的 OCR（PP-OCRv3） |

## 線上使用（GitHub Pages）

推到 GitHub 後，網頁會自動建置並發佈到 `https://<帳號>.github.io/<repo>/`（第一次要做一個設定，見下方「部署」）。打開網頁就能使用，不用安裝任何東西；第一次使用需要下載約 25 MB 的 OCR 模型，之後瀏覽器會快取。

## 每月使用（3 步）

1. **放入**：把當月所有 PDF 拖進網頁。有密碼的話輸入一次，可以輸入好幾組，程式會逐一嘗試。每份帳單列出銀行、結帳日、筆數和核對結果；點開可以看到繳款截止日和金額明細。薪資單信件（.eml）可以一起拖進來；沒有 .eml 的話，在「貼上薪資單內文」貼上整份薪資單。收入項目進「收入」，扣項記成固定支出；轉到其他帳戶的提存（例如 `D5(儲蓄提存)`）記到「轉帳」，轉入銀行照你活頁簿「轉帳」表的分法。薪資單要通過「收入 − 扣項 ＝ 實發」的核對。
2. **確認**：審核表預設只列出待確認的列：黃底是類型用猜的、藍底是摘要來自 OCR、紅底是核對不符。直接在表上修改；按「套用到同摘要」，下個月同樣的摘要就會自動分類。不認得的薪資扣項先當固定支出、標黃；它的類型選單也列出轉入銀行，選了就改記到「轉帳」。點欄位標題可以排序（第一下 ▲ 由小到大、第二下 ▼ 由大到小、第三下回到檔案順序；文字照中文排序、其中的數字照大小，金額照數值，同值維持檔案順序），可以和篩選一起用，↑ ↓ 與 Enter 跳到的下一筆都照畫面上的順序，排序不會保存。
3. **匯出**：「存成 Excel」下載 .xlsx（含「固定」「浮動」「核對結果」「繳費」四張表，「核對結果」最後一欄是繳款截止日；「繳費」每份要繳款的帳單一列：信用卡名稱、繳款截止日、繳款方式、本期應繳；有薪資單時多一張「收入」：日期、收入類型、摘要、收入形式、金額；有轉帳的提存時再多一張「轉帳」：帳戶名稱、日期、摘要、存/提/轉、轉入銀行、金額、手續費），或用「複製固定／浮動／繳費／收入／轉帳」直接貼進你的活頁簿，欄位與 Excel 相同；複製成功的訊息會寫出要貼到哪張表，程式的名稱和帳本的名稱都列出，例如「固定（Spend2）」（對照見「個人化」）。

鍵盤操作：↑ ↓ 移動、Enter 確認並跳到下一筆、T 改類型、E 改摘要、空白鍵展開截圖。

## 自己架設或開發

需要 Node 18+、Python 3.10+。

```bash
cd web
bash scripts/fetch_vendor.sh      # 下載 pdf.js、onnxruntime-web、ExcelJS 與 OCR 模型到 vendor/（不進版控）
python3 build.py                  # 產生 dist/index.html 與要一起發佈的檔案
```

`build.py` 產生兩種版本：

| 輸出 | 用途 |
| --- | --- |
| `dist/site/` | 一般靜態網站（GitHub Pages 或任何主機）：完整的 `index.html` 加上 `pdf.worker.min.js`、`ort-wasm-simd.wasm`、`rec.onnx.b64.txt`、`keys.txt` |
| `dist/index.html` | 發佈成 claude.ai Artifact 用的頁面內容（不含 `<!doctype>`），本機測試開 `dist/test.html` |

「存成 Excel」在一般網頁上直接用瀏覽器下載；在 claude.ai Artifact 裡則透過它的 `downloads` 功能。

## 部署

`.github/workflows/pages.yml` 會在每次推送到 `main` 時下載第三方檔案、建置、跑合成資料的測試，然後發佈 `web/dist/site` 到 GitHub Pages。第一次只要設定一次：

1. repo 的 **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**
2. 到 **Actions** 分頁，等「Deploy to GitHub Pages」跑完（約 2 分鐘），網址會顯示在該次執行的 deploy 步驟

若是 Private repo，GitHub Pages 需要付費方案；免費帳號請把 repo 設為 Public。

## 測試

```bash
cd web
node test/banks.test.cjs        # 7 家銀行解析
node test/banks_edge.test.cjs   # 合作金庫補 0、缺結帳日、繳款截止日等邊界情況（合成資料）
node test/logic.test.cjs        # 分類、核對、設定匯入匯出、xlsx／TSV
node test/payslip.test.cjs      # 薪資單 .eml／貼上內文 → 收入、固定與轉帳（合成資料）
node test/ocr.test.cjs          # 瀏覽器 OCR（Playwright + Chromium）
python3 build.py && node test/e2e.test.cjs   # 整頁流程（Playwright）
node test/pages.test.cjs        # dist/site 以一般網站方式執行（無 claude.ai 功能、瀏覽器下載）
```

真實帳單不會放進版控。沒有私人測試資料時，相關測試會顯示 `SKIP` 並以成功結束，其餘用合成資料的測試照常執行。要用自己的帳單跑完整測試，請在 `web/test/fixtures/` 放入：

| 檔案 | 內容 |
| --- | --- |
| `pdf/*.pdf` | 解密後的帳單 |
| `分類參考.xlsx` | 你的活頁簿（「固定」「浮動」「工作表1」） |
| `personal-settings.json` | 你在網頁「設定 → 匯出設定 JSON」存下的個人設定（選用） |
| `convert_reference.py` | 套用你個人卡名與規則的 Python 版（選用） |
| `*.eml` | 你的薪資單信件（選用；搭配 `帳本.xlsx` 會再檢查分類） |
| `帳本.xlsx` | 含「收入」「轉帳」工作表的活頁簿，給薪資單測試用（選用） |
| `expected_due.json` | 各帳單的繳款截止日，照紙本手填，例如 `{"TSB.pdf": "2026-11-02", "FUBON.pdf": null}`（`null` 是無需繳款；選用） |

然後用 `python3 scripts/make_expected.py` 產生 `expected.json`（Python 版的參考結果），JS 版必須逐筆一致。

## Python 版

`python/` 是最早的命令列版本（Windows），與網頁版結果一致，也是網頁版的參考實作。差別是 Python 版不讀繳款截止日，「核對結果」少最後一欄，也沒有「繳費」表，不處理薪資單：

- `decrypt_pdf.ps1`：用 qpdf 批次解密，執行時才輸入密碼，不會存檔
- `convert.py`：轉換並輸出 Excel
- 用法見 `python/使用說明.txt`

## 個人化

程式內建的卡片名稱（「台北富邦信用卡」這類）和分類規則都是通用的。你的卡片名稱、常去店家的分類規則、薪資入帳帳戶，請在網頁「設定」裡修改，再「匯出設定 JSON」自行保存（見下方「備份設定」）；這個檔案不要放進版控。

「設定 → 從帳本學分類」：選你平常記帳的活頁簿，程式會從裡面學「摘要 → 類型」，之後同樣的摘要就照你的分法，不用再猜。每張表用程式裡的名稱或帳本裡的名稱都可以：

| 程式裡 | 帳本裡 | 讀哪幾欄 | 學到什麼 |
|---|---|---|---|
| 固定 | Spend2 | B 類型、C 摘要 | 摘要 → 固定支出類型 |
| 浮動 | Spend1 | B 類型、C 摘要 | 摘要 → 浮動支出類型 |
| 收入 | Incomes | B 收入類型、C 摘要 | 薪資項目 → 收入類型 |
| 轉帳 | Bank | C 摘要、E 轉入銀行 | 哪些薪資扣項是轉到別的帳戶、轉到哪裡（存在設定 JSON 的 `bankTargets`，例如 `["儲蓄帳戶"]`） |

- 不讀日期、金額和其他工作表（例如類型清單）；不會修改活頁簿，也不會上傳。
- 分類順序：信用卡明細先看關鍵字規則，再看學到的分類；薪資項目先看學到的分類。都沒有就用預設類型並標黃。收入類型和轉入銀行不會套到信用卡消費上。
- 同一個摘要在帳本裡有兩種分法會標黃；在確認表按過「套用到同摘要」的，重新匯入也不會被蓋掉。
- 帳本新增了收入或轉帳表後，重新匯入一次；重新匯入只會補上新學到的。

薪資單預設叫「薪資單」。要依公司區分，在設定 JSON 的 `payslip.companies` 加上公司名稱和信件裡會出現的關鍵字，例如 `{"name": "範例公司", "keys": ["範例公司"], "account": "範例銀行"}`（`account` 選用，沒填就用「薪資入帳帳戶」）。

### 備份設定

設定只存在這個瀏覽器裡。「設定 → 備份設定 → 匯出設定 JSON」存成 `cc-settings.json`，換電腦、換瀏覽器或清除網站資料後用「匯入設定 JSON」還原。

| 欄位 | 內容 |
|---|---|
| `dateMode` | 日期用帳單日、消費日或入帳日 |
| `cards`、`cardByLast4` | 各銀行的卡片名稱與預設類型；依卡號末四碼指定的卡名 |
| `rules` | 關鍵字分類規則 |
| `learned` | 學到的「摘要 → 類型」：從帳本學的，加上你按「套用到同摘要」的（手動的優先） |
| `fixedTypes`、`floatingTypes`、`incomeTypes`、`bankTargets` | 固定／浮動支出類型、收入類型、轉入銀行 |
| `payslip` | `account` 薪資入帳帳戶、`companies` 公司與關鍵字 |
| `ocrFix` | OCR 錯字校正 |
| `version` | 設定檔版本 |

**不包含**：PDF 密碼、放入的帳單與薪資單、確認表上逐列的修改和「已確認」狀態、排序與篩選。

匯入時：檔案裡有的欄位取代目前的，沒有的欄位保留目前的；`learned` 是合併，不是取代，所以匯入舊的備份不會弄丟之後新學到的分類，同一個摘要以手動學到的為準；學到的分類還在用的類型和轉入銀行也會留著。

這個檔案的 `learned` 含有你所有的消費摘要和薪資項目，`payslip.account` 是你的入帳帳戶，請自己保管、不要分享；`.gitignore` 已排除 `cc-settings*.json`。

## 文件

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：架構、資料流、正確性設計
- [docs/BANKS.md](docs/BANKS.md)：各銀行帳單格式與解析要點
- [web/SPEC.md](web/SPEC.md)：各模組的介面約定

## 第三方元件

見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
