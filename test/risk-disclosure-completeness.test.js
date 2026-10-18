// test/risk-disclosure-completeness.test.js — TRD-LLM-2 (#1413), corrected 2026-09-27.
//
// THE MISTAKE THIS FILE EXISTS TO PREVENT FROM RECURRING. The first version of the bundle section printed
// `size = equity x riskPerTradePct% / effective stop distance` as THE sizing rule and shipped with a test that
// asserted the section CONTAINED that sentence. So the test pinned my own wording, and certified an omission: the
// rule that actually sizes every ticket is `maxRiskPerTradePct`, which `risk.js` applies AFTERWARDS as a
// recomputation, and on the live config it is 0.07% against a declared 2% — roughly 28x smaller.
//
// Every assertion below therefore targets a FACT (which dial binds, what the realised risk is, which conditions
// can refuse) rather than a phrase, so a rewrite that keeps the fact still passes and a rewrite that drops it
// still fails.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const pb = require('../trading/agent/promptBuilder');

// The live risk block (read from TradingSettings 2026-09-27).
const LIVE = {
  risk: {
    riskPerTradePct: 2, maxRiskPerTradePct: 0.07, maxEquityPerPositionPct: 80, exposureCapPct: 100,
    maxPositions: 10, maxNewTradesPerDay: 20, reentryCooldownBars: 0, maxAdversePct: 0.3,
    takeProfitOffsetPct: 5, maxCostShareOfR: 0.65, maxAdverseCostMultiple: 1.5,
    correlationVeto: 0.7, dailyLossHaltPct: 3, minRealisedRrPct: 50,
  },
};

test('★ the binding dial is decided by ARITHMETIC, not by wording: the smaller of the two always wins', () => {
  // Both dials divide by the SAME riskStopDist, so the comparison never depends on the ticket.
  const pairs = [[2, 0.07], [1, 5], [0.5, 0.5], [3, 2.999], [0.01, 0.02], [10, 0.001]];
  for (const [declared, cap] of pairs) {
    const r = pb.effectiveRiskPct({ risk: { riskPerTradePct: declared, maxRiskPerTradePct: cap } });
    assert.strictEqual(r.effective, Math.min(declared, cap),
      `declared ${declared} vs cap ${cap}: the effective risk must be the MINIMUM`);
    assert.strictEqual(r.inert, cap < declared, `declared ${declared} vs cap ${cap}: inert iff the cap is smaller`);
  }
});

test('a tie is NOT inert, and an absent or zero cap leaves the declared dial in force', () => {
  assert.strictEqual(pb.effectiveRiskPct({ risk: { riskPerTradePct: 2, maxRiskPerTradePct: 2 } }).inert, false);
  for (const cap of [undefined, null, 0, 'nonsense']) {
    const r = pb.effectiveRiskPct({ risk: { riskPerTradePct: 2, maxRiskPerTradePct: cap } });
    assert.strictEqual(r.inert, false, `cap ${JSON.stringify(cap)} must not be read as a binding cap`);
    assert.strictEqual(r.effective, 2);
    assert.strictEqual(r.maxRisk, null, 'an absent/zero cap is null, never 0 — Number(null) === 0 is the trap');
  }
  // A missing risk block entirely must not throw and must fall back to the documented default.
  assert.strictEqual(pb.effectiveRiskPct({}).declared, 1);
});

test('★ the LIVE config is disclosed as INERT, with the effective number named', () => {
  const text = pb.riskParameterLines(LIVE).join('\n');
  const r = pb.effectiveRiskPct(LIVE);
  assert.strictEqual(r.inert, true, 'precondition: on the live config the declared 2% is inert');
  assert.match(text, /INERT/);
  assert.ok(text.includes(`${r.effective}% of equity`), `the REALISED risk (${r.effective}%) must be named`);
  assert.ok(text.includes(`NOT ${r.declared}%`), 'and contrasted against the declared dial, or the seat will trust 2%');
  // The declared dial must never be presented as the realised risk on its own.
  assert.ok(!/realised risk per trade is 2%/.test(text), 'the inert dial must not be stated as the realised risk');
});

