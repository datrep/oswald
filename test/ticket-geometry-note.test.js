// test/ticket-geometry-note.test.js — the note that tells a seat what the cap did to ITS ticket.
//
// WHY THIS IS THE HIGHEST-RISK STRING IN THE PROMPT. It is derived arithmetic stated in prose to a voter, and the
// desk has already shipped a card that published the DECLARED stop beside a cost share computed on the CAPPED one
// — a 4.86x error (TRD-RSK-1). A note that misstates the reward:risk is that same defect with a reader who acts
// on it. So the central assertion here is a CROSS-CHECK: the R the note claims must equal what the real
// `exitLevels.entryLevels` returns for the identical geometry, rather than a second derivation that happens to
// agree today.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const agg = require('../trading/agent/aggregator');
const { entryLevels } = require('../trading/agent/exitLevels');
const { code } = require('./_source');

const PRICE = 100;
const DECLARED_PCT = 0.702;          // the owner's own ticket
const ATR14 = PRICE * DECLARED_PCT / 100 / 2;   // a 2xATR declared stop

// Build the risk object the way `risk.evaluate` does, straight from `entryLevels`, so the note is fed the
// engine's own numbers.
//
// ⚠ THE KEYS HERE ARE `risk.js`'S, AND THAT IS NOT A DETAIL — it is the fix. Until 2026-09-29 this fixture
// invented `pct` / `floor` / `note`, and production stores `capPct` and (until the same day) no `floor` at all.
// So the two seat-facing branches below were CORRECT ONLY AGAINST A SHAPE THAT NEVER EXISTED: the test certified
// a clause that could not fire, and it passed every time. See the writer pin at the bottom of this file.
function riskFor(capPct) {
  const lv = entryLevels({ direction: 'buy', atr14: ATR14, price: PRICE, stopDistance: PRICE * DECLARED_PCT / 100, maxAdversePct: capPct });
  const truncated = lv.stopDist < PRICE * DECLARED_PCT / 100;
  return {
    stopDistance: PRICE * DECLARED_PCT / 100,
    effectiveStopDistance: lv.stopDist,
    effectiveRR: lv.effectiveRR,
    // null when the cap does NOT act — the `stopCap.cappedBy` convention, which `risk.js` mirrors exactly.
    stopCap: truncated
      ? {
        cappedBy: 'max_adverse_pct', capPct, costPct: 0.1936, costShare: 0.6453,
        ceiling: 0.65, ceilingFrom: 'maxCostShareOfR', floor: 0.1936 * 1.5,
      }
      : null,
    costShareOfR: 0.6453,
    costShareCeiling: 0.65,
  };
}

test('★ the R the note claims EQUALS what exitLevels returns for the same geometry', () => {
  const risk = riskFor(0.3);
  const note = agg.ticketGeometryNote(risk, { price: PRICE }, { risk: { maxAdverseCostMultiple: 1.5 } });
  // The engine's own answer for this ticket: a 0.702% declared stop capped to 0.30%.
  assert.strictEqual(risk.effectiveRR, 3.51, 'precondition: exitLevels says 3.51R for this geometry');
  assert.match(note, /3\.51R/, `the note must state the engine's own ${risk.effectiveRR}R, got: ${note}`);
  assert.match(note, /TRUNCATED/);
  assert.match(note, /declared stop 0\.7020% of price/);
  assert.match(note, /venue stop 0\.3000% of price/);
});

test('a cap that is not binding makes NO reward:risk claim at all', () => {
  // Cap above the declared stop: the engine leaves the declared distance alone.
  const risk = riskFor(1.5);
  const note = agg.ticketGeometryNote(risk, { price: PRICE }, { risk: {} });
  assert.match(note, /cap not binding/);
  assert.ok(!/\d+\.\d\dR/.test(note), `no R factor may be stated when nothing was truncated, got: ${note}`);
  assert.ok(!/TRUNCATED/.test(note));
});

