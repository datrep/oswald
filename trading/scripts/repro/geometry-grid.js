// trading/scripts/repro/geometry-grid.js — RANK THE EXIT GEOMETRY ON REAL PRICE PATHS.
//
// THE QUESTION. Measured 2026-09-28 (TRD-TP-1 #1412): the desk's payoff ratio is not a parameter. It sets a
// target at 1.5 x the DECLARED stop (pulled in 5% => 1.425 x declared) and a cap as a % of PRICE that shortens
// the STOP only, so R:R is an output of where the cap happens to land — and it took five distinct values across
// ten live tickets. Cost-inclusive break-even ((1 + c/r)/(1 + RR)) was 35.4% with the cap binding and 62.9% with
// it inert, against a realised win rate of 50%.
//
// WHY THE EXISTING SWEEP CANNOT ANSWER IT. `temp/sweep-stop-cap.js` realises the RECORDED P&L for any trade
// whose MAE sat inside the candidate cap — so it HOLDS THE TARGET FIXED while varying the stop. Move the target
// and every trade's outcome changes, not just the stopped ones. Nothing in the repo varies the two jointly.
//
// THIS DOES. `agent/geometryReplay.js` walks the recorded tick path from each entry and asks which level was
// touched FIRST; this file loads the paths, runs the grid and prints it. The three structures under test are:
//   (a) targetOn='declared'  the design today — R:R emergent
//   (b) targetOn='risk'      the target as a multiple of the stop the venue got — R:R named and stable
//   (c) either, with no cap  stop width and target multiple as two independent dials
//
// WRITES NOTHING: no settings change, no event, no alert. Read-only by construction.
//
// Usage: node trading/scripts/repro/geometry-grid.js [--user 1] [--horizon 720] [--since 2026-09-21] [--until 2026-09-28T12:00:00Z]
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const { getPool } = require('../../../shared/db');
const ticksRepo = require('../../store/ticks');
const { grid, DEFAULT_MAX_HOLD_MIN } = require('../../agent/geometryReplay');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const USER = Number(arg('--user', 1)) || 1;
const HORIZON_MIN = Number(arg('--horizon', DEFAULT_MAX_HOLD_MIN)) || DEFAULT_MAX_HOLD_MIN;
const SINCE = arg('--since', '2026-09-21');
// ⚠ THE CUTOFF IS A FIXED TIMESTAMP, NOT `Date.now()`. The horizon was derived from the clock at first, which
// made the SAME COMMAND return different numbers minutes apart: a trade opened an hour ago has a longer path
// every time you look, so more of them reach their target. A result that drifts with the wall clock is not a
// measurement, so the data cutoff is stated, printed, and part of the invocation.
//
// ★ 2026-10-19: THE DEFAULT WAS A HARD-CODED SEPTEMBER DATE, AND IT SILENTLY RETURNED AN EMPTY SAMPLE. Run
// with no arguments on 2026-10-18 it reported "229 filled trades; 0 usable" and every skip said the trade had
// `only -25996m of path` — a NEGATIVE horizon, because the default cutoff (2026-09-28T12:00:00Z) sits before
// every recent entry. A measurement that answers "no data" when the data is right there is worse than one that
// refuses to run, so the default is now DERIVED FROM THE DATA (the newest entry, floored to the minute). It is
// still a fixed timestamp and still printed, so the reproducibility the comment above protects is unchanged.
const UNTIL_ARG = arg('--until', null);
// A trade whose path is shorter than this cannot exercise a target, so including it would only add timeouts.
const MIN_HORIZON_MIN = Number(arg('--min-horizon', 120)) || 120;
const VENUE = 'plus500';                  // the desk's own venue rate: the price its P&L is denominated in
const STOP_SCALES = [0.25, 0.5, 0.75, 1.0, 1.5];
const TARGET_MULTIPLES = [0.5, 1.0, 1.425, 2.0, 3.0];
const CAPS = [null, 0.3];                 // no cap, and the setting that was live until 2026-09-28T06:51Z
const LIVE_CAP = 1.5;

const J = (s) => { try { return s == null ? s : JSON.parse(s); } catch { return {}; } };
const f = (v, d = 4) => (v == null || !Number.isFinite(Number(v)) ? 'n/a' : Number(v).toFixed(d));
const sgn = (v, d = 3) => (v == null || !Number.isFinite(Number(v)) ? 'n/a' : (v >= 0 ? '+' : '') + Number(v).toFixed(d));

