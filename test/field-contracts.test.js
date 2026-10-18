// test/field-contracts.test.js — the contracts must not lie.
//
// A contract asserts that a value matches its LABEL, so a contract carries an ASSUMPTION about
// what the label means. Get the assumption wrong and the contract produces false failures — and
// both of these contracts did exactly that on their first run:
//   * excursions were assumed unsigned (mfePct >= 0), so ten legitimate trades were reported bad.
//     They are SIGNED: mfePct = ((favourable - open) * dir) / open * 100 (autopsy.js:53), so MFE
//     is negative for a trade that never went favourable and MAE is positive for one that never
//     went adverse.
//   * the levels were assumed anchored to the fill, so twelve arithmetically perfect levels were
//     reported bad. They are anchored to the DECISION price (TRD-37).
// These tests pin the CORRECTED semantics, and pin the two signatures the contracts exist to
// catch: the TRD-31 favourable/adverse swap, and the TRD-37 anchor drift.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { excursionViolations, levelGeometry, rrFloor, dirOf } = require('../trading/agent/fieldContracts');
const { LEVEL_RR } = require('../trading/agent/exitLevels');

// --- direction -----------------------------------------------------------------
test('dirOf reads both vocabularies, case-insensitively', () => {
  assert.equal(dirOf('buy'), 1);
  assert.equal(dirOf('BUY'), 1);
  assert.equal(dirOf('long'), 1);
  assert.equal(dirOf('sell'), -1);
  assert.equal(dirOf('short'), -1);
  assert.equal(dirOf('SHORT'), -1);
});

// --- excursion contract ---------------------------------------------------------
test('a never-favourable trade is NOT a violation (MFE may legitimately be negative)', () => {
  // #1031's real shape: the best it ever got was still a loss.
  const t = { direction: 'buy', openPrice: 100, closePrice: 99.6, mfePct: -0.2754, maePct: -0.4 };
  assert.deepEqual(excursionViolations(t), []);
});

test('a never-adverse trade is NOT a violation (MAE may legitimately be positive)', () => {
  // #1032's real shape: it never traded below the entry.
  const t = { direction: 'sell', openPrice: 100, closePrice: 99.8, mfePct: 0.2, maePct: 0.1602 };
  assert.deepEqual(excursionViolations(t), []);
});

test('the TRD-31 signature — favourable and adverse swapped — IS caught', () => {
  // The original defect: MFE held the adverse extreme and MAE the favourable one.
  const swapped = { direction: 'buy', openPrice: 100, closePrice: 101, mfePct: -1.5, maePct: 2.0 };
  assert.deepEqual(excursionViolations(swapped), ['mae_above_mfe']);
});

test('the close must lie on the sampled path', () => {
  // MFE/MAE are the extremes of the sampled path, and the close is ON that path, so the achieved
  // move cannot sit outside [MAE, MFE]. This is the invariant the closePrice-in-the-sampler fix
  // established (MFE used to read lower than the move actually achieved).
  const impossible = { direction: 'buy', openPrice: 100, closePrice: 103, mfePct: 1.0, maePct: -1.0 };
  assert.deepEqual(excursionViolations(impossible), ['achieved_outside_path']);
});

test('direction is honoured when computing the achieved move', () => {
  // A short that closed lower achieved a POSITIVE move, so it must sit inside [MAE, MFE].
  const shortWin = { direction: 'short', openPrice: 100, closePrice: 98, mfePct: 2.2, maePct: -0.3 };
  assert.deepEqual(excursionViolations(shortWin), []);
  // Same numbers read as a long would be a -2% move, which is still inside the path below.
  const shortAsLong = { direction: 'buy', openPrice: 100, closePrice: 98, mfePct: 2.2, maePct: -2.1 };
  assert.deepEqual(excursionViolations(shortAsLong), []);
  // But a long claiming a small adverse excursion while closing 2% down is impossible.
  const tooTight = { direction: 'buy', openPrice: 100, closePrice: 98, mfePct: 0.1, maePct: -0.05 };
  assert.deepEqual(excursionViolations(tooTight), ['achieved_outside_path']);
});

