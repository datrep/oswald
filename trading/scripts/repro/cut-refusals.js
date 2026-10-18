// trading/scripts/repro/cut-refusals.js — TRD-EXI-1b (#1490). Does the floor PAY, or does it only look prudent?
//
// THE FLOOR WAS JUSTIFIED ON ONE SIDE OF ITS OWN WORK. `minCutSavingR = 0.3` was set from 25 cuts the desk TOOK:
// right 14 times, wrong twice, and still net negative, because a correct cut saves ~0.158R while a wrong one
// forfeits ~2.70R. The cuts it now DECLINES were invisible — no close, so no autopsy, so no counterfactual — so
// nothing in that evidence could ever contradict the floor. This script reads the other side: every refusal is
// counterfactualised against the path that followed it, and the floor is re-priced on the population it governs.
//
// WHAT IT DOES. Settles any refusal whose horizon has elapsed or whose position has closed (the standing sweep
// does this continuously; running it here makes the read current), then joins each refusal to its verdict. It
// writes `cut_refusal_resolved` events and moves NO level, no metric and no rule.
//
// HOW TO READ THE FLOOR TABLE. Every row in the refusal log was declined under the floor in force, so the table
// answers exactly one question: **what would LOWERING the floor to f change, in R?** A record with `savingR >= f`
// would have been CUT under that lower floor instead of held, so the delta is `-Σ refusalValueR` over those rows.
// A NEGATIVE delta means the floor earned what it cost - refusing them was right, and lowering would give it back.
//
// ★ THE LIMIT, AND IT IS NOT COSMETIC. The gate writes no refusal ABOVE its own floor, so this record can only
// price floors at or below the current one. It CAN confirm 0.3 or argue for lowering it. It CANNOT justify
// RAISING it: a floor of 0.5 would be measured on cuts that were taken, and asking "what if we had held that one"
// needs the forward path replayed PAST the close, which is `exit-policy-study.js`'s machinery, not this one.
//
// Usage (from the repo root):  node trading/scripts/repro/cut-refusals.js
'use strict';

const store = require('../../store');
const autopsy = require('../../agent/autopsy');

const USER_ID = Number(process.env.TRADING_USER_ID || 1);
const FLOORS = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3];

const n2 = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(2));

