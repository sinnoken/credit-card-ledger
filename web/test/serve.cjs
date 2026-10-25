// Shared Playwright helpers: static server for dist/ (or any dir) + CDN routing to vendor copies.
const http = require('http'), fs = require('fs'), path = require('path');
const V = path.join(__dirname, '../vendor');
const CDN = {
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js': 'pdf.min.js',
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/ort.min.js': 'ort.min.js',
  'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js': 'exceljs.min.js',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.css': 'text/css' };
function serve(dir, port) {
  return new Promise((res) => {
    const s = http.createServer((req, rsp) => {
      const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
      if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { rsp.writeHead(404); return rsp.end(); }
      rsp.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(rsp);
    }).listen(port, '127.0.0.1', () => res(s));
  });
}
async function routeCdn(page) {
  for (const [url, f] of Object.entries(CDN)) await page.route(url, (r) => r.fulfill({ path: path.join(V, f), contentType: 'text/javascript' }));
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
  await page.route('https://fonts.gstatic.com/**', (r) => r.fulfill({ status: 404, body: '' }));
}
module.exports = { serve, routeCdn, CDN };
