// test/shadow-signals.test.js — TRD-SHW-1 (2026-09-14).
//
// Pins the two things that make the shadow ledger worth having: the QUESTION is
// frozen and versioned, and the STRIP really removes the desk's conclusions.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const shadow = require('../trading/agent/shadow');
const { code } = require('./_source');

// A quantResult shaped like the real one, INCLUDING the desk's conclusions — the
// whole point is that stripContext must not carry them through.
const QUANT = {
  symbols: [{
    symbol: 'Sugar', venue: 'plus500', status: 'ok',
    price: 18.155, prevPrice: 18.16, atr14: 0.08, adx14: 44.31,
    regime: 'trend', regimeDir: 'down',
    donchian: { lower: 17.2, upper: 18.9 },
    series: new Array(120).fill(18),
    // ---- the desk's conclusions, all of which must vanish ----
    signal: { type: 'entry', direction: 'sell', basis: 'donchian20 breakout down, ADX 44.31', strategy: 'survoil' },
    flat: 'inside range 17.2–18.9 · MACD -0.3401 vs -0.2831 no cross',
    votes: { quantVotes: [{ type: 'macd', note: 'no proposal' }] },
  }],
  strategies: ['survgold', 'survoil'],
  symbolScope: { others: [] },
};

test('the prompt version is frozen and is what gets stored', () => {
  assert.strictEqual(shadow.PROMPT_VERSION, 'q1-v1');
  const s = shadow.stripContext({ quantResult: QUANT });
  assert.strictEqual(s.promptVersion, 'q1-v1');
  assert.strictEqual(s.horizonBars, 24);
});

test('★ the strip removes every desk conclusion, at every depth', () => {
  const s = shadow.stripContext({ quantResult: QUANT });
  const json = JSON.stringify(s);
  for (const forbidden of ['"signal"', 'flat', 'quantVotes', 'strategyStats', 'proposal', 'donchian20 breakout', 'no cross', 'survoil']) {
    assert.ok(!json.includes(forbidden), `the strip leaked: ${forbidden}`);
  }
  // ...and the whitelisted structure is still there, or the question has no input.
  assert.strictEqual(s.symbols[0].symbol, 'Sugar');
  assert.strictEqual(s.symbols[0].adx14, 44.31);
  assert.deepStrictEqual(s.symbols[0].donchianBands, { lower: 17.2, upper: 18.9 });
  assert.strictEqual(s.symbols[0].bars, 120);
});

test('the rendered prompt contains none of the desk verdict vocabulary', () => {
  const text = shadow.buildPrompt(shadow.stripContext({ quantResult: QUANT }), 'Sugar');
  assert.ok(!/no signal/i.test(text), 'the prompt says "no signal"');
  assert.ok(!/PROPOSED ACTION/i.test(text), 'the prompt carries a proposed action');
  assert.ok(!/\bVOTE\b/.test(text), 'the prompt asks for a vote');
  assert.ok(!/flat/i.test(text), 'the prompt carries a flat reason');
  assert.ok(/struct/ .test('structure'), 'sanity');
  assert.ok(text.includes('Sugar'), 'the symbol must be named');
  assert.ok(text.includes('18.155'), 'the price must be shown (structure, not verdict)');
});

test('the question is the frozen Q1 and invariant of the data', () => {
  const a = shadow.buildPrompt(shadow.stripContext({ quantResult: QUANT }), 'Sugar');
  const b = shadow.buildPrompt(shadow.stripContext({ quantResult: { symbols: [] } }), 'Gold');
  const qa = a.split('\n').filter((l) => l.startsWith('You are shown') || l.startsWith('Question:'));
  const qb = b.split('\n').filter((l) => l.startsWith('You are shown') || l.startsWith('Question:'));
  assert.deepStrictEqual(qa, qb, 'the question text must not vary with the data');
  assert.ok(/not shown/i.test(a), 'the strip must be disclosed to the model');
});

test('parseAnswer: a directional yes', () => {
  const p = shadow.parseAnswer('{"evidence":"yes","direction":"buy","confidence":0.71,"basis":"higher lows"}');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.evidence, true);
  assert.strictEqual(p.direction, 'buy');
  assert.strictEqual(p.confidence, 0.71);
  assert.strictEqual(shadow.isDirectional(p), true);
});

