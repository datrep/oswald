// trading/scripts/repro/shw4-scorer-verify.js — TRD-SHW-4 acceptance (P1 + P2).
//
// READ-ONLY. Nothing here writes to ShadowSignals or PriceBars: it computes what the FIXED scorer would
// produce, and independently reproduces that number from PriceTicks.
//
// WHY AN INDEPENDENT SOURCE IS THE WHOLE TEST. The defect this verifies was invisible for seven days because
// the tests and the code shared one wrong belief about a field name. Re-running the same function and printing
// its output would reproduce the bug's own logic. So the check below re-derives the window's open and close
// from the TICKS the bars were built from, using the aggregation in `bars.js`'s `upsertHourlyBars` —
//     mid = (ISNULL(bid,ask) + ISNULL(ask,bid)) / 2
//     openPrice  = mid of the FIRST tick in the hour
//     closePrice = mid of the LAST  tick in the hour
// — and fails if the scorer disagrees with it.
//
//   node trading/scripts/repro/shw4-scorer-verify.js [--rows N]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { getPool, sql } = require('../../../shared/db');
const store = require('../../store');
const s = require('../../agent/shadowScore');

const USER = 1;
const argv = process.argv;
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d; };
const N_ROWS = arg('rows', 14);

const f = (v, dp = 4) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(dp));
const iso = (v) => (v ? new Date(v).toISOString().replace('.000Z', 'Z') : '—');

// The tick aggregation for one (symbol, venue, hour), mirroring upsertHourlyBars. The `id` tiebreakers are
// added because `capturedAt` is not unique (documented in store/bars.js) and ROW_NUMBER over a non-unique
// key is engine-arbitrary — that arbitrariness is the only tolerance in this comparison.
async function tickHour(pool, symbol, venue, hourStart) {
  const r = await pool.request()
    .input('u', sql.Int, USER).input('s', sql.NVarChar(64), symbol).input('v', sql.NVarChar(32), venue)
    .input('h', sql.DateTime2, new Date(hourStart)).input('e', sql.DateTime2, new Date(new Date(hourStart).getTime() + 3600e3))
    .query(`WITH t AS (
              SELECT mid = ((ISNULL(bid,ask) + ISNULL(ask,bid)) / 2.0), capturedAt, id
              FROM PriceTicks
              WHERE userId=@u AND symbol=@s AND venue=@v AND capturedAt >= @h AND capturedAt < @e
            )
            SELECT n = COUNT(*),
                   openMid  = MAX(CASE WHEN rnA = 1 THEN mid END),
                   closeMid = MAX(CASE WHEN rnD = 1 THEN mid END),
                   hi = MAX(mid), lo = MIN(mid)
            FROM (SELECT *, ROW_NUMBER() OVER (ORDER BY capturedAt ASC,  id ASC)  AS rnA,
                              ROW_NUMBER() OVER (ORDER BY capturedAt DESC, id DESC) AS rnD FROM t) x;`);
  const row = r.recordset[0] || {};
  return { n: Number(row.n) || 0, openMid: row.openMid, closeMid: row.closeMid, hi: row.hi, lo: row.lo };
}

