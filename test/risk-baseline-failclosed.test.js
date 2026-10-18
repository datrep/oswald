// test/risk-baseline-failclosed.test.js — TRD-109: the baseline chain fails CLOSED (2026-09-20).
//
// THE DEFECT. Both risk baselines answered "false" — the same answer as "safe" — in every state where they
// could not be evaluated:
//
//   * `killswitch.floorBreached` returned false on a missing or non-numeric baseline. With
//     `kill.initialEquity` absent the chain therefore fell to `risk.initialEquity` — a stale hardcoded
//     2,685.76 against an equity near 4,000 — so the −8% disaster floor would not fire until roughly −38%,
//     and every surface still reported the desk as armed. Measured on the live settings 2026-09-20.
//   * `risk.dayStartEquity` ended `... || 0` and WROTE that zero as the day's start, and `dailyHaltActive`
//     read `start <= 0` as "not halted". The 3% daily halt switched itself off in exactly the state where
//     nothing was known — a silent off switch is worse than a loud halt.
//
// WHAT IS PINNED, AND WHY IT IS PURE. The rule is the thing that was wrong, and the rule is the thing that
// must not drift. The fix is a THIRD answer ('unusable', alongside 'ok' and 'breached'); and the asymmetry
// that makes it safe — entries fail CLOSED, the evacuation of a book stays narrow — is pinned as a RELATION
// between two files rather than restated as prose, because prose is what drifted the first time.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');

const killswitch = require('../trading/agent/killswitch');
const risk = require('../trading/agent/risk');

const GOOD = { kill: { disasterFloorPct: -8, initialEquity: 4000 } };

// --- the floor -----------------------------------------------------------------

test('floorState has THREE states, and "cannot be evaluated" is neither of the old two', () => {
  assert.strictEqual(killswitch.floorState(GOOD, 4000).status, 'ok');
  assert.strictEqual(killswitch.floorState(GOOD, 3600).status, 'breached', 'a −10% drawdown is past a −8% floor');
  assert.strictEqual(killswitch.floorState(GOOD, 3680).status, 'breached', 'the boundary itself is a breach');
  assert.strictEqual(killswitch.floorState(GOOD, 3680.01).status, 'ok', 'and one tick inside it is not');
  assert.strictEqual(killswitch.floorState(GOOD, 3600).pct, -10);

  const unusable = [
    [{ kill: { disasterFloorPct: -8 } }, 4000, 'no baseline at all'],
    [{ kill: { disasterFloorPct: -8, initialEquity: 0 } }, 4000, 'a zero baseline'],
    [{ kill: { disasterFloorPct: -8, initialEquity: null } }, 4000, 'a null baseline'],
    [{ kill: { disasterFloorPct: -8, initialEquity: 'n/a' } }, 4000, 'a non-numeric baseline'],
    [{ kill: { disasterFloorPct: -8, initialEquity: 4000 } }, null, 'no equity'],
    [{ kill: { disasterFloorPct: -8, initialEquity: 4000 } }, 'abc', 'a non-numeric equity'],
    [{ kill: { disasterFloorPct: -8, initialEquity: 4000 } }, '', 'an empty equity'],
    [{ kill: { initialEquity: 4000 } }, 4000, 'no floor percentage'],
    [{}, 4000, 'no kill block'],
    [undefined, 4000, 'no settings at all'],
  ];
  for (const [settings, equity, why] of unusable) {
    const st = killswitch.floorState(settings, equity);
    assert.strictEqual(st.status, 'unusable', `${why} must be UNUSABLE, never silently "safe"`);
    assert.ok(st.reason, `${why} must name the input that failed`);
  }
});

test('a FALLBACK baseline is reported as a fallback — the number was never the whole problem', () => {
  const st = killswitch.floorState({ kill: { disasterFloorPct: -8 }, risk: { initialEquity: 2685.76 } }, 4000);
  assert.strictEqual(st.status, 'ok', 'it can still be evaluated — the defect is that it was evaluated silently');
  assert.strictEqual(st.source, 'risk_legacy', 'which baseline was used is part of the answer');
  assert.strictEqual(st.initial, 2685.76);
  assert.match(st.reason, /risk\.initialEquity/);

  // The defect as arithmetic: the same equity is ~49% ABOVE the fallback, and the floor it actually arms is
  // ~38 points below where the desk believes it is.
  assert.ok(Math.abs(st.pct - 48.94) < 0.01, `expected ~+48.94%, got ${st.pct}`);
  const fallbackBreach = killswitch.floorState({ kill: { disasterFloorPct: -8 }, risk: { initialEquity: 2685.76 } }, 2470);
  assert.strictEqual(fallbackBreach.status, 'breached', 'this is where the floor fires when the fallback is in use');
  assert.strictEqual(killswitch.floorState(GOOD, 2470).pct, -38.25, 'against a real baseline, −38.25%');

  // A usable kill.initialEquity always wins, and says so.
  const normal = killswitch.floorState({ kill: { disasterFloorPct: -8, initialEquity: 4000 }, risk: { initialEquity: 2685.76 } }, 4000);
  assert.strictEqual(normal.source, 'kill');
  assert.strictEqual(normal.reason, null);
});

test('floorBreached does NOT evacuate on a baseline it cannot read', () => {
  // This is the asymmetry that makes the fix safe: evacuating is irreversible, refusing an entry is not, so
  // the boolean keeps its narrow meaning and only the ENTRY path became strict.
  assert.strictEqual(killswitch.floorBreached({ kill: { disasterFloorPct: -8 } }, 100), false,
    'a missing baseline is not a breach — it must not close a book');
  assert.strictEqual(killswitch.floorBreached({}, 100), false);
  assert.strictEqual(killswitch.floorBreached(GOOD, 3000), true);
  assert.strictEqual(killswitch.floorBreached(GOOD, 4000), false);
});