(async () => {
  const swept = await autopsy.resolveCutRefusals(USER_ID, { resolvedBy: 'sweep' });
  console.log('refusals:', JSON.stringify(swept));

  const [refused, resolved] = await Promise.all([
    store.listEventsAll(USER_ID, { kind: 'cut_refused' }),
    store.listEventsAll(USER_ID, { kind: 'cut_refusal_resolved' }),
  ]);
  if (refused.truncated || resolved.truncated) {
    console.log('WARNING: an event page cap was hit — the counts below are a FLOOR, not a total.');
  }

  const latest = new Map();
  for (const e of refused.rows) {
    const p = e.payload;
    if (p && p.refusalId && !latest.has(p.refusalId)) latest.set(p.refusalId, p);
  }
  const settled = new Map();
  for (const e of resolved.rows) {
    const p = e.payload;
    if (p && p.refusalId && !settled.has(p.refusalId)) settled.set(p.refusalId, p);
  }

  console.log(`\n${latest.size} refusal(s) on record, ${settled.size} settled`);
  const rows = [...latest.values()].map((p) => ({ refusal: p, r: settled.get(p.refusalId) || null }));
  const measured = rows.filter((x) => x.r && x.r.refusalValueR != null);
  const unmeasured = rows.filter((x) => !x.r || x.r.refusalValueR == null);

  if (!measured.length) {
    console.log('\nNOTHING MEASURABLE YET. Under the floor in force, a refusal only starts arriving once the');
    console.log('desk is being declined decisions it would have taken — and each one needs its horizon to elapse');
    console.log('(or its position to close) before it can be judged. Nothing below is an estimate of the answer.');
    process.exit(0);
  }

  // ── the tally, which is the thing the take-side count could never produce ──────────────────────────────────
  const byVerdict = {};
  for (const x of measured) {
    const v = x.r.verdict || 'unknown';
    byVerdict[v] = byVerdict[v] || { n: 0, sum: 0 };
    byVerdict[v].n++;
    byVerdict[v].sum += Number(x.r.refusalValueR);
  }
  const total = measured.reduce((a, x) => a + Number(x.r.refusalValueR), 0);
  console.log('\nwhat the refusals were WORTH  (positive = refusing was right, in R)');
  console.log('verdict'.padEnd(14), 'n'.padStart(4), 'total R'.padStart(9), 'mean R'.padStart(8));
  for (const [v, s] of Object.entries(byVerdict).sort((a, b) => b[1].sum - a[1].sum)) {
    console.log(v.padEnd(14), String(s.n).padStart(4), s.sum.toFixed(2).padStart(9), (s.sum / s.n).toFixed(2).padStart(8));
  }
  console.log('TOTAL'.padEnd(14), String(measured.length).padStart(4), total.toFixed(2).padStart(9), (total / measured.length).toFixed(2).padStart(8));
  const hard = measured.filter((x) => x.r.heldOutcomeSource === 'actual_close');
  console.log(`\nheld outcomes: ${hard.length} from a REAL close, ${measured.length - hard.length} from a mark at the window's end.`);
  if (hard.length) {
    const hardSum = hard.reduce((a, x) => a + Number(x.r.refusalValueR), 0);
    console.log(`the ${hard.length} closed ones alone: ${hardSum.toFixed(2)}R (${(hardSum / hard.length).toFixed(2)}R each) — the harder number, and worth reading before the pooled one.`);
  }

  const savings = measured.map((x) => Number(x.refusal.savingR)).filter((v) => Number.isFinite(v));
  const lo = Math.min(...savings);
  const hi = Math.max(...savings);
  console.log(`\nsavings the floor ruled on: ${lo.toFixed(3)}R .. ${hi.toFixed(3)}R (the floor in force refuses below its own value — nothing above it can appear here)`);

  // ── the floor table ────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nlowering the floor from 0.3 to f  —  what changes, in R');
  console.log('floor'.padEnd(8), 'refused'.padStart(8), 'cut instead'.padStart(12), 'delta R'.padStart(9), 'per cut'.padStart(9), 'read');
  const floorInForce = Number(measured[0].refusal.minSavingR) || 0.3;
  for (const f of FLOORS.filter((v) => v <= floorInForce + 1e-9)) {
    const flipped = measured.filter((x) => Number(x.refusal.savingR) >= f);
    const delta = -flipped.reduce((a, x) => a + Number(x.r.refusalValueR), 0);
    const read = !flipped.length ? 'no change'
      : delta < -0.5 ? 'floor EARNS its cost'
        : delta > 0.5 ? 'floor COSTS more than it saves'
          : 'within noise';
    console.log(
      f.toFixed(2).padEnd(8), String(flipped.length).padStart(8), String(measured.length - flipped.length).padStart(12),
      delta.toFixed(2).padStart(9), (flipped.length ? (delta / flipped.length).toFixed(2) : '—').padStart(9), ` ${read}`,
    );
  }

  // ── per refusal, so a total can always be taken apart ──────────────────────────────────────────────────────
  console.log('\nper refusal');
  console.log(['refusalId', 'sym', 'savingR', 'held', 'cut', 'value', 'verdict', 'heldFrom'].map((s) => String(s).padStart(12)).join(''));
  for (const x of rows) {
    const r = x.r || {};
    console.log([
      x.refusal.refusalId, x.refusal.symbol, n2(x.refusal.savingR) + 'R',
      n2(r.heldOutcomeR), n2(r.cutOutcomeR), n2(r.refusalValueR), r.verdict || 'PENDING', r.heldOutcomeSource || '—',
    ].map((s) => String(s).padStart(12)).join(''));
  }
  if (unmeasured.length) {
    console.log(`\n${unmeasured.length} refusal(s) NOT yet measurable — horizon open, no observations inside it, or a`);
    console.log('bad instant. They are COUNTED here rather than dropped, because a refusal that quietly fails to');
    console.log('resolve is the original defect wearing a different hat.');
    for (const x of unmeasured) {
      console.log(`  ${x.refusal.refusalId}  ${x.refusal.symbol}  savingR ${n2(x.refusal.savingR)}  ${x.r ? x.r.verdict : 'never settled'}`);
    }
  }

  console.log('\nCAUTION: n is small and the VALUE distribution is skewed — a refusal that kept a winner is worth');
  console.log('several units, one that cost the saving is worth a fraction of one. Read the tally BEFORE the mean,');
  console.log('and read the closed-only figure before the pooled one.');
  process.exit(0);
})().catch((e) => {
  console.error('failed:', e && e.message ? e.message : e);
  process.exit(1);
});