test('the cost share and the two-rule floor travel with the note', () => {
  const note = agg.ticketGeometryNote(riskFor(0.3), { price: PRICE }, { risk: { maxAdverseCostMultiple: 1.5 } });
  assert.match(note, /cost share of R 0\.6453 against the 0\.65 ceiling/);
  assert.match(note, /1\.5x the 0\.1936% round trip/);
  // And when the share is OVER the ceiling it must SAY SO — that is the refusal the owner could not see.
  const over = agg.ticketGeometryNote({ ...riskFor(0.3), costShareOfR: 0.8333 }, { price: PRICE }, { risk: {} });
  assert.match(over, /OVER, so this ticket is refused on cost/);
});

test('a missing price drops the percentages rather than inventing them', () => {
  const note = agg.ticketGeometryNote(riskFor(0.3), { price: null }, { risk: {} });
  assert.ok(!/% of price/.test(note), 'no percentage can be computed without a price');
  assert.match(note, /cost share of R/, 'the cost share needs no price and must survive');
});

test('an empty risk result produces NO text rather than a dangling heading', () => {
  for (const r of [null, undefined, {}, { stopDistance: null }, 0]) {
    assert.strictEqual(agg.ticketGeometryNote(r, { price: PRICE }, {}), '', `ticketGeometryNote(${JSON.stringify(r)}) must be empty`);
  }
});

// Non-vacuity: the note must be a function of the numbers, not a template. Two different caps must produce two
// different claims — otherwise every assertion above would pass on a constant string.
test('the note is derived from the geometry, not from a constant', () => {
  const a = agg.ticketGeometryNote(riskFor(0.3), { price: PRICE }, { risk: {} });
  const b = agg.ticketGeometryNote(riskFor(0.5), { price: PRICE }, { risk: {} });
  assert.notStrictEqual(a, b);
  assert.match(a, /3\.51R/);
  assert.match(b, /2\.11R/, 'a 0.5% cap leaves a different R, and the note must follow it');
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The pins that stop the blind spot recurring. A FIXTURE IS A CLAIM ABOUT A WRITER, and the writer lives in
// another file — so the claim has to be checked against it, or the test certifies a shape that never ships.
// ────────────────────────────────────────────────────────────────────────────────────────────────

test('★ THE FIXTURE MIRRORS THE WRITER — the keys `risk.js` stores on `v.stopCap`', () => {
  const src = code('trading/agent/risk.js');
  const start = src.indexOf('v.stopCap = stopCap.cappedBy');
  assert.ok(start > 0, 'the writer must be findable, or this pin is blind');
  const body = src.slice(start);
  const keys = [...body.slice(0, body.indexOf('}')).matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
  for (const k of ['cappedBy', 'capPct', 'costPct', 'costShare', 'ceiling', 'ceilingFrom', 'floor']) {
    assert.ok(keys.includes(k), `risk.js must carry ${k} on v.stopCap — the note and this fixture both read it`);
  }
  assert.ok(!keys.includes('pct'), 'and must NOT carry a bare `pct` — that key was the fiction the note read');
  assert.ok(!keys.includes('note'),
    'nor `note`: stopPolicy attaches it only on the REFUSAL path, where cappedBy is null and v.stopCap is null');
});

test('★ THE NOTE READS WHAT PRODUCTION STORES — `capPct`, and never `cap.pct`', () => {
  const src = code('trading/agent/aggregator.js');
  assert.ok(!/[^\w]cap\.pct[^\w]/.test(src),
    '`cap.pct` is never written by risk.js, so a clause reading it is dead — that was the defect');
  assert.match(src, /cap\.capPct/, 'the truncation and floor clauses must read the real key');
  // And the floor clause must be reachable at all, which requires BOTH keys it gates on.
  assert.match(src, /cap\.floor != null && cap\.capPct != null/);
});
