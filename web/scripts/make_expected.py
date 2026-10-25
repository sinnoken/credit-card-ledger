#!/usr/bin/env python3
"""Regenerate test/fixtures/expected.json from the private statements in test/fixtures/pdf/.

    python3 scripts/make_expected.py [path/to/convert.py] [--out FILE]

The reference converter (the validated Python tool) defaults to test/fixtures/convert_reference.py
(your private, gitignored copy with personal card names and rules), falling back to ../python/convert.py. Its own settings (card names, rules, OCR fixes)
are used as they are; the 摘要→類型 history is read from test/fixtures/分類參考.xlsx when present.
Needs: pip install pdfplumber pypdfium2 openpyxl rapidocr-onnxruntime

expected.json: { "<file>.pdf": { bank, closing, prev, cur,
                                 rows:   [{date, post, desc, amount, last4, ocr}],      # parser output
                                 output: [{sheet, date, type, desc, card, amount, guess, ocr}] } }  # main loop
Everything in it comes from real statements: it is private (gitignored), like the PDFs.
"""
import argparse, datetime, glob, importlib.util, json, os, sys

sys.dont_write_bytecode = True  # never leave a __pycache__ next to the (private) reference

WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(WEB, "test", "fixtures")
DEFAULT_REFS = [os.path.join(FIX, "convert_reference.py"), os.path.join(WEB, "..", "python", "convert.py")]  # private personal copy first


def load_reference(path):
    spec = importlib.util.spec_from_file_location("cc_reference", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.HERE = FIX  # load_history() looks for 分類參考.xlsx next to the script: point it at the fixtures
    return mod


def iso(d):
    return d.isoformat() if isinstance(d, (datetime.date, datetime.datetime)) else d


def convert(ref, path, hist, fixed_types):
    """One statement, exactly like ref.main()'s loop, without writing a workbook."""
    plumb = ref.pdfplumber.open(path)
    bank, parser = ref.detect(path, plumb)
    if not bank:
        raise SystemExit(f"{os.path.basename(path)}: bank not recognised by the reference")
    r = parser(path, plumb)
    out, prev_type = [], None
    for x in r["rows"]:
        if ref.is_payment(x["desc"], x["amount"]):
            continue
        card = ref.CARD_BY_LAST4.get(x["last4"]) or ref.BANK_CARD.get(bank, bank)
        desc, ocr_flag = x["desc"], x["ocr"]
        if ocr_flag:
            desc, _ = ref.fix_ocr(desc, hist)
        typ, guess = ref.classify(desc, card, hist, prev_type)
        prev_type = typ
        date = {"帳單日": r.get("closing"), "入帳日": x["post"] or x["date"]}.get(ref.DATE_MODE, x["date"])
        out.append({"sheet": "固定" if typ in fixed_types else "浮動", "date": iso(date), "type": typ, "desc": desc,
                    "card": card, "amount": int(round(x["amount"])), "guess": bool(guess), "ocr": bool(ocr_flag)})
    rows = [{"date": iso(x["date"]), "post": iso(x["post"]), "desc": x["desc"], "amount": float(x["amount"]),
             "last4": x["last4"], "ocr": bool(x["ocr"])} for x in r["rows"]]
    num = lambda v: None if v is None else float(v)
    return {"bank": bank, "closing": iso(r.get("closing")), "prev": num(r.get("prev")), "cur": num(r.get("cur")),
            "rows": rows, "output": out}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("reference", nargs="?", help="reference convert.py (default: test/fixtures/convert_reference.py, "
                    "else ../python/convert.py)")
    ap.add_argument("--pdf", default=os.path.join(FIX, "pdf"), help="folder of statements (default test/fixtures/pdf)")
    ap.add_argument("--out", default=os.path.join(FIX, "expected.json"), help="output file (default test/fixtures/expected.json)")
    a = ap.parse_args()
    ref_path = a.reference or next((p for p in DEFAULT_REFS if os.path.exists(p)), None)
    if not ref_path or not os.path.exists(ref_path):
        raise SystemExit("reference converter not found: " + (a.reference or " / ".join(DEFAULT_REFS)))
    files = sorted(glob.glob(os.path.join(a.pdf, "*.pdf")))
    if not files:
        raise SystemExit(f"no PDFs in {a.pdf} (private fixtures not present)")
    print("reference:", os.path.relpath(ref_path, WEB), file=sys.stderr)
    ref = load_reference(ref_path)
    hist, fixed_types = ref.load_history()
    res = {}
    for f in files:
        res[os.path.basename(f)] = convert(ref, f, hist, fixed_types)
        e = res[os.path.basename(f)]
        print(f"  {os.path.basename(f)}: {e['bank']} {len(e['rows'])} rows -> {len(e['output'])} output", file=sys.stderr)
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(res, fh, ensure_ascii=False, indent=1)
    print("wrote", os.path.relpath(a.out, WEB), file=sys.stderr)


if __name__ == "__main__":
    main()
