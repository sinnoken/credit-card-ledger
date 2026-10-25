# 第三方元件

網頁版在執行時從 CDN 載入下列程式庫，或把它們的檔案和頁面一起發佈。這些檔案都不在本 repo 裡；`web/scripts/fetch_vendor.sh` 會下載到 `web/vendor/`。

| 元件 | 版本 | 用途 | 授權 |
| --- | --- | --- | --- |
| [pdf.js](https://github.com/mozilla/pdf.js)（pdfjs-dist） | 3.11.174 | 讀取 PDF 文字層、渲染頁面 | Apache-2.0 |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime)（onnxruntime-web） | 1.14.0 | 在瀏覽器執行 OCR 模型 | MIT |
| [ExcelJS](https://github.com/exceljs/exceljs) | 4.4.0 | 產生 .xlsx | MIT |
| PP-OCRv3 中文辨識模型（ONNX，取自 [RapidOCR](https://github.com/RapidAI/RapidOCR) rapidocr-onnxruntime 1.2.3） | ch_PP-OCRv3_rec_infer | 說明欄 OCR | Apache-2.0（模型源自 [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)） |

Python 版使用 pdfplumber（MIT）、pypdfium2（Apache-2.0 / BSD-3-Clause）、openpyxl（MIT）、rapidocr-onnxruntime（Apache-2.0）；解密腳本使用 [qpdf](https://github.com/qpdf/qpdf)（Apache-2.0），需另外安裝。

散布 `dist/`（含模型與 WASM）時，請一併保留上述授權聲明。
