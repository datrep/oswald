// test/quant-proximity.test.js — `candidateProximity` (owner ask 2026-09-15).
//
// The ask, verbatim: *"could we show how close the proposed strategies are to the decisions, instead of a
// 'no strategy in scope for this symbol', like you dont know how close it is..."*
//
// Before this, a symbol with nothing in scope produced ONE line — "no strategy in scope for this symbol" —
// which is a dead end that reads like a fault. The desk had every number it needed (donchian bands, ADX,
// MACD, RSI) and never looked. Now the line carries distance-to-trigger for the strategies that COULD be
// scoped. Three things must hold, and each of them broke at least once while building this:
//
//   1. TRD-56 IS NOT VIOLATED. The `candidates —` clause is produced ONLY when nothing is in scope, and it
//      is clearly separated from the reason nothing fired. (test/flat-scope.test.js still owns that rule;
//      the structural check at the bottom of this file pins this half of it.)
//   2. THE NUMBERS ARE REAL. Bands are computed from the strategy's OWN period and attributed to THAT
//      strategy — the first version read `out.donchian` (empty on this path, because nothing ran) and then
//      printed a DC30 band under the DC20 strategies' names.
//   3. THE SENTENCE IS HONEST. A trigger that has ALREADY fired is reported as met, not as a negative
//      distance ("-13.23 below 30 to buy" was the live output on SGX), and a gate that would silently
//      discard the trigger is stated BEFORE the trigger's distance.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { candidateProximity, PROX_CLAUSE_LIMIT } = require('../trading/agent/quant');
const { code } = require('./_source');

const QUANT = code('trading/agent/quant.js');

// A ramp that repeats every 5 bars, so ANY window of >= 5 has high 105 / low 99. That keeps the expected
// donchian numbers something a reader can verify by eye instead of a fixture nobody can check.
const HIGHS = Array.from({ length: 60 }, (_, i) => 101 + (i % 5));
const LOWS = Array.from({ length: 60 }, (_, i) => 99 + (i % 5));

// `closes: []` on purpose: with no bars the mean-rev block falls back to `indicators.rsi`, which the tests
// set explicitly. Percentages come out exact, so the assertions are about the SENTENCE rather than about
// feeding an RSI its own fixture.
const ctx = (over = {}) => ({
  price: 100,
  adx14: 30,
  indicators: { rsi: 50, macd: { line: 0.1, signal: 0.05 } },
  highs: HIGHS,
  lows: LOWS,
  closes: [],
  regime: 'range',
  settings: {},
  symbol: 'Silver',
  ...over,
});

test('PROXIMITY: no candidates means no line (nothing to be close to)', () => {
  assert.strictEqual(candidateProximity([], ctx()), null);
  assert.strictEqual(candidateProximity(null, ctx()), null);
  assert.strictEqual(candidateProximity(undefined, ctx()), null);
});

test('PROXIMITY: a candidate list with no price cannot be measured', () => {
  assert.strictEqual(candidateProximity(['turtle'], ctx({ price: null })), null);
  assert.strictEqual(candidateProximity(['turtle'], ctx({ price: undefined })), null);
  assert.strictEqual(candidateProximity(['turtle'], ctx({ price: 'abc' })), null);
});

test('PROXIMITY: ids that own no gate produce nothing rather than an empty clause', () => {
  // 'congress' is GATELESS; an unknown id is not in any owner list. Neither may produce "candidates — ".
  assert.strictEqual(candidateProximity(['congress'], ctx()), null);
  assert.strictEqual(candidateProximity(['not-a-strategy'], ctx()), null);
});

test('PROXIMITY: the donchian band is measured from the current price, signed', () => {
  const out = candidateProximity(['turtle'], ctx());
  assert.strictEqual(out, 'candidates — turtle: DC20 break 99.00 (-1.00%) or 105.00 (+5.00%)');
});

test('PROXIMITY: the ADX gate is stated BEFORE the band it gates', () => {
  const out = candidateProximity(['turtle'], ctx({ adx14: 16.83 }));
  assert.match(out, /^candidates — need ADX > 20 \(now 16\.83\) · turtle: DC20 break/);
  // Silver's live case: the band is 0.39% away and the breakout still cannot fire. Stating the band alone
  // would advertise a trigger that the desk's own locked spec forbids.
  assert.ok(out.indexOf('need ADX') < out.indexOf('DC20'), 'the gate must precede the distance');
});

test('PROXIMITY: ADX above the gate does not produce a gate clause', () => {
  assert.ok(!candidateProximity(['turtle'], ctx({ adx14: 30 })).includes('need ADX'));
  // 20 is the boundary: the gate is `<= 20` closes it, so exactly 20 must still be reported as closed.
  assert.match(candidateProximity(['turtle'], ctx({ adx14: 20 })), /need ADX > 20 \(now 20\.00\)/);
});

