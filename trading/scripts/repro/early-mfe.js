// trading/scripts/repro/early-mfe.js — reconstruct the intra-trade excursion PATH
// from PriceTicks (report F3, the basis for amendment A1).
//
// autopsy.js stores only TERMINAL mfePct/maePct, so a trade that goes 0.5% our way
// in minute 5 and 0.5% our way only at minute 200 look identical. This script
// separates them: per-trade favourable excursion over 15/30/60/120-minute windows,
// the time-to-peak, and peakFrac (time of the best tick as a fraction of the hold).
//
// The finding it produced: every loser peaked EARLY in its hold (peakFrac
// 0.16/0.25/0.55) and every winner held to the close — the sharpest separator at
// n=7, with the caveat that three of the four winners are anchor-driven, so the
// real contrast is 3 losers vs 1 desk-owned winner. Treat as a hypothesis.
//
// Read-only. Usage (run from the repo root):
//   node trading/scripts/repro/early-mfe.js
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { getPool } = require('../../../shared/db');

const WINDOWS = [15, 30, 60, 120];
// Day one (2026-09-11). Edit for other sets, or see the report appendix for the
// query that selects closed trades by window instead of by id.
const IDS = [1032, 1031, 1030, 1028, 1027, 29, 27];

(async () => {
  const pool = await getPool();
  const trades = (await pool.request().query(
    `SELECT id, symbol, direction, openPrice, closePrice, grossPnl, holdingMinutes,
            openAt, closeAt, strategyId, origin, stopPrice, takeProfitPrice, maePct
       FROM Trades WHERE id IN (${IDS.join(',')}) ORDER BY id`,
  )).recordset;

  const rows = [];
  for (const t of trades) {
    const dir = t.direction === 'buy' ? 1 : -1;
    const ticks = (await pool.request().query(
      `SELECT capturedAt, (bid + ask) / 2.0 AS mid FROM PriceTicks
        WHERE symbol = '${t.symbol}' AND capturedAt BETWEEN '${new Date(t.openAt).toISOString().slice(0, 19).replace('T', ' ')}'
                                                      AND '${new Date(t.closeAt).toISOString().slice(0, 19).replace('T', ' ')}'
        ORDER BY capturedAt`,
    )).recordset;

    const open = Number(t.openPrice);
    const exc = (m) => ((m - open) * dir / open) * 100; // signed % excursion
    const mins = (d) => (new Date(d) - new Date(t.openAt)) / 60000;

    let best = null;
    const w = {};
    for (const wm of WINDOWS) w[wm] = { fav: -Infinity, adv: Infinity, n: 0 };
    for (const tk of ticks) {
      const e = exc(Number(tk.mid));
      const m = mins(tk.capturedAt);
      if (best === null || e > best.e) best = { e, m };
      for (const wm of WINDOWS) {
        if (m <= wm) {
          w[wm].n++;
          if (e > w[wm].fav) w[wm].fav = e;
          if (e < w[wm].adv) w[wm].adv = e;
        }
      }
    }
    const held = Number(t.holdingMinutes) || 0;
    rows.push({
      id: t.id, sym: t.symbol, dir: t.direction, pnl: Number(t.grossPnl),
      held, nTicks: ticks.length, strat: t.strategyId || '-', origin: t.origin || '-',
      mfe15: w[15].n ? +w[15].fav.toFixed(3) : null,
      mfe30: w[30].n ? +w[30].fav.toFixed(3) : null,
      mfe60: w[60].n ? +w[60].fav.toFixed(3) : null,
      mfeAll: best ? +best.e.toFixed(3) : null,
      tPeak: best ? +best.m.toFixed(0) : null,
      peakFrac: best && held ? +(best.m / held).toFixed(2) : null,
      mae: t.maePct == null ? null : Number(t.maePct),
    });
  }

  const pad = (v, n) => String(v == null ? '-' : v).padStart(n);
  console.log('\nid    sym   dir   pnl     held  ticks  mfe15  mfe30  mfe60  mfeAll  tPeak  peakFrac  mae    strat');
  for (const r of rows) {
    console.log([
      pad(r.id, 5), r.sym.padEnd(5), r.dir.padEnd(5), pad(r.pnl.toFixed(2), 7),
      pad(r.held, 5), pad(r.nTicks, 6),
      pad(r.mfe15, 6), pad(r.mfe30, 6), pad(r.mfe60, 6), pad(r.mfeAll, 7),
      pad(r.tPeak, 6), pad(r.peakFrac, 9), pad(r.mae, 7), ' ' + r.strat,
    ].join(' '));
  }

  const win = rows.filter((r) => r.pnl > 0);
  const los = rows.filter((r) => r.pnl <= 0);
  const stat = (arr, k) => {
    const v = arr.map((r) => r[k]).filter((x) => x != null);
    return v.length ? { n: v.length, avg: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3), min: Math.min(...v), max: Math.max(...v) } : null;
  };
  console.log('\nAVG by outcome (n is tiny — see the report: the day is one trade plus six observations)');
  for (const k of ['mfe15', 'mfe30', 'mfe60', 'mfeAll', 'tPeak', 'peakFrac']) {
    console.log(' ', k.padEnd(9), 'winners', JSON.stringify(stat(win, k)), ' losers', JSON.stringify(stat(los, k)));
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
