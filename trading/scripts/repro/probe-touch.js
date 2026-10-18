// trading/scripts/repro/probe-touch.js — READ-ONLY. Why did the hazard analysis see zero touches?
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { getPool } = require('../../../shared/db');

const IDS = [1066, 1067, 1069, 1070, 1074, 1076, 1047, 1064, 1068];

function mid(bid, ask) {
  if (bid == null || ask == null) return null;
  const b = Number(bid), a = Number(ask);
  if (!Number.isFinite(b) || !Number.isFinite(a) || b <= 0 || a <= 0) return null;
  return (b + a) / 2;
}

(async () => {
  const pool = await getPool();
  const t = await pool.request().query(`
    SELECT id, symbol, venue, direction, openPrice, stopPrice, takeProfitPrice, closePrice,
           openAt, closeAt, note,
           DATEDIFF(MINUTE, openAt, closeAt) AS holdMin
    FROM Trades WHERE id IN (${IDS.join(',')})`);

  for (const tr of t.recordset) {
    const k = await pool.request().query(`
      SELECT capturedAt, bid, ask, source FROM PriceTicks
      WHERE userId = 1 AND symbol = '${tr.symbol}' AND venue = '${tr.venue}'
        AND capturedAt >= '${tr.openAt.toISOString()}' AND capturedAt <= '${tr.closeAt.toISOString()}'
      ORDER BY capturedAt`);

    const mids = k.recordset.map((r) => mid(r.bid, r.ask)).filter((x) => x != null);
    const sources = [...new Set(k.recordset.map((r) => r.source))];
    if (!mids.length) { console.log(`#${tr.id} ${tr.symbol} ${tr.direction}  NO MIDS (rows ${k.recordset.length})`); continue; }

    const lo = Math.min(...mids), hi = Math.max(...mids);
    const stop = Number(tr.stopPrice), tp = Number(tr.takeProfitPrice);
    const sell = tr.direction === 'sell';
    // how close did the EXTREME get to each level, in %?
    const nearStopPct = sell ? (stop - hi) / stop * 100 : (lo - stop) / stop * 100;   // <=0 means crossed
    const nearTpPct = sell ? (lo - tp) / tp * 100 : (tp - hi) / tp * 100;
    const crosses = sell ? mids.filter((m) => m >= stop || m <= tp).length
                         : mids.filter((m) => m <= stop || m >= tp).length;
    // spacing
    const ts = k.recordset.map((r) => new Date(r.capturedAt).getTime());
    let maxGap = 0, sumGap = 0;
    for (let i = 1; i < ts.length; i++) { const g = ts[i] - ts[i - 1]; sumGap += g; if (g > maxGap) maxGap = g; }
    const avgGap = ts.length > 1 ? sumGap / (ts.length - 1) / 60000 : NaN;

    console.log(`#${tr.id} ${tr.symbol} ${tr.direction} hold ${tr.holdMin}m ticks ${k.recordset.length} src[${sources}]`);
    console.log(`    stop ${stop}  tp ${tp}  close ${tr.closePrice}   note "${tr.note}"`);
    console.log(`    path mid: lo ${lo.toFixed(5)} hi ${hi.toFixed(5)}   gap avg ${avgGap.toFixed(2)}m max ${(maxGap / 60000).toFixed(1)}m`);
    console.log(`    nearest approach: toStop ${nearStopPct.toFixed(4)}%  toTp ${nearTpPct.toFixed(4)}%   ticks beyond a level: ${crosses}`);

    // show the last 3 mids vs levels
    const tail = k.recordset.slice(-3).map((r) => `${new Date(r.capturedAt).toISOString().slice(11, 19)}=${mid(r.bid, r.ask)}`);
    console.log(`    last 3: ${tail.join('  ')}`);
  }
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