test('PROXIMITY: a band is attributed to the strategies that use THAT period', () => {
  // mtftrend is donchianPeriod 30. In the first version the DC30 band was printed under the DC20 owner
  // names, because the dedupe kept the period and the owner list in separate structures. The spike is at
  // index 35 on purpose: inside DC30's window (30..59) and OUTSIDE DC20's (40..59), so the two bands are
  // genuinely different and a merged line would be visibly wrong rather than accidentally right.
  const spiked = HIGHS.map((h, i) => (i === 35 ? h + 10 : h));
  const out = candidateProximity(['turtle', 'mtftrend'], ctx({ highs: spiked }));
  assert.match(out, /turtle: DC20 break 99\.00 \(-1\.00%\) or 105\.00 \(\+5\.00%\)/);
  assert.match(out, /mtftrend: DC30 break 99\.00 \(-1\.00%\) or 111\.00 \(\+11\.00%\)/);
});

test('PROXIMITY: identical bands are deduped and their periods merged', () => {
  const out = candidateProximity(['turtle', 'mtftrend'], ctx());
  assert.strictEqual(out.match(/break/g).length, 1, `identical bands must appear once, got: ${out}`);
  assert.match(out, /turtle\/mtftrend: DC20\/30 break 99\.00 \(-1\.00%\) or 105\.00 \(\+5\.00%\)/);
});

test('PROXIMITY: the band follows the strategy params, not a hardcoded 20', () => {
  const settings = { strategies: { symbolParams: { Silver: { turtle: { donchianPeriod: 5 } } } } };
  const out = candidateProximity(['turtle'], ctx({ settings }));
  assert.match(out, /turtle: DC5 break/);
});

test('PROXIMITY: a regime that would discard the trigger is stated before the trigger', () => {
  const out = candidateProximity(['meanrev'], ctx({ regime: 'trend', adx14: 27.21 }));
  assert.match(out, /meanrev need regime range \(now trend, ADX 27\.21 vs 25\) · meanrev RSI\(14\)/);
  assert.ok(out.indexOf('need regime range') < out.indexOf('RSI('), 'the gate must precede the number');
});

test('PROXIMITY: a META regime is never attributed to the ticker own ADX', () => {
  // THE DASHBOARD DEFECT, 2026-09-15. Silver read:
  //   "meanrev/rsi2/squeezerev need regime range (now trend, ADX 16.83)"
  // `trend` came from the desk-global meta verdict, which `meta.js` derives from the FIRST watchlist
  // symbol that has bars — Bitcoin — while 16.83 was SILVER's ADX. A global judgement printed as a local
  // measurement, and self-contradicting: 16.83 is nowhere near the 25 that makes a trend. The regime that
  // gates mean-rev is the meta one, so that is the number that has to appear beside it.
  const out = candidateProximity(['meanrev'], ctx({
    adx14: 16.83,
    regimeBasis: { regime: 'trend', adx: 27.16, symbol: 'Bitcoin', meta: true },
  }));
  assert.match(out, /need regime range \(now trend on Bitcoin, ADX 27\.16 vs 25\)/);
  assert.ok(!out.includes('16.83'), `the ticker ADX must not stand in for the meta one: ${out}`);
});

test('PROXIMITY: a meta regime without an ADX prints none, rather than borrowing one', () => {
  const out = candidateProximity(['meanrev'], ctx({
    adx14: 61.94,
    regimeBasis: { regime: 'trend', adx: null, symbol: 'Bitcoin', meta: true },
  }));
  assert.match(out, /need regime range \(now trend on Bitcoin\)/);
  assert.ok(!out.includes('61.94'), `no ADX of its own means no ADX: ${out}`);
});

test('PROXIMITY: a per-ticker regime still shows the ADX that produced it', () => {
  // The fallback path (no meta event, direct callers, the bar chart) genuinely IS the ticker own regime,
  // so pairing it with the ticker ADX is correct — it is only the META case where they diverge.
  const out = candidateProximity(['meanrev'], ctx({
    adx14: 31.4,
    regimeBasis: { regime: 'trend', adx: 31.4, symbol: null, meta: false },
  }));
  assert.match(out, /need regime range \(now trend, ADX 31\.40 vs 25\)/);
});

test('PROXIMITY: a null basis drops the regime clause, keeping the thresholds', () => {
  // quant passes `regimeBasis: gateScope.meanrev ? null : regimeBasis` — for an IN-SCOPE mean-rev family the
  // gate note above has already named the regime, and saying it twice is how a reader learns to skim.
  const bare = ctx();
  delete bare.regime;
  const out = candidateProximity(['meanrev'], { ...bare, regimeBasis: null });
  assert.ok(!out.includes('need regime range'), `the regime must not be repeated: ${out}`);
  assert.match(out, /meanrev RSI\(14\)/, 'the thresholds are still reported');
});

