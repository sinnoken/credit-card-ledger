/* export.js — CC.exporter (owner: agent C)
 * TSV for clipboard, xlsx (固定 / 浮動 / 核對結果) like convert_reference.py plus 繳費, 收入 and 轉帳 (payslips), save via downloads capability.
 * ExcelJS is referenced lazily as globalThis.ExcelJS.
 */
(function (g) {
  "use strict";
  const CC = (g.CC = g.CC || {});
  const E = (CC.exporter = {});

  E.HEAD = ["日期", "消費類型", "摘要", "消費方式", "分期數", "金額"];
  E.WIDTHS = [11, 23.5, 45, 18.4, 7.5, 8];
  // 繳款截止日 is appended last so formulas pointing at the older columns keep working
  E.CHECK_HEAD = ["檔案", "銀行", "結帳日", "上期應繳", "本期應繳", "明細合計(含繳款)", "應為(本期-上期)", "結果", "輸出筆數", "繳款截止日"];
  E.CHECK_WIDTHS = [42, 10, 11, 10, 10, 16, 16, 14, 9, 11];
  E.NO_PAY = "無需繳款";
  /** 繳款截止日 to show: NO_PAY when nothing is owed (banks print that instead of a date), else the ISO date or null. */
  E.dueOf = (cur, due) => (cur != null && cur <= 0 ? E.NO_PAY : due || null);
  // 繳費: one row per statement that has something to pay, laid out like the user's own ledger sheet
  E.PAY_HEAD = ["信用卡名稱", "日期", "摘要", "繳款方式", "還款金額"];
  E.PAY_WIDTHS = [20, 11, 8, 20, 10];
  E.PAY_BANK = { fubon: "台北富邦銀行", ctbc: "中國信託商業銀行", mega: "兆豐銀行", tsb: "台新銀行", first: "第一銀行", tcb: "合庫銀行", bot: "臺灣銀行" };
  // payslip earnings, laid out like the user's 收入 sheet; deductions go to 固定/浮動 as expenses
  E.INCOME_SHEET = "收入";
  E.INCOME_HEAD = ["日期", "收入類型", "摘要", "收入形式", "金額"];
  E.INCOME_WIDTHS = [11, 16, 30, 14, 10];
  // payslip deductions that move money to another account (轉入銀行 = the row's type), like the user's 轉帳 sheet
  E.BANK_SHEET = "轉帳";
  E.BANK_HEAD = ["帳戶名稱", "日期", "摘要", "存/提/轉", "轉入銀行", "金額", "手續費"];
  E.BANK_WIDTHS = [12, 11, 30, 9, 18, 10, 8];
  E.TRANSFER = "轉帳";
  E.NOTE ="說明：黃底＝類型是程式猜的；藍底＝摘要來自 OCR，可能有錯字；紅底＝金額核對不符。";
  E.FILL_GUESS = "FFF2CC";
  E.FILL_OCR = "DDEBF7";
  E.FILL_BAD = "F8CBAD";
  E.MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  const BANK_NAMES = { fubon: "台北富邦", ctbc: "中國信託", mega: "兆豐", tsb: "台新", first: "第一銀行", tcb: "合作金庫", bot: "臺灣銀行" };
  const bankName = (id) => {
    const b = CC.banks && Array.isArray(CC.banks.list) && CC.banks.list.find((x) => x.id === id);
    return (b && b.name) || BANK_NAMES[id] || id || "";
  };

  /** checks carry the bank's id or display name; resolve either to the bank entry (or null). */
  const bankOf = (idOrName) => {
    const list = (CC.banks && Array.isArray(CC.banks.list)) ? CC.banks.list : [];
    const id = Object.keys(BANK_NAMES).find((k) => k === idOrName || BANK_NAMES[k] === idOrName);
    return list.find((x) => x.id === idOrName || x.name === idOrName) || (id ? { id, card: "" } : null);
  };

  /** 'YYYY-MM-DD' → 'yyyy/m/d' */
  E.slashDate = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
    return m ? `${+m[1]}/${+m[2]}/${+m[3]}` : "";
  };
  /** 'YYYY-MM-DD' → Date at UTC midnight (ExcelJS writes UTC → no TZ shift). */
  E.toDate = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  };

  /** Sort like convert.py: (card, date or date.min), stable. */
  E.sortRows = (rows) =>
    rows.slice().sort((a, b) => {
      const ca = a.card || "", cb = b.card || "";
      if (ca !== cb) return ca < cb ? -1 : 1;
      const da = a.date || "", db = b.date || "";
      return da === db ? 0 : da < db ? -1 : 1;
    });

  const cleanCell = (v) => (v == null ? "" : String(v).replace(/[\t\r\n]+/g, " "));

  /** Text cell for pasting: tabs/newlines flattened; a value Excel would read as a formula (leading = + - @,
   *  possibly after whitespace, or a leading tab/CR before flattening) gets an apostrophe prefix (OWASP
   *  CSV-injection guidance). Excel's text paste keeps that ' visible, so only risky cells are touched. */
  E.textCell = (v) => {
    const raw = v == null ? "" : String(v);
    const c = cleanCell(raw);
    return /^[\t\r]/.test(raw) || /^\s*[=+\-@]/.test(c) ? "'" + c : c;
  };

  /** 分期數 like "3/12": pasted plain it becomes a date (3月12日) and a leading ' would stay visible, so no
   *  pure-TSV form guarantees text. We emit the text-producing formula ="3/12", which pastes as the visible
   *  text 3/12. Only digits/slash are wrapped (no quotes to escape); anything else goes through textCell. */
  E.instCell = (v) => {
    const c = cleanCell(v).trim();
    return /^\d{1,3}\/\d{1,3}$/.test(c) ? '="' + c + '"' : E.textCell(v);
  };

  /** Amount stays numeric (incl. negatives like -3); a non-numeric value is treated as text. */
  const amountCell = (v) => (typeof v === "number" && Number.isFinite(v) ? String(v) : E.textCell(v));

  /** Header + rows (sorted like the xlsx sheets), tab-separated, CRLF-free; safe to paste into Excel. */
  E.toTSV = (rows) => {
    const lines = [E.HEAD.join("\t")];
    for (const x of E.sortRows(rows || []))
      lines.push([E.slashDate(x.date), E.textCell(x.type), E.textCell(x.desc), E.textCell(x.card), E.instCell(x.inst),
        amountCell(x.amount)].join("\t"));
    return lines.join("\n");
  };

  /** checks → 繳費 rows {card, due, method, amount}: only statements with 本期應繳 > 0, by 繳款截止日 then card
   *  (a missing date sorts last). card is the check's card name, else the bank's default card name. */
  E.payRows = (checks) =>
    (checks || []).filter((ck) => ck.kind !== "payslip" && typeof ck.cur === "number" && ck.cur > 0).map((ck) => {
      const b = bankOf(ck.bank);
      return { card: ck.card || (b && b.card) || bankName(ck.bank), due: ck.due || null,
        method: (b && E.PAY_BANK[b.id]) || bankName(ck.bank), amount: ck.cur };
    }).sort((a, b) => (a.due || "9") < (b.due || "9") ? -1 : (a.due || "9") > (b.due || "9") ? 1 : a.card < b.card ? -1 : a.card > b.card ? 1 : 0);

  /** 繳費 as TSV with the same columns as the sheet (摘要 left empty). */
  E.payTSV = (checks) => {
    const lines = [E.PAY_HEAD.join("\t")];
    for (const p of E.payRows(checks))
      lines.push([E.textCell(p.card), E.slashDate(p.due), "", E.textCell(p.method), amountCell(p.amount)].join("\t"));
    return lines.join("\n");
  };

  /** 收入 (payslip earnings) as TSV, same columns and order as the sheet. */
  E.incomeTSV = (rows) => {
    const lines = [E.INCOME_HEAD.join("\t")];
    for (const x of E.sortRows(rows || []))
      lines.push([E.slashDate(x.date), E.textCell(x.type), E.textCell(x.desc), E.textCell(x.card), amountCell(x.amount)].join("\t"));
    return lines.join("\n");
  };

  /** 轉帳 (payslip deductions moved to another account) as TSV, same columns and order as the sheet. */
  E.bankTSV = (rows) => {
    const lines = [E.BANK_HEAD.join("\t")];
    for (const x of E.sortRows(rows || []))
      lines.push([E.textCell(x.card), E.slashDate(x.date), E.textCell(x.desc), E.TRANSFER, E.textCell(x.type), amountCell(x.amount), ""].join("\t"));
    return lines.join("\n");
  };

  const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb: "FF" + argb } });

  const resultText = (ck) => (ck.error ? (/^(需核對|不符)/.test(ck.error) ? ck.error : "錯誤：" + ck.error) : ck.ok ? "OK" : "不符，請檢查");

  /** rows: OutRow[]; checks: [{file, bank, closing, prev, cur, total, expect, ok, count, error?, due?, card?}] → ArrayBuffer */
  E.toXlsx = async (rows, checks) => {
    const X = g.ExcelJS;
    if (!X) throw new Error("Excel 元件尚未載入");
    const wb = new X.Workbook();
    wb.creator = "信用卡帳單轉換";
    for (const sheet of ["固定", "浮動"]) {
      const ws = wb.addWorksheet(sheet, { views: [{ state: "frozen", xSplit: 0, ySplit: 1, topLeftCell: "A2" }] });
      ws.addRow(E.HEAD).eachCell((c) => { c.font = { bold: true }; });
      for (const x of E.sortRows((rows || []).filter((r) => r.sheet === sheet))) {
        const r = ws.addRow([E.toDate(x.date), x.type, x.desc, x.card, x.inst == null ? null : x.inst, x.amount]);
        r.getCell(1).numFmt = "yyyy/m/d";
        if (x.guess && !x.confirmed) r.getCell(2).fill = fill(E.FILL_GUESS);
        if (x.ocr && !x.confirmed) r.getCell(3).fill = fill(E.FILL_OCR);
      }
      E.WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    }
    const ws = wb.addWorksheet("核對結果");
    ws.addRow(E.CHECK_HEAD).eachCell((c) => { c.font = { bold: true }; });
    for (const ck of checks || []) {
      const res = resultText(ck);
      const due = E.dueOf(ck.cur, ck.due);
      const r = ws.addRow([ck.file || "", bankName(ck.bank), E.toDate(ck.closing), ck.prev ?? null, ck.cur ?? null,
        ck.total ?? null, ck.expect ?? null, res, ck.count ?? 0, due === E.NO_PAY ? due : E.toDate(due)]);
      r.getCell(3).numFmt = "yyyy/m/d";
      r.getCell(10).numFmt = "yyyy/m/d";
      if (res !== "OK") for (let i = 1; i <= E.CHECK_HEAD.length; i++) r.getCell(i).fill = fill(E.FILL_BAD);
    }
    ws.addRow([]);
    ws.addRow([E.NOTE]);
    E.CHECK_WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    const wp = wb.addWorksheet("繳費");
    wp.addRow(E.PAY_HEAD).eachCell((c) => { c.font = { bold: true }; });
    for (const p of E.payRows(checks)) {
      const r = wp.addRow([p.card, E.toDate(p.due), null, p.method, p.amount]);
      r.getCell(2).numFmt = "yyyy/m/d";
      r.getCell(5).numFmt = "#,##0";
    }
    E.PAY_WIDTHS.forEach((w, i) => { wp.getColumn(i + 1).width = w; });
    const income = (rows || []).filter((r) => r.sheet === E.INCOME_SHEET);
    if (income.length) {
      const wi = wb.addWorksheet(E.INCOME_SHEET, { views: [{ state: "frozen", xSplit: 0, ySplit: 1, topLeftCell: "A2" }] });
      wi.addRow(E.INCOME_HEAD).eachCell((c) => { c.font = { bold: true }; });
      for (const x of E.sortRows(income)) {
        const r = wi.addRow([E.toDate(x.date), x.type, x.desc, x.card, x.amount]);
        r.getCell(1).numFmt = "yyyy/m/d";
        if (x.guess && !x.confirmed) r.getCell(2).fill = fill(E.FILL_GUESS);
      }
      E.INCOME_WIDTHS.forEach((w, i) => { wi.getColumn(i + 1).width = w; });
    }
    const bank = (rows || []).filter((r) => r.sheet === E.BANK_SHEET);
    if (bank.length) {
      const wk = wb.addWorksheet(E.BANK_SHEET, { views: [{ state: "frozen", xSplit: 0, ySplit: 1, topLeftCell: "A2" }] });
      wk.addRow(E.BANK_HEAD).eachCell((c) => { c.font = { bold: true }; });
      for (const x of E.sortRows(bank)) {
        const r = wk.addRow([x.card, E.toDate(x.date), x.desc, E.TRANSFER, x.type, x.amount, null]);
        r.getCell(2).numFmt = "yyyy/m/d";
        if (x.guess && !x.confirmed) r.getCell(5).fill = fill(E.FILL_GUESS);
      }
      E.BANK_WIDTHS.forEach((w, i) => { wk.getColumn(i + 1).width = w; });
    }
    const buf = await wb.xlsx.writeBuffer();
    // Node returns a Buffer; normalise to an exact ArrayBuffer
    if (buf instanceof ArrayBuffer) return buf;
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  };

  /** Save through the downloads capability. Resolves its status ('saved'); rejects {code} as given. */
  E.save = async (filename, buf, type = E.MIME) => {
    if (!(g.claude && g.claude.use)) return E.browserSave(filename, buf, type); // ordinary web host
    const dl = await g.claude.use("downloads");
    if (!dl) throw { code: "unavailable", message: "此環境無法存檔" };
    const r = await dl.save({ filename, data: new Blob([buf], { type }) });
    if (typeof r === "string") return r;
    return (r && r.status) || "saved";
  };
  /** Plain browser download (outside claude.ai): a temporary object URL on an <a download>. */
  E.browserSave = (filename, buf, type = E.MIME) => {
    const doc = g.document;
    if (!doc || !g.URL || !g.URL.createObjectURL) return Promise.reject({ code: "unavailable", message: "此環境無法存檔" });
    const url = g.URL.createObjectURL(new Blob([buf], { type }));
    const a = doc.createElement("a");
    a.href = url; a.download = filename; a.rel = "noopener"; a.style.display = "none";
    doc.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => g.URL.revokeObjectURL(url), 30000);
    return Promise.resolve("saved");
  };
})(globalThis);
