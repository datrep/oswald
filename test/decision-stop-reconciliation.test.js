// test/decision-stop-reconciliation.test.js — 2026-09-25.
//
// ★ THE DEFECT THIS PINS, FOUND ON A LIVE DECISION CARD (Oil, 2026-09-25, chair-vetoed).
//
// The card published, side by side:
//     stopDistance: 1.3538          (= 1.4586% of 92.815 — the DECLARED 2xATR)
//     costShareOfR: 0.576, costShareCeiling: 0.65
// and those two cannot both describe that position. Oil's round trip is 17.28 bps, so
//     costShareOf(0.1728, 1.4586) = 0.1185        <- what the PUBLISHED stop implies
//     costShareOf(0.1728, 0.3000) = 0.5760        <- what the card actually reported
// The second is the CAPPED distance the venue enforces; the ratio between the two is 4.86x. So a reader who
// took the published stop and recomputed the cost share got 11.9% where the desk meant 57.6% — the record
// could support the OPPOSITE conclusion about the same trade.
//
// ⚠ AND THE CHAIR ONLY GOT IT RIGHT FROM PROSE. chair-2's veto quoted the risk note's sentence ("stop capped
// at 0.3% of price (declared 1.459%) ... venue cost 0.1728% consumes 58% of R"); the structured field beside
// it said 1.459%. A seat reasoning from the FIELD would have seen a 1.46% stop with an 11.9% cost share — a
// comfortable trade — and voted yes.
//
// WHY IT HAPPENED. `risk.js` carries BOTH distances and says so ("The risk unit the venue will actually
// enforce, and the cap's disposition — recorded, never inferred"), but `aggregator.js` published only
// `stopDistance`. `effectiveStopDistance` and `stopCap` were read by NOTHING in the codebase — a field added
// for the record and then dropped at the boundary, which is the same "computed and read by nothing" shape
// TRD-114 recorded for `costShareOfR` itself, one layer above the place it was fixed. This is the
// TRD-96/98/101/102/114 class: a number that does not mean what it says.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stopPolicy = require('../trading/agent/stopPolicy');

const aggregatorSrc = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'aggregator.js'), 'utf8');
const riskSrc = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'risk.js'), 'utf8');
// Comments are stripped: the notes LEFT IN THE CODE explain this defect and name both numbers, so a pin that
// matched raw text would pass on prose. (Four false failures in this repo have come from exactly that.)
const codeOnly = (s) => s.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
const aggCode = codeOnly(aggregatorSrc);
const riskCode = codeOnly(riskSrc);

// The live decision, to the digits the card published.
const PRICE = 92.815;
const DECLARED = 1.3538;
const ATR = 0.6769;
// The settings that produced it, and the cap path needs no database: `backtest.costCfgFor` is pure, so this
// exercises the REAL `cappedStopDistance` rather than a restatement of it.
const SETTINGS = { risk: { maxAdversePct: 0.3, maxAdverseCostMultiple: 1.5, maxCostShareOfR: 0.65 } };

test('the premise: the declared distance IS 2xATR here, so `stopDistance` alone looks self-consistent', () => {
  assert.equal(DECLARED, +(2 * ATR).toFixed(4), 'the fixture must be the declared 2xATR the card published');
});

test('★ the cap produces a DIFFERENT distance, and both are real numbers the record needs', () => {
  const cap = stopPolicy.cappedStopDistance({ declaredStopDist: DECLARED, price: PRICE, settings: SETTINGS, symbol: 'Oil' });
  assert.equal(cap.cappedBy, 'max_adverse_pct', 'the Oil cap must actually bind, or this fixture proves nothing');
  assert.equal(cap.declaredStopDist, DECLARED);
  assert.equal(cap.capPct, 0.3);
  assert.equal(cap.costPct, 0.1728, "Oil's round trip must be the 17.28 bps the card quoted");
  assert.equal(+cap.stopDist.toFixed(6), +((PRICE * 0.3) / 100).toFixed(6), 'the effective stop is the cap percentage of price');
  assert.equal(+cap.costShare.toFixed(4), 0.576, 'and this is exactly the costShareOfR the card published');
  // Non-vacuity: the two distances are far apart, so publishing the wrong one is DETECTABLE rather than academic.
  assert.ok(DECLARED / cap.stopDist > 4.8, `the two distances must differ materially (got ${(DECLARED / cap.stopDist).toFixed(2)}x)`);
});

