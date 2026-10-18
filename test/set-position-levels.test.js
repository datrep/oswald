// EXE-14 S2 — moving a position's levels through the post-entry Edit card, and the ways it must REFUSE.
//
// THE FINDING THIS PINS (S1 re-probe, 2026-10-02). The first dump of the edit card was filtered to
// `[data-testid*="SetLimits"]` and therefore reported NO confirm control. That was wrong: `#setLimitsCfd` really
// does contain zero buttons, but the card is committed by `#trade-button` — an element carrying BOTH
// `id="trade-button"` and `data-testid="BuySell.SubmitButton"`, living in `DIV[BuySell.Footer]` inside
// `#buySellCfd`, a SIBLING of the card rather than a child. On the edit path it reads `Update`; on the entry
// ticket the SAME element reads `Buy`/`Sell`.
//
// Two consequences, and they are the whole point of this file:
//   1. A read-back taken WITHOUT clicking it proves nothing — it shows the value we typed while the venue still
//      holds the old level. So verification is against the ROW, never against the input.
//   2. Because the same element both commits an edit and opens a position, a click without a context check can
//      do the wrong one. The `Update` label is that check, and T4 below proves NO click happens when it fails.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { setPositionLevels, readRowLevels, levelsSettled } = require('../trading/plus500/webtrader');

// A stub that is loud about what it was asked to do. `committed` is flipped by the ONLY click this module is
// allowed to make, which is what lets the read-back distinguish "before" from "after".
function stubPage({ label = 'Update', before = { tp: 4129.28, stop: 4180.37 }, after = null } = {}) {
  const calls = [];
  const filled = {};
  const state = { committed: false };
  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const page = {
    calls,
    url: () => 'https://app.plus500.com/open-positions',
    goto: async (u) => { calls.push(['goto', u]); },
    waitForTimeout: async () => {},
    waitForFunction: async (fn) => {
      const src = String(fn);
      // The Update-label gate is the one wait that can FAIL, and it is the safety control under test.
      if (/trade-button/.test(src)) { calls.push(['waitForSubmitLabel']); return /^update$/i.test(label); }
      return true; // the row-present wait, and toggleLimit's waitInput
    },
    evaluate: async (fn, arg) => {
      const src = String(fn);
      if (src.includes('LimitStop')) {
        const lv = state.committed && after ? after : before;
        calls.push(['readRow', arg]);
        return { found: true, text: `Limit: ${fmt(lv.tp)}  Stop: ${fmt(lv.stop)}`, takeProfitPrice: lv.tp, stopPrice: lv.stop };
      }
      if (src.includes('Button.Edit')) { calls.push(['clickEdit', arg]); return true; }
      // toggleLimit's isExpanded -> the card is ALREADY open, so toggleLimit must be a no-op (no switch click).
      if (src.includes('getComputedStyle')) return true;
      // fillRate's read of the input it just filled.
      if (src.includes('el.value')) return filled[arg] == null ? null : filled[arg];
      // the context report, only reached on the refusal path
      if (src.includes("'#trade-button'")) return label;
      return null;
    },
    locator: (sel) => ({ first: () => ({ fill: async (v) => { const n = Number(v); filled[sel] = n; calls.push(['fill', sel, n]); } }) }),
    click: async (sel) => { calls.push(['click', sel]); if (sel === '#trade-button') state.committed = true; },
    keyboard: { press: async (k) => { calls.push(['press', k]); } },
  };
  return { page, calls, state };
}

// --- the arithmetic the whole step turns on ---------------------------------

test('a 4dp ledger level against a 2dp venue read is SETTLED, not a failure', () => {
  // The S1 sub-finding: `Trades.stopPrice` holds 4180.3696, the card shows 4,180.37, `fillRate` writes
  // toFixed(2). Comparing at four decimals would fail a write that is CORRECT and trip the restore path.
  assert.equal(levelsSettled([{ which: 'loss', want: 4180.3696 }], { found: true, stopPrice: 4180.37 }), true);
  assert.equal(levelsSettled([{ which: 'profit', want: 4129.2786 }], { found: true, takeProfitPrice: 4129.28 }), true);
  // A real move is NOT settled — the epsilon must not swallow a stop that actually moved.
  assert.equal(levelsSettled([{ which: 'loss', want: 4180.37 }], { found: true, stopPrice: 4185.00 }), false);
  assert.equal(levelsSettled([{ which: 'loss', want: 4180.37 }], { found: true, stopPrice: null }), false);
});

test('levelsSettled refuses to call an unreadable or empty plan a success', () => {
  assert.equal(levelsSettled([{ which: 'loss', want: 4180.37 }], { found: false }), false, 'a row we could not read is not agreement');
  assert.equal(levelsSettled([], { found: true, stopPrice: 1 }), false, 'an empty plan settles nothing');
  assert.equal(levelsSettled([{ which: 'loss', want: 4180.37 }], null), false);
});

