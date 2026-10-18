// test/close-provenance.test.js — 4.22 (2026-10-03): every close names its caller.
//
// THE DEFECT: every executor close wrote the same row (`note:'executor close'`) and `trade_closed` named no
// caller. Finding C1 took a two-day investigation to attribute 7 closes because lane (wake vs review),
// post-hoc logging and probes were structurally invisible. One stamped column turns the next hunt into a
// GROUP BY.
//
// THE PINS:
//   1. COMPLETENESS (the guard-the-guard): every `executor.closeTrade(` call site in `trading/` passes
//      `source:` — a 7th caller cannot be added silently. That defect IS a silently-added caller.
//   2. The write path: the column reaches the row + BOTH events (`trade_closed`, and the close-failure
//      `order_rejected`), and `note: 'executor close'` stays byte-identical (two consumers read it).
//   3. FAIL-OPEN: an absent source is legal (closes must stay cheap).
//
// Deliberately EXCLUDED from the sweep: `paper.js` / `connector/paper.js` (the sim ledger's OWN
// `closeTrade` — a different function with a different ledger and its own `reason` field), and the
// function DEFINITION in `executor.js`.
//
// Run with: npm run test:unit  (or: node --test test/close-provenance.test.js)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { code } = require('./_source');

const ROOT = path.join(__dirname, '..');

function filesUnder(rel) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || !e.name.endsWith('.js')) continue;
    if (e.parentPath && e.parentPath.includes('node_modules')) continue;
    out.push(path.join(e.parentPath, e.name));
  }
  return out;
}

// Every executor.closeTrade CALL (not the definition, not the paper ledgers). A call is any occurrence
// of `closeTrade(` whose nearest 200-char window names executor OR is the internal bare call with the
// (userId, settings, ...) shape used only by executor's own sweep.
function executorCalls() {
  const calls = [];
  for (const file of filesUnder('trading')) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (/paper\.js$/.test(rel)) continue;                       // the sim ledger's own closeTrade
    const src = fs.readFileSync(file, 'utf8');
    const re = /closeTrade\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const before = src.slice(Math.max(0, m.index - 90), m.index);
      const window = src.slice(m.index, m.index + 260);
      if (/function closeTrade$/.test(before)) continue;        // the definition
      const isExecutor = before.includes('executor') || /closeTrade\(userId, settings,\s*t\.id, \{ force: true/.test(window);
      if (!isExecutor) continue;
      calls.push({ rel, window });
    }
  }
  return calls;
}

test('COMPLETENESS: every executor close names its caller — a 7th caller cannot land silently', () => {
  const calls = executorCalls();
  assert.ok(calls.length >= 6, `expected at least the six known call sites, found ${calls.length}`);
  for (const c of calls) {
    assert.match(c.window, /source:/, `${c.rel}: this close call passes no \`source:\` — provenance would be lost`);
  }
});

test('the five lanes are stamped with what the caller actually holds', () => {
  const w = code('trading/agent/wakePipeline.js').replace(/\r\n/g, '\n');
  const r = code('trading/agent/review.js').replace(/\r\n/g, '\n');
  const p = code('trading/agent/pairs.js').replace(/\r\n/g, '\n');
  const rt = code('trading/routes.js').replace(/\r\n/g, '\n');
  const ex = code('trading/agent/executor.js').replace(/\r\n/g, '\n');
  assert.match(w, /source: result\.promptId \? `wake:\$\{result\.promptId\}` : 'wake'/, 'wake lane');
  assert.match(r, /source: 'review'/, 'review lane (its record is written AFTER the close — no id at call time)');
  assert.match(p, /source: `pairs:\$\{id\}`/, 'pairs leg-A unwind');
  assert.match(p, /source: `pairs:\$\{pairId\}`/, 'pairs unhedged-survivor unwind');
  assert.match(rt, /source: 'api'/, 'the route clamps server-side — never the request body');
  assert.match(ex, /source: 'sweep:kill'/, 'hard-kill sweep');
});

test('the write path: column + both events; the note stays byte-identical; absent source is legal', () => {
  const ex = code('trading/agent/executor.js').replace(/\r\n/g, '\n');
  assert.match(ex, /async function closeTrade\(userId, settings, tradeId, \{ keepOpen = false, force = false, source = null \} = \{\}\)/, 'the option is optional — fail-open');
  assert.match(ex, /closeSource: source \|\| null/, 'the row write');
  assert.match(ex, /'trade_closed', \{ tradeId: trade\.id, symbol: trade\.symbol, fill, closeSource: source \|\| null \}/, 'trade_closed payload');
  assert.match(ex, /closeSource: source \|\| null,\n\s+alreadyResolved/, 'the close-failure order_rejected payload is stamped too (C1 failed-attempt blindness was the same class)');
  assert.match(ex, /note: 'executor close'/, "the note stays byte-identical — stopCoverage exact-matches it");
  const store = code('trading/store.js').replace(/\r\n/g, '\n');
  assert.match(store, /'netPnlTerminal', 'closeSource'\]/, 'updateTrade whitelist carries the column');
  // 2026-10-08: the INSERT now carries closeSource FOLLOWED BY the spread/latency telemetry columns (added
  // 2026-10-05), so the old "closes immediately before OUTPUT" form went stale. Pin membership instead.
  assert.match(store, /INSERT INTO Trades \(userId[^)]*\bcloseSource\b[^)]*\)\s*\n\s*OUTPUT INSERTED\.id/, 'createTrade INSERT carries the column');
});

test('the migration is additive-only and never invents history', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'sql', 'migrations', '046_trade_close_source.sql'), 'utf8');
  assert.match(sql, /IF COL_LENGTH\('dbo\.Trades', 'closeSource'\) IS NULL/);
  assert.match(sql, /ADD closeSource NVARCHAR\(32\) NULL/);
  assert.doesNotMatch(sql, /UPDATE\s+dbo\.Trades/i, 'no backfill in the migration — NULL means unknown');
});
