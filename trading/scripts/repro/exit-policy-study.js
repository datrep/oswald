// trading/scripts/repro/exit-policy-study.js — counterfactual exit-rule study for
// report items A1 (follow-through time-stop) and A2 (max hold), plus the S5 question
// of whether the desk's own close ever beats letting the venue handle it.
//
// METHOD. For every closed demo trade with tick coverage, replay the REAL mid-price
// path forward from the entry and ask what each candidate exit rule would have
// produced, in R-multiples (P&L / the trade's own initial risk = size x |entry - stop|,
// so symbols are comparable):
//   1. if a VENUE LEVEL is touched first, the trade ends there (the venue acts
//      server-side, so it wins the race against any desk-side rule);
//   2. otherwise the candidate rule may exit at that tick's mid;
//   3. otherwise the position runs to the end of the path.
// Paths extend BEYOND the actual close, because "hold longer" rules need the prices
// that were available after the desk got out.
//
// RULES
//   actual            the trade as it happened (recorded grossPnl)
//   venue-only        no desk rule at all: the venue's own SL/TP decides
//   maxHold T min     A2 — flatten at T minutes
//   follow K min      A1 — flatten once no new favourable extreme has printed for K
//   mfeFail X@T       A1 variant — flatten if MFE < X x TP distance after T minutes
//
// LIMITS (read before quoting any number below):
//   * Counterfactual over trades the desk ACTUALLY TOOK. It cannot tell you about
//     trades a different rule would have avoided or created — that needs the Lab.
//   * n is tiny (a handful of trades). This ranks candidates for PRE-REGISTRATION;
//     it is not evidence of an edge. Rule L still applies: pre-register, walk
//     forward, BCa + BH, PF >= 1.2, paper-forward >= 50, owner sign-off.
//   * Ticks land on the ~5 min wake cadence, so rules below ~5 minutes are not
//     resolvable and intra-tick extremes are invisible.
//   * Assumes the venue fills AT the level it touched (no gap/slippage modelled).
//
// Usage (from the repo root):  node trading/scripts/repro/exit-policy-study.js
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { getPool } = require('../../../shared/db');

const PATH_HOURS = 24;      // how far forward to replay past the entry
const MIN_TICKS = 5;        // need a usable path

const MAX_HOLD = [15, 30, 60, 120, 240];
const FOLLOW = [10, 15, 30, 60];
const MFE_FAIL = [[0.25, 30], [0.5, 30], [0.25, 60]];

// The exit machinery CHANGED on this date: TRD-33 (the trailing anchor was seeded from pre-entry bars,
// so phantom stops closed positions) was completed 2026-09-11T22:00Z. A sample spanning it mixes two
// different desks, and the 2026-09-18 re-run showed the ranking INVERT (later-beats-earlier became
// later-is-worse), so the cohorts are reported separately rather than pooled into one number.
const FIX_DATE = '2026-09-11T22:00:00Z';