// --- venue-level contract -------------------------------------------------------
test('levels anchored exactly on the fill produce no bad and no drift', () => {
  // stop 99, stopDist 1 → anchor 100 = the fill, TP = 100 + 1.5 = 101.5.
  const t = { direction: 'buy', openPrice: 100, stopPrice: 99, takeProfitPrice: 101.5 };
  const g = levelGeometry(t);
  assert.deepEqual(g.bad, []);
  assert.deepEqual(g.drift, []);
  assert.equal(g.anchor, 100);
  assert.equal(g.stopDist, 1);
});

test('the TRD-37 signature — anchored off the fill — is a WARN with the realised R:R', () => {
  const t = { direction: 'buy', openPrice: 100.2, stopPrice: 99, takeProfitPrice: 101.5 };
  // ★ TRD-GEO-1 (2026-09-25): the anchor must now be OBSERVED, not inferred from the levels themselves.
  // Without `anchorPrice` the drift is REFUSED rather than derived — see the refusal test below. Here the
  // decision price was 100 and the venue filled at 100.2.
  const g = levelGeometry(t, { anchorPrice: 100 });
  assert.deepEqual(g.bad, [], 'an off-fill anchor is not a violation: the arithmetic is exact');
  assert.equal(g.drift.length, 1);
  assert.equal(g.drift[0].code, 'anchored_off_fill');
  assert.equal(g.drift[0].anchorSource, 'observed');
  assert.ok(g.drift[0].pct < 0, 'a fill above the anchor is a negative drift');
  // realised R:R = |TP - fill| / |fill - stop| = 1.3 / 1.2
  assert.ok(Math.abs(g.drift[0].realisedRR - 1.3 / 1.2) < 1e-9);
});

// --- TRD-GEO-1: the derivation is a DEFINITION, not a measurement -----------------

test('★ an unobserved anchor REFUSES the drift instead of inventing one', () => {
  const t = { direction: 'buy', openPrice: 100.2, stopPrice: 99, takeProfitPrice: 101.5 };
  const g = levelGeometry(t);
  assert.deepEqual(g.drift, [], 'no drift number may be emitted from an anchor derived from these levels');
  assert.strictEqual(g.unmeasurable.length, 1);
  assert.strictEqual(g.unmeasurable[0].code, 'drift_unmeasurable');
  assert.strictEqual(g.unmeasurable[0].reason, 'anchor_not_observed');
  assert.strictEqual(g.anchorSource, 'derived_from_levels');
  // The derived value is still returned for callers that need it — it is labelled, not removed.
  assert.strictEqual(g.anchor, 100);
});

test('★★ THE DEMONSTRATION, on a real ticket: the derived anchor invents a drift that is not there', () => {
  // Trade 1094, Oil buy — the entry that closed "Loss call" and produced the 09-24 equity cliff. The cap
  // fired (`stop_capped`: declared 1.1966 -> 0.2857, effectiveRR 6.282), so the span is
  // `cappedStopDist + LEVEL_RR x declared` and the level-derived anchor is nowhere near the truth.
  const t1094 = { direction: 'buy', openPrice: 95.24, stopPrice: 94.9493, takeProfitPrice: 97.0299 };
  const observed = 95.235;   // entry_reanchored.decisionPrice
  const derived = levelGeometry(t1094);
  const truth = levelGeometry(t1094, { anchorPrice: observed });
  // The derivation produces an anchor ~0.57% away from the fill — MORE THAN ELEVEN TIMES the 0.05% WARN
  // band, i.e. a phantom "anchored off the fill" warning on a ticket that was anchored almost perfectly.
  assert.strictEqual(derived.anchorSource, 'derived_from_levels');
  assert.ok(Math.abs(derived.anchor - 95.78154) < 0.001, `derived anchor ${derived.anchor}`);
  // The truth is a hundredth of the band, so it correctly does NOT warn.
  assert.strictEqual(truth.anchorSource, 'observed');
  assert.deepEqual(truth.drift, [], 'the real drift is 0.005%, well inside the band');
  assert.ok(Number.isFinite(truth.anchor) && Math.abs(truth.anchor - observed) < 1e-9);
});

