# -*- coding: utf-8 -*-
"""
信用卡 PDF 帳單 → Excel（固定 / 浮動 / 核對結果）

用法：把解密後的 PDF 放進 decrypted 資料夾（或與本程式同一資料夾），
執行「轉換.bat」或 `python convert.py`。結果輸出到 output 資料夾。

支援：台北富邦、中國信託、兆豐、台新、第一銀行、合作金庫、臺灣銀行
需要：pip install pdfplumber openpyxl rapidocr-onnxruntime
"""
import os, re, sys, glob, datetime, difflib, unicodedata

import pdfplumber
import pypdfium2 as pdfium
from openpyxl import Workbook, load_workbook
from openpyxl.styles import PatternFill, Font, Alignment

HERE = os.path.dirname(os.path.abspath(__file__))

# ============================== 設定（可自行修改） ==============================

# 日期欄要用哪個："帳單日"（結帳日）、"消費日" 或 "入帳日"
DATE_MODE = "帳單日"

# 既有分類紀錄（你的活頁簿）。放在同資料夾就會自動學習「摘要 → 類型」
HISTORY_FILES = ["分類參考.xlsx", "活頁簿1.xlsx"]

# 銀行 → 消費方式（卡片名稱）
BANK_CARD = {
    "台北富邦": "台北富邦信用卡",
    "中國信託": "中國信託信用卡",
    "兆豐": "兆豐信用卡",
    "台新": "台新信用卡",
    "第一銀行": "第一銀行信用卡",
    "合作金庫": "合庫信用卡",
    "臺灣銀行": "臺銀信用卡",
}
# 同一家銀行有多張卡時，用卡號末四碼指定名稱，例如 {"1234": "富邦J卡"}
CARD_BY_LAST4 = {}

# 對不到規則時，各卡的預設類型
CARD_DEFAULT_TYPE = {name: "日用其他" for name in BANK_CARD.values()}

# 「固定」工作表的類型（其餘都放「浮動」）
FIXED_TYPES = [
    "電費", "水費", "天然氣/瓦斯費", "電話費(市話)", "電話費(行動)", "房租",
    "網際網路費(撥接/ADSL)", "保險(個人/汽機車/房屋)", "貸款(個人/房屋)",
    "稅金(燃料/房屋/所得)", "汽機車保養費", "住屋管理費", "有線電視費",
    "孩童零用錢", "南山人壽保單", "紅包費用", "固定呆帳", "功德費", "零用預金",
    "持股信託", "保險(壽險/勞保/健保)",
]

# 分類規則：由上往下比對摘要（不分全形半形、大小寫），第一個符合的生效
RULES = [
    # 通用的起始規則；個人化的規則請自行加在這裡（或放在不進版控的分類參考.xlsx）
    (["台灣大哥大", "中華電信09", "遠傳", "台灣之星"], "電話費(行動)"),
    (["中華電信Y", "中華電信y"], "網際網路費(撥接/ADSL)"),
    (["台灣電力", "台電"], "電費"),
    (["自來水"], "水費"),
    (["瓦斯", "天然氣"], "天然氣/瓦斯費"),
    (["所得稅", "綜所稅", "牌照稅", "燃料"], "稅金(燃料/房屋/所得)"),
    (["中油", "台塑石油", "全國加油"], "加油"),
    (["停車"], "停車"),
    (["ETAG", "遠通電收"], "過路費"),
    (["7-ELEVEN", "統一超商", "全家", "萊爾富"], "外食"),
    (["MOMO", "PCHOME", "蝦皮", "SHOPEE", "露天", "COUPANG", "酷澎", "AMAZON", "ALIEXPRESS"], "日用其他"),
]

PAYMENT_WORDS = ["扣繳", "授扣繳款", "已繳款", "繳款", "扣款", "感謝您", "本行扣", "轉帳扣", "转帐", "自動轉帳"]
FEE_WORDS = ["國外交易服務費", "海外簽帳手續費", "國外交易手續費"]
REWARD_WORDS = ["回饋", "刷卡金", "折抵", "回馈"]

# ================================================================================

FILL_GUESS = PatternFill("solid", fgColor="FFF2CC")   # 黃：類型是猜的
FILL_OCR = PatternFill("solid", fgColor="DDEBF7")     # 藍：摘要來自 OCR
FILL_BAD = PatternFill("solid", fgColor="F8CBAD")     # 紅：核對不符