test('parseAnswer: "no evidence" is a valid answer and is NOT directional', () => {
  const p = shadow.parseAnswer('{"evidence":"no","direction":"none","confidence":0,"basis":"range-bound"}');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.evidence, false);
  assert.strictEqual(p.direction, null);
  assert.strictEqual(shadow.isDirectional(p), false);
  assert.strictEqual(p.basis, 'range-bound');
});

test('parseAnswer REFUSES a yes with no direction rather than inventing one', () => {
  const p = shadow.parseAnswer('{"evidence":"yes","direction":"none","confidence":0.9}');
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, 'direction_invalid');
  assert.strictEqual(p.direction, null);
  assert.strictEqual(shadow.isDirectional(p), false);
});

test('parseAnswer: malformed replies fail closed and keep the reason', () => {
  assert.strictEqual(shadow.parseAnswer('I am not sure').reason, 'no_json');
  assert.strictEqual(shadow.parseAnswer('{not json}').reason, 'bad_json');
  assert.strictEqual(shadow.parseAnswer('{"evidence":"maybe","direction":"buy"}').reason, 'evidence_not_boolean');
  assert.strictEqual(shadow.parseAnswer(null).reason, 'no_json');
  for (const bad of ['I am not sure', '{not json}', '{"evidence":"maybe"}', null, undefined]) {
    const p = shadow.parseAnswer(bad);
    assert.strictEqual(shadow.isDirectional(p), false, 'a malformed reply must never be trade-able');
  }
});

test('parseAnswer: prose around the JSON is tolerated, confidence is clamped', () => {
  const p = shadow.parseAnswer('Sure — here it is:\n{"evidence":"yes","direction":"sell","confidence":4.2,"basis":"x"}\nHope that helps.');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.direction, 'sell');
  assert.strictEqual(p.confidence, 1);
  const q = shadow.parseAnswer('{"evidence":true,"direction":"BUY","confidence":-3}');
  assert.strictEqual(q.direction, 'buy');
  assert.strictEqual(q.confidence, 0);
});

test('scheduledEventFor: an FOMC day is flagged, and only that day', () => {
  const events = [{ eventDate: '2026-09-16', eventType: 'halt', note: 'FOMC meeting day (federalreserve.gov)' }];
  assert.strictEqual(shadow.scheduledEventFor(events, '2026-09-16T12:00:00Z'), 'FOMC meeting day (federalreserve.gov)');
  assert.strictEqual(shadow.scheduledEventFor(events, '2026-09-17T12:00:00Z'), null);
  assert.strictEqual(shadow.scheduledEventFor([], '2026-09-16T12:00:00Z'), null);
  assert.strictEqual(shadow.scheduledEventFor(null, '2026-09-16T12:00:00Z'), null);
  assert.strictEqual(shadow.scheduledEventFor(events, 'not-a-date'), null);
});

// ------------------------------------------------------------ structure

test('STRUCTURE: the runner never places an order and is not on a trading path', () => {
  const src = code('trading/agent/shadowCall.js');
  for (const forbidden of ['openTrade', 'closeTrade', 'executor', 'connector', 'risk.evaluate']) {
    assert.ok(!src.includes(forbidden), `the shadow runner must not reference ${forbidden}`);
  }
});

test('STRUCTURE: the strip is a whitelist, not a key deletion', () => {
  const src = code('trading/agent/shadow.js');
  assert.ok(src.includes('function stripContext'), 'stripContext must exist');
  assert.ok(!src.includes('delete ctx.'), 'the strip must not subtract keys — it must build the object');
});

test('STRUCTURE: shadow is a metered budget consumer', () => {
  const budget = code('trading/agent/budget.js');
  assert.ok(budget.includes("'shadow'"), 'shadow must be a budget consumer or its spend is invisible');
});

