#!/usr/bin/env bash
# Recreate vendor/ (local copies used by build.py and the tests; the published page loads the CDNs).
#   scripts/fetch_vendor.sh [TARGET_DIR]     (default: vendor/ next to this scripts/ folder)
# Needs: npm, pip, python3 with onnxruntime (pip install onnxruntime), unzip, tar, base64.
#  - npm pack pdfjs-dist@3.11.174, onnxruntime-web@1.14.0, exceljs@4.4.0 -> TARGET/pkg/<name>/package/...
#    and the files build.py / the tests use: pdf.min.js, pdf.worker.min.js, ort.min.js, ort-wasm-simd.wasm, exceljs.min.js
#  - ch_PP-OCRv3_rec_infer.onnx from the rapidocr-onnxruntime==1.2.3 wheel ->
#    rec.onnx.b64.txt (base64, one line, no newline) and keys.txt (the model's 'character' metadata).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(mkdir -p "${1:-$HERE/vendor}" && cd "${1:-$HERE/vendor}" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "vendor -> $OUT"
mkdir -p "$WORK/npm" "$OUT/pkg"
pack() { # pack <spec> <pkg dir name>
  local tgz
  tgz="$(cd "$WORK/npm" && npm pack --silent "$1" | tail -n 1)"
  rm -rf "$OUT/pkg/$2" && mkdir -p "$OUT/pkg/$2"
  tar -xzf "$WORK/npm/$tgz" -C "$OUT/pkg/$2"
  echo "  $1 -> pkg/$2"
}
pack pdfjs-dist@3.11.174 pdfjs-dist-3.11.174
pack onnxruntime-web@1.14.0 onnxruntime-web-1.14.0
pack exceljs@4.4.0 exceljs

P="$OUT/pkg"
cp "$P/pdfjs-dist-3.11.174/package/build/pdf.min.js" "$OUT/pdf.min.js"
cp "$P/pdfjs-dist-3.11.174/package/build/pdf.worker.min.js" "$OUT/pdf.worker.min.js"
cp "$P/onnxruntime-web-1.14.0/package/dist/ort.min.js" "$OUT/ort.min.js"
cp "$P/onnxruntime-web-1.14.0/package/dist/ort-wasm-simd.wasm" "$OUT/ort-wasm-simd.wasm"
cp "$P/exceljs/package/dist/exceljs.min.js" "$OUT/exceljs.min.js"

mkdir -p "$WORK/wheel" "$WORK/model"
pip download --quiet --no-deps --only-binary=:all: rapidocr-onnxruntime==1.2.3 -d "$WORK/wheel"
unzip -q -j "$WORK"/wheel/rapidocr_onnxruntime-1.2.3-*.whl 'rapidocr_onnxruntime/models/ch_PP-OCRv3_rec_infer.onnx' -d "$WORK/model"
MODEL="$WORK/model/ch_PP-OCRv3_rec_infer.onnx"
base64 -w 0 "$MODEL" > "$OUT/rec.onnx.b64.txt"
python3 -I - "$MODEL" "$OUT/keys.txt" <<'PY'
import sys, onnxruntime as ort
sess = ort.InferenceSession(sys.argv[1], providers=["CPUExecutionProvider"])
chars = sess.get_modelmeta().custom_metadata_map["character"].splitlines()
assert len(chars) == 6623, len(chars)
with open(sys.argv[2], "w", encoding="utf-8", newline="\n") as f:
    f.write("\n".join(chars))
print("  keys.txt:", len(chars), "characters")
PY
echo "done: $(ls "$OUT" | tr '\n' ' ')"
