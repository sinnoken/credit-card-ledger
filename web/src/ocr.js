/* ocr.js — in-browser PP-OCRv3 text-line recognition for the 說明 cell (owner: agent B)
 * Classic script. Attaches CC.ocr. DEFAULT_FIX and cleanup() work in Node; ensure()/recognize()
 * need a browser (fetch, canvas, globals `ort` from onnxruntime-web 1.14 and a pdf.js page).
 *
 *   CC.ocr.ensure(onProgress?)        -> Promise<void>   idempotent; onProgress({stage, loaded, total})
 *        stages: 'cache' (IndexedDB lookup) · 'download' (bytes of rec.onnx.b64.txt) · 'init' (ort session) · 'ready'
 *        rejects Error(中文) with .code: 'network' | 'model' | 'unsupported'
 *   CC.ocr.recognize(pdfPage, [{y,x0,x1}]) -> Promise<[{text, conf, crop}]>  (PDF points, y = line centre)
 *   CC.ocr.cleanup(text, fixList = DEFAULT_FIX) -> string
 */
(function (g) {
  "use strict";
  const CC = (g.CC = g.CC || {});
  const O = (CC.ocr = {});

  // Python OCR_FIX (convert_reference.py) + 連二 → 連＿
  O.DEFAULT_FIX = [
    ["P i", "Pi"], ["Pi一", "Pi－"], ["支付遭", "支付連"], ["中油一", "中油－"], ["回馈", "回饋"],
    ["一國内", "－國內"], ["國内", "國內"], ["转帐", "轉帳"], ["帐", "帳"], ["费", "費"], ["缴", "繳"],
    ["连", "連"], ["拍卖", "拍賣"], ["連二", "連＿"], ["连二", "連＿"],
  ];

  /** Apply [from, to] replacements in order (every occurrence), then trim. */
  O.cleanup = (text, fixList) => {
    let t = String(text == null ? "" : text);
    for (const [a, b] of fixList || O.DEFAULT_FIX) if (a) t = t.split(a).join(b);
    return t.trim();
  };

  const MODEL_URL = "rec.onnx.b64.txt", KEYS_URL = "keys.txt";
  const DB = "cc-ocr", STORE = "models", KEY = "rec-v3";
  const MODEL_B64_SIZE = 14254336; // fallback total for progress when Content-Length is missing
  // 300 dpi render; model input h=48 and w >= 320 padded with 0 (as RapidOCR batches do).
  // Margins (× line height) tried around the tight ink box: RapidOCR feeds the detector's tight box, and the
  // reading is sensitive to the margin (e.g. 轉帳 read as 转), so two crops are read and the longer reading kept.
  const SCALE = 300 / 72, H = 48, MIN_W = 320, PADS = [0, 0.05], CROP_H = 32;

  const fail = (msg, code, cause) => {
    const e = new Error(msg);
    e.code = code;
    if (cause) e.cause = cause;
    return e;
  };

  /* ------------------------- IndexedDB (best effort) ------------------------- */
  function idbOpen() {
    return new Promise((resolve) => {
      let settled = false;
      const res = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        if (!g.indexedDB) return res(null);
        const rq = g.indexedDB.open(DB, 1);
        rq.onupgradeneeded = () => { try { rq.result.createObjectStore(STORE); } catch (_) {} };
        // A late success after onblocked already gave up: nobody holds this connection, so close it.
        rq.onsuccess = () => { if (settled) { try { rq.result.close(); } catch (_) {} } else res(rq.result); };
        rq.onerror = () => res(null);
        rq.onblocked = () => res(null);
      } catch (_) { res(null); }
    });
  }
  O._idbOpen = idbOpen; // test hook
  async function idbGet() {
    const db = await idbOpen();
    if (!db) return null;
    return new Promise((res) => {
      try {
        const rq = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
        rq.onsuccess = () => { db.close(); const v = rq.result; res(v instanceof ArrayBuffer && v.byteLength > 1e6 ? new Uint8Array(v) : null); };
        rq.onerror = () => { db.close(); res(null); };
      } catch (_) { try { db.close(); } catch (__) {} res(null); }
    });
  }
  async function idbPut(u8) {
    const db = await idbOpen();
    if (!db) return false;
    return new Promise((res) => {
      try {
        const buf = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer;
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(buf, KEY);
        tx.oncomplete = () => { db.close(); res(true); };
        tx.onerror = tx.onabort = () => { db.close(); res(false); };
      } catch (_) { try { db.close(); } catch (__) {} res(false); }
    });
  }

  /* ------------------- streaming base64 decoder (ASCII bytes) ------------------- */
  const B64 = new Int16Array(256).fill(-1);
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("").forEach((c, i) => (B64[c.charCodeAt(0)] = i));
  B64[45] = 62; B64[95] = 63; // url-safe '-' '_'

  function B64Decoder(sizeHint) {
    let out = new Uint8Array(Math.ceil((sizeHint || 1 << 20) * 3 / 4) + 4), n = 0, acc = 0, bits = 0;
    return {
      push(chunk) {
        if (n + chunk.length > out.length) { // grow (only if the hint was wrong)
          const o2 = new Uint8Array(Math.max(out.length * 2, n + chunk.length));
          o2.set(out.subarray(0, n)); out = o2;
        }
        for (let i = 0, L = chunk.length; i < L; i++) {
          const v = B64[chunk[i]];
          if (v < 0) continue; // '=', whitespace, newlines
          acc = ((acc << 6) | v) & 0xffffff; bits += 6;
          if (bits >= 8) { bits -= 8; out[n++] = (acc >> bits) & 0xff; }
        }
      },
      done() { return out.subarray(0, n); },
    };
  }

  async function download(onProgress) {
    let rsp;
    try { rsp = await fetch(MODEL_URL); } catch (e) { throw fail("辨識模型下載失敗，請檢查網路後再試一次", "network", e); }
    if (!rsp.ok) throw fail(`辨識模型下載失敗（HTTP ${rsp.status}）`, "network");
    const total = +rsp.headers.get("Content-Length") || MODEL_B64_SIZE;
    const dec = B64Decoder(total);
    let loaded = 0;
    try {
      if (rsp.body && rsp.body.getReader) {
        const rd = rsp.body.getReader();
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          dec.push(value); loaded += value.length;
          onProgress({ stage: "download", loaded, total: Math.max(total, loaded) });
        }
      } else {
        const u8 = new Uint8Array(await rsp.arrayBuffer());
        dec.push(u8); loaded = u8.length;
      }
    } catch (e) { throw fail("辨識模型下載中斷，請再試一次", "network", e); }
    onProgress({ stage: "download", loaded, total: loaded });
    const bytes = dec.done();
    if (bytes.length < 1e6) throw fail("辨識模型檔案不完整", "model");
    return bytes;
  }

  /* ------------------------------- ensure ------------------------------- */
  let ready = null, session = null, keys = null, queue = Promise.resolve();

  O.ensure = (onProgress) => {
    if (!ready) {
      ready = load(typeof onProgress === "function" ? onProgress : () => {}).catch((e) => { ready = null; throw e; });
    } else if (typeof onProgress === "function") {
      ready.then(() => onProgress({ stage: "ready", loaded: 1, total: 1 }), () => {});
    }
    return ready;
  };
  O.isReady = () => !!session;

  async function load(onProgress) {
    const prog = (p) => { try { onProgress(p); } catch (_) {} };
    const ort = g.ort;
    if (!ort || !ort.InferenceSession || typeof fetch !== "function")
      throw fail("這個瀏覽器無法執行文字辨識（缺少 onnxruntime）", "unsupported");
    try {
      ort.env.wasm.wasmPaths = new URL("./", g.location.href).href;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;
      ort.env.wasm.proxy = false;
    } catch (_) {}

    const keysP = fetch(KEYS_URL)
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .catch((e) => { throw fail("辨識字典（keys.txt）下載失敗", "network", e); });
    keysP.catch(() => {});

    prog({ stage: "cache", loaded: 0, total: 1 });
    let bytes = null, fromCache = false;
    try { bytes = await idbGet(); } catch (_) { bytes = null; }
    if (bytes) fromCache = true;
    else bytes = await download(prog);
    prog({ stage: "cache", loaded: 1, total: 1 });

    const txt = await keysP;
    const k = txt.replace(/\r/g, "").split("\n");
    if (k.length && k[k.length - 1] === "") k.pop();
    if (k.length < 6000) throw fail("辨識字典（keys.txt）內容不正確", "model");
    keys = ["blank", ...k, " "];

    prog({ stage: "init", loaded: 0, total: 1 });
    let s;
    try {
      s = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    } catch (e) {
      if (fromCache) { // corrupted cache? drop it and retry once from the network
        try { bytes = await download(prog); s = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] }); fromCache = false; }
        catch (e2) { throw e2 && e2.code ? e2 : fail("辨識模型無法啟動（" + ((e2 && e2.message) || e2) + "）", "model", e2); }
      } else throw fail("辨識模型無法啟動（" + ((e && e.message) || e) + "）", "model", e);
    }
    if (!fromCache) { try { await idbPut(bytes); } catch (_) {} }
    bytes = null;
    session = s;
    O.fromCache = fromCache;
    prog({ stage: "init", loaded: 1, total: 1 });
    prog({ stage: "ready", loaded: 1, total: 1 });
  }

  /* ------------------------------ recognize ------------------------------ */
  const newCanvas = (w, h) => {
    const c = g.document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  };
  const release = (c) => { if (c) { c.width = 0; c.height = 0; } };

  /** Tighten the cell [x0,x1] around line centre yc (points) to the ink of that one line (no margin). -> {sx,sy,w,h} | null */
  function tighten(pageCtx, cw, chgt, x0, x1, yc) {
    const half = 9 * SCALE;
    const sx = Math.max(0, Math.round(x0 * SCALE)), sw = Math.min(cw - sx, Math.round((x1 - x0) * SCALE));
    const sy = Math.max(0, Math.round(yc * SCALE - half)), sh = Math.min(chgt - sy, Math.round(half * 2));
    if (sw <= 2 || sh <= 2) return null;
    const d = pageCtx.getImageData(sx, sy, sw, sh).data;
    const ink = (x, y) => { const i = (y * sw + x) * 4; return d[i] + d[i + 1] + d[i + 2] < 450; };
    const rowInk = new Int32Array(sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (ink(x, y)) rowInk[y]++;
    // from the centre line walk to the nearest ink row, then grow up/down until 3 blank rows: one text line only
    const mid = Math.round(sh / 2);
    let c = mid, k = 0;
    while (c < sh && !rowInk[c] && k < 12) { c++; k++; }
    if (c >= sh || !rowInk[c]) { c = mid; k = 0; while (c > 0 && !rowInk[c] && k < 12) { c--; k++; } }
    if (!rowInk[c]) return null;
    let top = c, bot = c, gap = 0;
    for (let y = c; y >= 0; y--) { if (rowInk[y]) { top = y; gap = 0; } else if (++gap >= 3) break; }
    gap = 0;
    for (let y = c; y < sh; y++) { if (rowInk[y]) { bot = y; gap = 0; } else if (++gap >= 3) break; }
    let left = sw, right = -1;
    for (let x = 0; x < sw; x++) for (let y = top; y <= bot; y++) if (ink(x, y)) { if (x < left) left = x; if (x > right) right = x; break; }
    if (right < 0) return null;
    return { sx: sx + left, sy: sy + top, w: right - left + 1, h: bot - top + 1 };
  }

  async function runModel(input) {
    // Like RapidOCR: image resized to h=48 on the left, tensor at least MIN_W wide, padding = 0 (mid-grey).
    const w = input.width, px = input.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, H).data;
    const W = Math.max(w, MIN_W), N = H * W, data = new Float32Array(3 * N);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < w; x++) { // BGR like OpenCV / RapidOCR
        const i = y * W + x, j = (y * w + x) * 4;
        data[i] = px[j + 2] / 127.5 - 1;
        data[N + i] = px[j + 1] / 127.5 - 1;
        data[2 * N + i] = px[j] / 127.5 - 1;
      }
    const name = (session.inputNames && session.inputNames[0]) || "x";
    const out = await session.run({ [name]: new g.ort.Tensor("float32", data, [1, 3, H, W]) });
    const t = out[(session.outputNames && session.outputNames[0])] || Object.values(out)[0];
    const T = t.dims[1], C = t.dims[2], v = t.data;
    let text = "", last = 0, conf = 0, n = 0;
    for (let s = 0; s < T; s++) {
      let best = 0, bv = -Infinity;
      for (let k = 0, o = s * C; k < C; k++) if (v[o + k] > bv) { bv = v[o + k]; best = k; }
      if (best !== 0 && best !== last) { text += keys[best] ?? ""; conf += bv; n++; }
      last = best;
    }
    return { text, conf: n ? conf / n : 0 };
  }

  const expand = (b, p, cw, ch) => {
    const x = Math.max(0, b.sx - p), y = Math.max(0, b.sy - p);
    return { sx: x, sy: y, w: Math.min(cw, b.sx + b.w + p) - x, h: Math.min(ch, b.sy + b.h + p) - y };
  };

  /** Resize the box to h=48 (bilinear, like cv2.resize), run the model, return {text, conf, crop}. */
  async function readBox(page, box) {
    const W = Math.max(16, Math.ceil(H * box.w / box.h));
    const input = newCanvas(W, H);
    try {
      const ic = input.getContext("2d", { willReadFrequently: true });
      ic.fillStyle = "#fff"; ic.fillRect(0, 0, W, H);
      ic.drawImage(page, box.sx, box.sy, box.w, box.h, 0, 0, W, H);
      return await runModel(input);
    } finally { release(input); }
  }

  /** Small PNG preview of the cell for the review table (height CROP_H). */
  function cropURL(page, b) {
    const h = CROP_H, w = Math.max(8, Math.round(h * b.w / b.h)), c = newCanvas(w, h);
    try {
      const x = c.getContext("2d");
      x.fillStyle = "#fff"; x.fillRect(0, 0, w, h);
      x.imageSmoothingQuality = "high";
      x.drawImage(page, b.sx, b.sy, b.w, b.h, 0, 0, w, h);
      return c.toDataURL("image/png");
    } finally { release(c); }
  }

  async function recognizeNow(pdfPage, reqs) {
    if (!session) await O.ensure();
    const vp = pdfPage.getViewport({ scale: SCALE });
    const page = newCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const results = [];
    try {
      const ctx = page.getContext("2d", { willReadFrequently: true, alpha: false });
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, page.width, page.height);
      try {
        await pdfPage.render({ canvasContext: ctx, viewport: vp, background: "rgba(255,255,255,1)" }).promise;
      } catch (e) { throw fail("無法繪製 PDF 頁面以進行辨識", "render", e); }
      for (const r of reqs || []) {
        const box = r && tighten(ctx, page.width, page.height, r.x0, r.x1, r.y);
        if (!box) { results.push({ text: "", conf: 0, crop: null }); continue; }
        let best = null;
        for (const m of PADS) { // a few margins; CTC tends to DROP glyphs, so keep the longest reading (tie: higher conf)
          const res = await readBox(page, expand(box, Math.round(m * box.h), page.width, page.height));
          if (!best || [...res.text].length > [...best.text].length || ([...res.text].length === [...best.text].length && res.conf > best.conf)) best = res;
        }
        best.crop = cropURL(page, expand(box, Math.round(0.15 * box.h), page.width, page.height));
        results.push(best);
      }
    } finally { release(page); }
    return results;
  }

  /** Serialised: the single-threaded wasm session must not run concurrently. */
  O.recognize = (pdfPage, reqs) => {
    const p = queue.then(() => recognizeNow(pdfPage, reqs));
    queue = p.catch(() => {});
    return p;
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
