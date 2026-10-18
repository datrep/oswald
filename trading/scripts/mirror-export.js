'use strict';
// trading/scripts/mirror-export.js — THE DESK MIRROR FEED (2026-10-06, owner: "creating the dynamic UI
// mirror to the plus500 desk"). Read-only DB reader; writes trading/public/desk-mirror.json (+ temp copy)
// every 4 s. The page (trading/public/desk-mirror.html) renders it; the payload is the same class of public
// data the dashboard already shows (no auth, same exposure as bridge-state.json).
//
// Run detached:  Start-Process node -ArgumentList 'trading\scripts\mirror-export.js' ...
// Nothing here writes to the desk, the venue, or the DB.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { getPool } = require('../db');

const ROOT = path.join(__dirname, '..', '..');
const PUB = path.join(ROOT, 'trading', 'public', 'desk-mirror.json');
const TMP = path.join(ROOT, 'temp', 'desk-mirror.json');
const CADENCE_MS = 4000;

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

async function build(pool) {
  const q = async (sql) => (await pool.request().query(sql)).recordset;

  const acctRow = (await q("SELECT TOP (1) CAST(payload AS varchar(max)) p FROM TradingEvents WHERE userId=1 AND kind='account' ORDER BY id DESC"))[0];
  const acct = acctRow ? parse(acctRow.p) : null;

  const positions = await q(
    "SELECT id, symbol, direction, size, units, openPrice, currentRate, floatingPnl, stopPrice, takeProfitPrice, CONVERT(varchar(19),openAt,120) openAt, strategyId, plus500PositionId, netPnlMin, netPnlMax, netPnlSamples FROM Trades WHERE userId=1 AND status='open' ORDER BY id"
  );
  const closes = await q(
    "SELECT TOP (10) id, symbol, direction, size, closePrice, closeFillPrice, grossPnl, CONVERT(varchar(19),closeAt,120) closeAt, closeAtSource, closePriceSource FROM Trades WHERE userId=1 AND status='closed' AND closeAt > DATEADD(hour, -24, GETUTCDATE()) ORDER BY closeAt DESC"
  );
  const fills = await q(
    "SELECT TOP (6) id, symbol, direction, CONVERT(varchar(19),openAt,120) openAt, fillDelayMs, spreadSignalPct, spreadSubmitPct, signalToFillSec, slippagePct, anchorAgeSec FROM Trades WHERE userId=1 AND origin='agent' AND filledAt IS NOT NULL ORDER BY id DESC"
  );
  const era = (await q("SELECT COUNT(*) n FROM Trades WHERE userId=1 AND origin='agent' AND status='closed' AND stopPrice IS NOT NULL AND openAt >= '2026-10-02T08:00:00'"))[0];

  const realized24h = closes.reduce((s, c) => s + (Number(c.grossPnl) || 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    account: acct ? { equity: acct.equity, available: acct.available, margin: acct.margin, pnl: acct.pnl, at: acct.at, currency: acct.currency } : null,
    positions,
    closes,
    fills,
    realized24h: +realized24h.toFixed(2),
    era: era ? era.n : null,
  };
}

(async () => {
  const pool = await getPool();
  let fails = 0;
  for (;;) {
    try {
      const out = await build(pool);
      const json = JSON.stringify(out, null, 1);
      try { fs.writeFileSync(TMP, json); } catch { /* best-effort */ }
      try { fs.writeFileSync(PUB, json); } catch { /* best-effort */ }
      if (fails) console.log(`[mirror-export] recovered after ${fails} failure(s)`);
      fails = 0;
    } catch (e) {
      fails++;
      if (fails <= 3 || fails % 30 === 0) console.error(`[mirror-export] build failed (${fails}): ${String(e.message || e).slice(0, 160)}`);
    }
    await new Promise((r) => setTimeout(r, CADENCE_MS));
  }
})().catch((e) => { console.error('[mirror-export] fatal:', String(e.message || e)); process.exit(1); });