async function main() {
  const pool = await getPool();
  const signals = await store.listShadowSignals(USER, { limit: 5000 });
  const directional = signals.filter((r) => r.direction === 'buy' || r.direction === 'sell');

  // Eligibility: a window needs 24 bars AFTER the call, so only rows older than the horizon can be scored.
  // Sorting by recency WITHIN the eligible set is what makes tick coverage likely (ticks are pruned to 7 days).
  const horizonMs = s.HORIZON_BARS * 3600e3;
  const eligible = directional
    .filter((r) => Date.now() - new Date(r.createdAt).getTime() >= horizonMs + 60e3)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  console.log(`shadow ledger — ${signals.length} calls, ${directional.length} directional, ` +
    `${directional.filter((r) => r.scoredAt).length} already scored (scoredAt set ⇒ one-shot, never rescored)`);
  console.log(`eligible for scoring (horizon elapsed): ${eligible.length}`);
  console.log(`\nP1 — recompute each directional row with the FIXED scorer, then reproduce it from PriceTicks\n`);

  const barCache = new Map();
  const out = [];
  for (const row of eligible.slice(0, N_ROWS)) {
    const key = `${row.symbol}|${row.venue}`;
    if (!barCache.has(key)) {
      barCache.set(key, await store.listBars(USER, { timeframe: '1h', symbol: row.symbol, venue: row.venue, limit: 400 }));
    }
    const bars = barCache.get(key);
    const win = s.sliceHorizon(bars, row.createdAt, s.HORIZON_BARS);
    if (win.length < s.HORIZON_BARS) {
      // WHY this happens is itself diagnostic: the horizon is 24 BARS, and a sparse instrument (equities,
      // CFDs outside session hours) forms 24 hourly bars in more than one calendar day. Report the density
      // rather than the failure, because "not ready" and "a different horizon" look identical from here.
      const after = bars.filter((b) => new Date(b.barStart).getTime() > new Date(row.createdAt).getTime());
      const spanH = after.length > 1
        ? (new Date(after[after.length - 1].barStart) - new Date(after[0].barStart)) / 3600e3
        : 0;
      out.push({
        row, state: 'horizon_incomplete', have: after.length,
        barsAvail: bars.length, spanH,
        density: after.length ? (after.length / ((Date.now() - new Date(row.createdAt).getTime()) / 3600e3)) * 24 : 0,
      });
      continue;
    }
    const scored = s.scoreRow(row, bars, []);

    // Independent reproduction: same 24 hours, from ticks.
    const hours = [];
    for (const b of win) hours.push(await tickHour(pool, row.symbol, row.venue, b.barStart));
    const covered = hours.filter((h) => h.n > 0).length;
    const first = hours[0], last = hours[hours.length - 1];

    let ind = null;
    if (first.n > 0 && last.n > 0) {
      const open = Number(first.openMid), close = Number(last.closeMid);
      const dir = row.direction === 'buy' ? 1 : -1;
      const closePct = ((close - open) * dir) / open * 100;
      ind = { open, close, closePct, r: s.rOf(closePct, s.riskPctOf(row.atr14, row.priceAtCall)) };
    }
    out.push({
      row, state: 'ok', scored, ind, covered,
      barOpen: win[0].openPrice, barClose: win[win.length - 1].closePrice,
      priorStored: { realisedR: row.realisedR, benchmarkLongR: row.benchmarkLongR, scoredAt: row.scoredAt },
    });
  }

  let ok, mismatch, noTicks, incomplete;
  ok = mismatch = noTicks = incomplete = 0;
  for (const o of out) {
    if (o.state === 'horizon_incomplete') {
      incomplete++;
      console.log(`#${o.row.id} ${o.row.symbol}/${o.row.venue} ${o.row.direction} ${iso(o.row.createdAt)}`);
      console.log(`   HORIZON NOT FORMED: ${o.have}/24 bars after the call (${o.barsAvail} bars stored, ` +
        `~${f(o.density, 1)} bars/day) — the horizon is 24 BARS, so this instrument's window is not one day\n`);
      continue;
    }
    const p = o.priorStored;
    console.log(`#${o.row.id} ${o.row.symbol}/${o.row.venue} ${o.row.direction} ${iso(o.row.createdAt)}`);
    console.log(`   window bars ${s.HORIZON_BARS} · tick coverage ${o.covered}/24 hours`);
    console.log(`   stored BEFORE fix: realisedR ${p.realisedR == null ? 'NULL' : p.realisedR}` +
      ` · benchmarkLongR ${p.benchmarkLongR == null ? 'NULL' : p.benchmarkLongR}` +
      (p.scoredAt ? '  (scoredAt set — one-shot, will never be rescored)' : '  (still pending)'));
    console.log(`   FIXED scorer     : realisedR ${f(o.scored.realisedR)} · benchmarkLongR ${f(o.scored.benchmarkLongR)}` +
      ` · mfe ${f(o.scored.mfePct, 3)} · mae ${f(o.scored.maePct, 3)}`);
    if (!o.ind) {
      noTicks++;
      console.log(`   independent      : NOT REPRODUCIBLE — no ticks survive in this window (they are pruned)\n`);
      continue;
    }
    const openMatch = Math.abs(Number(o.barOpen) - o.ind.open) < 1e-6;
    const closeMatch = Math.abs(Number(o.barClose) - o.ind.close) < 1e-6;
    // ★ THE ONLY LEGITIMATE DIVERGENCE IS THE CLOSE, and it is not hand-waved. A 1h bar's closePrice is the
    // mid of the last tick AS OF WHEN THE AGGREGATION LAST RAN, and `upsertHourlyBars` only re-aggregates the
    // last 2 days of ticks — so an hour older than that keeps the close it had then. `openPrice` cannot drift
    // (the first tick of an hour is fixed), which is exactly why the open matches to the digit and the close
    // may not. So rather than loosen a tolerance, assert the IDENTITY: the difference in R must equal the
    // difference in close, divided by the risk unit. If that holds, the fix is verified and the residual is
    // fully accounted for.
    const riskPct = s.riskPctOf(o.row.atr14, o.row.priceAtCall);
    const dir = o.row.direction === 'buy' ? 1 : -1;
    const closePctBar = ((Number(o.barClose) - Number(o.barOpen)) * dir) / Number(o.barOpen) * 100;
    const resid = Math.abs(closePctBar - o.ind.closePct) / riskPct;
    const rGap = Math.abs(Number(o.scored.realisedR) - Number(o.ind.r));
    const identityHolds = Math.abs(rGap - resid) < 1e-6;
    const rMatch = o.scored.realisedR != null && identityHolds;
    console.log(`   independent      : open ${f(o.ind.open)} close ${f(o.ind.close)} closePct ${f(o.ind.closePct, 4)}%` +
      ` ⇒ realisedR ${f(o.ind.r)}`);
    console.log(`   bar openPrice ${f(o.barOpen)} ${openMatch ? '==' : '!='} tick openMid` +
      ` · bar closePrice ${f(o.barClose)} ${closeMatch ? '==' : '!='} tick closeMid`);
    console.log(`   R gap ${f(rGap, 6)} vs close-implied residual ${f(resid, 6)} ⇒ ` +
      `${identityHolds ? 'IDENTITY HOLDS (only divergence is the frozen close)' : 'UNEXPLAINED'}\n`);
    if (openMatch && rMatch) ok++; else mismatch++;
  }

  console.log(`P1 RESULT: reproduced ${ok} · mismatched ${mismatch} · no surviving ticks ${noTicks} · horizon incomplete ${incomplete}`);

  // ★ P2: absence must stay NULL, never become a plausible zero.
  console.log(`\nP2 — absence is not zero`);
  console.log(`   rOf(null, 2)          = ${s.rOf(null, 2)}        (was 0 before the fix)`);
  console.log(`   rOf(undefined, 2)     = ${s.rOf(undefined, 2)}`);
  console.log(`   rOf(0, 2)             = ${s.rOf(0, 2)}           (a genuine zero survives)`);
  const noOpen = s.scoreRow(
    { createdAt: new Date().toISOString(), direction: 'buy', atr14: 1, priceAtCall: 100, symbol: 'Gold' },
    Array.from({ length: s.HORIZON_BARS }, (_, i) => ({ barStart: new Date(Date.now() + (i + 1) * 3600e3).toISOString(), high: 101, low: 99, closePrice: 100 })),
    [],
  );
  console.log(`   scoreRow on bars whose openPrice is MISSING:ready ${noOpen.ready}` +
    ` · realisedR ${noOpen.realisedR === undefined ? 'absent' : noOpen.realisedR}` +
    ` · benchmarkLongR ${noOpen.benchmarkLongR === undefined ? 'absent' : noOpen.benchmarkLongR}` +
    '   (must be null, NOT 0)');

  // What the fix means for the population, and the bad values already on disk.
  const pending = directional.filter((r) => !r.scoredAt);
  const fabricated = directional.filter((r) => r.realisedR == null && Number(r.benchmarkLongR) === 0);
  console.log(`\nLEDGER IMPACT`);
  console.log(`   directional rows still pending (recoverable if the fix ships before their horizon): ${pending.length}`);
  console.log(`   already-scored directional rows struck off permanently (scoredAt set, one-shot):      ` +
    `${directional.length - pending.length}`);
  console.log(`   rows carrying the fabricated benchmarkLongR = 0.000000 alongside a NULL realisedR:    ${fabricated.length}`);
  console.log(`   ⇒ those rows can never enter T1 (no realisedR, never rescored), but the value still READS`);
  console.log(`     as a measurement. Setting it to NULL is a data correction with no test consequence —`);
  console.log(`     proposed, NOT performed: this script writes nothing.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
