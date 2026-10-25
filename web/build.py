#!/usr/bin/env python3
"""Build dist/: inline src/styles.css + src/*.js into src/template.html, copy published support files.
dist/index.html  -> what gets published (no doctype; Artifact wraps it)
dist/test.html   -> same page with doctype+charset for local Playwright tests
"""
import os, shutil
H = os.path.dirname(os.path.abspath(__file__))
ORDER = ["core.js", "banks.js", "ocr.js", "settings.js", "classify.js", "export.js", "app.js"]
tpl = open(os.path.join(H, "src/template.html"), encoding="utf-8").read()
css = open(os.path.join(H, "src/styles.css"), encoding="utf-8").read()
js = "\n".join(f"/* ===== {m} ===== */\n" + open(os.path.join(H, "src", m), encoding="utf-8").read() for m in ORDER)
assert "</script" not in js.lower(), "a module contains '</script' — would break inlining"
out = tpl.replace("/*__CSS__*/", css).replace("/*__JS__*/", js)
os.makedirs(os.path.join(H, "dist"), exist_ok=True)
open(os.path.join(H, "dist/index.html"), "w", encoding="utf-8").write(out)
open(os.path.join(H, "dist/test.html"), "w", encoding="utf-8").write('<!doctype html><meta charset="utf-8">\n' + out)
for f in ["pdf.worker.min.js", "ort-wasm-simd.wasm", "rec.onnx.b64.txt", "keys.txt"]:
    shutil.copy(os.path.join(H, "vendor", f), os.path.join(H, "dist", f))
print("built dist/index.html", len(out), "bytes")
