// trading/scripts/backfill-trade-sizes.js — the HISTORICAL half of the TRD-EXE-3 read-back.
//
// WHY A SCRIPT AND NOT THE POLLER. `accountPoller` reconciles the sizes of positions the venue currently
// reports, which is what makes it free — and which is also why it can never reach a CLOSED trade: the venue
// stops listing a position the moment it closes, so a closed row's true size only exists in the recorded
// `position_pnl` history. Measured 2026-09-30 after the live read-back had corrected both open positions:
// **26 of 30 closed rows still disagreed with the venue, mean 8.44%, max 100%** (`#1106` SGX: the desk
// recorded 10 against a venue-held 20 — the worked case in row #1463's own text).
//
// WHY THAT MATTERS. `Trades.size` is the denominator under every R the desk publishes, so each of those 26
// rows currently carries an R multiple computed from a size that was never filled.
//
// ⚠ THE CONSEQUENCE, NAMED BEFORE IT IS RUN — read this before `--apply`. This is NOT a live-order change:
// no order is placed or altered, no position is touched, and closed rows are not in the exposure budget. It
// does change what the ANALYTICS read, and `analytics.strategyStats` feeds the parity/retirement gate, so a
// corrected R set can move a verdict that retires a strategy (which strips its `symbolScope` and stops that
// symbol trading). That is a live decision reached through a measurement, which is why the default is a DRY
// RUN and why every written row emits its own `size_reconciled` event with the before/after pair.
//
// Idempotent: a row whose numbers already agree is not written and not logged, so a second run reports 0.
'use strict';

const store = require('../store');
const { getPool } = require('../db');
const { sizeVerdict } = require('../agent/sizeReconcile');

const APPLY = process.argv.includes('--apply');
const SYMBOL = (process.argv.find((a) => a.startsWith('--symbol=')) || '').split('=')[1] || null;
const USER = 1;

(async () => {
  const pool = await getPool();

  // The venue's LAST word on each position it has ever reported. `rn = 1` is the newest `position_pnl` row for
  // that positionId, which for a closed trade is the final sample taken before the venue stopped reporting it.
  const venue = await pool.request().query(`
    WITH v AS (
      SELECT JSON_VALUE(payload,'$.positionId') AS positionId,
             TRY_CONVERT(float, JSON_VALUE(payload,'$.size')) AS venueSize,
             TRY_CONVERT(float, JSON_VALUE(payload,'$.openingRate')) AS openingRate,
             createdAt,
             ROW_NUMBER() OVER (PARTITION BY JSON_VALUE(payload,'$.positionId') ORDER BY id DESC) AS rn
      FROM dbo.TradingEvents WHERE userId=${USER} AND kind='position_pnl'
    )
    SELECT positionId, venueSize, openingRate, createdAt FROM v WHERE rn=1`);

  const byPosition = new Map();
  for (const r of venue.recordset) {
    // ⚠ ABSENCE FIRST, at the SQL boundary too: a row that never carried a size must not enter the map as 0.
    if (r.positionId == null || String(r.positionId).trim() === '' || r.venueSize == null) continue;
    byPosition.set(String(r.positionId), r);
  }

  const trades = await pool.request().query(`
    SELECT id, symbol, direction, size, units, status, plus500PositionId, strategyId
      FROM dbo.Trades
     WHERE userId=${USER} AND plus500PositionId IS NOT NULL
       AND status IN ('open','closed')${SYMBOL ? ` AND symbol='${SYMBOL.replace(/'/g, "''")}'` : ''}
     ORDER BY id`);

  const plan = [];
  let unmatched = 0;
  for (const t of trades.recordset) {
    const v = byPosition.get(String(t.plus500PositionId));
    if (!v) { unmatched += 1; continue; }
    const verdict = sizeVerdict({ deskSize: t.size, venueSize: v.venueSize, units: t.units });
    if (!verdict.ok || !verdict.write) continue;
    plan.push({ trade: t, verdict });
  }

  console.log(`venue positions observed : ${byPosition.size}`);
  console.log(`desk rows examined       : ${trades.recordset.length} (open + closed with a position id)`);
  console.log(`no venue observation     : ${unmatched} (left untouched — an absent size is not a correction)`);
  console.log(`rows that DISAGREE       : ${plan.length}${APPLY ? '' : '   <-- dry run, nothing written'}`);
  const worst = [...plan].sort((a, b) => Math.abs(b.verdict.deltaPct) - Math.abs(a.verdict.deltaPct)).slice(0, 10);
  for (const p of worst) {
    console.log(`  #${p.trade.id} ${p.trade.symbol} [${p.trade.status}] ${p.trade.strategyId || '-'}: `
      + `${p.verdict.desk} -> ${p.verdict.venue} (${p.verdict.deltaPct}%, ${p.verdict.direction})`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN. Re-run with --apply to write these (each write emits a `size_reconciled` event).');
    console.log('⚠ The corrected R set is read by analytics.strategyStats, which the parity/retirement gate');
    console.log('  consumes — so this can move a verdict that retires a strategy. That is the whole reason the');
    console.log('  default is a dry run.');
    process.exit(0);
  }

  let written = 0;
  for (const p of plan) {
    await store.updateTrade(USER, p.trade.id, { size: p.verdict.venue });
    written += 1;
    await store.logEvent(USER, 'size_reconciled', {
      tradeId: p.trade.id, positionId: String(p.trade.plus500PositionId), symbol: p.trade.symbol,
      tradeDirection: p.trade.direction, tradeStatus: p.trade.status,
      deskSize: p.verdict.desk, venueSize: p.verdict.venue,
      delta: p.verdict.delta, deltaPct: p.verdict.deltaPct, correctionDirection: p.verdict.direction,
      units: p.verdict.units != null ? p.verdict.units : null,
      venue: 'plus500', source: 'backfill', strategyId: p.trade.strategyId || null,
      at: new Date().toISOString(),
      note: 'HISTORICAL correction (trading/scripts/backfill-trade-sizes.js): the desk recorded the size it '
        + 'computed at submit, the venue held a size snapped to its increment, and the read-back had never run '
        + 'on a closed row. Trades.size now carries the VENUE\'S last observed size. Every R computed on this '
        + 'trade before now used the old denominator (TRD-EXE-3).',
    }).catch(() => {});
  }
  console.log(`\nWROTE ${written} row(s). Each emitted a size_reconciled event with source='backfill'.`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
