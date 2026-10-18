// test/risk-unit-explained.test.js — TRD-RSK-11 (#1468): a field that is always present is not evidence.
//
// ★ THE DEFECT THIS PINS. `risk.js` wrote `cappedAtPct: Number(risk.maxEquityPerPositionPct ?? 5)` when it built
// `sizeCalc` — UNCONDITIONALLY, FROM THE SETTING. It was present whether or not the cap truncated anything, so it
// reported what the cap IS and never whether it ACTED. `fieldContracts.riskUnit` then read its mere PRESENCE as
// proof that the cap bound:
//
//     const explained = s.cappedAtPct != null;        // NEVER NULL => ALWAYS TRUE
//
// So `unexplained` was always empty, the F20 warn was UNREACHABLE, and the contract printed "the dial is doing its
// job" on every run. The TRD-F20-EPOCH work's entire premise — "only a gap the cap does NOT explain is a real
// label mismatch" — was inert by construction.
//
// ★ MEASURED CONSEQUENCE: `cappedAtPct` is 80 on 266 decisions, while the reason `size capped at 80% equity`
// appears on only 231. So 35 decisions carried a seat-facing claim that a cap bound when it did not.
//
// ★ THE FIX, AND WHY IT IS TWO EDITS AND NOT ONE. The field is now written only in the branch that truncates
// (`cappedAtPct` is null when the cap did not act — the shape `boundBy` and `stopCap.cappedBy` already use), and
// the reader stopped treating presence as proof. Making the field nullable WITHOUT the reader change would have
// swapped a false "explained" for a false "unexplained" on every row.
//
// ★ AND WHY THE READER DOES NOT READ `cappedAtPct` AT ALL. `riskUnit` reads a WINDOW, and the window spans the
// fix: rows before it carry `cappedAtPct` unconditionally, rows after it carry it honestly. A contract that read
// the field would let the old rows certify themselves — the same "a window statistic quoted forward as a standing
// fact" error that TRD-RSK-10 §1.1b committed with `exposureCapPct`. So the claim comes from two witnesses that
// cannot be faked: L4's `boundBy` enum (post-2026-09-29, and more precise because ANY of the four controls can
// cause the gap), and the writer's own reason string (every era, because it is pushed in the truncating branch).
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fc = require('../trading/agent/fieldContracts');
const { code } = require('./_source');

// ⚠ CRLF: every source here is CRLF, and `.` does not match `\r`, so a line-anchored pattern needs the newlines
// normalised first. `test/_source.js` strips comments; this normalises line endings. Both are needed.
const nl = (s) => s.replace(/\r\n/g, '\n');
const risk = nl(code('trading/agent/risk.js'));
const contracts = nl(code('trading/agent/fieldContracts.js'));

// --- the explanation rule ----------------------------------------------------

test('every one of the four controls explains the gap, and names itself', () => {
  const cases = [
    ['maxEquityPerPositionPct', 'notional cap'],
    ['maxRiskPerTradePct', 'risk cap'],
    ['exposureCapPct', 'portfolio budget'],
    ['margin_utilisation', 'margin guard'],
  ];
  for (const [boundBy, label] of cases) {
    const r = fc.riskUnitExplain({ boundBy, reasons: [] });
    assert.equal(r.explained, true, `${boundBy} must explain a dial-vs-realised gap`);
    assert.match(r.why, new RegExp(label), `${boundBy} must name itself as "${label}"`);
  }
});

test('cappedAtPct ALONE certifies NOTHING — the 35-decision defect', () => {
  // THIS IS THE ASSERTION THAT FAILS ON THE OLD READER. Old `explained` was `cappedAtPct != null`, so a row that
  // carried the field but whose cap never acted was counted as explained. It must now be UNEXPLAINED.
  const r = fc.riskUnitExplain({ cappedAtPct: 80, reasons: [] });
  assert.equal(r.explained, false, 'presence of cappedAtPct is not evidence the cap bound');
  assert.equal(r.why, '');
});

test('the writer reason still explains a gap on rows written BEFORE the L4 enum existed', () => {
  // Era coverage: those rows carry no `boundBy`, so the reason string is the only witness they have. Without this
  // the fix would have turned the whole back catalogue into false label mismatches.
  const r = fc.riskUnitExplain({ cappedAtPct: 80, reasons: ['size capped at 80% equity'] });
  assert.equal(r.explained, true);
  assert.equal(r.why, 'notional cap bound (80%)');
  assert.equal(r.by, 'reason');
});

test('an unparseable reason is NOT evidence — and that is why the writer resolves the value once', () => {
  // `reasons.push(\`size capped at ${risk.maxEquityPerPositionPct}% equity\`)` printed the RAW setting, while the
  // cap itself used `?? 5`. An absent setting would therefore have produced the reason "size capped at undefined%
  // equity" beside a genuine 5% cap. The writer now resolves it once, so the cap, the field and the reason cannot
  // print three different numbers.
  assert.equal(fc.riskUnitExplain({ reasons: ['size capped at undefined% equity'] }).explained, false);
  assert.equal(fc.riskUnitExplain({ reasons: ['sized down to exposure budget'] }).explained, false);
  assert.equal(fc.riskUnitExplain({}).explained, false);
});

