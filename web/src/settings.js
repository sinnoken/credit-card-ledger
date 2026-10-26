/* settings.js — CC.settings (owner: agent C)
 * Defaults ported from convert_reference.py (+ 分類參考.xlsx 工作表1), persistence, JSON import/export,
 * learning 摘要→類型 from the user's workbook (ExcelJS, referenced lazily via globalThis.ExcelJS).
 */
(function (g) {
  "use strict";
  const CC = (g.CC = g.CC || {});
  const S = (CC.settings = {});
  const norm = (s) => CC.util.norm(s);

  const KEY = "cc-settings-v1";
  const DATE_MODES = ["帳單日", "消費日", "入帳日"];

  const FIXED_TYPES = [
    "電費", "水費", "天然氣/瓦斯費", "電話費(市話)", "電話費(行動)", "房租",
    "網際網路費(撥接/ADSL)", "保險(個人/汽機車/房屋)", "貸款(個人/房屋)",
    "稅金(燃料/房屋/所得)", "汽機車保養費", "住屋管理費", "有線電視費",
    "孩童零用錢", "南山人壽保單", "紅包費用", "固定呆帳", "功德費", "零用預金",
    "持股信託", "保險(壽險/勞保/健保)",
  ];
  // 分類參考.xlsx 工作表1 column B
  const FLOATING_TYPES = [
    "外食", "食材", "水果", "點心", "伙食其他", "電器用品", "3C用品", "書籍", "日用其他", "加油",
    "停車", "過路費", "交通其他", "教養費", "治裝費", "美容費", "醫療費", "娛樂費", "喜慶交際費",
    "贈與費", "攝影相關器材", "股票基金", "銀行手續費", "浮動呆帳",
  ];

  S.DATE_MODES = DATE_MODES;
  // 收入類型 for payslip earnings (sheet 收入); the workbook's 收入 (or Incomes) sheet adds the user's own
  const INCOME_TYPES = ["薪資", "薪資加給", "節日績效獎金", "各類補助", "勞務兼差收入", "非勞務收入"];

  S.FIXED_TYPES = FIXED_TYPES;
  S.INCOME_TYPES = INCOME_TYPES;
  S.DEFAULTS = Object.freeze({
    version: 1,
    dateMode: "帳單日",
    cards: {
      fubon: { name: "台北富邦信用卡", defaultType: "日用其他" },
      ctbc: { name: "中國信託信用卡", defaultType: "日用其他" },
      mega: { name: "兆豐信用卡", defaultType: "日用其他" },
      tsb: { name: "台新信用卡", defaultType: "日用其他" },
      first: { name: "第一銀行信用卡", defaultType: "日用其他" },
      tcb: { name: "合庫信用卡", defaultType: "日用其他" },
      bot: { name: "臺銀信用卡", defaultType: "日用其他" },
    },
    cardByLast4: {},
    // Generic starter rules only (utilities, telecom, tax, fuel, parking, tolls, convenience stores,
    // large e-commerce platforms). Personal rules belong in the user's own settings JSON (匯入設定 JSON).
    rules: [
      { words: ["台灣大哥大", "中華電信09", "遠傳", "台灣之星"], type: "電話費(行動)" },
      { words: ["中華電信Y", "中華電信y"], type: "網際網路費(撥接/ADSL)" },
      { words: ["台灣電力", "台電"], type: "電費" },
      { words: ["自來水"], type: "水費" },
      { words: ["瓦斯", "天然氣"], type: "天然氣/瓦斯費" },
      { words: ["所得稅", "綜所稅", "牌照稅", "燃料"], type: "稅金(燃料/房屋/所得)" },
      { words: ["中油", "台塑石油", "全國加油"], type: "加油" },
      { words: ["停車"], type: "停車" },
      { words: ["ETAG", "遠通電收"], type: "過路費" },
      { words: ["7-ELEVEN", "統一超商", "全家", "萊爾富"], type: "外食" },
      { words: ["MOMO", "PCHOME", "蝦皮", "SHOPEE", "露天", "COUPANG", "酷澎", "AMAZON", "ALIEXPRESS"], type: "日用其他" },
    ],
    learned: {},
    fixedTypes: FIXED_TYPES,
    floatingTypes: FLOATING_TYPES,
    incomeTypes: INCOME_TYPES,
    // 轉入銀行 learned from the workbook's 轉帳 sheet: a payslip deduction of one of these types is a transfer, not an expense
    bankTargets: [],
    // account = 收入形式 / 消費方式 of payslip rows; companies: [{name, keys:[...], account?}] matched in the e-mail
    payslip: { account: "", companies: [] },
    ocrFix: [
      ["P i", "Pi"], ["Pi一", "Pi－"], ["支付遭", "支付連"], ["中油一", "中油－"], ["回馈", "回饋"],
      ["一國内", "－國內"], ["國内", "國內"], ["转帐", "轉帳"], ["帐", "帳"], ["费", "費"], ["缴", "繳"],
      ["连", "連"], ["拍卖", "拍賣"], ["連二", "連＿"], ["连二", "連＿"],
    ],
  });

  const clone = (o) => JSON.parse(JSON.stringify(o));
  S.defaults = () => clone(S.DEFAULTS);

  const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
  const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  /** Define an own data property: keys like "__proto__" / "constructor" stay ordinary keys (no prototype setter). */
  const put = (o, k, v) => { Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); return o; };
  /** Fresh plain object from src's own enumerable string-valued entries (others dropped). */
  const copyStrMap = (src) => { const o = {}; for (const [k, v] of Object.entries(src)) if (typeof v === "string") put(o, k, v); return o; };
  /** Card → fresh {name?, defaultType?} from own string fields only (anything else, incl. an own "__proto__", is dropped). */
  const cardEntry = (base, c) => {
    const o = {};
    for (const f of ["name", "defaultType"]) {
      if (hasOwn(c, f) && typeof c[f] === "string") o[f] = c[f];
      else if (base && hasOwn(base, f) && typeof base[f] === "string") o[f] = base[f];
    }
    return o;
  };
  const ruleList = (a) => a.filter((r) => isObj(r) && hasOwn(r, "words") && isStrArr(r.words) && hasOwn(r, "type") && typeof r.type === "string")
    .map((r) => ({ words: r.words.slice(), type: r.type }));
  const pairList = (a) => a.filter((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && typeof p[1] === "string")
    .map((p) => [p[0], p[1]]);
  const SRCS = ["manual", "workbook"];
  const FIELDS = ["dateMode", "cards", "cardByLast4", "rules", "fixedTypes", "floatingTypes", "incomeTypes", "bankTargets", "payslip", "ocrFix"];
  /** payslip settings → fresh {account, companies} from own string fields only. */
  const payslipEntry = (p) => {
    const o = { account: "", companies: [] };
    if (!isObj(p)) return o;
    if (hasOwn(p, "account") && typeof p.account === "string") o.account = p.account;
    if (hasOwn(p, "companies") && Array.isArray(p.companies))
      for (const c of p.companies) {
        if (!isObj(c) || !hasOwn(c, "name") || typeof c.name !== "string" || !hasOwn(c, "keys") || !isStrArr(c.keys)) continue;
        const e = { name: c.name, keys: c.keys.slice() };
        if (hasOwn(c, "account") && typeof c.account === "string") e.account = c.account;
        o.companies.push(e);
      }
    return o;
  };
  /** learned entry → canonical shape {desc, type, conflict?, src}; missing src = 'workbook' (pre-src backups). */
  const learnedEntry = (v) => {
    if (!isObj(v) || !hasOwn(v, "desc") || !hasOwn(v, "type") || typeof v.desc !== "string" || typeof v.type !== "string") return null;
    const e = { desc: v.desc, type: v.type };
    if (v.conflict) e.conflict = true;
    e.src = v.src === "manual" ? "manual" : "workbook";
    return e;
  };
  const copyLearned = (src) => {
    const o = {};
    for (const [k, v] of Object.entries(src)) { const e = learnedEntry(v); if (e) put(o, k, e); }
    return o;
  };

  /** Merge a (partial, already validated or trusted) object onto fresh defaults. */
  S.merge = (o) => {
    const s = S.defaults();
    if (!isObj(o)) return s;
    if (DATE_MODES.includes(o.dateMode)) s.dateMode = o.dateMode;
    if (isObj(o.cards))
      for (const [id, c] of Object.entries(o.cards))
        if (isObj(c)) put(s.cards, id, cardEntry(hasOwn(s.cards, id) ? s.cards[id] : null, c));
    if (isObj(o.cardByLast4)) s.cardByLast4 = copyStrMap(o.cardByLast4);
    if (Array.isArray(o.rules)) s.rules = ruleList(o.rules);
    if (isObj(o.learned)) s.learned = copyLearned(o.learned);
    if (isStrArr(o.fixedTypes)) s.fixedTypes = Array.from(new Set([...o.fixedTypes]));
    if (isStrArr(o.floatingTypes)) s.floatingTypes = o.floatingTypes.slice();
    if (isStrArr(o.incomeTypes)) s.incomeTypes = Array.from(new Set([...o.incomeTypes]));
    if (isStrArr(o.bankTargets)) s.bankTargets = Array.from(new Set([...o.bankTargets]));
    if (isObj(o.payslip)) s.payslip = payslipEntry(o.payslip);
    if (Array.isArray(o.ocrFix)) s.ocrFix = pairList(o.ocrFix);
    return s;
  };

  S.load = () => {
    let raw = null;
    try { raw = g.localStorage ? g.localStorage.getItem(KEY) : null; } catch (e) { raw = null; }
    if (!raw) return S.defaults();
    try { return S.merge(validate(JSON.parse(raw))); } catch (e) { return S.defaults(); }
  };

  /** Returns true when stored, false when storage is unavailable. Never throws. */
  S.save = (s) => {
    try {
      if (!g.localStorage) return false;
      g.localStorage.setItem(KEY, JSON.stringify(s));
      return true;
    } catch (e) { return false; }
  };

  S.exportJSON = (s) => JSON.stringify(s, null, 2);

  function fail(msg) { throw new Error("設定檔格式錯誤：" + msg); }

  function validate(o) {
    if (!isObj(o)) fail("內容必須是物件");
    if (o.version != null && o.version !== 1) fail("不支援的版本 " + o.version);
    if (o.dateMode != null && !DATE_MODES.includes(o.dateMode)) fail("日期欄位設定無效（" + o.dateMode + "）");
    if (o.cards != null) {
      if (!isObj(o.cards)) fail("cards 必須是物件");
      for (const [id, c] of Object.entries(o.cards)) {
        if (!isObj(c)) fail("卡片 " + id + " 格式錯誤");
        if (c.name != null && typeof c.name !== "string") fail("卡片 " + id + " 名稱必須是文字");
        if (c.defaultType != null && typeof c.defaultType !== "string") fail("卡片 " + id + " 預設類型必須是文字");
      }
    }
    if (o.cardByLast4 != null) {
      if (!isObj(o.cardByLast4)) fail("cardByLast4 必須是物件");
      for (const [k, v] of Object.entries(o.cardByLast4))
        if (typeof v !== "string") fail("末四碼 " + k + " 的卡名必須是文字");
    }
    if (o.rules != null) {
      if (!Array.isArray(o.rules)) fail("rules 必須是陣列");
      o.rules.forEach((r, i) => {
        if (!isObj(r) || !isStrArr(r.words) || typeof r.type !== "string") fail("第 " + (i + 1) + " 條規則格式錯誤");
      });
    }
    if (o.learned != null) {
      if (!isObj(o.learned)) fail("learned 必須是物件");
      for (const [k, v] of Object.entries(o.learned))
        if (!isObj(v) || typeof v.desc !== "string" || typeof v.type !== "string" || (v.src != null && !SRCS.includes(v.src)))
          fail("學習紀錄「" + k + "」格式錯誤");
    }
    if (o.fixedTypes != null && !isStrArr(o.fixedTypes)) fail("fixedTypes 必須是文字陣列");
    if (o.floatingTypes != null && !isStrArr(o.floatingTypes)) fail("floatingTypes 必須是文字陣列");
    if (o.incomeTypes != null && !isStrArr(o.incomeTypes)) fail("incomeTypes 必須是文字陣列");
    if (o.bankTargets != null && !isStrArr(o.bankTargets)) fail("bankTargets 必須是文字陣列");
    if (o.payslip != null) {
      if (!isObj(o.payslip)) fail("payslip 必須是物件");
      if (o.payslip.account != null && typeof o.payslip.account !== "string") fail("薪資入帳帳戶必須是文字");
      if (o.payslip.companies != null) {
        if (!Array.isArray(o.payslip.companies)) fail("payslip.companies 必須是陣列");
        o.payslip.companies.forEach((c, i) => {
          if (!isObj(c) || typeof c.name !== "string" || !isStrArr(c.keys) || (c.account != null && typeof c.account !== "string"))
            fail("第 " + (i + 1) + " 家公司格式錯誤");
        });
      }
    }
    if (o.ocrFix != null) {
      if (!Array.isArray(o.ocrFix)) fail("ocrFix 必須是陣列");
      o.ocrFix.forEach((p, i) => {
        if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string" || typeof p[1] !== "string")
          fail("OCR 校正第 " + (i + 1) + " 筆格式錯誤");
      });
    }
    return o;
  }

  /**
   * Merge learned maps. Keys only in `cur` are kept. For a key in both: an incoming manual entry wins;
   * an incoming workbook entry never replaces an existing manual one; otherwise incoming wins.
   */
  S.mergeLearned = (cur, inc) => {
    const out = copyLearned(isObj(cur) ? cur : {});
    for (const [k, v] of Object.entries(inc || {})) {
      const e = learnedEntry(v);
      if (!e) continue;
      if (e.src === "workbook" && hasOwn(out, k) && out[k].src === "manual") continue;
      put(out, k, e);
    }
    return out;
  };

  /**
   * importJSON(str[, current]) → validated settings. Without `current`: the import replaces everything (absent
   * fields = defaults). With `current` (the settings in use): fields present in the import replace current's, fields
   * absent from it (a partial backup) are kept from current; `learned` is MERGED into current.learned (see
   * mergeLearned) so an older backup cannot drop newer rules. 固定 types that kept learned entries rely
   * on (present in current.fixedTypes) are kept so those rows stay on the 固定 sheet.
   */
  S.importJSON = (str, current) => {
    let o;
    try { o = JSON.parse(String(str)); } catch (e) { throw new Error("無法讀取設定檔：不是有效的 JSON"); }
    validate(o);
    if (isObj(current)) {
      const combined = {};
      for (const f of FIELDS) {
        const v = hasOwn(o, f) && o[f] != null ? o[f] : hasOwn(current, f) ? current[f] : undefined;
        if (v !== undefined) put(combined, f, v);
      }
      // cards merge per bank and per field onto current's entries: only fields present in the import replace.
      if (hasOwn(o, "cards") && o.cards != null && isObj(current.cards)) {
        const cards = {};
        for (const [id, c] of Object.entries(current.cards)) if (isObj(c)) put(cards, id, cardEntry(null, c));
        for (const [id, c] of Object.entries(o.cards)) put(cards, id, cardEntry(hasOwn(cards, id) ? cards[id] : null, c));
        put(combined, "cards", cards);
      }
      if (hasOwn(o, "learned") && o.learned != null) put(combined, "learned", o.learned);
      o = combined;
    }
    const s = S.merge(o);
    if (isObj(current) && isObj(current.learned)) {
      s.learned = S.mergeLearned(current.learned, s.learned);
      const curFixed = isStrArr(current.fixedTypes) ? current.fixedTypes : [];
      const ft = new Set(s.fixedTypes);
      for (const v of Object.values(s.learned)) if (curFixed.includes(v.type)) ft.add(v.type);
      s.fixedTypes = Array.from(ft);
      // likewise keep 收入類型 / 轉入銀行 that kept learned entries still use, so those rows stay on 收入 / 轉帳
      for (const f of ["incomeTypes", "bankTargets"]) {
        const cur = isStrArr(current[f]) ? current[f] : [], keep = new Set(s[f]);
        for (const v of Object.values(s.learned)) if (cur.includes(v.type)) keep.add(v.type);
        s[f] = Array.from(keep);
      }
    }
    return s;
  };

  /* ---------------------------- workbook learning ---------------------------- */

  /** ExcelJS cell value -> Python-like value (null / string / number / boolean). */
  function cellVal(v) {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString().slice(0, 19).replace("T", " ");
    if (typeof v === "object") {
      if (Array.isArray(v.richText)) return v.richText.map((r) => r.text || "").join("");
      if ("result" in v) return cellVal(v.result);
      if ("text" in v) return cellVal(v.text);
      if ("error" in v) return String(v.error);
      return null;
    }
    return v;
  }
  const truthy = (v) => !(v == null || v === "" || v === 0 || v === false);
  const pyStr = (v) => (v === true ? "True" : v === false ? "False" : String(v));
  /** Undo export.textCell's anti-formula prefix when it survived a paste: "'-退款" → "-退款" (one ' only).
   *  textCell prefixes ' only before = + - @ (optionally after whitespace) or before whitespace (a leading
   *  tab/CR flattened to a space), so exactly those shapes are undone; "Domino's" / "'quoted'" are untouched. */
  const unTSV = (s) => (/^'(?=[\s=+\-@])/.test(s) ? s.slice(1) : s);
  S.unTSV = unTSV;

  /** The program's sheet names and the names the same sheets carry in the user's ledger workbook. */
  S.LEDGER_SHEETS = Object.freeze({ 固定: "Spend2", 浮動: "Spend1", 收入: "Incomes", 轉帳: "Bank" });
  /** 「固定（Spend2）」: how a sheet is named to the user. */
  S.sheetLabel = (sheet) => (hasOwn(S.LEDGER_SHEETS, sheet) ? `${sheet}（${S.LEDGER_SHEETS[sheet]}）` : sheet);

  /**
   * Learn 摘要 → 類型 from the user's workbook, each sheet under its own or its ledger name (LEDGER_SHEETS):
   * 固定 / 浮動 / 收入 (payslip earnings): col B 類型, col C 摘要; 轉帳: col C 摘要, col E 轉入銀行 (a payslip deduction
   * moved to another account). Like load_history().
   * Resolves {learned, count, conflicts, fixedTypes, incomeTypes, bankTargets}. Later rows win, sheets read in the
   * order above (轉帳 last); a key seen with two types gets conflict:true (yellow until 套用到同摘要).
   */
  S.importWorkbook = async (arrayBuffer) => {
    const X = g.ExcelJS;
    if (!X) throw new Error("Excel 元件尚未載入");
    const wb = new X.Workbook();
    try { await wb.xlsx.load(arrayBuffer); } catch (e) { throw new Error("無法讀取 Excel 檔：" + (e && e.message || e)); }
    const hist = {}, conflict = new Set(), fixed = new Set(FIXED_TYPES), income = new Set(), bank = new Set();
    let found = false;
    for (const [role, alias] of Object.entries(S.LEDGER_SHEETS)) for (const name of [role, alias]) {
      const ws = wb.getWorksheet(name);
      if (!ws) continue;
      found = true;
      const transfer = role === "轉帳", typeCol = transfer ? 5 : 2;
      for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const t = cellVal(row.getCell(typeCol).value), d = cellVal(row.getCell(3).value);
        if (!truthy(t) || !truthy(d)) continue;
        const type = unTSV(pyStr(t)), desc = unTSV(pyStr(d)), k = norm(desc);
        if (hasOwn(hist, k) && hist[k].type !== type) conflict.add(k);
        put(hist, k, { desc, type });
        if (role === "固定") fixed.add(type);
        else if (role === "收入") income.add(type);
        else if (transfer) bank.add(type);
      }
    }
    if (!found) throw new Error("活頁簿裡找不到" + Object.keys(S.LEDGER_SHEETS).map((n) => `「${S.sheetLabel(n)}」`).join("") + "任何一張工作表");
    for (const k of conflict) hist[k].conflict = true;
    return { learned: hist, count: Object.keys(hist).length, conflicts: conflict.size, fixedTypes: Array.from(fixed),
      incomeTypes: Array.from(income), bankTargets: Array.from(bank) };
  };

  /** Apply an importWorkbook() result to settings: workbook entries (src:'workbook') override existing
   *  workbook entries but never a manual 「套用到同摘要」 correction (src:'manual'). */
  S.applyWorkbook = (s, res) => {
    const out = copyLearned(isObj(s.learned) ? s.learned : {});
    for (const [k, v] of Object.entries((res && res.learned) || {})) {
      if (hasOwn(out, k) && out[k].src === "manual") continue;
      const e = isObj(v) ? learnedEntry({ desc: v.desc, type: v.type, conflict: v.conflict, src: "workbook" }) : null;
      if (e) put(out, k, e);
    }
    s.learned = out;
    const ft = new Set(s.fixedTypes || []);
    for (const t of res.fixedTypes || []) ft.add(t);
    s.fixedTypes = Array.from(ft);
    const it = new Set(s.incomeTypes || []);
    for (const t of res.incomeTypes || []) it.add(t);
    s.incomeTypes = Array.from(it);
    const bt = new Set(s.bankTargets || []);
    for (const t of res.bankTargets || []) bt.add(t);
    s.bankTargets = Array.from(bt);
    return s;
  };

  /** 「套用到同摘要」: remember desc → type as a manual entry (clears any conflict). */
  S.learn = (s, desc, type) => {
    s.learned = s.learned || {};
    put(s.learned, norm(desc), { desc: String(desc), type: String(type), src: "manual" });
    return s;
  };
})(globalThis);