test('an absent anchor price is not coerced into an anchor at ZERO', () => {
  const t = { direction: 'buy', openPrice: 100, stopPrice: 99, takeProfitPrice: 101.5 };
  for (const bad of [null, undefined, '', 0, -1, 'nonsense']) {
    const g = levelGeometry(t, { anchorPrice: bad });
    assert.strictEqual(g.anchorSource, 'derived_from_levels', `anchorPrice=${JSON.stringify(bad)} must not be read as an anchor`);
    assert.deepEqual(g.drift, [], 'a drift of -100% would be a confident, completely wrong claim');
  }
});

test('the floor still uses the FILL, so it is independent of the anchor question', () => {
  // `realisedRR` is measured from the fill against absolute levels, so TRD-GEO-1 does not touch it: a
  // ticket below the floor is still reported even when no anchor was observed.
  const t = { direction: 'sell', openPrice: 95.8, stopPrice: 98.7198, takeProfitPrice: 95.1578 };
  const g = levelGeometry(t, { floor: rrFloor({}) });
  assert.strictEqual(g.belowFloor.length, 1, 'the F20 floor must keep working without an observed anchor');
  assert.ok(g.belowFloor[0].rr < rrFloor({}));
});

test('★ the health check names the rows it did NOT measure, in every branch that reports a count', () => {
  // Verified live 2026-09-25: the check returned "11/30 measured row(s)" while 20 further rows had no
  // observed anchor. Reporting 11/30 alone invites reading 30 as the sample when it is only the measurable
  // part of it — which is the same absent-measurement-reads-as-clean failure this task is about.
  const src = require('./_source').code('trading/agent/fieldContracts.js');
  const g = src.slice(src.indexOf('async function venueLevelGeometry'), src.indexOf('// --- 4. a "backtest win rate"'));
  assert.ok(g.length > 500, 'the slice must not be empty');
  assert.match(g, /had no observed anchor and were NOT measured/, 'the drift branch must name the gap');
  // ⚠ THE BINDING IS `live.unmeasurable` SINCE THE EPOCH SCOPE (2026-09-28): the same rule is now applied to
  // two populations (the live window and the pre-epoch residue), so the counts are read off a measured result
  // rather than loose locals. The ASSERTION is unchanged — a count of rows that were not measured has to be
  // stated — only the name it reaches for moved with the refactor.
  assert.match(g, /the drift was NOT measured for \$\{live\.unmeasurable\}/, 'and so must the refusal branch');
  assert.match(g, /PRE-EPOCH row\(s\) \(opened before \$\{String\(since\)\.slice\(0, 10\)\}\) are EXCLUDED/,
    'and so must the epoch exclusion, in EVERY verdict that carries a count');
  assert.match(g, /OUTER APPLY/, 'the anchor must be READ from the recorded event, not derived');
  assert.match(g, /kind = 'entry_reanchored'/, 'and this is the event that records it');
});

test('levels on the wrong side of the fill are caught, for both directions', () => {
  const longBad = { direction: 'buy', openPrice: 100, stopPrice: 101, takeProfitPrice: 102.5 };
  assert.ok(levelGeometry(longBad).bad.includes('long_levels_bad_side'));
  const shortBad = { direction: 'sell', openPrice: 100, stopPrice: 99, takeProfitPrice: 97.5 };
  assert.ok(levelGeometry(shortBad).bad.includes('short_levels_bad_side'));
});

test('a short is mirrored correctly', () => {
  // stop above, TP below, anchored on the fill.
  const t = { direction: 'sell', openPrice: 100, stopPrice: 101, takeProfitPrice: 98.5 };
  const g = levelGeometry(t);
  assert.deepEqual(g.bad, []);
  assert.deepEqual(g.drift, []);
  assert.equal(g.anchor, 100);
});

test('the R:R ratio is NOT asserted, because deriving the anchor makes it a tautology', () => {
  // Any geometry satisfies tpDist/stopDist === LEVEL_RR when stopDist is DEFINED as
  // span/(1+LEVEL_RR). This test exists to stop anyone re-adding that assertion: a check that
  // cannot fail is worse than no check, because it reads as coverage.
  const arbitrary = { direction: 'buy', openPrice: 100, stopPrice: 99.99, takeProfitPrice: 100.02 };
  assert.deepEqual(levelGeometry(arbitrary).bad, [], 'no geometry can fail the ratio check');
});