(async () => {
  const pool = await getPool();
  const trades = (await pool.request().query(
    `SELECT id, symbol, venue, direction, size, openPrice, stopPrice, takeProfitPrice,
            closePrice, closeAt, openAt, note, grossPnl, holdingMinutes, strategyId
       FROM Trades
      WHERE grossPnl IS NOT NULL AND openPrice IS NOT NULL AND stopPrice IS NOT NULL
        AND takeProfitPrice IS NOT NULL AND openAt IS NOT NULL
        AND venue = 'plus500'
      ORDER BY id`,
  )).recordset;
  const skipped = { noRisk: 0, fewTicks: 0 };

  const results = [];
  for (const t of trades) {
    const dir = t.direction === 'buy' ? 1 : -1;
    const open = Number(t.openPrice), stop = Number(t.stopPrice), tp = Number(t.takeProfitPrice);
    const size = Number(t.size);
    const risk = Math.abs(open - stop);
    if (!(risk > 0) || !(size > 0)) { skipped.noRisk++; continue; }
    const stopDist = risk, tpDist = Math.abs(tp - open);

    // VENUE FILTER IS MANDATORY (2026-09-13). PriceTicks holds MULTIPLE venues per
    // symbol at the same timestamp, and they are on different bases: measured on
    // 2026-09-10 17:59:12 Gold printed 4351.92 (plus500), 4356.00 (binance) and
    // 4398.90 (yahoo) — a ~1.1% basis difference, the same order as the desk's stop
    // distances (Gold stopDist 26-28 on 4355 = 0.6%). A symbol-only read therefore
    // manufactures level touches that never happened: the first version of this
    // script "stopped out" three trades that were actually venue take-profits.
    const rows = (await pool.request().query(
      `SELECT capturedAt, (bid + ask) / 2.0 AS mid FROM PriceTicks
        WHERE symbol = '${t.symbol}' AND venue = '${t.venue}'
          AND capturedAt >= '${new Date(t.openAt).toISOString().slice(0, 19).replace('T', ' ')}'
          AND capturedAt <= DATEADD(hour, ${PATH_HOURS}, '${new Date(t.openAt).toISOString().slice(0, 19).replace('T', ' ')}')
        ORDER BY capturedAt`,
    )).recordset;
    if (rows.length < MIN_TICKS) continue;

    const path = rows.map((r) => ({ m: Number(r.mid), t: (new Date(r.capturedAt) - new Date(t.openAt)) / 60000 }))
      .filter((p) => Number.isFinite(p.m) && Number.isFinite(p.t));
    if (path.length < MIN_TICKS) { skipped.fewTicks++; continue; }

    const actualR = Number(t.grossPnl) / (size * risk);
    const venueClosed = /^venue closed/i.test(t.note || '');
    // FAITHFULNESS (2026-09-13): for a trade the VENUE closed, the venue's own exit is
    // the only valid baseline, and the path must stop at the real close. Racing the
    // levels from ticks would invent outcomes, because ~5 min sampling can miss the
    // touch entirely: trade 29's venue TP was 104.0865 while our own ticks peaked at
    // 103.995, so a tick-only race "stopped out" a trade that was actually a take-profit.
    const hold = Number(t.holdingMinutes) || 0;
    const raced = venueClosed ? path.filter((p) => p.t <= hold) : path;
    if (raced.length < MIN_TICKS) { skipped.fewTicks++; continue; }

    // Walk the path once, recording where each rule would first fire.
    const fireAt = (fn) => { for (let i = 0; i < raced.length; i++) if (fn(raced, i)) return i; return -1; };
    const rOf = (price) => ((price - open) * dir) / risk;

    // 1. venue levels win the race (server-side, immediate)
    const venueIdx = fireAt((p, i) => (dir > 0 ? (p[i].m <= stop || p[i].m >= tp) : (p[i].m >= stop || p[i].m <= tp)));
    const venuePrice = venueIdx < 0 ? null : (dir > 0 ? (raced[venueIdx].m <= stop ? stop : tp) : (raced[venueIdx].m >= stop ? stop : tp));

    // Settle a rule that would fire at index idx (-1 = never fires).
    const settle = (idx) => {
      if (venueIdx >= 0 && (idx < 0 || venueIdx <= idx)) return rOf(venuePrice);
      if (idx < 0) return venueClosed ? actualR : rOf(raced[raced.length - 1].m);
      return rOf(raced[idx].m);
    };

    const out = {};
    out['actual'] = actualR;
    out['venue-only'] = venueClosed ? actualR : settle(-1);

    for (const T of MAX_HOLD) out[`maxHold ${T}m`] = settle(fireAt((p, k) => p[k].t >= T));
    for (const K of FOLLOW) {
      let peak = -Infinity, trough = Infinity, lastExtreme = 0, idx = -1;
      for (let i = 0; i < raced.length; i++) {
        const m = raced[i].m;
        const newExtreme = dir > 0 ? m > peak : m < trough;
        if (newExtreme) { if (dir > 0) peak = m; else trough = m; lastExtreme = raced[i].t; }
        if (raced[i].t - lastExtreme >= K && raced[i].t >= K) { idx = i; break; }
      }
      out[`follow ${K}m`] = settle(idx);
    }
    for (const [X, T] of MFE_FAIL) {
      let peak = -Infinity, trough = Infinity, idx = -1;
      for (let i = 0; i < raced.length; i++) {
        const m = raced[i].m;
        if (dir > 0 ? m > peak : m < trough) { if (dir > 0) peak = m; else trough = m; }
        if (raced[i].t < T) continue;
        const mfe = ((dir > 0 ? peak : trough) - open) * dir;
        if (mfe < X * tpDist) { idx = i; break; }
      }
      out[`mfeFail ${X}@${T}m`] = settle(idx);
    }

    results.push({ id: t.id, sym: t.symbol, dir: t.direction, holds: t.holdingMinutes, ticks: raced.length, venueClosed, venueHit: venueIdx >= 0, openAt: t.openAt, out });
  }

  if (!results.length) {
    // Fail LOUDLY. A silently empty result hid a malformed venue filter once already
    // (`AND venue = '${t.venue}'` with venue missing from the SELECT = 'undefined').
    console.log(`no trades with usable tick paths (trades=${trades.length}, skipped noRisk=${skipped.noRisk}, fewTicks=${skipped.fewTicks})`);
    console.log(`needs >= ${MIN_TICKS} ticks FOR THE TRADE'S OWN VENUE inside the window`);
    process.exit(1);
  }

  const rules = Object.keys(results[0].out);
  const sumOf = (rows, r) => rows.reduce((a, x) => a + (x.out[r] ?? 0), 0);
  const sum = (r) => sumOf(results, r);

  const table = (rows, title) => {
    if (!rows.length) return;
    const base = sumOf(rows, 'actual');
    console.log(`\n${title} — ${rows.length} trade(s)`);
    console.log('rule'.padEnd(18), 'total R'.padStart(9), 'delta vs actual'.padStart(16), 'better/worse'.padStart(14));
    for (const r of rules) {
      const tot = sumOf(rows, r);
      const better = rows.filter((x) => (x.out[r] ?? 0) > (x.out.actual ?? 0)).length;
      const worse = rows.filter((x) => (x.out[r] ?? 0) < (x.out.actual ?? 0)).length;
      console.log(r.padEnd(18), tot.toFixed(2).padStart(9), (tot - base).toFixed(2).padStart(16), `${better}/${worse}`.padStart(14));
    }
  };

  const day = (x) => new Date(x.openAt).toISOString().slice(0, 10);
  console.log(`\nexit-policy counterfactual — ${results.length} trades with usable tick paths, opened ${day(results[0])} .. ${day(results[results.length - 1])}`);
  console.log("(R-multiples; P&L / the trade's own initial risk. Counterfactual over TAKEN trades only — see LIMITS.)");
  console.log(`COHORTS split at ${FIX_DATE.slice(0, 10)} (TRD-33, the phantom trailing stop): the exit machinery changed there.`);
  table(results, 'ALL');
  table(results.filter((x) => new Date(x.openAt) < new Date(FIX_DATE)), 'PRE-FIX');
  table(results.filter((x) => new Date(x.openAt) >= new Date(FIX_DATE)), 'POST-FIX');

  console.log('\nper-trade: actual vs venue-only vs the best desk-side rule');
  const ranked = rules.filter((r) => r !== 'actual' && r !== 'venue-only').sort((a, b) => sum(b) - sum(a));
  const best = ranked[0];
  const cols = ['id', 'sym', 'dir', 'held', 'vex', 'actual', 'venue-only', best];
  console.log(cols.map((s) => String(s).padStart(11)).join(''));
  for (const x of results) {
    const v = [x.id, x.sym, x.dir, x.holds, x.venueHit ? 'yes' : 'no',
      x.out.actual, x.out['venue-only'], x.out[best]];
    console.log(v.map((n) => (typeof n === 'number' ? n.toFixed(2) : String(n)).padStart(11)).join(''));
  }
  const hit = results.filter((x) => x.venueHit).length;
  console.log(`\nvenue level touched within ${PATH_HOURS}h: ${hit}/${results.length} trades`);
  console.log('CAUTION: this RANKS candidates, it does not establish an edge. n is in the tens, the');
  console.log('per-rule deltas are smaller than single-trade variance, and it is a counterfactual over');
  console.log('trades actually taken.');
  // ★★ TRD-EXT-1 (2026-09-24): THE COHORT SPLIT ABOVE IS DEGENERATE, AND THIS BLOCK USED TO ADVERTISE IT.
  //
  // It said: "Read the cohort tables: on 2026-09-18 the pooled ranking INVERTED against the earlier sample, so
  // a pooled number here is not stable." That was true when written and is now **impossible** — MEASURED: the
  // all-cohort and POST-FIX tables are byte-identical, because `PriceTicks` holds 47,757 rows and BEGINS
  // 2026-09-16T21:08:23Z, while FIX_DATE is 2026-09-11T22:00:00Z. Every row in this sample is post-fix, so the
  // pre-fix cohort is EMPTY by construction and cannot be restored by widening anything — there are no earlier
  // ticks. Telling a reader to consult those tables invites them to believe a stability check was performed.
  //
  // AND THE OBVIOUS REPAIR DOES NOT WORK EITHER: moving the boundary to 2026-09-18 (where `entry_reanchored`
  // and `stop_capped` first appear — 28 and 27 events, both entry/stop machinery) leaves a pre-cohort of
  // **3 trades**, against 28 post. The earliest trade with the >= MIN_TICKS usable path is 2026-09-17.
  // A temporal half-split IS still possible (2026-09-22 gives 15 | 16), but it is NOT a machinery boundary and
  // would test a weaker question, so it is a registered decision rather than a silent edit. See TRD-EXT-1.
  console.log('⚠ COHORT SPLIT DEGENERATE (TRD-EXT-1): every row here is POST-FIX — ticks start 2026-09-16 and the');
  console.log('  FIX_DATE boundary is 2026-09-11, so the pre-fix cohort is EMPTY and the two tables are identical.');
  console.log('  Ranking stability is therefore NOT tested by this run and must not be read as if it were. The');
  console.log('  best available alternative is a temporal half-split at 2026-09-22 (15 | 16), which is a WEAKER');
  console.log('  question — it is not a machinery boundary.');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
