'use strict';
// trading/scripts/giveback-tracker.js — peak-to-exit ("give-back") per closed era trade + aggregates.
// Read-only. The live instrument for judging exit-side changes (trail1R verification, T2.5).
// Writes temp/giveback-tracker-out.json. Owner item 1 (2026-10-07).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { getPool } = require('../../trading/db');
(async () => {
  const p = await getPool();
  const rows = (await p.request().query(`
    SELECT id, symbol, direction, strategyId, grossPnl, netPnlMax, netPnlMin, mfePct, maePct, holdingMinutes,
           CONVERT(varchar(19),closeAt,120) ca
    FROM Trades WHERE userId=1 AND status='closed' AND closeAt >= '2026-10-02T08:00:00' ORDER BY closeAt`)).recordset;
  const trades = [];
  const gives = [];
  let green = 0, surrender = 0;
  for (const t of rows) {
    const peak = t.netPnlMax, fin = t.grossPnl;
    const wentGreen = peak != null && peak > 0.5;
    const giveback = wentGreen ? +(peak - fin).toFixed(2) : null;
    if (wentGreen) { green++; gives.push(giveback); if (giveback > 0.75 * peak) surrender++; }
    trades.push({ id: t.id, symbol: t.symbol, dir: t.direction, strategy: t.strategyId, peak, trough: t.netPnlMin, final: fin, giveback, held: t.holdingMinutes, mfePct: t.mfePct, closeAt: t.ca });
  }
  gives.sort((a, b) => a - b);
  const med = gives.length ? gives[Math.floor(gives.length / 2)] : null;
  const agg = {
    n: rows.length, wentGreen: green, surrendered: surrender,
    surrenderPct: green ? +(100 * surrender / green).toFixed(1) : null,
    medianGiveback: med, totalGiveback: +gives.reduce((s, x) => s + x, 0).toFixed(1),
  };
  console.log('give-back tracker — era closed trades:', rows.length);
  console.log(`went green (peak > +0.5 SGD): ${green} | surrendered >75% of peak: ${surrender} (${agg.surrenderPct}%)`);
  console.log(`median give-back: ${med} SGD | total give-back: ${agg.totalGiveback} SGD`);
  console.log('\nworst give-backs:');
  const worst = trades.filter((t) => t.giveback != null).sort((a, b) => b.giveback - a.giveback).slice(0, 8);
  for (const t of worst) console.log(`  #${t.id} ${t.symbol} ${t.dir} peak ${t.peak} -> final ${t.final} (gave back ${t.giveback}) [${t.strategy}]`);
  require('fs').writeFileSync(path.join(__dirname, '../../temp/giveback-tracker-out.json'), JSON.stringify({ generatedAt: new Date().toISOString(), agg, trades }, null, 2));
  console.log('\nwrote temp/giveback-tracker-out.json');
  await p.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
