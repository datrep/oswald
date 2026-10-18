// test/risk-veto-codes.test.js — TRD-RSK-2: a refusal is attributable by CODE, not by reading its sentence.
//
// WHY THIS EXISTS. A refusal by the risk gate happens BEFORE the committee, so `llmCalled` is false and no seat is
// asked anything. The only trace was a prose reason inside a wake event, so "why is the desk not trading" meant
// reading that prose against `agent/risk.js` to find which site set the flag. That investigation happened, and it
// got the answer WRONG: it named the cost ceiling where the correlation guard had fired, because the sentence
// "venue cost 0.1936% = 65% of R" reads like a breach of a 65% ceiling and 65% IS that ceiling rounded — the real
// share was 0.6453, i.e. UNDER. Codes remove the reading.
//
// The assertions are deliberately STRUCTURAL where the risk is structural: the danger is a NEW veto site being
// added that sets the flag without a code, which no behavioural test on today's sites would catch.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');

const RISK = 'trading/agent/risk.js';
const AGG = 'trading/agent/aggregator.js';
const PIPE = 'trading/agent/wakePipeline.js';
const promptBuilder = require('../trading/agent/promptBuilder');

// The complete set, in evaluation order. Kept here so a new site must be declared rather than silently added.
const CODES = [
  'kill_switch_hard', 'baseline_unusable', 'equity_unavailable', 'already_held', 'max_positions',
  'max_new_trades', 'reentry_cooldown', 'daily_halt', 'data_missing', 'cost_ceiling', 'size_zero',
  'exposure_budget', 'correlation', 'venue_minimum',
  // L3 (rev 5, 2026-09-29): the margin guard. Two codes because the two refusals need different responses —
  // `margin_utilisation` means the desk is out of VENUE CAPACITY (an operational fact about the book), while
  // `margin_guard_unusable` means the guard could not read its own denominator (a data fact, and the desk is
  // refusing rather than passing on ignorance). Collapsing them would hide which one is happening.
  'margin_utilisation', 'margin_guard_unusable',
];

test('★ the ONLY thing that sets `v.veto` is the code-carrying helper — no site can refuse anonymously', () => {
  const src = code(RISK);
  const all = src.match(/v\.veto = true/g) || [];
  assert.strictEqual(all.length, 1,
    `exactly one assignment may exist (inside the helper); found ${all.length} — a site that sets the flag without`
    + ' a code is a refusal a report cannot attribute');
  assert.match(src, /const veto = \(code, text\) => \{ v\.veto = true; v\.vetoCodes\.push\(code\); v\.vetoReasons\.push\(text\); reasons\.push\(text\); \}/,
    'the helper must record the code AND the refusal text AND the whole list, in one place');
});

test('★ ★ the refusal line LEADS WITH THE REFUSAL, not with a resize note the gate passed', () => {
  // ⚠ MEASURED DEFECT, 2026-09-28. `reasons` holds the gate's notes (the stop cap, the TP offset, each size cap)
  // in the same list as the refusals, in push order, and the stop-cap note is pushed while the ticket is still
  // being ADMITTED — so it led almost every veto. 14 live refusals read "risk veto: stop capped at 0.3% of price
  // (declared 0.645%) ..." while 3 of them carried `vetoCodes: ["correlation"]`. The prose named a resize the
  // gate had PASSED as the reason it refused, which is the misattribution TRD-RSK-2 exists to end.
  const { vetoLine } = require('../trading/agent/risk');
  const v = {
    veto: true, vetoCodes: ['correlation'],
    vetoReasons: ['|correlation| with Oil is 0.78, at or above the 0.7 rule'],
    // push order preserved exactly as the gate produces it: the note first, the refusal last.
    reasons: ['stop capped at 0.3% of price (declared 0.645%), venue cost 0.1728% = 57% of R',
      'size capped at 0.07% risk/trade (implied 0.240% of equity)',
      '|correlation| with Oil is 0.78, at or above the 0.7 rule'],
  };
  const line = vetoLine(v);
  assert.match(line, /^risk veto: \[correlation\] \|correlation\|/, 'the REFUSAL must come first, and the code must be named right after the prefix');
  assert.ok(line.indexOf('stop capped') > line.indexOf('|correlation|'),
    'the resize note must NOT precede the refusal — that ordering is the whole defect');
  assert.match(line, /— gate notes: stop capped at 0\.3%/, 'and the notes are kept, not dropped: they explain the ticket');
  // ⚠ The prefix is a CONTRACT, not cosmetics: the UI keys `/risk veto/i` and routes.js classifies
  // `/^risk veto:/i`. Putting the code BEFORE the colon broke the second one silently, so the colon stays put.
  assert.match(line, /^risk veto:/);
});