test('PROXIMITY: regime range omits the gate clause entirely', () => {
  const out = candidateProximity(['meanrev'], ctx());
  assert.strictEqual(out, 'candidates — meanrev RSI(14) 50.00 — 20.00 below 30 to buy');
});

test('PROXIMITY: the nearer threshold is the one reported', () => {
  // rsi 60 with 30/70 -> 30.00 from buy, 10.00 from sell. Nearest wins.
  assert.match(candidateProximity(['meanrev'], ctx({ indicators: { rsi: 60, macd: null } })), /10\.00 above 70 to sell$/);
  assert.match(candidateProximity(['meanrev'], ctx({ indicators: { rsi: 35, macd: null } })), /5\.00 below 30 to buy$/);
});

test('PROXIMITY: a trigger that already fired says so, and never prints a negative distance', () => {
  // THE LIVE BUG. SGX read "meanrev RSI(14) 16.77 — -13.23 below 30 to buy": a condition that has already
  // been met, printed as though it were a shortfall. That case — met, and still not trading — is the most
  // interesting one the line has to report, so it gets its own wording.
  const buy = candidateProximity(['meanrev'], ctx({ indicators: { rsi: 16.77, macd: null } }));
  assert.match(buy, /meanrev RSI\(14\) 16\.77 — BELOW 30, buy trigger already met$/);
  assert.ok(!buy.includes('-13.23'), 'a met trigger must not be printed as a negative distance');

  const sell = candidateProximity(['meanrev'], ctx({ indicators: { rsi: 80.96, macd: null } }));
  assert.match(sell, /meanrev RSI\(14\) 80\.96 — ABOVE 70, sell trigger already met$/);
  assert.ok(!sell.includes('10.96'));
});

test('PROXIMITY: thresholds come from paramsFor, including per-symbol overrides', () => {
  const settings = { strategies: { symbolParams: { Silver: { meanrev: { rsiLow: 40, rsiHigh: 60 } } } } };
  const out = candidateProximity(['meanrev'], ctx({ settings, indicators: { rsi: 50, macd: null } }));
  assert.match(out, /RSI\(14\) 50\.00 — 10\.00 below 40 to buy$/);

  // The same override moves the trigger: 55 is now ABOVE 60's... no — above 40 and below 60, so the sell
  // side is 5.00 and the buy side is 15.00.
  const out2 = candidateProximity(['meanrev'], ctx({ settings, indicators: { rsi: 55, macd: null } }));
  assert.match(out2, /5\.00 above 60 to sell$/);
});

test('PROXIMITY: rsi2 uses its own period and its own low/high keys', () => {
  // Bitcoin's live numbers. rsi2 is the one strategy whose bar a human actually watches.
  const out = candidateProximity(['rsi2'], ctx({ indicators: { rsi: 89.17, macd: null } }));
  assert.strictEqual(out, 'candidates — rsi2 RSI(2) 89.17 — 0.83 above 90 to sell');

  const settings = { strategies: { symbolParams: { Silver: { rsi2: { rsiPeriod: 3 } } } } };
  assert.match(candidateProximity(['rsi2'], ctx({ settings, indicators: { rsi: 50, macd: null } })), /rsi2 RSI\(3\)/);
});

test('PROXIMITY: the RSI is computed from the closes when the bars are long enough', () => {
  // A falling series pins the computation: every bar is a loss, so RSI is 0 and the buy trigger is met.
  const closes = Array.from({ length: 40 }, (_, i) => 200 - i);
  const out = candidateProximity(['rsi2'], ctx({ closes, indicators: { rsi: 50, macd: null } }));
  assert.match(out, /rsi2 RSI\(2\) 0\.00 — BELOW 10, buy trigger already met$/);
});

test('PROXIMITY: macd reports the gap to a cross', () => {
  const out = candidateProximity(['macd'], ctx({ indicators: { rsi: 50, macd: { line: 0.1, signal: 0.05 } } }));
  assert.strictEqual(out, 'candidates — macd: MACD 0.05 from a cross');
  assert.strictEqual(
    candidateProximity(['macd'], ctx({ indicators: { rsi: 50, macd: { line: -0.2, signal: -0.1 } } })),
    'candidates — macd: MACD -0.10 from a cross',
  );
  // No macd snapshot at all -> no macd clause (and not the string "MACD NaN").
  assert.strictEqual(candidateProximity(['macd'], ctx({ indicators: { rsi: 50, macd: null } })), null);
});