// --- the day-start and the daily halt ------------------------------------------

test('the day-start is RESOLVED, and an unusable one is null rather than zero', () => {
  const today = '2026-09-21';

  const logged = risk.resolveDayStart({ today, loggedDate: today, loggedEquity: 3965.09, equity: 4000 });
  assert.strictEqual(logged.equity, 3965.09, "today's logged start is the start — the live read does not overwrite it");
  assert.strictEqual(logged.write, false, 'and nothing is written');
  assert.strictEqual(logged.source, 'logged');

  const stale = risk.resolveDayStart({ today, loggedDate: '2026-09-20', loggedEquity: 3965.09, equity: 4001 });
  assert.strictEqual(stale.equity, 4001, "yesterday's row is not today's start");
  assert.strictEqual(stale.write, true);
  assert.strictEqual(stale.source, 'live');

  // THE DEFECT ITSELF: nothing usable anywhere must be null, never 0 — a 0 here is what silently switched
  // the daily halt off, because `start <= 0` read as "not halted".
  const none = risk.resolveDayStart({ today, loggedDate: null, equity: null, baseline: null });
  assert.strictEqual(none.equity, null, 'a zero written from nothing is the fail-OPEN answer this replaces');
  assert.strictEqual(none.write, false, 'nothing may be logged from nothing');
  assert.match(none.reason, /live read and kill\.initialEquity/);

  // The baseline is the documented second choice, and a zero live read is not an equity.
  assert.strictEqual(risk.resolveDayStart({ today, equity: null, baseline: 4113.14 }).source, 'baseline');
  assert.strictEqual(risk.resolveDayStart({ today, equity: 0, baseline: 4113.14 }).equity, 4113.14);
  assert.strictEqual(risk.resolveDayStart({ today, equity: 'abc', baseline: 4113.14 }).equity, 4113.14);

  // A logged ZERO for today is REPAIRED, not honoured — one bad row must not cost the day.
  const repaired = risk.resolveDayStart({ today, loggedDate: today, loggedEquity: 0, equity: 4000 });
  assert.strictEqual(repaired.equity, 4000);
  assert.strictEqual(repaired.write, true);
  assert.strictEqual(repaired.repairedFrom, 0, 'the repair says what it replaced, so the log can show it');

  // ...but a repair with nothing to repair FROM is still null.
  const unrepairable = risk.resolveDayStart({ today, loggedDate: today, loggedEquity: 0, equity: null, baseline: null });
  assert.strictEqual(unrepairable.equity, null);
});

test('the daily halt HALTS when it cannot be evaluated, and only a configured 0 turns it off', () => {
  // Normal arithmetic is unchanged.
  assert.deepStrictEqual(
    risk.dailyHaltVerdict({ thresholdPct: 3, dayStart: 4000, equity: 3880 }),
    { halted: true, dayStart: 4000, drawdownPct: -3, thresholdPct: 3 });
  assert.strictEqual(risk.dailyHaltVerdict({ thresholdPct: 3, dayStart: 4000, equity: 3900 }).halted, false, '-2.5% is inside a 3% halt');

  // FAIL CLOSED: an unusable day-start is a HALT, not a free pass.
  for (const ds of [null, 0, -1, undefined, 'abc', NaN]) {
    const v = risk.dailyHaltVerdict({ thresholdPct: 3, dayStart: ds, equity: 4000 });
    assert.strictEqual(v.halted, true, `dayStart ${JSON.stringify(ds)} must halt, not pass`);
    assert.match(v.reason, /cannot be evaluated/);
    assert.strictEqual(v.drawdownPct, undefined, 'there is no percentage to report, and none is invented');
  }

  // An unreadable equity is also a halt, for the same reason.
  const noEq = risk.dailyHaltVerdict({ thresholdPct: 3, dayStart: 4000, equity: null });
  assert.strictEqual(noEq.halted, true);
  assert.match(noEq.reason, /equity unavailable/);

  // A threshold of 0 is CONFIGURED off, and says so rather than looking identical to "did not trigger".
  assert.deepStrictEqual(risk.dailyHaltVerdict({ thresholdPct: 0 }), { halted: false, disabled: true, thresholdPct: 0 });
  assert.deepStrictEqual(risk.dailyHaltVerdict({ thresholdPct: -1 }), { halted: false, disabled: true, thresholdPct: -1 });

  // A threshold that is not a number is not a licence to skip the comparison.
  assert.strictEqual(risk.dailyHaltVerdict({ thresholdPct: 'abc', dayStart: 4000, equity: 4000 }).halted, true);
});

// --- where the strictness is allowed to bite -----------------------------------

test('the entry veto sits BELOW the exit short-circuit, and asks the three-state question', () => {
  const src = code('trading/agent/risk.js');

  const exitAt = src.indexOf("if (!proposal || proposal.type !== 'entry') return v;");
  const floorAt = src.indexOf("require('./killswitch').floorState(settings, equity)");

  assert.ok(exitAt > -1, 'the exit short-circuit must still exist');
  assert.ok(floorAt > -1, 'the entry guard must ask the question with three answers, not two');
  assert.ok(floorAt > exitAt,
    'an EXIT must never be refused for a missing baseline — the guard belongs below the short-circuit');
  assert.ok(src.indexOf('floorBreached(') === -1,
    'the entry path must not use the boolean the irreversible caller uses');
  assert.match(src, /floor\.status === 'unusable' \|\| floor\.source === 'risk_legacy'/,
    'both the absent baseline AND the silent fallback refuse entries');
});
