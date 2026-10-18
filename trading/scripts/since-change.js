// trading/scripts/since-change.js — measure the desk on trades closed AFTER a declared change,
// and REFUSE to hand down a verdict while that sample is too small to carry one.
//
// WHY THIS EXISTS. Every statistic the desk already publishes is a ROLLING window (`days: 90` in
// `parityCheck`, `days: 90` in `netEdge`, `days: 30` by default in `strategyStats`). A rolling
// window pools trades from before a code change with trades from after it and reports their
// average as though it described one regime. When the change is the thing being evaluated that is
// not a rounding error, it is the whole measurement — the pre-change trades outvote the
// post-change ones for as long as the window is longer than the change is old, and they never
// stop being counted, they just slowly stop mattering.
//
// So this tool takes the one input a rolling window cannot express: an ABSOLUTE instant. Trades
// closed before it are removed from the population entirely. They are printed at the end for
// contrast and they are never mixed into a statistic, a verdict, or an alpha-spending count.
//
// The statistic is not reimplemented here. `rStats` and `expectancyVerdict` are imported from
// `agent/expectancy.js` — the same functions the live harness calls — because a measurement tool
// that computes its own mean R is measuring a different quantity from the one the gate applies,
// and the two would drift apart without either of them being obviously wrong.
//
// ★ LOOKING WITH THIS TOOL IS FREE. LOOKING WITH THE HARNESS IS NOT.
// Every logged `parity_check` spends alpha, and a tighter critical value needs a bigger sample, so
// running the real harness "just to see" permanently raises its own bar (TRD-41/TRD-110). This
// script writes nothing, logs nothing and counts no look, so it can be run as often as the sample
// is worth re-reading.
//
// Usage:
//   node trading/scripts/since-change.js --since 2026-09-23T00:00:00Z
//   node trading/scripts/since-change.js --since <ISO> [--user 1] [--min-trades 20]
//                                       [--min-days 0] [--alpha 0.05] [--json]
//
// Exit codes: 0 = at least one verdict produced · 4 = REFUSED (sample too thin — the normal
// outcome for a while) · 2 = bad usage · 3 = runtime failure.
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const store = require('../store');
const { rStats, expectancyVerdict, requiredSample, num } = require('../agent/expectancy');

const NO_VERDICT = 'NO VERDICT';

// ── pure core (exported so it can be tested without a database) ────────────────────────────────

