// test/excursion-exit.test.js — TRD-EXI-2 prototype: the adverse-excursion cut, observe-only.
//
// THE HYPOTHESIS AND ITS EVIDENCE. A position that has travelled 0.6 of the way to its own stop rarely recovers,
// so cutting there costs less than running to the stop. Measured retroactively over the 113 closed trades that
// carry a stop and a P&L (2026-10-01):
//
//     threshold 0.50 ->  -10.07 S$   (fires on 41, 11 winners)   <- the MORE aggressive cut LOSES
//     threshold 0.60 ->  +65.79 S$   (fires on 34,  4 winners)   <- the peak
//     threshold 0.70 ->  +36.07 S$   (fires on 31,  3 winners)
//
// WHAT IS PINNED AND WHY. The arithmetic, the refusal on unusable rows, the fact that it is denominated by the
// trade's OWN stop rather than by a fixed percentage of price (a fixed band and a per-trade stop disagree, and
// that disagreement IS the defect class this desk keeps finding), and that nothing in the close path acts on it.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { code, read } = require('./_source');
const { excursionFraction, EXCURSION_THRESHOLD } = require('../trading/agent/autopsy');

const AUTOPSY = 'trading/agent/autopsy.js';

test('the fraction is the adverse excursion divided by the trade OWN stop distance', () => {
  // Silver #1160: entry 60.115, stop 60.6159 (0.833% away), mae -0.7103% -> 0.853 of the stop.
  const r = excursionFraction({ entry: 60.115, stopPrice: 60.6159, maePct: -0.7103 });
  assert.equal(r.excursionStopDistPct, 0.833236, 'the stop distance as a percentage of price');
  assert.equal(r.excursionFraction, 0.8525, 'and the excursion as a fraction of it');
  assert.equal(r.excursionWouldCut, true);
  // Oil #1157: entry 91.91, stop 90.697, mae -1.1098% -> 0.8409 of the stop, i.e. cut well before the stop that
  // the executor was holding for. Recorded 2026-10-01 as the largest loss of the night (-18.73).
  const oil = excursionFraction({ entry: 91.91, stopPrice: 90.697, maePct: -1.1098 });
  assert.equal(oil.excursionFraction, 0.8409);
  assert.equal(oil.excursionWouldCut, true, 'a trade that sat past 0.8 of its stop cuts');
  // ⚠ A FULL STOP-OUT IS 1.0, NOT "OVER THE THRESHOLD" IN A DIFFERENT UNIT: the denominator is the same stop.
  const stopOut = excursionFraction({ entry: 100, stopPrice: 98, maePct: -2 });
  assert.equal(stopOut.excursionFraction, 1);
  assert.equal(stopOut.excursionWouldCut, true);
  // and past it, for the rows where the venue filled through the level
  assert.equal(excursionFraction({ entry: 100, stopPrice: 98, maePct: -2.2 }).excursionFraction, 1.1);
});

test('★★ the threshold is 0.6 because 0.5 and 0.7 were both measured WORSE', () => {
  assert.equal(EXCURSION_THRESHOLD, 0.6);
  // the boundary is inclusive at the threshold and exclusive just under it, so "0.6" means 0.6
  assert.equal(excursionFraction({ entry: 100, stopPrice: 98, maePct: -1.2 }).excursionWouldCut, true);
  assert.equal(excursionFraction({ entry: 100, stopPrice: 98, maePct: -1.19 }).excursionWouldCut, false);
});

test('a WINNER that never went 0.6 of the way is untouched — the cost of the rule is what it cuts', () => {
  // #1152 Oil, a +20.54 winner: mae -0.64%, stop distance 1.151% -> 0.556, under the line
  const w = excursionFraction({ entry: 90.62, stopPrice: 89.5774, maePct: -0.64 });
  assert.equal(w.excursionFraction, 0.5563);
  assert.equal(w.excursionWouldCut, false, 'a winner that dipped 0.56 of the way must NOT be cut');
  // #1155 Silver winner: mae -0.2408, stop 0.990 -> 0.2432
  assert.equal(excursionFraction({ entry: 60.637, stopPrice: 61.2374, maePct: -0.2408 }).excursionWouldCut, false);
  // ⚠ AND THE FOUR WINNERS THE RULE WOULD HAVE CUT ARE REAL, not hypothetical — the rule is not free.
  // #1124 Silver: mae -1.345% against a stop 1.897% away -> 0.709, and it closed +5.24.
  assert.equal(excursionFraction({ entry: 63.765, stopPrice: 64.975, maePct: -1.345 }).excursionWouldCut, true);
});

test('an unusable row refuses — never a confident fraction from a missing value', () => {
  // ⚠ `Number(null)` IS 0, so a missing MAE would otherwise read as "never went adverse" and a missing STOP as a
  // zero-denominator. Both must refuse, and the distinction matters: "no excursion" and "we cannot tell" are
  // different answers and only one of them is safe to act on.
  for (const bad of [
    { entry: 100, stopPrice: 98, maePct: null },
    { entry: 100, stopPrice: null, maePct: -1 },
    { entry: null, stopPrice: 98, maePct: -1 },
    { entry: 100, stopPrice: 100, maePct: -1 },   // zero R -> no denominator
    { entry: 0, stopPrice: 98, maePct: -1 },      // no price
    { entry: 100, stopPrice: 98, maePct: '' },
    {},
  ]) {
    const r = excursionFraction(bad);
    assert.equal(r.excursionFraction, null, `${JSON.stringify(bad)} must refuse`);
    assert.equal(r.excursionWouldCut, null, 'and must not answer a boolean either');
  }
  // a favourable-only excursion is 0, which is a REAL reading and not a refusal
  assert.equal(excursionFraction({ entry: 100, stopPrice: 98, maePct: 0 }).excursionFraction, 0);
  assert.equal(excursionFraction({ entry: 100, stopPrice: 98, maePct: 0 }).excursionWouldCut, false);
});

test('★★ it is OBSERVE-ONLY: the close path records it and nothing acts on it', () => {
  const src = code(AUTOPSY);
  // it lands on the diagnosis (the event-only channel TRD-EXI-1 established), beside the close classification
  assert.match(src, /Object\.assign\(diagnosis, excursionFraction\(\{/, 'recorded on the diagnosis');
  assert.match(src, /excursionFraction, EXCURSION_THRESHOLD,/, 'and exported so a test can pin the arithmetic');
  // ⚠ THE PIN THAT MATTERS: no exit decision may read it. If this ever appears in a close/exit decision path,
  // the rule has stopped being a measurement and become a posture change nobody signed for.
  assert.ok(!/excursionWouldCut\s*\)\s*\{?\s*$/.test(src.replace(/\n/g, ' ')), 'not used as a branch');
  assert.ok(!/if\s*\([^)]*excursionFraction/.test(src), 'no branch on the fraction anywhere in this module');
  // and it is NOT a Trades column - TRD-OPT-2 owns that schema. Checked as a COLUMN DEFINITION rather than by
  // grepping the word, which also appears in the existing prose about adverse excursion beside maePct.
  const schema = read('sql/schema/DB_init_table.sql');
  assert.ok(!/^\s*[A-Za-z]*excursion[A-Za-z]*\s+(NVARCHAR|DECIMAL|FLOAT|INT|DATETIME|BIT|BIGINT)/im.test(schema),
    'no schema COLUMN for it — the prototype must stay on the event channel');
});