test('boundBy wins over the reason, because it names the control that actually decided', () => {
  // A ticket can be truncated by the notional cap and then shrunk again by the portfolio budget. `boundBy` names
  // the tightest constraint, which is the useful answer; the reason names an earlier one.
  const r = fc.riskUnitExplain({ boundBy: 'exposureCapPct', cappedAtPct: 80, reasons: ['size capped at 80% equity'] });
  assert.equal(r.why, 'portfolio budget bound');
});

// --- the warn is reachable again ---------------------------------------------

test('a window of self-certifying rows no longer explains itself away', () => {
  const window = [
    { cappedAtPct: 80, reasons: ['size capped at 80% equity'] },   // the cap really acted
    { cappedAtPct: 80, reasons: [] },                              // it did NOT <-- one of the 35
  ];
  const explainedN = window.filter((s) => fc.riskUnitExplain(s).explained).length;
  assert.equal(explainedN, 1);
  assert.equal(window.length - explainedN, 1, 'the row whose cap did not act must now be UNEXPLAINED');
});

// --- the writer --------------------------------------------------------------

test('risk.js writes cappedAtPct ONLY where the cap truncates', () => {
  assert.match(risk, /let cappedAtPct = null;/, 'it must start null, like boundBy');

  // ⚠ UPDATED 2026-10-01 (P2). This assertion used to pin `if (size * price > maxValue)` and
  // `size = maxValue / price;` — THE DEFECT ITSELF. `size * price` is the INSTRUMENT's currency and `maxValue`
  // is the ACCOUNT's, so the comparison ran across two currencies and the cap's real ceiling was `capPct x fx`
  // (measured: 40% bound at 51.25%, 35% at 44.84%). It is not loosened here — it is moved to the converted form.
  const from = risk.indexOf('if (size * price * notionalK > maxValue)');
  assert.ok(from > 0, 'the truncation branch must exist, and it must convert before comparing');
  const branch = risk.slice(from, risk.indexOf('\n  }', from));
  assert.match(branch, /^ {4}size = maxValue \/ \(price \* notionalK\);$/m);
  assert.match(branch, /^ {4}boundBy = 'maxEquityPerPositionPct';$/m);
  assert.match(branch, /^ {4}cappedAtPct = maxEquityPerPositionPct;$/m, 'set INSIDE the branch, or it is not a binding claim');
  assert.match(branch, /reasons\.push\(`size capped at \$\{maxEquityPerPositionPct\}% equity`\)/, 'the reason must print the RESOLVED value');

  // The sizeCalc literal must carry the LOCAL. A fresh read of the setting here is the original defect.
  assert.match(risk, /^ {4}cappedAtPct,$/m, 'sizeCalc must carry the local');
  assert.doesNotMatch(risk, /cappedAtPct:\s*Number\(risk\.maxEquityPerPositionPct/, 'the unconditional write must not return');
});

test('the cap, the field and the reason all read ONE resolved value', () => {
  assert.match(risk, /const maxEquityPerPositionPct = Number\(risk\.maxEquityPerPositionPct \?\? 5\);/);
  assert.match(risk, /const maxValue = equity \* \(maxEquityPerPositionPct \/ 100\);/);
  // the old duplicated `?? 5` inside the branch is gone
  assert.doesNotMatch(risk, /if \(size \* price > equity \* \(Number\(risk\.maxEquityPerPositionPct/);
});

// --- the reader --------------------------------------------------------------

test('the contract no longer treats cappedAtPct presence as proof', () => {
  assert.doesNotMatch(contracts, /const explained = s\.cappedAtPct != null/, 'the always-true predicate must be gone');
  assert.match(contracts, /const \{ explained, why \} = riskUnitExplain\(s\);/);
  // and it must not have re-introduced it under another name anywhere in the contract
  assert.doesNotMatch(contracts, /explained\s*=\s*[^\n;]*cappedAtPct/);
});

test('the explanation enum covers EXACTLY the controls risk.js can name', () => {
  // The two files must not drift: a fifth control added to risk.js without a label here would silently read as
  // "unexplained" and re-open the false-warning path. This is the cross-file pin.
  const written = [...risk.matchAll(/boundBy = '([A-Za-z_]+)'/g)].map((m) => m[1]);
  assert.ok(written.length >= 4, `expected the four control sites, found ${written.length}`);
  assert.deepEqual([...new Set(written)].sort(), Object.keys(fc.RISK_UNIT_CONTROL).sort());
});

test('the warn branch is reachable, and reads as the F20 premise intended', () => {
  // The comment above the predicate states the premise; the code must still implement it. Both must be present,
  // and the unreachable version must not come back.
  assert.match(contracts, /const unexplained = inert\.filter\(\(x\) => !x\.explained\);/);
  assert.match(contracts, /if \(unexplained\.length\) \{/);
});

// --- THE FALSE-WARNING TRAP, which is the half of this fix that is easy to get wrong --------------------
//
// Making `cappedAtPct` honest is only HALF the change. Measured on the newest 200 sizing events the moment the
// reader stopped trusting the field: **25 rows became "unexplained"** — and 24 of those carry the RISK cap's
// prose, not the notional cap's. A reader that knew only the notional wording would have swapped a false
// "explained" for a false "unexplained" on 12% of the window, which is precisely the trade TRD-RSK-11 forbade.

test('EVERY "capped" reason the writer can push is recognised, so the fix cannot invent false warnings', () => {
  // Cross-file: the templates are read from the WRITER, not restated here. A third cap added to risk.js without a
  // matching entry in the contract fails this test instead of silently reading as an unexplained mismatch.
  const templates = [...risk.matchAll(/reasons\.push\(`size capped at ([^`]*)`\)/g)].map((m) => m[1]);
  assert.ok(templates.length >= 2, `expected both cap reasons in risk.js, found ${templates.length}`);
  for (const t of templates) {
    const sample = `size capped at ${t.replace(/\$\{[^}]*\}/g, '7.5')}`;
    assert.equal(fc.riskUnitExplain({ reasons: [sample] }).explained, true, `unrecognised cap prose: ${sample}`);
  }
  // the risk cap's own wording, verbatim from event #105926
  const r = fc.riskUnitExplain({ reasons: ['size capped at 0.07% risk/trade (implied 1.000% of equity)'] });
  assert.equal(r.explained, true);
  assert.equal(r.why, 'risk cap bound (0.07%)');
});

// --- the second, independent reason a gap looked unexplained: THE WRONG DENOMINATOR ----------------------

test('realised risk prefers the writer own resolvedRiskPct over any derivation', () => {
  const r = fc.riskUnitRealised({ resolvedRiskPct: 0.3696, atr: 0.6662, equity: 4150, finalSize: 11.5 });
  assert.equal(r.source, 'resolvedRiskPct');
  assert.equal(r.realisedPct, 0.3696);
});

test('realised risk uses the stop the ticket ACTUALLY used - event #105926', () => {
  // The contract measured `finalSize x (atr x 2)`, but the reason line records the stop widened to 3x spread.
  const row = {
    equity: 4134.54, atr: 0.0278, finalSize: 8.5374, riskPct: 2,
    reasons: ['stop widened to 3x spread (0.3390 > 2xATR 0.0556)'],
  };
  const r = fc.riskUnitRealised(row);
  assert.equal(r.source, 'reason:widened');
  assert.equal(r.stopDist, 0.3390);
  assert.ok(Math.abs(r.realisedPct - 0.07) < 0.005, `expected ~0.07%, got ${r.realisedPct}`);
  // ★ AND THAT IS EXACTLY WHAT THE RISK CAP'S REASON SAYS. The gap was explained all along; the denominator was
  // wrong. This is the assertion that says the two halves of the fix have to travel together.
  assert.equal(fc.riskUnitExplain({ reasons: ['size capped at 0.07% risk/trade (implied 1.000% of equity)'] }).explained, true);
  // the approximation the old code used, for contrast: 6.1x smaller than the truth
  assert.ok(Math.abs((8.5374 * 0.0278 * 2 / 4134.54) * 100 - 0.0115) < 0.001, 'the old figure must be reproducible');
});

test('the approximation is used ONLY when nothing better exists, and it is REPORTED', () => {
  const r = fc.riskUnitRealised({ atr: 1, equity: 1000, finalSize: 10 });
  assert.equal(r.source, 'atr');
  assert.ok(Math.abs(r.realisedPct - 2) < 1e-9, '10 units at a 2.0 stop on 1000 equity is 2%');
  assert.match(contracts, /stop basis:/, 'the window must say which denominator the verdict rests on');
  assert.match(contracts, /unmeasurable/);
});

test('an unmeasurable row is named as unmeasurable, never silently counted as fine', () => {
  const r = fc.riskUnitRealised({ finalSize: 10 });
  assert.equal(r.realisedPct, null);
  assert.equal(r.source, 'unreadable');
  assert.match(contracts, /if \(got\.realisedPct == null\) \{ unmeasured\+\+; continue; \}/);
});

test('the contract no longer hardcodes the atr derivation for the gap', () => {
  assert.match(contracts, /const got = riskUnitRealised\(s, \{ stopMultiple \}\);/);
  assert.doesNotMatch(contracts, /const realisedPct = pct\(Number\(s\.finalSize\) \* stopDist/);
});