test('★★ costShareOfR is ONLY reconcilable against the effective stop — the invariant the card violated', () => {
  const cap = stopPolicy.cappedStopDistance({ declaredStopDist: DECLARED, price: PRICE, settings: SETTINGS, symbol: 'Oil' });
  const onEffective = stopPolicy.costShareOf({ costPct: cap.costPct, stopPct: (cap.stopDist / PRICE) * 100 });
  const onDeclared = stopPolicy.costShareOf({ costPct: cap.costPct, stopPct: (DECLARED / PRICE) * 100 });

  assert.equal(+onEffective.toFixed(4), cap.costShare, 'the reported share must be the EFFECTIVE-stop share');
  assert.equal(+onEffective.toFixed(4), 0.576, 'and it must be the number the card published');
  // ★ NON-VACUITY: the declared stop gives a materially different answer, so a reader CAN tell which distance
  // a share belongs to — provided the record publishes the right one. Without this term the invariant would
  // hold no matter which distance were carried.
  assert.equal(+onDeclared.toFixed(4), 0.1185, 'the declared stop implies 11.9%, not 57.6%');
  assert.notEqual(+onDeclared.toFixed(4), +onEffective.toFixed(4));
  assert.ok(onEffective / onDeclared > 4.8, 'the misreading changes the conclusion by ~4.9x, which is why it matters');
  // And on a ceiling of 0.65 both readings PASS — the cost gate cannot distinguish them, so the record is the
  // only place the distinction can survive.
  assert.ok(+onDeclared.toFixed(4) < 0.65 && +onEffective.toFixed(4) < 0.65,
    'both readings sit under the ceiling — the gate passes either way, so nothing else would have caught this');
});

test('★ the aggregator now publishes the EFFECTIVE distance and the cap disposition, on BOTH paths', () => {
  // Counted rather than asserted once: there are two return shapes (the risk-refusal path and the approved
  // path) and a field added to one and forgotten in the other is exactly the half-applied edit this repo has
  // shipped before. The refusal path is the one that most needs auditing and it carried NO stop at all.
  const eff = (aggCode.match(/effectiveStopDistance: risk\.effectiveStopDistance \?\? null/g) || []).length;
  const stopCap = (aggCode.match(/stopCap: risk\.stopCap \|\| null/g) || []).length;
  assert.equal(eff, 2, `effectiveStopDistance must be carried on BOTH return paths (found ${eff})`);
  assert.equal(stopCap, 2, `stopCap must be carried on BOTH return paths (found ${stopCap})`);
  const declared = (aggCode.match(/stopDistance: risk\.stopDistance \|\| null/g) || []).length;
  assert.equal(declared, 2, `the declared stop must now travel on both paths too (found ${declared})`);
});

test('★ the premise in risk.js: it SIZES on the effective distance and keeps the declared only for the target', () => {
  // The aggregator can only publish what risk.js computed, so these are the producer's side of the contract.
  assert.match(riskCode, /v\.stopDistance = Math\.round\(stopDist \* 10000\) \/ 10000;/,
    'risk.js must keep carrying the DECLARED distance (the take-profit is placed at 1.5x it)');
  assert.match(riskCode, /v\.effectiveStopDistance = Math\.round\(riskStopDist \* 10000\) \/ 10000;/,
    'and the EFFECTIVE one — if this line goes, the record silently carries a null and nothing else notices');
  assert.match(riskCode, /const riskStopDist = stopCap\.cappedBy \? stopCap\.stopDist : stopDist;/,
    'and `riskStopDist` must BE the capped distance');
  // The size and the cost share must both be built on `riskStopDist`, not `stopDist`. This is the line that
  // makes `stopDistance` unusable as a risk denominator.
  assert.match(riskCode, /let size = sizeForRisk\(riskPerTrade, expectedLossDist\);/,
    // ⚠ UPDATED 2026-09-30 (TRD-EXE-10): the denominator is `expectedLossDist` now — the distance the LOSS
    // travels — which IS `riskStopDist` times the measured stop fill factor (24 venue stop-outs, median 1.305x).
    // The property this pin exists for is unchanged and is pinned in BOTH links below.
    // ⚠ UPDATED 2026-10-01 (TRD-EXE-19): the divide moved into `sizeForRisk`, which adds the contract's scale
    // (`pointValue x fx`) to the denominator. The denominator is STILL `expectedLossDist`, which is the whole
    // point of this pin, so it follows the form rather than being removed.
    'the size must divide by the distance the LOSS travels');
  // ⚠ UPDATED 2026-10-01 (TRD-EXE-13): the exit-side component is now NAMED separately, and the sizing
  // denominator composes it with the entry-drift factor. The property this pin exists for — "the EFFECTIVE
  // distance times the measured factor, never the DECLARED one" — is UNCHANGED, so both links are pinned: the
  // exit half must still be `riskStopDist x lossFactor`, and the denominator must still be built from that. It was
  // not loosened, and the blind form is now explicitly asserted absent.
  assert.match(riskCode, /const entryLossDist = riskStopDist \* lossFactor;/,
    'and that distance must be the EFFECTIVE distance times the measured factor — never the DECLARED one');
  assert.match(riskCode, /const expectedLossDist = entryLossDist \* driftFactor;/,
    'and the denominator composes it with the entry-drift factor (inert at the default of 1)');
  assert.doesNotMatch(riskCode, /expectedLossDist = stopDist \* /,
    'never the DECLARED distance — feeding the denominator the declared distance was the whole defect');
  assert.match(riskCode, /stopPct: \(riskStopDist \/ price\) \* 100, settings,/,
    'and the cost share must be taken against it too — feeding this the declared distance is the whole defect');
});