test('PROXIMITY: the clause list is capped, and the cap is reachable', () => {
  // Silver, live: gate + band + meanrev + rsi2 + macd is FIVE clauses; four are kept and the MACD tail is
  // dropped. The cap counts what the reader SEES — an earlier version joined the two mean-rev entries into
  // one pushed clause, so a 4-clause cap printed a 5-clause line.
  const out = candidateProximity(['turtle', 'meanrev', 'rsi2', 'macd'], ctx({ adx14: 16.83 }));
  assert.strictEqual(out.split(' · ').length, PROX_CLAUSE_LIMIT, out);
  assert.ok(!out.includes('from a cross'), `the tail must be dropped, got: ${out}`);
  assert.match(out, /^candidates — need ADX > 20/);
});

test('PROXIMITY: every clause is separated and none is empty', () => {
  const out = candidateProximity(['turtle', 'meanrev', 'rsi2', 'macd'], ctx());
  for (const clause of out.replace(/^candidates — /, '').split(' · ')) {
    assert.ok(clause.trim().length > 0, `empty clause in: ${out}`);
  }
  assert.ok(!out.includes('undefined'), out);
  assert.ok(!out.includes('NaN'), out);
  assert.ok(!out.includes('?'), `an unreadable number is not a distance: ${out}`);
});

test('PROXIMITY: the line is prefixed so it cannot be mistaken for the flat reason (TRD-56)', () => {
  const out = candidateProximity(['turtle'], ctx());
  assert.match(out, /^candidates — /);
  // And it is a separate sentence from the reason: the caller pushes the scope summary FIRST.
  assert.ok(!out.includes('no strategy in scope'), 'the two sentences must not be blended');
});

test('PROXIMITY (structural): ids come from the SCOPE when there is one, the registry when there is not', () => {
  // TRD-56 protects the rule that a flat reason names only gates of strategies that can actually trade the
  // symbol. BOTH branches satisfy it — the registry list when nothing is in scope, the scope itself when
  // something is. Only the IDS and the prefix differ, so the two cases cannot drift apart.
  assert.match(QUANT, /const inScope = strategyIds\.length > 0;/);
  assert.match(QUANT, /const ids = inScope \? strategyIds : require\('\.\/binding'\)\.applicableIds\(symbol, strategies\)/);
  assert.match(QUANT, /\}, \{ prefix: inScope \? 'distance' : 'candidates' \}\);/);
  assert.match(QUANT, /const idle = scopeSummary\(strategyIds, opts\.globalStrategyIds\)/);
  assert.match(QUANT, /if \(idle\) notes\.push\(idle\)/);
  // The gate note above already names the regime for an IN-SCOPE mean-rev family, so the distance clause
  // must not say it a second time.
  assert.match(QUANT, /regimeBasis: gateScope\.meanrev \? null : regimeBasis/);
  // A symbol that HAS a signal never gets a distance line — the block stays inside the flat-reason branch.
  assert.ok(
    QUANT.indexOf('if (!out.signal)') < QUANT.indexOf('const inScope = strategyIds.length > 0;'),
    'the clause lives inside the flat-reason block',
  );
  // The whole block is still guarded, so a throw degrades to the old message instead of failing a wake.
  assert.match(
    QUANT,
    /const ids = inScope[\s\S]{0,900}?const prox = candidateProximity\([\s\S]{0,900}?catch \{/,
    'the whole proximity block must sit inside try/catch, not just the registry lookup',
  );
});

test('PROXIMITY: the prefix tells a candidate list and an in-scope scope apart', () => {
  assert.match(candidateProximity(['turtle'], ctx()), /^candidates — /);
  const asScope = candidateProximity(['turtle'], ctx(), { prefix: 'distance' });
  assert.match(asScope, /^distance — /);
  assert.ok(!asScope.includes('candidate'), 'an in-scope symbol is not a candidate list');
});

test('PROXIMITY (structural): the meta regime travels with its provenance', () => {
  // `meta.evaluateMeta` records which symbol and ADX produced the verdict; the pipeline must carry all
  // three, or the proximity line cannot say whose regime it is quoting.
  const PIPE = code('trading/agent/wakePipeline.js');
  assert.match(PIPE, /regimeAdx: metaPayload\.adx14/);
  assert.match(PIPE, /regimeSymbol: metaPayload\.symbol/);
  assert.match(PIPE, /quant\.evaluate\(userId, settings, openTrades, regimeOpts\)/);
  // And quant must prefer the meta basis over the ticker's when both exist.
  assert.match(QUANT, /opts\.regime\s*\n?\s*\? \{/);
  assert.match(QUANT, /regimeBasis,/);
});

test('PROXIMITY (structural): quant does not require ./binding at module load', () => {
  // A top-level require would couple the deterministic engine to the binding registry (and its DB). The
  // lazy require inside the catch-guarded block is the whole reason this is safe.
  assert.ok(!/^const .*= require\('\.\/binding'\)/m.test(QUANT), 'no top-level binding require');
});