// Split closed trades into the ones the change can be judged on and the ones it cannot.
// A trade with no readable closeAt belongs to neither population — it is dropped rather than
// guessed into one, because guessing it into `post` would inflate the sample under test.
//
// ★ `new Date(null)` IS 1970-01-01, NOT "INVALID" — found by test, 2026-09-24. It is a finite
// timestamp, so the `Number.isFinite` guard below cannot see it and a null closeAt would be filed
// as a pre-change trade from the epoch. That never reaches a verdict (it lands in the excluded set)
// but it would pad the contrast table with rows that never happened, which is exactly the kind of
// plausible-looking wrongness this tool is supposed to remove. So nullish and empty are rejected
// BEFORE the Date is constructed.
function partition(rows, since) {
  const cut = new Date(since).getTime();
  const post = [];
  const pre = [];
  for (const r of rows || []) {
    const raw = r.closeAt;
    if (raw == null || raw === '') continue;
    const at = new Date(raw).getTime();
    if (!Number.isFinite(at)) continue;
    if (at >= cut) post.push(r); else pre.push(r);
  }
  return { post, pre };
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

// Excursions are DESCRIPTIVE: they answer "did price move far enough to pay the spread", which is a
// different question from the R-multiple verdict and must never be dressed up as one.
function excursions(trades) {
  const mfe = [];
  const mae = [];
  for (const t of trades) {
    const m = num(t.mfePct);
    if (Number.isFinite(m)) mfe.push(m);
    const a = num(t.maePct);
    if (Number.isFinite(a)) mae.push(a);
  }
  const mfeMean = mean(mfe);
  const maeMean = mean(mae);
  return {
    mfe: mfeMean,
    mae: maeMean,
    mfeN: mfe.length,
    maeN: mae.length,
    // Gross of costs, and labelled so: the cost constants are a separate live read and folding them
    // in here would make one number mean two things.
    grossEdge: mfeMean != null && maeMean != null ? mfeMean - Math.abs(maeMean) : null,
  };
}

function measure(trades) {
  const rs = rStats(trades);
  const exc = excursions(trades);
  return {
    trades: trades.length,
    rTrades: rs.n,
    rExcluded: rs.excluded,
    meanR: rs.meanR,
    sdR: rs.sdR,
    ...exc,
  };
}

// The verdict, or an explicit refusal. The floor is enforced by `expectancyVerdict` itself — the
// same `minTrades` the live gate uses — so this tool cannot drift from the rule it is previewing.
function verdictFor(m, opts) {
  const v = expectancyVerdict({ n: m.rTrades, meanR: m.meanR, sdR: m.sdR }, opts);
  if (v.state === 'insufficient') {
    return { state: NO_VERDICT, refused: true, reason: v.reason, n: m.rTrades };
  }
  return { ...v, refused: false };
}

// ── rendering ─────────────────────────────────────────────────────────────────────────────────
const t = (s, w) => String(s).padEnd(w);
const r4 = (x) => (Number.isFinite(x) ? Number(x.toFixed(4)) : null);
const r2 = (x) => (Number.isFinite(x) ? Number(x.toFixed(2)) : null);
const GLYPH = { [NO_VERDICT]: '·', accept: '+', retire: '-', undecided: '?' };

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return dflt;
    const v = argv[i + 1];
    return v == null || v.startsWith('--') ? true : v;
  };
  const asJson = argv.includes('--json');

  const since = flag('since', null);
  if (!since || since === true) {
    console.error('since-change: --since <ISO instant> is REQUIRED.');
    console.error('  A rolling window is exactly what this tool exists to avoid, so the change');
    console.error('  boundary is never guessed. Example:');
    console.error('    node trading/scripts/since-change.js --since 2026-09-23T00:00:00Z');
    process.exit(2);
  }
  const cut = new Date(since);
  if (!Number.isFinite(cut.getTime())) {
    console.error(`since-change: --since "${since}" is not a readable instant. Use ISO-8601, e.g. 2026-09-23T00:00:00Z.`);
    process.exit(2);
  }

  const userId = Number(flag('user', 1)) || 1;
  const settings = await store.getSettings(userId);
  const p = (settings.learning && settings.learning.parity) || {};
  const alpha = Number(flag('alpha', Number(p.alpha) || 0.05)) || 0.05;
  const minTrades = Math.max(3, Number(flag('min-trades', Number(p.minTrades) || 20)) || 20);
  const minDays = Math.max(0, Number(flag('min-days', 0)) || 0);

  // The alpha-spending schedule is a property of the harness, not of this script. It is reported so
  // the boundary below is the boundary the gate would actually apply, even though no look is spent.
  const priorLooks = await store.countEventsSince(userId, 'parity_check', 365 * 24 * 60).catch(() => 0);
  const looks = Number(priorLooks || 0) + 1;

  // One read, then split in memory. `limit` is saturated deliberately: the store clamps at 2000, so
  // saturation is detectable, and a silently truncated population is the one failure mode that would
  // make every number below quietly wrong.
  const LIMIT = 2000;
  const rows = await store.listClosedTradesForStats(userId, { days: 3650, limit: LIMIT });
  const saturated = rows.length >= LIMIT;
  const { post, pre } = partition(rows, cut);

  const elapsedDays = Math.max(0, (Date.now() - cut.getTime()) / 86400000);

  const byStrategy = (list) => {
    const m = new Map();
    for (const tr of list) {
      const key = tr.strategyId || 'unknown';
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(tr);
    }
    return m;
  };
  const postBy = byStrategy(post);
  const preBy = byStrategy(pre);

  const results = [];
  for (const [strategy, trades] of postBy) {
    const m = measure(trades);
    const v = verdictFor(m, { alpha, looks, minTrades });
    const need = requiredSample({ meanR: m.meanR, sdR: m.sdR }, { alpha, looks, minTrades });
    const preM = preBy.has(strategy) ? measure(preBy.get(strategy)) : null;
    results.push({ strategy, ...m, verdict: v, need, pre: preM ? { trades: preM.trades, rTrades: preM.rTrades, meanR: preM.meanR, sdR: preM.sdR } : null });
  }
  results.sort((a, b) => b.rTrades - a.rTrades || String(a.strategy).localeCompare(String(b.strategy)));

  const timeFloorOk = elapsedDays >= minDays;
  const verdicts = results.filter((r) => !r.verdict.refused && timeFloorOk);
  const refused = results.filter((r) => r.verdict.refused || !timeFloorOk);

  if (asJson) {
    console.log(JSON.stringify({
      since: cut.toISOString(), userId, elapsedDays: r4(elapsedDays), alpha, looks, minTrades, minDays,
      saturatedAt: saturated ? LIMIT : null,
      excludedPreChange: pre.length,
      strategies: results.map((r) => ({ ...r, verdict: { ...r.verdict } })),
      producedVerdicts: verdicts.length,
      note: 'Every statistic is computed from post-change closes only. Pre-change closes are excluded from all statistics, verdicts and look counts.',
    }, null, 2));
    process.exit(verdicts.length ? 0 : 4);
  }

  console.log(`since-change — trades CLOSED at/after ${cut.toISOString()}`);
  console.log(`user ${userId} · ${r4(elapsedDays)} day(s) elapsed · alpha ${alpha} · looks ${looks} · floor n>=${minTrades}${minDays ? ` · floor ${minDays} day(s)` : ''}`);
  if (saturated) console.log(`!! the trade read saturated at ${LIMIT} rows — counts below may be truncated. Narrow the window before trusting them.`);
  console.log('');
  console.log('★ EVERY NUMBER BELOW IS COMPUTED FROM POST-CHANGE CLOSES ONLY.');
  console.log(`  ${pre.length} pre-change close(s) exist and were EXCLUDED — from the statistics, from the`);
  console.log('  verdicts, and from the alpha-spending count. They appear at the end for contrast only.');
  console.log('');

  if (!post.length) {
    console.log('  no closed trade has been recorded since the change. Nothing to measure yet.');
    console.log('');
  } else {
    console.log(`  ${t('strategy', 14)} ${t('closes', 7)} ${t('R n', 5)} ${t('no-stop', 8)} ${t('mean R', 9)} ${t('sd R', 8)} ${t('MFE%', 8)} ${t('MAE%', 8)} ${t('gross', 8)}`);
    for (const r of results) {
      console.log(`  ${t(r.strategy, 14)} ${t(r.trades, 7)} ${t(r.rTrades, 5)} ${t(r.rExcluded, 8)} ${t(r4(r.meanR) ?? '-', 9)} ${t(r4(r.sdR) ?? '-', 8)} ${t(r2(r.mfe) ?? '-', 8)} ${t(r2(r.mae) ?? '-', 8)} ${t(r2(r.grossEdge) ?? '-', 8)}`);
    }
    console.log('  (gross = mean MFE% − |mean MAE%|, before costs. MFE/MAE are descriptive, not a verdict.)');
    console.log('');
  }

  console.log('VERDICT');
  if (!results.length) {
    console.log(`  ${GLYPH[NO_VERDICT]} nothing to judge.`);
  } else if (!timeFloorOk) {
    console.log(`  ${GLYPH[NO_VERDICT]} REFUSED — only ${r4(elapsedDays)} day(s) have elapsed and the floor is ${minDays}.`);
    console.log('    A thin sample is not corrected by a shorter wait; it is corrected by waiting longer.');
  } else {
    for (const r of results) {
      const v = r.verdict;
      if (v.refused) {
        console.log(`  ${GLYPH[NO_VERDICT]} ${t(r.strategy, 14)} NO VERDICT — ${v.reason}`);
      } else {
        const ci = Number.isFinite(v.lower) ? `95% CI on mean R [${r4(v.lower)}, ${r4(v.upper)}]` : '';
        console.log(`  ${GLYPH[v.state] || '?'} ${t(r.strategy, 14)} ${t(v.state, 11)} boundary ${r4(v.boundary)}  ${ci}`);
      }
    }
  }
  console.log('');

  if (results.length) {
    const judgeable = results.filter((r) => r.rTrades > 0);
    if (judgeable.length) {
      console.log('HOW FAR AWAY IS A VERDICT? (observed mean/sd held fixed — a SCALE, not a forecast)');
      for (const r of judgeable) {
        const n = r.need;
        const at = n.acceptAt != null ? `accept at n=${n.acceptAt}`
          : n.unreachable ? 'acceptance unreachable at ANY n (mean R <= 0)'
            : `accept beyond n=5000`;
        const rt = n.retireAt != null ? ` · retire at n=${n.retireAt}` : '';
        console.log(`  ${t(r.strategy, 14)} ${at}${rt}   (have ${r.rTrades} R-measurable)`);
      }
      console.log('');
    }
  }

  if (pre.length) {
    console.log(`EXCLUDED — ${pre.length} pre-change close(s), shown for contrast ONLY (not in any statistic above)`);
    console.log(`  ${t('strategy', 14)} ${t('closes', 7)} ${t('R n', 5)} ${t('mean R', 9)} ${t('sd R', 8)}`);
    for (const [strategy, trades] of [...preBy.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const m = measure(trades);
      console.log(`  ${t(strategy, 14)} ${t(m.trades, 7)} ${t(m.rTrades, 5)} ${t(r4(m.meanR) ?? '-', 9)} ${t(r4(m.sdR) ?? '-', 8)}`);
    }
    console.log('');
  }

  console.log(`${verdicts.length} of ${results.length || 0} strategy(ies) produced a verdict; ${refused.length} refused.`);
  console.log('NOTHING WAS WRITTEN. No settings change, no retirement, no event, no alert, no look spent.');
  console.log('Re-running this costs nothing — which is why it exists alongside the harness that does.');
  process.exit(verdicts.length ? 0 : 4);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`failed: ${String(e.stack || e.message || e)}`);
    process.exit(3);
  });
}

module.exports = { partition, measure, excursions, verdictFor, NO_VERDICT };