// --- F20: the realised-R:R floor (2026-09-18) -----------------------------------
//
// The audit found the LIVE position carrying 0.22 R:R against a declared 1.5 — a sell that filled 1.56%
// away from its anchor, which left a 3.05% stop and a 0.67% target. The geometry was arithmetically exact
// and the drift was already reported... as a `warn`, unread, since TRD-37. A `warn` says "the anchor moved";
// the floor says "this position is not the one the desk decided on", which is the part that costs money.
test('the floor is a FRACTION of the declared R:R, so it cannot drift away from LEVEL_RR', () => {
  assert.equal(rrFloor({}), LEVEL_RR * 0.5, 'unset = half the declared ratio');
  assert.equal(rrFloor({ risk: { minRealisedRrPct: 80 } }), LEVEL_RR * 0.8);
  assert.equal(rrFloor({ risk: { minRealisedRrPct: 0 } }), 0, 'zero means the owner accepted the drift: floor disabled');
  assert.equal(rrFloor({ risk: { minRealisedRrPct: 'nonsense' } }), LEVEL_RR * 0.5, 'a malformed setting falls back, never to an accidental zero');
});

test('#1046 — the live position that produced F20 — is BELOW the floor', () => {
  // The audit's own numbers: Oil sell, fill 95.80, stop 98.7198, TP 95.1578.
  const t = { id: 1046, direction: 'sell', openPrice: 95.80, stopPrice: 98.7198, takeProfitPrice: 95.1578 };
  const g = levelGeometry(t, { floor: rrFloor({}) });

  assert.ok(g.belowFloor.length === 1, 'it must be named');
  assert.equal(g.belowFloor[0].code, 'realised_rr_below_floor');
  assert.ok(Math.abs(g.belowFloor[0].rr - 0.22) < 0.005, `realised R:R ${g.belowFloor[0].rr} must match the audit's 0.22`);
  assert.equal(g.belowFloor[0].floor, 0.75, 'against the 50% default floor');
});

test('a position that got the geometry it was promised is NOT below the floor', () => {
  const t = { direction: 'buy', openPrice: 100, stopPrice: 99, takeProfitPrice: 101.5 };
  const g = levelGeometry(t, { floor: rrFloor({}) });
  assert.deepEqual(g.belowFloor, [], '1.5R against a 0.75 floor');
  assert.equal(g.realised.rr, 1.5, 'and the realised ratio is measured from the fill, independently of the drift gate');
});

test('a stop on the WRONG SIDE of the fill is the worst case, not an exemption', () => {
  // realisedRR returns rr:null when stopDist is not positive. A position whose stop the market has already
  // passed is the case most worth naming, so `null` must land below the floor rather than outside the check.
  const t = { direction: 'buy', openPrice: 100, stopPrice: 100.5, takeProfitPrice: 100.75 };
  const g = levelGeometry(t, { floor: rrFloor({}) });
  assert.equal(g.belowFloor.length, 1, 'unmeasurable risk is below any floor');
  assert.equal(g.belowFloor[0].rr, null);
});

test('a disabled floor reports nothing, as the owner asked', () => {
  const t = { id: 1046, direction: 'sell', openPrice: 95.80, stopPrice: 98.7198, takeProfitPrice: 95.1578 };
  assert.deepEqual(levelGeometry(t, { floor: rrFloor({ risk: { minRealisedRrPct: 0 } }) }).belowFloor, []);
});

test('the health run passes the settings through, so the floor is the owner\'s', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'trading/agent/selfHealth.js'), 'utf8');
  assert.match(src, /runAll\(userId, \{ settings \}\)/, 'without settings the contract can only use the default floor');
});