test('readRowLevels parses the venue row text, so the BEFORE read needs no click', async () => {
  const real = global.document;
  const parse = async (text) => {
    global.document = { querySelector: (s) => (s.includes('LimitStop') ? { textContent: text } : null) };
    try { return await readRowLevels({ evaluate: (fn, arg) => Promise.resolve(fn(arg)) }, 1889364478); }
    finally { global.document = real; }
  };

  const tidy = await parse('Limit: 4,129.28  Stop: 4,180.37');
  assert.equal(tidy.found, true);
  assert.equal(tidy.takeProfitPrice, 4129.28, '`Limit:` is the take-profit');
  assert.equal(tidy.stopPrice, 4180.37, '`Stop:` is the stop');

  // ⚠⚠ THE LIVE FORMAT, copied verbatim off the venue on 2026-10-02. The value is NOT on the same line as its
  // label — there is a NEWLINE and a TAB between `Stop:` and the number. This parsed only because the separator
  // is `\s*`; a single `\s` returns null, and a null stop reads as "the venue holds no stop" rather than as a
  // parse failure — an absent-read-as-present in the one function that feeds the restore path. Pinned so a
  // future tidy-up of the regex cannot silently lose the stop.
  const live = await parse('Limit: 2,741.42  Stop:\r\n\t      2,681.66');
  assert.equal(live.found, true);
  assert.equal(live.takeProfitPrice, 2741.42);
  assert.equal(live.stopPrice, 2681.66, 'a line break between the label and the value must still parse');

  global.document = { querySelector: () => null };
  try {
    const r = await readRowLevels({ evaluate: (fn, arg) => Promise.resolve(fn(arg)) }, 1);
    assert.equal(r.found, false, 'a missing row is reported as missing, never as zeros');
  } finally { global.document = real; }
});

// --- the refusals -----------------------------------------------------------

test('it refuses before touching the tab when there is no venue id or no level to set', async () => {
  const { page, calls } = stubPage();
  const a = await setPositionLevels(page, {}, { id: 1 }, { stopPrice: 100 });
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'no_venue_position_id');

  const b = await setPositionLevels(page, {}, { plus500PositionId: '1889364478' }, {});
  assert.equal(b.reason, 'nothing_to_set');

  assert.deepEqual(calls, [], 'nothing was navigated, read or clicked');
});

test('★ when the submit does NOT read "Update", it refuses and CLICKS NOTHING', async () => {
  const { page, calls } = stubPage({ label: 'Buy' });
  const r = await setPositionLevels(page, {}, { plus500PositionId: '1889364478' }, { stopPrice: 4150 });

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_in_edit_context');
  assert.equal(r.submitLabel, 'Buy', 'and it reports WHAT the control said, so the record names the state');
  assert.equal(
    calls.filter((c) => c[0] === 'click' && c[1] === '#trade-button').length, 0,
    'a click here is the SAME element that opens a position — this guard is the whole reason the step is safe',
  );
});

// --- the success path -------------------------------------------------------

test('on success it commits exactly once, AFTER the fill, and verifies against the ROW', async () => {
  const { page, calls } = stubPage({
    label: 'Update',
    before: { tp: 4129.28, stop: 4180.37 },
    after: { tp: 4129.28, stop: 4150.00 },
  });
  const r = await setPositionLevels(page, {}, { plus500PositionId: '1889364478' }, { stopPrice: 4150 });

  assert.equal(r.ok, true, `expected success, got ${JSON.stringify(r).slice(0, 300)}`);
  assert.equal(r.before.stopPrice, 4180.37, 'the BEFORE value came from the row');
  assert.equal(r.after.stopPrice, 4150, 'and the AFTER value is the VENUE\'s, not the number we typed');
  assert.equal(r.submitLabel, 'Update');

  const commits = calls.map((c, i) => [c, i]).filter(([c]) => c[0] === 'click' && c[1] === '#trade-button');
  assert.equal(commits.length, 1, 'exactly one commit');
  const fillIdx = calls.findIndex((c) => c[0] === 'fill');
  const commitIdx = calls.findIndex((c) => c[0] === 'click' && c[1] === '#trade-button');
  assert.ok(fillIdx >= 0 && commitIdx > fillIdx, 'the value is filled BEFORE the commit, never after');

  // toggleLimit must have been a NO-OP: the level is already armed on an edit card, so a switch click would
  // DISARM it. The stub reports the card as already expanded, which is what the live probe measured.
  assert.equal(calls.filter((c) => c[0] === 'click' && c[1] !== '#trade-button').length, 0,
    'nothing but the commit was clicked — the armed level was not toggled off');
});

// --- the failure path, which is the one that protects the position ----------

test('★ on a read-back mismatch it RESTORES the venue value and commits again', async () => {
  // The venue never moves — the only shape in which the read-back can lie.
  const { page, calls } = stubPage({ label: 'Update', before: { tp: 4129.28, stop: 4180.37 }, after: null });
  const r = await setPositionLevels(page, {}, { plus500PositionId: '1889364478' }, { stopPrice: 4150 });

  assert.equal(r.ok, false, 'an unconfirmed write is NOT a success');
  assert.equal(r.reason, 'readback_mismatch');
  assert.equal(r.restored.stopPrice, 4180.37, 'what goes back is the value read BEFORE the attempt');
  assert.equal(r.restoreOk, true);

  const commitCount = calls.filter((c) => c[0] === 'click' && c[1] === '#trade-button').length;
  assert.equal(commitCount, 2, 'the attempt, then the restore');
});