test('★ NON-VACUITY: a config where the cap is NOT binding must not claim it is', () => {
  const loose = { risk: { ...LIVE.risk, maxRiskPerTradePct: 5 } };
  const text = pb.riskParameterLines(loose).join('\n');
  assert.ok(!/INERT/.test(text), 'a cap above the declared dial is not inert and must not say so');
  assert.match(text, /realised risk per trade is 2%/);
  // And a config with NO cap must say so rather than silently omitting the dial.
  const none = pb.riskParameterLines({ risk: { riskPerTradePct: 2 } }).join('\n');
  assert.match(none, /Per-trade risk cap: none set/);
  assert.ok(!/INERT/.test(none));
});

test('★ EVERY refusal rule the deterministic gate can apply is enumerated', () => {
  // Derived from the sites in trading/agent/risk.js that set `v.veto = true`, not from prose.
  const text = pb.riskParameterLines({ risk: { ...LIVE.risk, reentryCooldownBars: 6 } }).join('\n');
  const must = [
    /already held/i,                       // one position per symbol
    /10 open positions already reached/,   // maxPositions
    /20 new trades already taken today/,   // maxNewTradesPerDay
    /closed within 6h/,                    // reentryCooldownBars
    /down 3% against day-start equity/,    // dailyLossHaltPct
    /correlation.*>= 0\.7/i,               // correlationVeto
    /exposure is already at the 100% budget/, // exposureCapPct
    /below the venue's own minimum/i,      // venue floor
    /round trip exceeds 65\.0% of the risk unit/, // cost ceiling
    /size is zero or negative/,            // size <= 0
    /kill switch is at HARD/,              // kill
    /equity or the risk baseline cannot be read/, // TRD-109
    /price or volatility data is missing/, // atr/price guard
  ];
  for (const re of must) assert.match(text, re, `a refusal rule is missing from the disclosure: ${re}`);
  // The zero-cooldown case must DROP that clause rather than print "within 0h".
  const noCd = pb.riskParameterLines(LIVE).join('\n');
  assert.ok(!/closed within 0h/.test(noCd), 'a disabled cooldown must not be rendered as a rule');
});

test('★ the seat is told a refusal happens BEFORE it is asked, so it cannot see or argue with one', () => {
  const text = pb.riskParameterLines(LIVE).join('\n');
  assert.match(text, /refusal happens BEFORE any seat is asked/i);
  assert.match(text, /not reported back to you/i);
});

test('★ no dollar, euro or currency unit leaks into the disclosure (account is DEMO; sizes are units)', () => {
  const text = pb.riskParameterLines(LIVE).join('\n');
  assert.ok(!/[$€£]\s?\d/.test(text), 'a currency amount would be read as a P&L, not a size');
});

// The integration claim: the section must arrive in the real bundle, and the constant head must stay constant so
// the disclosure does not cost the prefix cache (TRD-78).
test('the corrected disclosure reaches the bundle without moving the constant head', () => {
  const build = (settings, account) => pb.buildBundle({
    userId: 1, trigger: 'test', now: new Date('2026-09-27T04:00:00Z'),
    session: { state: 'open', detail: 't', scheduledEvents: [] }, quantResult: { symbols: [] },
    openTrades: [], closedTrades: [], digest: null, proposal: null, alert: null, stale: false,
    pulse: null, meta: null, multi: null, congress: null, whitepaper: null, proposals: [],
    userInput: null, prevOutcomes: null, venueCostFacts: null, settings, account,
  });
  const a = build(LIVE, { equity: 4114.24, available: 3868.37, margin: 122.93, pnl: -1.18 });
  assert.match(a, /riskPerTradePct \(2%\) IS INERT/);
  assert.match(a, /REFUSAL RULES/);
  const b = build({ risk: { ...LIVE.risk, maxRiskPerTradePct: 4 } }, { equity: 9999.99, available: 1, margin: 0, pnl: 0 });
  const head = a.indexOf('--- RISK PARAMETERS');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  assert.ok(i >= head, `the common prefix (${i}) must still cover the constant head (ends at ${head})`);
  assert.ok(!/INERT/.test(b), 'non-vacuity: the other config differs in this very claim');
});