def norm(s):
    """比對用：全形轉半形、去空白、轉大寫"""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", s or "")).upper()


def to_num(s):
    s = unicodedata.normalize("NFKC", s).replace(",", "").replace("$", "").replace("元", "").replace(" ", "")
    s = s.lstrip("+")
    return float(s)


NUM_RE = re.compile(r"^[+-]?\$?[\d,]+(\.\d+)?元?$")
ROC_RE = re.compile(r"^(\d{3})[/?](\d{2})[/?](\d{2})$")
MD_RE = re.compile(r"^(\d{2})/(\d{2})$")


def is_num(s):
    return bool(NUM_RE.match(unicodedata.normalize("NFKC", s).replace(" ", "")))


def roc(s):
    m = ROC_RE.match(s.strip())
    if not m:
        return None
    try:
        return datetime.date(int(m.group(1)) + 1911, int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def md_date(s, closing):
    m = MD_RE.match(s.strip())
    if not m:
        return None
    mo, d = int(m.group(1)), int(m.group(2))
    y = closing.year if mo <= closing.month else closing.year - 1
    try:
        return datetime.date(y, mo, d)
    except ValueError:
        return None


# ------------------------------ 文字擷取 ------------------------------

def chars_plumber(page):
    out = []
    for c in page.chars:
        t = c["text"]
        col = c.get("non_stroking_color")
        if isinstance(col, (list, tuple)) and len(col) in (1, 3) and all(v == 1 for v in col):
            continue  # 白色（看不見）的文字，例如臺銀帳單的範本欄位名
        if t and t.strip():
            out.append((t, c["x0"], c["top"], c["x1"], c["bottom"]))
    return out


def chars_pdfium(pdf, i):
    pg = pdf[i]
    h = pg.get_height()
    tp = pg.get_textpage()
    out = []
    for k in range(tp.count_chars()):
        t = tp.get_text_range(k, 1)
        if not t or not t.strip():
            continue
        l, b, r, tt = tp.get_charbox(k)
        out.append((t, l, h - tt, r, h - b))
    return out


def build_lines(chars, ytol=2.5, gap=5.0):
    chars = sorted(chars, key=lambda c: (c[2], c[1]))
    rows = []
    for c in chars:
        mid = (c[2] + c[4]) / 2
        for r in rows:
            if abs(r["mid"] - mid) <= ytol:
                r["c"].append(c)
                break
        else:
            rows.append({"mid": mid, "c": [c]})
    lines = []
    for r in sorted(rows, key=lambda r: r["mid"]):
        cs = sorted(r["c"], key=lambda c: c[1])
        segs, cur = [], None
        for c in cs:
            w = c[3] - c[1]
            if cur and c[1] - cur["x1"] <= gap:
                if c[1] - cur["x1"] > max(1.2, w * 0.25):
                    cur["t"] += " "
                cur["t"] += c[0]
                cur["x1"] = c[3]
            else:
                cur = {"t": c[0], "x0": c[1], "x1": c[3]}
                segs.append(cur)
        lines.append({"y": r["mid"], "segs": segs, "text": " ".join(s["t"] for s in segs)})
    return lines


def segs_in(line, x0, x1):
    return [s for s in line["segs"] if x0 <= s["x0"] < x1]


# ------------------------------ OCR ------------------------------

_ocr = None


def ocr_page(pdf_path, page_index, dpi=300):
    """回傳 [(text, x_center_pt, y_center_pt)]"""
    global _ocr
    if _ocr is None:
        try:
            from rapidocr_onnxruntime import RapidOCR
        except ImportError:
            print("  ! 尚未安裝 OCR 套件：pip install rapidocr-onnxruntime")
            _ocr = False
            return []
        _ocr = RapidOCR()
    if _ocr is False:
        return []
    scale = dpi / 72
    img = pdfium.PdfDocument(pdf_path)[page_index].render(scale=scale).to_pil()
    import numpy as np
    res, _ = _ocr(np.array(img))
    out = []
    for box, text, score in res or []:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        out.append((text, min(xs) / scale, max(xs) / scale, sum(ys) / 4 / scale))
    return out


def ocr_offset(boxes, cand, ax0, ax1):
    """用金額當錨點，算出 OCR 座標與文字層的垂直偏移"""
    diffs = []
    for y, *_rest in cand:
        amt = _rest[2]
        want = f"{abs(int(round(amt))):,}"
        for t, x0, x1, by in boxes:
            if ax0 <= (x0 + x1) / 2 < ax1 and abs(by - y) < 10 and want in unicodedata.normalize("NFKC", t).replace(".", ","):
                diffs.append(by - y)
                break
    diffs.sort()
    return diffs[len(diffs) // 2] if diffs else 0.0


def ocr_desc(boxes, y, x0, x1, ytol=3.5):
    hit = [b for b in boxes if abs(b[3] - y) <= ytol and x0 <= (b[1] + b[2]) / 2 < x1]
    hit.sort(key=lambda b: b[1])
    return "".join(b[0] for b in hit).strip()


# OCR 常見錯字（左邊換成右邊）
OCR_FIX = [("P i", "Pi"), ("Pi一", "Pi－"), ("支付遭", "支付連"), ("中油一", "中油－"), ("回馈", "回饋"),
           ("一國内", "－國內"), ("國内", "國內"), ("转帐", "轉帳"), ("帐", "帳"), ("费", "費"), ("缴", "繳"),
           ("连", "連"), ("拍卖", "拍賣")]


def ocr_cleanup(t):
    for a, b in OCR_FIX:
        t = t.replace(a, b)
    return t


# ------------------------------ 各銀行解析 ------------------------------
# 每個 parser 回傳 dict：closing, prev, cur, rows=[{date, post, desc, amount, last4, ocr}]


def row(date, post, desc, amount, last4="", ocr=False):
    return {"date": date or post, "post": post, "desc": desc.strip(), "amount": amount,
            "last4": last4, "ocr": ocr}


def parse_fubon(path, plumb):
    r = {"rows": []}
    last4 = ""
    for page in plumb.pages:
        lines = build_lines(chars_plumber(page))
        for i, L in enumerate(lines):
            t = L["text"]
            if "帳單結帳日" in t and i + 1 < len(lines):
                for s in lines[i + 1]["segs"]:
                    if roc(s["t"]):
                        r["closing"] = roc(s["t"])
            if "繳(退)金額" in t and i + 1 < len(lines):
                nums = [to_num(s["t"]) for s in lines[i + 1]["segs"] if is_num(s["t"])]
                r["prev"], r["cur"] = nums[0], nums[4]
            m = re.search(r"末.碼\s*([0-9０-９]{4})", t)
            if m:
                last4 = unicodedata.normalize("NFKC", m.group(1))
            segs = L["segs"]
            if not segs or not roc(segs[0]["t"]) or segs[0]["x0"] > 60:
                continue
            amt = segs[-1]["t"]
            if not is_num(amt) or segs[-1]["x0"] < 480:
                continue
            desc = " ".join(s["t"] for s in segs_in(L, 70, 285))
            post = next((roc(s["t"]) for s in segs_in(L, 285, 340) if roc(s["t"])), None)
            r["rows"].append(row(roc(segs[0]["t"]), post, desc, to_num(amt), last4))
    return r


def parse_ctbc(path, plumb):
    r = {"rows": []}
    for pi, page in enumerate(plumb.pages):
        lines = build_lines(chars_plumber(page))
        cand = []
        for L in lines:
            segs = L["segs"]
            nums = [s for s in segs if is_num(s["t"])]
            if segs and roc(segs[0]["t"]) and len(nums) >= 5 and "prev" not in r:
                vals = [to_num(s["t"]) for s in nums]
                r["closing"], r["prev"], r["cur"] = roc(segs[0]["t"]), vals[0], vals[-1]
                continue
            d1 = next((roc(s["t"]) for s in segs_in(L, 0, 45) if roc(s["t"])), None)
            d2 = next((roc(s["t"]) for s in segs_in(L, 45, 110) if roc(s["t"])), None)
            amt = [s for s in segs_in(L, 230, 310) if is_num(s["t"])]
            if (d1 or d2) and amt:
                card = [s["t"] for s in segs_in(L, 310, 360) if re.fullmatch(r"\d{4}", s["t"])]
                cand.append((L["y"], d1, d2, to_num(amt[-1]["t"]), card[0] if card else ""))
        if cand:
            boxes = ocr_page(path, pi)
            off = ocr_offset(boxes, cand, 230, 310)
            for y, d1, d2, a, c in cand:
                desc = ocr_cleanup(ocr_desc(boxes, y + off, 100, 230))
                r["rows"].append(row(d1, d2, desc or "(需人工確認)", a, c, ocr=True))
    return r


def parse_mega(path, plumb):
    r = {"rows": []}
    last4 = ""
    for page in plumb.pages:
        lines = build_lines(chars_plumber(page))
        for i, L in enumerate(lines):
            t = L["text"]
            if "結帳日期" in t and i + 1 < len(lines) and "closing" not in r:
                for s in lines[i + 1]["segs"]:
                    if roc(s["t"]):
                        r["closing"] = roc(s["t"])
                        break
            if "上期待繳總額" in t and "已繳金額" in t and i + 1 < len(lines):
                nums = [to_num(s["t"]) for s in lines[i + 1]["segs"] if is_num(s["t"])]
                r["prev"], r["cur"] = nums[0], nums[4]
            m = re.search(r"\d{4}-\w{4}-\w{4}-(\d{4})", t)
            if m:
                last4 = m.group(1)
            m = re.match(r"^(\d{3}/\d{2}/\d{2})\s*(\d{3}/\d{2}/\d{2})?\s*(.*)$", L["segs"][0]["t"]) if L["segs"] else None
            if not m or L["segs"][0]["x0"] > 160:
                continue
            amt = L["segs"][-1]["t"]
            if not is_num(amt):
                continue
            d1, d2 = roc(m.group(1)), roc(m.group(2)) if m.group(2) else None
            desc = " ".join([m.group(3)] + [s["t"] for s in L["segs"][1:] if s["x0"] < 295]).strip()
            r["rows"].append(row(d1, d2 or d1, desc, to_num(amt), last4))
    return r


def parse_taishin(path, plumb):
    r = {"rows": []}
    last4 = ""
    for page in plumb.pages:
        lines = build_lines(chars_plumber(page))
        rowlines, orphans = [], []
        for L in lines:
            t = L["text"]
            if t.startswith("帳單結帳日"):
                r["closing"] = roc(L["segs"][-1]["t"])
            if t.startswith("上期應繳總額"):
                r["prev"] = to_num(L["segs"][-1]["t"])
            if t.startswith("=本期累計應繳金額"):
                r["cur"] = to_num(L["segs"][-1]["t"])
            m = re.search(r"卡號末四碼:(\d{4})", t)
            if m:
                last4 = m.group(1)
                continue
            segs = L["segs"]
            d1 = next((roc(s["t"]) for s in segs_in(L, 60, 110) if roc(s["t"])), None)
            d2 = next((roc(s["t"]) for s in segs_in(L, 110, 155) if roc(s["t"])), None)
            amt = [s for s in segs_in(L, 320, 368) if is_num(s["t"])]
            if d1 and amt:
                rowlines.append([L["y"], d1, d2, " ".join(s["t"] for s in segs_in(L, 155, 320)),
                                 to_num(amt[0]["t"]), last4])
            elif segs and 150 <= segs[0]["x0"] < 170 and len(segs) == 1:
                orphans.append((L["y"], segs[0]["t"]))
        for y, txt in orphans:  # 跨行的說明：併入最近的一筆
            near = min(rowlines, key=lambda rl: abs(rl[0] - y), default=None)
            if near and abs(near[0] - y) <= 7:
                near[3] = (txt + near[3]) if y < near[0] else (near[3] + txt)
        for y, d1, d2, desc, a, l4 in rowlines:
            r["rows"].append(row(d1, d2, desc, a, l4))
    return r


def parse_first(path, plumb):
    r = {"rows": []}
    pending = []
    for page in plumb.pages:
        for L in build_lines(chars_plumber(page)):
            segs = L["segs"]
            if segs and segs[0]["t"] == "新臺幣" and len(segs) >= 7 and "prev" not in r:
                nums = [to_num(s["t"]) for s in segs if is_num(s["t"])]
                r["prev"], r["cur"] = nums[0], nums[4]
                r["closing"] = roc(segs[-1]["t"])
                continue
            d1 = next((s["t"] for s in segs_in(L, 30, 65) if MD_RE.match(s["t"])), None)
            d2 = next((s["t"] for s in segs_in(L, 65, 100) if MD_RE.match(s["t"])), None)
            amt = [s for s in segs_in(L, 330, 378) if is_num(s["t"])]
            if (d1 or d2) and amt:
                card = [s["t"] for s in segs_in(L, 378, 405) if re.fullmatch(r"\d{4}", s["t"])]
                pending.append((d1, d2, " ".join(s["t"] for s in segs_in(L, 100, 330)),
                                to_num(amt[0]["t"]), card[0] if card else ""))
    for d1, d2, desc, a, c in pending:
        cl = r.get("closing") or datetime.date.today()
        r["rows"].append(row(md_date(d1, cl) if d1 else None, md_date(d2, cl) if d2 else None, desc, a, c))
    return r


def parse_tcb(path, plumb):
    r = {"rows": []}
    pdf = pdfium.PdfDocument(path)
    keep = lambda c: re.fullmatch(r"[0-9?/,.\-%]", c[0])
    # 結帳日：第 1 頁第一個日期
    for L in build_lines([c for c in chars_pdfium(pdf, 0) if keep(c)], ytol=4.5, gap=4):
        for s in L["segs"]:
            if roc(s["t"]):
                r["closing"] = roc(s["t"])
                break
        if "closing" in r:
            break
    for pi in range(1, len(pdf)):
        lines = build_lines([c for c in chars_pdfium(pdf, pi) if keep(c)], ytol=4.5, gap=4)
        cand, totals, started = [], [], False
        for L in lines:
            segs = L["segs"]
            if segs and segs[0]["t"].startswith("-----"):
                break
            d1 = next((roc(s["t"]) for s in segs_in(L, 25, 85) if roc(s["t"])), None)
            d2 = next((roc(s["t"]) for s in segs_in(L, 85, 140) if roc(s["t"])), None)
            amt = [s for s in segs_in(L, 290, 350) if is_num(s["t"])]
            if d1 and amt:
                card = [s["t"] for s in segs_in(L, 350, 400) if re.fullmatch(r"\d{4}", s["t"])]
                cand.append((L["y"], d1, d2, to_num(amt[0]["t"]), ("J" + card[0]) if card else ""))
                started = True
            elif amt and len(segs) == 1:
                totals.append(to_num(amt[0]["t"]))
        if cand:
            r["prev"], r["cur"] = totals[0], totals[-1]
            boxes = ocr_page(path, pi)
            off = ocr_offset(boxes, cand, 290, 350)
            for y, d1, d2, a, c in cand:
                desc = ocr_cleanup(ocr_desc(boxes, y + off, 140, 300))
                r["rows"].append(row(d1, d2, desc or "(需人工確認)", a, c, ocr=True))
    return r


def parse_bot(path, plumb):
    r = {"rows": []}
    pending = []
    for page in plumb.pages:
        lines = build_lines(chars_plumber(page))
        for i, L in enumerate(lines):
            t = L["text"]
            m = re.search(r"結\s*帳\s*日\s*(\d{3}/\d{2}/\d{2})", t)
            if m and "closing" not in r:
                r["closing"] = roc(m.group(1))
            if "前期應繳總金額" in t:
                for L2 in lines[i + 1:i + 5]:
                    nums = [to_num(s["t"]) for s in L2["segs"] if is_num(s["t"])]
                    if len(nums) >= 6:
                        r["prev"], r["cur"] = nums[0], nums[-1]
                        break
            segs = L["segs"]
            d1 = next((s["t"] for s in segs_in(L, 40, 80) if MD_RE.match(s["t"])), None)
            d2 = next((s["t"] for s in segs_in(L, 80, 125) if MD_RE.match(s["t"])), None)
            amt = [s for s in segs_in(L, 320, 398) if is_num(s["t"])]
            if (d1 or d2) and amt:
                card = [s["t"] for s in segs_in(L, 0, 40) if re.fullmatch(r"\d{4}", s["t"])]
                pending.append((d1, d2, " ".join(s["t"] for s in segs_in(L, 125, 320)),
                                to_num(amt[0]["t"]), card[0] if card else ""))
    cl = r.get("closing") or datetime.date.today()
    for d1, d2, desc, a, c in pending:
        r["rows"].append(row(md_date(d1, cl) if d1 else None, md_date(d2, cl) if d2 else None, desc, a, c))
    return r


BANKS = [  # (名稱, 各家獨有的關鍵字：網址或客服電話, parser)
    ("合作金庫", ["tcb-bank.com.tw", "2227-3131"], parse_tcb),
    ("中國信託", ["ctbc.tw", "2745-8080"], parse_ctbc),
    ("臺灣銀行", ["ecard.bot.com.tw", "2182-1901"], parse_bot),
    ("台新", ["taishinbank.com.tw", "2655-3355"], parse_taishin),
    ("第一銀行", ["firstbank.com.tw", "2173-2999"], parse_first),
    ("台北富邦", ["fubon.com", "8751-1313"], parse_fubon),
    ("兆豐", ["megabank.com.tw", "(02)89820000", "8982-0000"], parse_mega),
]


def detect(path, plumb):
    t = ""
    for p in plumb.pages:
        t += p.extract_text() or ""
    pdf = pdfium.PdfDocument(path)
    for i in range(len(pdf)):
        t += pdf[i].get_textpage().get_text_range()
    pdf.close()
    t = unicodedata.normalize("NFKC", t).lower()
    scores = [(sum(k in t for k in keys), name, parser) for name, keys, parser in BANKS]
    best = max(scores, key=lambda x: x[0])
    if best[0] == 0:
        return None, None
    if sum(1 for x in scores if x[0] == best[0]) > 1:
        print(f"  ! 同時符合多家銀行：{[x[1] for x in scores if x[0] == best[0]]}")
        return None, None
    return best[1], best[2]


# ------------------------------ 分類 ------------------------------

def load_history():
    hist, fixed_types, conflict = {}, set(FIXED_TYPES), set()
    for fn in HISTORY_FILES:
        p = os.path.join(HERE, fn)
        if not os.path.exists(p):
            continue
        wb = load_workbook(p, read_only=True, data_only=True)
        for sheet in ("固定", "浮動"):
            if sheet not in wb.sheetnames:
                continue
            for rw in wb[sheet].iter_rows(min_row=2, values_only=True):
                if len(rw) >= 3 and rw[1] and rw[2]:
                    k = norm(str(rw[2]))
                    if k in hist and hist[k][1] != str(rw[1]):
                        conflict.add(k)  # 同一摘要在舊紀錄裡有兩種分法
                    hist[k] = (str(rw[2]), str(rw[1]))
                    if sheet == "固定":
                        fixed_types.add(str(rw[1]))
        print(f"已讀取分類參考：{fn}（{len(hist)} 種摘要）")
        break
    for k in conflict:
        hist[k] = (hist[k][0], hist[k][1], True)
    return hist, fixed_types


def fix_ocr(desc, hist):
    """OCR 摘要：找既有紀錄裡最像的摘要取代"""
    if not hist:
        return desc, False
    keys = list(hist.keys())
    m = difflib.get_close_matches(norm(desc), keys, n=1, cutoff=0.85)
    if m:
        return hist[m[0]][0], True
    return desc, False


def is_payment(desc, amount):
    return amount < 0 and any(w in desc for w in PAYMENT_WORDS) and not any(w in desc for w in REWARD_WORDS)


def classify(desc, card, hist, prev_type):
    """優先順序：手續費跟前一筆 → 折抵跟原消費 → 關鍵字規則 → 舊紀錄 → 卡片預設（標黃）"""
    n = norm(desc)
    if any(w in desc for w in FEE_WORDS) and prev_type:
        return prev_type, False
    m = re.search(r"折抵_(.+)$", desc)
    if m:
        return classify(m.group(1), card, hist, None)
    for words, typ in RULES:
        if any(norm(w) in n for w in words):
            return typ, False
    if n in hist:
        h = hist[n]
        return h[1], len(h) > 2  # 舊紀錄有兩種分法時標黃
    default = CARD_DEFAULT_TYPE.get(card, "日用其他")
    if any(w in desc for w in REWARD_WORDS) or "%" in desc:
        return default, False
    return default, True


# ------------------------------ 主程式 ------------------------------

def main():
    src = os.path.join(HERE, "decrypted")
    if not os.path.isdir(src):
        src = HERE
    files = sorted(glob.glob(os.path.join(src, "*.pdf")))
    if not files:
        print("找不到 PDF。請把解密後的帳單放進 decrypted 資料夾。")
        return
    hist, fixed_types = load_history()
    out_rows, checks = [], []

    for f in files:
        name = os.path.basename(f)
        try:
            plumb = pdfplumber.open(f)
            bank, parser = detect(f, plumb)
            if not bank:
                print(f"  ? {name}：認不出銀行，略過")
                checks.append([name, "無法判斷", None, None, None, None, None, "略過", 0])
                continue
            print(f"  - {name}：{bank}")
            r = parser(f, plumb)
        except Exception as e:
            print(f"  ! {name}：解析失敗 {e}")
            checks.append([name, "", None, None, None, None, None, f"錯誤：{e}", 0])
            continue

        total = round(sum(x["amount"] for x in r["rows"]), 2)
        expect = round(r.get("cur", 0) - r.get("prev", 0), 2) if "cur" in r else None
        ok = expect is not None and abs(total - expect) < 0.01
        n_out = 0
        prev_type = None
        for x in r["rows"]:
            if is_payment(x["desc"], x["amount"]):
                continue
            card = CARD_BY_LAST4.get(x["last4"]) or BANK_CARD.get(bank, bank)
            desc, ocr_flag = x["desc"], x["ocr"]
            if ocr_flag:
                desc, matched = fix_ocr(desc, hist)
            typ, guess = classify(desc, card, hist, prev_type)
            prev_type = typ
            m = re.search(r"分期\s*(\d+/\d+)", desc)
            out_rows.append({
                "sheet": "固定" if typ in fixed_types else "浮動",
                "date": {"帳單日": r.get("closing"), "入帳日": x["post"] or x["date"]}.get(DATE_MODE, x["date"]),
                "type": typ, "desc": desc, "card": card,
                "inst": m.group(1) if m else None, "amount": int(round(x["amount"])),
                "guess": guess, "ocr": ocr_flag,
            })
            n_out += 1
        checks.append([name, bank, r.get("closing"), r.get("prev"), r.get("cur"), total, expect,
                       "OK" if ok else "不符，請檢查", n_out])

    # ---- 輸出 ----
    os.makedirs(os.path.join(HERE, "output"), exist_ok=True)
    out = os.path.join(HERE, "output", f"信用卡明細_{datetime.datetime.now():%Y%m%d_%H%M}.xlsx")
    wb = Workbook()
    wb.remove(wb.active)
    head = ["日期", "消費類型", "摘要", "消費方式", "分期數", "金額"]
    widths = [11, 23.5, 45, 18.4, 7.5, 8]
    for sheet in ("固定", "浮動"):
        ws = wb.create_sheet(sheet)
        ws.append(head)
        for c in ws[1]:
            c.font = Font(bold=True)
        rows = sorted([x for x in out_rows if x["sheet"] == sheet], key=lambda x: (x["card"], x["date"] or datetime.date.min))
        for x in rows:
            ws.append([x["date"], x["type"], x["desc"], x["card"], x["inst"], x["amount"]])
            rr = ws.max_row
            ws.cell(rr, 1).number_format = "yyyy/m/d"
            if x["guess"]:
                ws.cell(rr, 2).fill = FILL_GUESS
            if x["ocr"]:
                ws.cell(rr, 3).fill = FILL_OCR
        for i, w in enumerate(widths):
            ws.column_dimensions["ABCDEF"[i]].width = w
        ws.freeze_panes = "A2"

    ws = wb.create_sheet("核對結果")
    ws.append(["檔案", "銀行", "結帳日", "上期應繳", "本期應繳", "明細合計(含繳款)", "應為(本期-上期)", "結果", "輸出筆數"])
    for c in ws[1]:
        c.font = Font(bold=True)
    for ck in checks:
        ws.append(ck)
        ws.cell(ws.max_row, 3).number_format = "yyyy/m/d"
        if ck[7] != "OK":
            for c in ws[ws.max_row]:
                c.fill = FILL_BAD
    ws.append([])
    ws.append(["說明：黃底＝類型是程式猜的；藍底＝摘要來自 OCR，可能有錯字；紅底＝金額核對不符。"])
    for col, w in zip("ABCDEFGHI", [42, 10, 11, 10, 10, 16, 16, 14, 9]):
        ws.column_dimensions[col].width = w

    wb.save(out)
    bad = [c for c in checks if c[7] != "OK"]
    print(f"\n完成：{len(files)} 份帳單，輸出 {len(out_rows)} 筆 → {out}")
    print("核對全部通過" if not bad else f"有 {len(bad)} 份需要檢查，請看「核對結果」工作表")


if __name__ == "__main__":
    main()