// ── §11.2 — the Fixture-INDEPENDENT source pin, written BEFORE the change it guards ──────────────────
//
// S4's item 3 moves the `candidateProximity` clause onto `out.flat` (pre-registration §3). The test above
// ("the strip removes every desk conclusion") would catch a leak — but ONLY because this file's fixture
// happens to carry `flat` and `signal`. A guard that depends on a fixture is one a fixture can silently
// disarm, and that is exactly how §1.4 of the pre-registration survived 1,295 passing tests.
//
// So this pin reads the SOURCE of the strip region instead. It is written before S4 item 3 lands, which is
// the only moment a pin can be written while it is still *able* to fail — one added afterwards was written
// by someone who already knew what it had to catch.
//
// The region is comment-stripped by `./_source`, so this cannot pass (or fail) on the prose that discusses
// `flat` and `signal` at length — the CRLF trap documented in that module is why the strip lives there.
test('STRUCTURE (SOURCE PIN, §11.2): the strip cannot name `flat` or `signal`, fixture or not', () => {
  const src = code('trading/agent/shadow.js');
  const from = src.indexOf('function structureRow');
  const to = src.indexOf('function buildPrompt');
  assert.ok(from > 0 && to > from, 'the strip region must be locatable, or this pin is vacuous');
  const region = src.slice(from, to);
  for (const forbidden of ['flat', 'signal']) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(region),
      `the strip names \`${forbidden}\` — S4 item 3 lands on out.flat, and that is the field it must not reach`);
  }
  assert.ok(!shadow.KEPT_CONTEXT_KEYS.some((k) => /flat|signal/i.test(k)),
    'the whitelist must not admit a desk verdict field');
});

// ── §11.3 — ABSENCE IS NOT ZERO. Written now, and SKIPPED now, on purpose ────────────────────────────
//
// MEASURED 2026-09-24 (pre-registration §12.3): `num()` guards AFTER coercing, so `Number(null) === 0` and
// `Number('') === 0` both survive `Number.isFinite` and come back as a real 0, while `undefined` correctly
// becomes null. `structureRow({price:null, atr14:''})` therefore reports price 0 and ATR 0 — an instrument
// at zero with zero volatility. That is a FABRICATED structure row, not a missing one, and it is the third
// instance of absence-as-a-number in this repo (after `rOf(null)` in §1.2 and the fixture in §1.4).
//
// The fix — guard absence BEFORE coercion, as SHW-4 did for `rOf` — changes what the model is SHOWN, so in
// principle it moves PROMPT_VERSION and §2's registered order says it belongs with the S4 bundle change.
//
// ★ IT LANDED 2026-09-24, MID-COHORT, UNDER AN OWNER RULING — and the justification is a MEASUREMENT, not a
// judgement call. Asked directly, the ledger answers it: 726 `ShadowSignals` rows carry `priceAtCall = 0` in
// **0** cases, `atr14 = 0` in **0**, `adx14 = 0` in **0**, and no NULLs either. And that IS a measurement of
// the prompt: `shadowCall.js:79-80` passes the SAME `pick` to `stripContext({quantResult:{symbols:[pick]}})`, so
// `num(pick.price)` is exactly what the model was shown and `priceAtCall` is its input. The reason it never
// fired is structural, not luck — `shadowCall.js:52` picks only `status === 'ok'` symbols, so a symbol whose
// structure failed to compute is never selected. ⇒ the fix changed nothing the model was shown for every call
// the desk has ever recorded. Residual risk, stated rather than hidden: unreachable is only OBSERVED, so a
// mid-cohort landing still puts an unmarked difference in the path PROMPT_VERSION exists to mark. §12.5.
//
// Hence the assertion is no longer skipped. It was written while it could still fail, which is the point — a
// suite that could not state this requirement is how §1.2 survived 7 days.
test('§11.3: an absent structure field renders as null, never as 0', () => {
  const r = shadow.structureRow({
    symbol: 'X', price: null, prevPrice: undefined, atr14: '',
    donchian: { lower: null, upper: null },
  });
  assert.strictEqual(r.price, null, 'an absent price must be null, not 0');
  assert.strictEqual(r.atr14, null, 'an absent atr14 must be null, not 0');
  assert.deepStrictEqual(r.donchianBands, { lower: null, upper: null }, 'absent band edges must be null, not 0');
  assert.strictEqual(shadow.structureRow({ symbol: 'X', adx14: 0 }).adx14, 0, 'a GENUINE zero must survive');
  assert.strictEqual(shadow.structureRow({ symbol: 'X', prevPrice: undefined }).prevPrice, null);
});