test('a refusal with no notes says so by omission rather than printing an empty section', () => {
  const { vetoLine } = require('../trading/agent/risk');
  const v = { veto: true, vetoCodes: ['daily_halt'], vetoReasons: ['the day is down 3.2%'], reasons: ['the day is down 3.2%'] };
  assert.strictEqual(vetoLine(v), 'risk veto: [daily_halt] the day is down 3.2%');
  assert.doesNotMatch(vetoLine(v), /gate notes/);
});

test('★ a row written before the split still reads as a refusal — the fallback is not a blank', () => {
  // Historical events have `reasons` and no `vetoReasons`. Reporting them as "vetoed" with no text would erase
  // the only trace those rows have, which is precisely the failure this row's own subject is about.
  const { vetoLine } = require('../trading/agent/risk');
  const legacy = { veto: true, vetoCodes: [], reasons: ['max positions (3) reached'] };
  assert.strictEqual(vetoLine(legacy), 'risk veto: max positions (3) reached');
  assert.strictEqual(vetoLine({ veto: true, reasons: [] }), 'risk veto: vetoed', 'and an empty one is still labelled');
});

test('every declared code is emitted by exactly one site, and nothing else is', () => {
  const src = code(RISK);
  const emitted = [...src.matchAll(/veto\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual([...emitted].sort(), [...CODES].sort(),
    'the emitted codes must equal the declared set — a missing one means a site was not converted, an extra one'
    + ' means a new rule arrived without being declared');
  assert.strictEqual(new Set(emitted).size, emitted.length, 'each code should come from one place');
});

test('★ the codes travel: refusal decision -> wake payload -> a report can group them', () => {
  assert.match(code(AGG), /riskVetoCodes: risk\.vetoCodes \|\| \[\]/,
    'the refusal decision must carry the codes, or they stop at the gate');
  assert.match(code(PIPE), /vetoCodes: d\.riskVetoCodes \|\| null/,
    'and the wake payload must carry them per decision, or they stop at the aggregator');
});

test('★ the codes and the CHAIR DISCLOSURE cannot drift — every code has a disclosed refusal rule', () => {
  // `riskParameterLines` tells the seat what can refuse it. If a code exists with no matching line, the seat is
  // being kept in the dark about a rule that fires; if a line exists with no code, the report cannot count it.
  const text = promptBuilder.riskParameterLines({ risk: {
    riskPerTradePct: 2, maxRiskPerTradePct: 0.07, maxEquityPerPositionPct: 80, exposureCapPct: 100,
    maxPositions: 10, maxNewTradesPerDay: 20, reentryCooldownBars: 6, maxAdversePct: 0.3,
    takeProfitOffsetPct: 5, maxCostShareOfR: 0.65, maxAdverseCostMultiple: 1.5,
    correlationVeto: 0.7, dailyLossHaltPct: 3,
    // L3: armed, so the two margin rules are DISCLOSED. Like `reentryCooldownBars` above, an unarmed control
    // cannot refuse anything, so its refusal rule is correctly absent from the list — the disclosure test
    // supplies the settings that arm the rule rather than accepting a rule whose text never appears.
    maxMarginUtilisationPct: 80,
  } }).join('\n');
  const homes = {
    already_held: /already held/i,
    max_positions: /10 open positions already reached/,
    max_new_trades: /20 new trades already taken today/,
    reentry_cooldown: /closed within 6h/,
    daily_halt: /down 3% against day-start equity/,
    correlation: /correlation.*>= 0\.7/i,
    exposure_budget: /exposure is already at the 100% budget/,
    margin_utilisation: /the book's margin utilisation is already at the 80% ceiling/,
    margin_guard_unusable: /the margin guard cannot be evaluated \(the venue's margin rate or an open position's notional is unreadable\)/,
    venue_minimum: /below the venue's own minimum/i,
    cost_ceiling: /round trip exceeds 65\.0% of the risk unit/,
    size_zero: /size is zero or negative/,
    kill_switch_hard: /kill switch is at HARD/,
    // These two are deliberately ONE disclosed clause: the seat does not need them told apart to reason, but a
    // report does, which is exactly why the codes are finer-grained than the prose.
    baseline_unusable: /equity or the risk baseline cannot be read/,
    equity_unavailable: /equity or the risk baseline cannot be read/,
    data_missing: /price or volatility data is missing/,
  };
  for (const c of CODES) {
    assert.ok(homes[c], `code ${c} has no declared home in the disclosure — add one rather than letting the gate`
      + ' and the chair disagree about what can refuse a ticket');
    assert.match(text, homes[c], `the disclosure is missing the rule for ${c}`);
  }
});

test('a code is a stable identifier: lowercase, no spaces, no numbers that encode a threshold', () => {
  // A code carrying its threshold (`cost_ceiling_65`) would go stale the moment the dial moved, and a report would
  // then be describing a setting that no longer exists.
  for (const c of CODES) {
    assert.match(c, /^[a-z][a-z_]*$/, `code ${c} must be a stable lowercase identifier`);
    assert.ok(!/\d/.test(c), `code ${c} must not encode a threshold`);
  }
});