// --- 2026-09-30: the breach carries its CAUSE -----------------------------------
//
// `field_levels` was standing red on `#1125` (Sugar sell, realised R:R 0.652 against the 0.75 floor) and the
// message said only "below the floor". The desk's geometry was correct: at the decision the ticket carried
// stopDist 0.0962 and a 1.425R target (1.5R less the owner's 5% TP offset). The VENUE filled 0.045 away,
// and because the entry re-anchor cannot see the fill (TRD-ANC-1: the venue tick series is frozen during an
// entry, 0 available ticks in 30 of 30) the levels were not moved, so the realised risk became 0.1412.
//
// That distinction decides the response - a mis-built ticket means fixing the builder, a fill-drift breach
// means the levels/venue path - so the branch that fires now names which one it is.
test('#1125 — a below-floor row reports the fill drift that explains it', () => {
  // The real numbers: anchor (decision price) 18.565, fill 18.52, stop 18.6612, TP 18.4279.
  const t = { id: 1125, direction: 'sell', openPrice: 18.52, stopPrice: 18.6612, takeProfitPrice: 18.4279, decisionPrice: 18.565 };
  const g = levelGeometry(t, { floor: rrFloor({}), anchorPrice: t.decisionPrice });

  assert.equal(g.belowFloor.length, 1);
  const f = g.belowFloor[0];
  assert.ok(Math.abs(f.rr - 0.6523) < 0.001, `realised R:R ${f.rr} must be the recorded 0.6523`);
  assert.equal(f.anchorSource, 'observed', 'the breach is attributed to an OBSERVED anchor, not a derived one');
  assert.ok(Math.abs(f.fillDriftPct - 0.243) < 0.01, `the fill landed ${f.fillDriftPct}% from the anchor - the recorded driftPct was 0.242392`);
  // The drift is a MAGNITUDE: the sign of a price move flips with direction, and this repo has got that
  // sign wrong twice (see exitLevels' own note). A negative here would be the third time.
  assert.ok(f.fillDriftPct > 0, 'reported positive regardless of direction');
});

test('an UNOBSERVED anchor is reported as unmeasured, never as a zero drift', () => {
  // #1046's shape: no `entry_reanchored` event, so there is no observed anchor. A drift derived from the
  // levels under test is wrong by a multiple on capped tickets (TRD-GEO-1), so the honest answer is null -
  // and `Number(null) === 0` must not turn "not measured" into "no drift".
  const t = { id: 1046, direction: 'sell', openPrice: 95.80, stopPrice: 98.7198, takeProfitPrice: 95.1578 };
  const f = levelGeometry(t, { floor: rrFloor({}) }).belowFloor[0];
  assert.equal(f.fillDriftPct, null, 'not measured is null, not 0');
  assert.equal(f.anchorSource, 'derived_from_levels');
});

test('a clean ticket that is NOT below the floor reports no drift either way (non-vacuity)', () => {
  const t = { direction: 'buy', openPrice: 100, stopPrice: 99, takeProfitPrice: 101.5, decisionPrice: 100 };
  const g = levelGeometry(t, { floor: rrFloor({}), anchorPrice: t.decisionPrice });
  assert.deepEqual(g.belowFloor, [], 'the attribution must not manufacture a breach');
});

test('the drift is measured from the FILL, so the same ticket with a better fill clears the floor', () => {
  // Only the fill changes; the levels and the anchor are identical. This is the whole claim of the branch:
  // on this desk the breach is a fill fact, not a level fact.
  const levels = { stopPrice: 18.6612, takeProfitPrice: 18.4279, decisionPrice: 18.565 };
  const bad = levelGeometry({ id: 1, direction: 'sell', openPrice: 18.52, ...levels }, { floor: rrFloor({}), anchorPrice: levels.decisionPrice });
  const good = levelGeometry({ id: 2, direction: 'sell', openPrice: 18.565, ...levels }, { floor: rrFloor({}), anchorPrice: levels.decisionPrice });
  assert.equal(bad.belowFloor.length, 1, 'filled 0.045 away: below the floor');
  assert.deepEqual(good.belowFloor, [], 'filled ON the anchor: the same levels are a 1.425R ticket');
  assert.ok(good.realised.rr > 1.4, `and the realised ratio is ${good.realised.rr}`);
});
