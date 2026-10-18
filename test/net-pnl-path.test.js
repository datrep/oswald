'use strict';
// TRD-PNL-1: the NET P/L path — a currency min/max/terminal range that cannot be lost.
//
// WHY THIS FILE IS MOSTLY ABOUT WHAT MUST NOT BE POSSIBLE. The defect was that `floatingPnl` — the venue's
// NetPL — was read every ~2.4s and OVERWRITTEN, so every earlier sample of a trade's path was discarded. The
// cheap fix is a min/max, and the cheap fix is also where it goes wrong: a maximum that a caller can SET is a
// maximum that can be LOWERED, and a terminal value that is rewritten on every reconcile is a current value
// with a misleading name. So the assertions are about the shapes the code must FORBID.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'trading', 'store.js'), 'utf8');
const UPDATE_TRADE = SRC.slice(SRC.indexOf('async function updateTrade'), SRC.indexOf('async function getTradeById'));
// The `updatable` allowlist, read out of the source rather than restated — a copy would drift.
const UPDATABLE = (() => {
  const m = SRC.match(/const updatable = \[([\s\S]*?)\];/);
  return m ? m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
})();

test('★ netPnlMin/netPnlMax/netPnlSamples are NOT in the settable allowlist', () => {
  // A maximum a caller can set is a maximum a caller can LOWER. These are widened by SQL only.
  for (const k of ['netPnlMin', 'netPnlMax', 'netPnlSamples']) {
    assert.ok(!UPDATABLE.includes(k), `${k} must NOT be directly settable — a max that can go down is not a max`);
  }
  // Non-vacuity: the allowlist is real and non-empty, so the assertion above is not passing because the
  // parser found nothing.
  assert.ok(UPDATABLE.length > 20, `expected the real allowlist, parsed ${UPDATABLE.length}`);
  assert.ok(UPDATABLE.includes('floatingPnl'), 'floatingPnl IS settable — it is the live feed');
  assert.ok(UPDATABLE.includes('netPnlTerminal'), 'the terminal value is settable at close');
});

test('★ the tracking lives in updateTrade, the ONE function every writer passes through', () => {
  // There are five places that write floatingPnl (executor reconcile, two mirror paths, the poller, and the
  // mirror upgrade). A fix applied at five sites is a fix applied at four — so the clauses must be HERE.
  assert.match(UPDATE_TRADE, /netPnlMin = CASE WHEN netPnlMin IS NULL OR @floatingPnl < netPnlMin/,
    'the min clause must be in updateTrade');
  assert.match(UPDATE_TRADE, /netPnlMax = CASE WHEN netPnlMax IS NULL OR @floatingPnl > netPnlMax/,
    'the max clause must be in updateTrade');
  assert.match(UPDATE_TRADE, /netPnlSamples = ISNULL\(netPnlSamples, 0\) \+ 1/,
    'samples must be counted, or a range over 1 sample reads as a range over 500');
  // And they must be GATED on floatingPnl being written, or every unrelated update would inflate the count.
  const gate = UPDATE_TRADE.indexOf("hasOwnProperty.call(fields, 'floatingPnl')");
  assert.ok(gate > -1, 'the widening must be gated on an actual floatingPnl write');
  assert.ok(gate < UPDATE_TRADE.indexOf('netPnlMin = CASE'), 'and the gate must precede the clauses');
});

test('★ the terminal value FREEZES — ISNULL, not an unconditional assignment', () => {
  // A terminal value that a re-reconcile can move is a current value with a misleading name.
  assert.match(UPDATE_TRADE, /netPnlTerminal = ISNULL\(netPnlTerminal, floatingPnl\)/,
    'the terminal must be frozen on first close');
  // And it must read the OLD `floatingPnl` (the column), not a new parameter — the value in force at the end.
  assert.ok(!/netPnlTerminal = ISNULL\(netPnlTerminal, @floatingPnl\)/.test(UPDATE_TRADE),
    'it must freeze the last sample in force, not a value arriving in the same statement');
});

test('the four columns exist in the migration that adds them', () => {
  const ddl = fs.readFileSync(path.join(__dirname, '..', 'trading', 'sql', '2026-09-27-net-pnl-path.sql'), 'utf8');
  for (const c of ['netPnlMin', 'netPnlMax', 'netPnlSamples', 'netPnlTerminal']) {
    assert.match(ddl, new RegExp(`ADD ${c} `), `${c} must be added by the migration`);
  }
  // Idempotent guards, so re-running the file is safe.
  assert.match(ddl, /IF COL_LENGTH\('dbo\.Trades', 'netPnlMin'\) IS NULL/, 'the ADD must be guarded');
});