function costPctFor(symbol) {
  try {
    const bps = require('../../agent/venueComparability')
      .roundTripBpsFromCfg(require('../../agent/backtest').costCfgFor(symbol));
    return Number.isFinite(bps) ? bps / 100 : null;
  } catch { return null; }
}

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  // The cutoff: the argument if given, otherwise the newest entry in the data, floored to the minute.
  let UNTIL = UNTIL_ARG;
  if (!UNTIL) {
    const m = (await q(`SELECT MAX(openAt) AS m FROM Trades WHERE userId = ${USER} AND openPrice IS NOT NULL`))[0];
    if (!m || !m.m) { console.error('no trades with a filled price — nothing to replay'); process.exit(1); }
    UNTIL = new Date(Math.floor(new Date(m.m).getTime() / 60000) * 60000).toISOString().replace('.000Z', 'Z');
  }
  const UNTIL_MS = Date.parse(UNTIL);
  if (!Number.isFinite(UNTIL_MS)) { console.error(`--until ${UNTIL} is not a readable timestamp`); process.exit(1); }

  // ---- 1. the entries, and the geometry each was actually built with ----------------------------------
  const trades = await q(`SELECT id, symbol, direction, openPrice, stopPrice, openAt, closeAt, decisionId, status
      FROM Trades WHERE userId = ${USER} AND openPrice IS NOT NULL AND stopPrice IS NOT NULL
        AND openAt >= '${SINCE}' ORDER BY openAt`);

  const usable = [];
  const skipped = [];
  for (const t of trades) {
    const covMin = Math.floor((UNTIL_MS - t.openAt.getTime()) / 60000);
    const horizon = Math.min(HORIZON_MIN, covMin);
    if (horizon < MIN_HORIZON_MIN) { skipped.push({ id: t.id, symbol: t.symbol, why: `only ${covMin}m of path` }); continue; }
    if (!t.decisionId) { skipped.push({ id: t.id, symbol: t.symbol, why: 'no decisionId' }); continue; }
    const d = (await q(`SELECT TOP 1 payload FROM TradingEvents WHERE kind='decision'
        AND JSON_VALUE(payload,'$.promptId') = ${t.decisionId}
        AND JSON_VALUE(payload,'$.symbol') = '${String(t.symbol).replace(/'/g, "''")}'`))[0];
    if (!d) { skipped.push({ id: t.id, symbol: t.symbol, why: 'decision not resolvable on promptId+symbol' }); continue; }
    const p = J(d.payload);
    const declared = Number(p.stopDistance);
    const declaredRiskPct = declared > 0 ? (declared / Number(t.openPrice)) * 100 : null;
    if (!(declaredRiskPct > 0)) { skipped.push({ id: t.id, symbol: t.symbol, why: 'no declared distance' }); continue; }

    const until = new Date(t.openAt.getTime() + horizon * 60000);
    const rows = await ticksRepo.ticksSince(USER, t.symbol, VENUE, t.openAt, until).catch(() => []);
    const path = rows.map((r) => ({ at: r.capturedAt, mid: ticksRepo.midOf(r) })).filter((x) => x.mid > 0);
    if (path.length < 10) { skipped.push({ id: t.id, symbol: t.symbol, why: `only ${path.length} ticks` }); continue; }

    const gaps = path.slice(1).map((x, i) => (new Date(x.at).getTime() - new Date(path[i].at).getTime()) / 1000).filter((x) => x > 0).sort((a, b) => a - b);
    usable.push({
      id: t.id, symbol: t.symbol, direction: t.direction, entryPx: Number(t.openPrice), entryAt: t.openAt,
      declaredRiskPct, horizonMin: horizon, ticks: path.length, path,
      medianGapSec: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
      costPct: costPctFor(t.symbol),
      capped: !!(p.stopCap && p.stopCap.cappedBy),
      wasCappedAt: HORIZON_MIN,
    });
  }

  if (!usable.length) {
    // ★ NAMED, NOT A BARE EMPTY TABLE. An empty sample has causes that look identical in the output and could
    // not be more different: a window that predates the trades, a window that predates the TICK record, no
    // decisions, or genuinely no filled trades. The tally says which one it is, and the hint names the fix.
    const tally = skipped.reduce((a, s) => { const k = String(s.why).replace(/[0-9.-]+/g, '#'); a[k] = (a[k] || 0) + 1; return a; }, {});
    console.error('\n================ NO USABLE TRADES ================');
    console.error(`  ${trades.length} filled trade(s) in the window, 0 usable. Skipped by reason:`);
    for (const [why, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.error(`    ${String(n).padStart(4)}  ${why}`);
    console.error(`  data cutoff used: ${UNTIL}`);
    console.error('  -> a NEGATIVE path means the cutoff predates the entry: pass --until near the newest trade, or omit it to derive the cutoff from the data.');
    console.error('  -> "only # ticks" at a recent cutoff means the tick record does not cover that window (the position poll only started 2026-10-15).');
    process.exit(2);
  }

  console.log('\n================ THE SAMPLE ================');
  console.log(`  ${trades.length} filled trades since ${SINCE}; ${usable.length} usable, ${skipped.length} skipped`);
  for (const s of skipped) console.log(`    skipped #${s.id} ${s.symbol}: ${s.why}`);
  console.log(`  venue=${VENUE}  horizon<=${HORIZON_MIN}m  data cutoff=${UNTIL} (FIXED, so this run is reproducible)  min accepted ${MIN_HORIZON_MIN}m`);
  const gaps = usable.map((u) => u.medianGapSec).filter((x) => x != null).sort((a, b) => a - b);
  console.log(`  median tick gap across the sample: ${gaps.length ? gaps[Math.floor(gaps.length / 2)] + 's' : 'n/a'}  ` +
    `(coarsest ${gaps.length ? gaps[gaps.length - 1] : 'n/a'}s)`);
  console.log(`  declared risk widths in the sample: ${[...new Set(usable.map((u) => u.declaredRiskPct.toFixed(3)))].join(', ')}% of price`);
  const noCost = usable.filter((u) => u.costPct == null).length;
  if (noCost) console.log(`  ⚠ ${noCost} trade(s) have NO cost basis — their netR is gross, and they are marked`);

  if (!usable.length) { console.log('\n  no usable trades — nothing to rank.'); await pool.close(); return; }

  // ---- 2. the grid, under BOTH coarse policies (the cadence must not be what decides it) --------------
  const cells = new Map();
  for (const policy of ['observed', 'stop']) {
    for (const capPct of CAPS) {
      for (const targetOn of ['declared', 'risk']) {
        for (const u of usable) {
          const rows = grid({
            direction: u.direction, entryPx: u.entryPx, entryAt: u.entryAt, path: u.path,
            declaredRiskPct: u.declaredRiskPct, stopScales: STOP_SCALES, targetMultiples: TARGET_MULTIPLES,
            targetOn, capPct, costPct: u.costPct, maxHoldMin: u.horizonMin, coarsePolicy: policy,
          });
          for (const r of rows) {
            if (!r.ok) continue;
            const key = `${policy}|${capPct == null ? 'none' : capPct}|${targetOn}|${r.stopScale}|${r.targetMultiple}`;
            if (!cells.has(key)) cells.set(key, { policy, capPct, targetOn, stopScale: r.stopScale, k: r.targetMultiple, n: 0, net: 0, win: 0, stop: 0, timeout: 0, nodata: 0, coarse: 0, riskPctSum: 0 });
            const c = cells.get(key);
            c.n++;
            if (r.outcome === 'no_data') { c.nodata++; continue; }
            c.net += r.netR;
            if (r.outcome === 'target') c.win++;
            else if (r.outcome === 'stop') c.stop++;
            else c.timeout++;
            c.coarse += r.coarse ? 1 : 0;
            c.riskPctSum += r.riskPct;
          }
        }
      }
    }
  }
  for (const c of cells.values()) {
    c.meanNetR = c.n - c.nodata > 0 ? c.net / (c.n - c.nodata) : null;
    c.winRate = c.n - c.nodata > 0 ? c.win / (c.n - c.nodata) : null;
    c.coarsePct = c.n - c.nodata > 0 ? (c.coarse / (c.n - c.nodata)) * 100 : null;
  }

  const table = (policy, capPct, targetOn) => {
    const rows = [...cells.values()].filter((c) => c.policy === policy && c.capPct === capPct && c.targetOn === targetOn);
    if (!rows.length) return;
    const best = rows.reduce((a, b) => (b.meanNetR != null && (a.meanNetR == null || b.meanNetR > a.meanNetR) ? b : a));
    console.log(`\n  --- ${targetOn === 'declared' ? '(a) TARGET ON DECLARED' : '(b) TARGET ON RISK'} · cap ${capPct == null ? 'NONE' : capPct + '%'} · policy ${policy} ---`);
    console.log('   stopScale   k       n   win%   stop%  time%  coarse%   mean netR   mean risk%');
    for (const s of STOP_SCALES) {
      for (const k of TARGET_MULTIPLES) {
        const c = rows.find((x) => x.stopScale === s && x.k === k);
        if (!c || !c.n) continue;
        const mark = c === best ? '  <== BEST' : '';
        console.log(`   ${String(s).padStart(9)} ${String(k).padStart(6)} ${String(c.n).padStart(5)} ` +
          `${String(c.winRate == null ? 'n/a' : (c.winRate * 100).toFixed(0)).padStart(6)} ` +
          `${String(((c.stop / (c.n - c.nodata)) * 100).toFixed(0)).padStart(6)} ` +
          `${String(((c.timeout / (c.n - c.nodata)) * 100).toFixed(0)).padStart(6)} ` +
          `${String(c.coarsePct == null ? 'n/a' : c.coarsePct.toFixed(0)).padStart(8)} ` +
          `${String(sgn(c.meanNetR)).padStart(11)} ${String(f(c.riskPctSum / c.n, 3)).padStart(12)}${mark}`);
      }
    }
    console.log(`   -> best: stopScale ${best.stopScale} x k ${best.k} = ${sgn(best.meanNetR)} R/trade at a ${(best.winRate * 100).toFixed(0)}% win rate`);
  };

  console.log('\n================ THE GRID ================');
  console.log('  mean netR is per trade, AFTER the venue round trip, in units of the risk that geometry took.');
  for (const policy of ['observed', 'stop']) {
    console.log(`\n########## coarse policy: ${policy} ##########`);
    for (const capPct of CAPS) for (const targetOn of ['declared', 'risk']) table(policy, capPct, targetOn);
  }

  // ---- 3. does the cadence decide the ranking? --------------------------------------------------------
  console.log('\n================ DOES THE COARSE-STEP POLICY DECIDE THE ANSWER? ================');
  // ⚠ THIS SECTION IS WHY THE POLICY IS A PARAMETER RATHER THAN A CHOICE. If the winner is the same geometry
  // under both, the 10s-vs-121s sampling cadence is not what produced the ranking and the result stands. If it
  // is not, the cadence is doing the deciding and the cell must not be read as a result.
  const bests = new Map();
  for (const c of cells.values()) {
    if (c.meanNetR == null) continue;
    const bkey = `${c.targetOn}|${c.capPct == null ? 'none' : c.capPct}`;
    if (!bests.has(bkey)) bests.set(bkey, {});
    const cur = bests.get(bkey)[c.policy];
    if (!cur || c.meanNetR > cur.meanNetR) bests.get(bkey)[c.policy] = { stopScale: c.stopScale, k: c.k, meanNetR: c.meanNetR };
  }
  let agree = 0, total = 0;
  for (const [bkey, v] of bests) {
    if (!v.observed || !v.stop) continue;
    total++;
    const same = v.observed.stopScale === v.stop.stopScale && v.observed.k === v.stop.k;
    if (same) agree++;
    const [targetOn, cap] = bkey.split('|');
    console.log(`  ${String(targetOn).padEnd(9)} cap ${String(cap).padEnd(5)}  observed -> s${v.observed.stopScale} k${v.observed.k} (${sgn(v.observed.meanNetR)})   ` +
      `strict -> s${v.stop.stopScale} k${v.stop.k} (${sgn(v.stop.meanNetR)})   ${same ? 'SAME' : 'DIFFERENT'}`);
  }
  console.log(`  -> the two policies agree on the winner in ${agree} of ${total} configurations`);
  if (!total) console.log('  ⚠ nothing compared — the section is not answering its question');
  else if (agree < total) console.log('  ⚠ where they disagree, the cadence is doing the deciding and that cell must not be read as a result');

  // ---- 4. the headline: (a) vs (b), and where the cap sits ------------------------------------------
  console.log('\n================ (a) vs (b): WHAT THE TWO STRUCTURES ACTUALLY DELIVER ================');
  console.log('  (both at the SAME stop widths, cap NONE, policy observed — so only the reward base differs)');
  for (const s of STOP_SCALES) {
    const a = cells.get(`observed|none|declared|${s}|1.425`);
    const b = cells.get(`observed|none|risk|${s}|1.425`);
    if (!a || !b) continue;
    console.log(`  stopScale ${String(s).padStart(5)}:  (a) declared  win ${(a.winRate * 100).toFixed(0)}%  mean ${sgn(a.meanNetR)} R   |   ` +
      `(b) risk  win ${(b.winRate * 100).toFixed(0)}%  mean ${sgn(b.meanNetR)} R`);
  }
  console.log('  ⚠ at 1.425 the two differ ONLY where a cap applies, so the row to read for the cap is cap 0.3% below:');
  for (const s of STOP_SCALES) {
    const a = cells.get(`observed|0.3|declared|${s}|1.425`);
    const b = cells.get(`observed|0.3|risk|${s}|1.425`);
    if (!a || !b) continue;
    console.log(`  stopScale ${String(s).padStart(5)}:  (a) declared  win ${(a.winRate * 100).toFixed(0)}%  mean ${sgn(a.meanNetR)} R   |   ` +
      `(b) risk  win ${(b.winRate * 100).toFixed(0)}%  mean ${sgn(b.meanNetR)} R`);
  }
  console.log(`\n  (the live setting is cap ${LIVE_CAP}%, which binds on none of these widths — see TRD-RSK-2 #1418)`);

  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
