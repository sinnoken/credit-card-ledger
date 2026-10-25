// Private-fixture gate. The real statements, the Python reference output, the owner's workbook and settings
// are gitignored (test/fixtures/...). Tests call need()/skipUnless() so a public checkout runs the synthetic
// checks and prints a clear SKIP for the rest instead of failing.
const fs = require('fs'), path = require('path');
const FIX = path.join(__dirname, 'fixtures');
const PDFS = ['BOT.pdf', 'CTBC.pdf', 'FIRST.pdf', 'FUBON.pdf', 'MEGA.pdf', 'TCB.pdf', 'TSB.pdf'];
const rel = (p) => path.relative(path.join(__dirname, '..'), p);
/** Absolute paths for names relative to test/fixtures ('pdf' = all seven statements). */
const paths = (names) => names.flatMap((n) => (n === 'pdf' ? PDFS.map((f) => path.join(FIX, 'pdf', f)) : [path.join(FIX, n)]));
/** List of missing fixture paths (repo-relative). */
function missing(names) { return paths(names).filter((p) => !fs.existsSync(p)).map(rel); }
/** true when all present; otherwise prints one SKIP line for `what` and returns false. */
function need(names, what) {
  const m = missing(names);
  if (!m.length) return true;
  console.log(`SKIP${what ? ' ' + what : ''} (private fixtures not present: ${m.join(', ')})`);
  return false;
}
/** Whole-file gate: when anything is missing print SKIP and exit 0. */
function skipUnless(names, what) { if (!need(names, what)) process.exit(0); }
module.exports = { FIX, PDFS, missing, need, skipUnless };
