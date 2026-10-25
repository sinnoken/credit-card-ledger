// Loads pdf.js (legacy build) + src modules into globalThis for Node tests.
// Usage: const CC = require('./test/node_env.cjs')(['core.js','banks.js'])
const path = require('path');
module.exports = (mods) => {
  if (!globalThis.pdfjsLib) {
    const w = console.warn; console.warn = () => {};
    globalThis.pdfjsLib = require(path.join(__dirname, '../vendor/pkg/pdfjs-dist-3.11.174/package/legacy/build/pdf.js'));
    console.warn = w;
  }
  for (const m of mods) require(path.join(__dirname, '../src', m));
  return globalThis.CC;
};
