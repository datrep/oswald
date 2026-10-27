'use strict';
// test/require-paths-resolve.test.js — 2026-10-23.
//
// THE BUG THIS EXISTS FOR. `trading/plus500/webtrader.js` called
// `require('../../agent/trailingStop')`. From `trading/plus500/` that resolves to `oswald/agent/trailingStop`,
// which does not exist — the file is at `trading/agent/trailingStop`. The require sat INSIDE the trail-calibration
// branch, so it threw only when a trail engagement was actually attempted: the desk typed the stop into the venue
// ticket and then died before pressing Update, and the client reverted the values. The owner saw "it set the
// revised values, and then hard reset".
//
// ⚠ IT SURVIVED A GREEN SUITE because the trail tests exercise `trailingStop.calibrateCount` directly and pin the
// surrounding source with regexes — the require is never executed by any of them. Cost: **43 module errors measured
// 2026-10-20 → 10-23** (6, then 22, then 15) — a dead trail engage for three days, and a venue ticket that visibly
// reset itself after the desk had typed the stop into it.
//
// So this test does the one thing that catches it structurally, and catches the whole class: every relative
// `require()` in `trading/**` must resolve to a file that exists. It is cheap, it needs no browser, and it fails
// on the exact line that a lazy require hides in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TRADING = path.join(ROOT, 'trading');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(p, out);
    } else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Only literal requires. Anything computed is out of scope and is reported as such rather than silently passed.
const RE = /require\(\s*'(\.[^']*)'\s*\)/g;

test('every relative require under trading/** resolves to a real file', () => {
  const files = walk(TRADING);
  assert.ok(files.length > 50, `expected to scan the trading tree, found only ${files.length} files`);
  const broken = [];
  let checked = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(src))) {
      const spec = m[1];
      const target = path.resolve(path.dirname(file), spec);
      checked += 1;
      const candidates = [target, `${target}.js`, path.join(target, 'index.js')];
      if (!candidates.some((c) => fs.existsSync(c))) {
        const line = src.slice(0, m.index).split('\n').length;
        broken.push(`${path.relative(ROOT, file)}:${line}  require('${spec}') -> ${path.relative(ROOT, target)}`);
      }
    }
  }
  assert.ok(checked > 300, `expected to check many requires, checked only ${checked}`);
  assert.deepStrictEqual(broken, [], `unresolvable requires:\n${broken.join('\n')}`);
});

test('the trail calibration require specifically points at trading/agent/trailingStop', () => {
  // A direct pin on the line that was wrong, so the failure names the defect rather than only the class.
  const src = fs.readFileSync(path.join(TRADING, 'plus500', 'webtrader.js'), 'utf8');
  assert.match(src, /require\('\.\.\/agent\/trailingStop'\)/, 'webtrader must reach trailingStop via ../agent/');
  assert.doesNotMatch(src, /require\('\.\.\/\.\.\/agent\//, 'nothing under trading/plus500/ is two levels from agent/');
  const mod = require(path.join(TRADING, 'agent', 'trailingStop'));
  assert.strictEqual(typeof mod.calibrateCount, 'function', 'calibrateCount must be reachable from the module the trail path loads');
});
