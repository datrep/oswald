// trading/scripts/repro/parity-horizon.js — how long until the parity gate opens, measured.
//
// Companion to `parity-preview.js`. That one prints the verdict TODAY and `requiredSample` at
// today's look count; this one closes the loop, because the look budget grows on a clock while the
// sample grows at the rate the desk actually closes trades, so the target is a FIXED POINT rather
// than a snapshot. `agent/parityHorizon.js` holds the arithmetic (pure, tested); this file only
// measures the inputs and prints.
//
// WRITES NOTHING: no settings change, no event, no alert, no retirement. Read-only by construction.
//
// Usage: node trading/scripts/repro/parity-horizon.js [--user 1] [--looks N] [--looks-per-week N]
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const store = require('../../store');
const { strategyStats } = require('../../agent/analytics');
const { ratePerDay, horizon } = require('../../agent/parityHorizon');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const userId = Number(arg('--user', 1)) || 1;
const looksArg = arg('--looks', null);
const looksPerWeek = Number(arg('--looks-per-week', 1)) || 1;

const r4 = (x) => (Number.isFinite(x) ? Number(x.toFixed(4)) : x);
const day = (d) => new Date(d).toISOString().slice(0, 10);

(async () => {
  const settings = await store.getSettings(userId);
  const p = (settings.learning && settings.learning.parity) || {};
  const minTrades = Math.max(3, Number(p.minTrades) || 10);
  const alpha = Number(p.alpha) || 0.05;
  const enabled = (settings.strategies && settings.strategies.enabled) || [];
  const validated = !!(settings.learning && settings.learning.parityValidated);

  const priorLooks = await store.countEventsSince(userId, 'parity_check', 365 * 24 * 60).catch(() => 0);
  const looks = looksArg != null ? Number(looksArg) : Number(priorLooks || 0) + 1;

  const stats = await strategyStats(userId, { days: 90 });
  const trades = await store.listTrades(userId, { limit: 500 });
  const now = Date.now();

  console.log(`parity horizon — user ${userId}, alpha ${alpha}, minTrades ${minTrades}`);
  console.log(`looks ${looks} (${priorLooks} prior parity check(s)), +${looksPerWeek}/week`);
  console.log(`parityValidated ${validated} -> runInFactor ${validated ? 1 : 0.5}`);
  console.log(`enabled: ${enabled.length ? enabled.join(', ') : '(none)'}`);
  console.log('NOTHING IS WRITTEN.\n');

  // Arrival rate per strategy, from the ledger. Rejected orders are not arrivals and mirrored rows
  // were never the desk's to count, so both are excluded before the span is taken.
  const closesFor = (id) => trades
    .filter((t) => t.strategyId === id && t.status === 'closed' && t.closeAt)
    .map((t) => t.closeAt);

  const rows = [];
  for (const s of stats.filter((x) => x.strategy !== 'unknown')) {
    const rate = ratePerDay(closesFor(s.strategy), { now });
    const h = horizon(
      { n: s.rTrades, meanR: s.meanR, sdR: s.sdR },
      { alpha, minTrades, looks, ratePerDay: rate.perDay, looksPerWeek },
    );
    rows.push({ s, rate, h, enabled: enabled.includes(s.strategy) });
  }

  const t = (s, w) => String(s).padEnd(w);
  console.log(`  ${t('strategy', 12)} ${t('on', 4)} ${t('R n', 5)} ${t('mean R', 9)} ${t('sd R', 8)} ${t('/day', 7)} ${t('snapshot', 10)} ${t('fixed point', 12)} ${t('target', 9)} ${t('wait', 12)}`);
  for (const { s, rate, h, enabled: on } of rows) {
    const snap = h.naive.acceptAt != null ? `n=${h.naive.acceptAt}` : (h.naive.unreachable ? 'never' : '?');
    const fixed = !h.coupled ? '—'
      : h.coupled.accepted ? `n=${h.coupled.n} @L${h.coupled.looks}`
        : h.coupled.retired ? `retire n=${h.coupled.n}` : 'beyond horizon';
    const target = h.coupled && h.coupled.targetAtAccept != null ? `n=${h.coupled.targetAtAccept}` : '—';
    const wait = !h.coupled ? '—'
      : h.coupled.retired ? `${h.coupled.weeks}w to retire`
        : h.coupled.accepted ? `${h.coupled.weeks}w (~${day(now + h.coupled.days * 86400000)})` : '—';
    console.log(`  ${t(s.strategy, 12)} ${t(on ? 'yes' : 'no', 4)} ${t(s.rTrades, 5)} ${t(r4(s.meanR), 9)} ${t(r4(s.sdR), 8)} ${t(rate.perDay == null ? '—' : rate.perDay.toFixed(2), 7)} ${t(snap, 10)} ${t(fixed, 12)} ${t(target, 9)} ${t(wait, 12)}`);
    if (h.coupled && h.coupled.inflation) console.log(`               the snapshot understates the bar by ${h.coupled.inflation.toFixed(2)}x — the target grows while you wait`);
    for (const nt of h.notes) console.log(`               ! ${nt}`);
  }

  // THE SPILLOVER. parityValidated is DERIVED as "at least one enabled strategy reached accept"
  // (analytics.parityCheck) and then applied desk-wide (risk.runInFactor). So the first strategy to
  // clear the bar hands FULL SIZE to every other strategy, including ones whose own evidence is
  // nowhere near. Printing the pair makes that visible before it fires.
  const on = rows.filter((r) => r.enabled && r.h.coupled && r.h.coupled.accepted);
  if (on.length >= 2) {
    const first = on.reduce((a, b) => (a.h.coupled.weeks <= b.h.coupled.weeks ? a : b));
    const rest = on.filter((r) => r !== first);
    console.log(`\n  SPILLOVER: ${first.s.strategy} clears the bar first (week ${first.h.coupled.weeks}); at that moment`);
    console.log(`  parityValidated flips true for the WHOLE DESK, so runInFactor goes 0.5 -> 1 for:`);
    for (const r of rest) {
      const at = r.h.coupled.weeks;
      console.log(`    ${r.s.strategy} — its own verdict at that point is ${at <= first.h.coupled.weeks ? 'already accept' : `still undecided (its own fixed point is week ${at})`}`);
    }
  } else if (on.length === 1) {
    console.log(`\n  only ${on[0].s.strategy} reaches accept inside the horizon — no spillover in view,`);
    console.log(`  but parityValidated would still be desk-wide the moment it does.`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
