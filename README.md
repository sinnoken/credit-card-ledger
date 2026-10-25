# 帳單轉帳本

把台灣信用卡的 PDF 電子帳單，轉成記帳活頁簿「固定」「浮動」工作表格式的明細。每份帳單都會核對金額，核對不過的不能直接匯出。

全部在你的瀏覽器裡處理：PDF、密碼和明細都不會上傳到任何地方。

| 支援銀行 | 讀取方式 |
| --- | --- |
| 台北富邦、兆豐、台新、第一銀行、臺灣銀行 | PDF 文字層 |
| 中國信託、合作金庫 | 金額取自文字層；說明欄用瀏覽器內的 OCR（PP-OCRv3） |

## 每月使用（3 步）

1. **放入**：把當月所有 PDF 拖進網頁。有密碼的話輸入一次，可以輸入好幾組，程式會逐一嘗試。
2. **確認**：審核表預設只列出待確認的列：黃底是類型用猜的、藍底是摘要來自 OCR、紅底是核對不符。直接在表上修改；按「套用到同摘要」，下個月同樣的摘要就會自動分類。
3. **匯出**：「存成 Excel」下載 .xlsx（含「固定」「浮動」「核對結果」三張表），或用「複製固定／浮動」直接貼進你的活頁簿。

鍵盤操作：↑ ↓ 移動、Enter 確認並跳到下一筆、T 改類型、E 改摘要、空白鍵展開截圖。

## 自己架設或開發

需要 Node 18+、Python 3.10+。

```bash
cd web
bash scripts/fetch_vendor.sh      # 下載 pdf.js、onnxruntime-web、ExcelJS 與 OCR 模型到 vendor/（不進版控）
python3 build.py                  # 產生 dist/index.html 與要一起發佈的檔案
```

`dist/` 是一個靜態網站：`index.html` 是頁面內容（不含 `<!doctype>`，原本是發佈成 claude.ai Artifact 用的），本機測試請開 `dist/test.html`。要放上自己的靜態主機時，`pdf.worker.min.js`、`ort-wasm-simd.wasm`、`rec.onnx.b64.txt`、`keys.txt` 要和頁面放在同一個資料夾。

「存成 Excel」使用 claude.ai Artifact 的 `downloads` 功能；在一般網頁上沒有這個功能時，這個按鈕會隱藏，「複製」仍可使用。

## 測試

```bash
cd web
node test/banks.test.cjs        # 7 家銀行解析
node test/banks_edge.test.cjs   # 合作金庫補 0、缺結帳日等邊界情況（合成資料）
node test/logic.test.cjs        # 分類、核對、設定匯入匯出、xlsx／TSV
node test/ocr.test.cjs          # 瀏覽器 OCR（Playwright + Chromium）
python3 build.py && node test/e2e.test.cjs   # 整頁流程（Playwright）
```

真實帳單不會放進版控。沒有私人測試資料時，相關測試會顯示 `SKIP` 並以成功結束，其餘用合成資料的測試照常執行。要用自己的帳單跑完整測試，請在 `web/test/fixtures/` 放入：

| 檔案 | 內容 |
| --- | --- |
| `pdf/*.pdf` | 解密後的帳單 |
| `分類參考.xlsx` | 你的活頁簿（「固定」「浮動」「工作表1」） |
| `personal-settings.json` | 你在網頁「設定 → 匯出設定 JSON」存下的個人設定（選用） |
| `convert_reference.py` | 套用你個人卡名與規則的 Python 版（選用） |

然後用 `python3 scripts/make_expected.py` 產生 `expected.json`（Python 版的參考結果），JS 版必須逐筆一致。

## Python 版

`python/` 是最早的命令列版本（Windows），與網頁版結果一致，也是網頁版的參考實作：

- `decrypt_pdf.ps1`：用 qpdf 批次解密，執行時才輸入密碼，不會存檔
- `convert.py`：轉換並輸出 Excel
- 用法見 `python/使用說明.txt`

## 個人化

程式內建的卡片名稱（「台北富邦信用卡」這類）和分類規則都是通用的。你的卡片名稱、常去店家的分類規則，請在網頁「設定」裡修改，再「匯出設定 JSON」自行保存；這個檔案不要放進版控。

## 文件

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：架構、資料流、正確性設計
- [docs/BANKS.md](docs/BANKS.md)：各銀行帳單格式與解析要點
- [web/SPEC.md](web/SPEC.md)：各模組的介面約定

## 第三方元件

見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
