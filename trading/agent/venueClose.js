// Venue-close reconciliation (2026-09-12).
//
// WHY THIS EXISTS
// The desk sets VENUE-NATIVE stop-loss / take-profit, so Plus500 closes most
// positions itself. Those fills show up in the venue's /closed-positions list as
// "Profit call" / "Loss call", and Oil & Silver also close at session end
// ("Market closed"). Until now the mirror only noticed that a local-open row had
// vanished from the venue and marked it `phantom` — the close price, P&L, close
// time and close reason were thrown away. On 2026-09-11 that lost 4 of 7 real
// closes (+2.67, -5.05, +20.17, +8.28) and the Past table showed rows with no
// price and no P&L, i.e. "broken".
//
// WHAT THIS DOES
// Matches our trades against the venue's own closed-position rows and writes the
// real close back onto the row. Matching is EXACT by plus500PositionId (the
// venue's data-position-id — verified identical for every row we hold); the
// symbol+direction fallback is only used when we have no position id at all, and
// it will not attach a close that happened BEFORE the trade opened.
//
// Pure matcher is unit-tested (test/venue-close.test.js).
const store = require('../store');
const log = require('./log');
const { nightsFor, fundingMinuteFromText, DEFAULT_FUNDING_MINUTE_UTC } = require('./time');
// TRD-108 (2026-09-21): what this close ACTUALLY happened at, derived from the venue's own P&L.
const { impliedFillPrice, CLOSE_PRICE_SOURCE } = require('./closeFill');
// TRD-118 (2026-09-24): and WHICH KIND OF TIME the close instant is. The venue's closed-positions list is a
// DISPLAY, so its close time carries minute resolution — measured at 36 of 36 `venue_rate` closes, against
// 0 of 94 opens. Without this, a window-based metric samples the price path against a guessed end.
const { sourceForVenueClose } = require('./closeTime');
// ★ TRD-PNL-6 residual (#1499, 2026-10-02): the close-time fx rate is a LOOKUP against the stamped series.
const { getPool } = require('../db');

// ★ TRD-PNL-6 residual (#1499, 2026-10-02): THE RATE AT THE INSTANT OF THE CLOSE IS A LOOKUP NOW.
// TRD-PNL-7 / P1a+P1b (2026-10-01) stamp `fxSgd` on every account sample precisely so this becomes a lookup
// instead of an inference — the refusal's own stated gap (the close-instant rate it could not obtain, back
// then) closed the day the stamp landed. NEAREST SAMPLE AT OR BEFORE THE CLOSE: a rate from AFTER the close
// describes a different moment and is not used. A refusal travels as null, never as a fabricated 1.
async function fxAtClose(userId, closedAt) {
  if (!closedAt) return null;
  const pool = await getPool();
  const r = await pool.request()
    .input('at', new Date(closedAt))
    .input('userId', Number(userId) || 1)
    .query(`SELECT TOP 1 CONVERT(varchar(23), createdAt, 126) AS at,
                   CAST(JSON_VALUE(payload, '$.fxSgd') AS FLOAT) AS fx
              FROM TradingEvents
             WHERE userId = @userId AND kind = 'account'
               AND JSON_VALUE(payload, '$.fxSgd') IS NOT NULL
               AND createdAt <= @at
             ORDER BY id DESC`);
  const row = r.recordset[0];
  const fx = row ? Number(row.fx) : NaN;
  return Number.isFinite(fx) && fx > 0 ? { fx, at: row.at } : null;
}

const REASON_LABEL = {
  'profit call': 'take-profit hit at the venue',
  'loss call': 'stop-loss hit at the venue',
  'market closed': 'instrument session closed',
  'stop out': 'venue stop-out',
};

// ★ THE ACCOUNT'S CURRENCY, READ FROM THE SETTINGS THAT DECLARE IT (TRD-PNL-4 / #1484). This module used to
// hold its own literal, which was the second home the row warned about - and a currency written down in one
// place while recorded nowhere is precisely how the fill derivation below went wrong for 60 rows.
const { currencyOf, instrumentCurrencyOf } = require('./accountCurrency');

function reasonLabel(reason) {
  const key = String(reason || '').trim().toLowerCase();
  return REASON_LABEL[key] || reason || 'unknown reason';
}

// Pick the venue close for one trade. `used` is a Set of positionIds already
// claimed this pass so two identical rows can never take the same fill.
function matchVenueClose(trade, rows, used = new Set()) {
  if (!trade || !Array.isArray(rows)) return null;
  const pid = trade.plus500PositionId != null ? String(trade.plus500PositionId) : null;
  if (pid) {
    // Exact identity — trust it even if the venue's symbol differs in case/spacing.
    const hit = rows.find((r) => String(r.positionId) === pid && !used.has(String(r.positionId)));
    return hit || null;
  }
  // No position id: symbol + direction, and the close must be AFTER the open.
  const openAt = trade.openAt ? new Date(trade.openAt).getTime() : null;
  const sym = String(trade.symbol || '').trim().toLowerCase();
  const dir = String(trade.direction || '').trim().toLowerCase();
  const cands = rows
    .filter((r) => !used.has(String(r.positionId)))
    .filter((r) => String(r.symbol || '').trim().toLowerCase() === sym)
    .filter((r) => (dir ? String(r.direction || '').toLowerCase() === dir : true))
    .filter((r) => r.closedAt && (openAt == null || new Date(r.closedAt).getTime() >= openAt))
    .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
  return cands[0] || null;
}

// TRD-49: the funding clock this row's `swapNights` is counted on. The venue bills carry once per
// crossing of the funding time it publishes per instrument, so writing the stored count on UTC
// midnight recorded a rule the venue does not follow — and that count sits on the SAME ROW as
// `fundingCost`, which is the venue's ACTUAL charge, so a wrong count makes a correct row look like a
// contradiction. One registry read per pass; per SYMBOL, not per pass, because a batch can span
// instruments with different clocks and averaging them would invent a third one. A symbol the
// registry has no clock for gets the venue default rather than midnight.
async function resolveSwapClocks(userId, symbols) {
  const wanted = [...new Set((symbols || []).filter(Boolean))];
  if (!wanted.length) return {};
  try {
    const facts = await require('./instruments').venueCostFacts(userId, { symbols: wanted });
    const out = {};
    for (const [sym, f] of Object.entries(facts)) {
      const m = fundingMinuteFromText(f && f.fundingTime);
      if (m != null) out[sym] = m;
    }
    return out;
  } catch {
    return {}; // registry unavailable -> the venue default at the write site, never midnight
  }
}

// Write one venue close onto a trade row and journal it.
// `clocks` is the symbol -> UTC-minute map from `resolveSwapClocks`.
async function applyClose(userId, trade, row, settings, clocks = {}) {
  const closedAt = row.closedAt ? new Date(row.closedAt) : null;
  const holdingMinutes = closedAt && trade.openAt
    ? Math.max(0, Math.round((closedAt.getTime() - new Date(trade.openAt).getTime()) / 60000))
    : null;
  // TRD-108 (2026-09-21): `row.closeRate` IS NOT THE FILL. The venue reports the RATE it closed at — the
  // stop on a loss, the take-profit on a win — and it equals that LEVEL on most rows, while the money says
  // the fill went past it. So the fill is derived from the P&L that IS authoritative, and both facts are
  // stored with the provenance that keeps them apart. NULL when it cannot be derived: an invented fill
  // would be the same defect one column over.
  //
  // ★★★ AND THE SECOND SENTENCE ABOVE WAS THE ARTIFACT, NOT THE MEASUREMENT (found 2026-09-30, TRD-PNL-5
  // #1496). The money "said" the fill went past the level because the derivation divided an SGD P&L by a
  // USD-quoted size: on every instrument except the SGD-quoted one, the apparent overshoot WAS USD/SGD —
  // Gold 1.2965, Oil 1.2978, Arabica 1.3262, Silver 1.2804, against SGX 1.0482 with no currency mismatch.
  // Checked against the venue's own statement for #1148: the rates and the P&L reconcile ONLY at fx 1.2865,
  // and the fill this call derived is exactly the SGD figure spent as USD. The rates were the fill.
  //
  // So the derivation REFUSED rather than divide across a rate nobody applied. `closePrice` still carries the
  // venue's rate with `closePriceSource` naming it, which is the fact a metric should read, and `autopsy`
  // already falls back to it when `closeFillPrice` is NULL. The two currencies come from the settings that
  // declare them (TRD-PNL-4 / #1484): `pnlCurrency` resolves, and `quoteCurrency` resolves only for an
  // instrument somebody has RECORDED - so the refusal survives for every instrument still unrecorded, which is
  // the correct state rather than a leftover.
  //
  // ★★★ AND THE REFUSAL'S OWN STATED GAP CLOSED (2026-10-02, #1499 residual). It said a conversion "would
  // also need the fx rate at the instant of the close" — a rate the desk then recorded nowhere — and
  // TRD-PNL-7 / P1a+P1b now STAMP `fxSgd` on every account sample, so `fxAtClose` below makes that rate a
  // lookup. When both currencies are stated, DIFFERENT, and a stamped rate exists at-or-before the close, the
  // derivation converts and proceeds; it still refuses for unrecorded instruments and for closes with no
  // usable sample.
  const fx = await fxAtClose(userId, closedAt).catch(() => null);
  const closeFillPrice = impliedFillPrice({
    openPrice: trade.openPrice, direction: trade.direction, grossPnl: row.netPnl, size: trade.size,
    pnlCurrency: currencyOf(settings),              // declared in settings.account.currency
    quoteCurrency: instrumentCurrencyOf(settings, trade.symbol), // recorded per instrument, or null
    fx: fx ? fx.fx : null,                          // stamped account-sample rate nearest the close
  });
  // ★ ORIGIN='venue' P&L IS WITHHELD FROM THE LEDGER (2026-10-26, owner decision: "venue rows are not on your
  // jurisdiction... there should be nothing that resulted in -1.1k from the agent, which is what is shown").
  //
  // WHY THE NUMBER IS WRONG RATHER THAN MERELY SOMEONE ELSE'S: a `venue` row is a position MIRRORED from the
  // account that the desk never opened, so `openPrice` is the price at mirror time, NOT the true entry. The
  // difference is the position's whole life before we noticed it, which is why 12 closed venue rows summed to
  // **-1,120.97** while the account itself moved **+55.69** over the same span. A column that can be summed into
  // an order-of-magnitude-wrong answer is worse than an empty one.
  //
  // ⚠ NOTHING IS DESTROYED. The venue's own figure still rides on the `trade_closed` event below as `netPnl`, so
  // the fact is still recorded and still auditable — it is only kept out of `Trades.grossPnl`, which is the
  // column every performance query sums. That is the difference between withholding a number and losing it.
  const withholdPnl = trade.origin === 'venue';
  await store.updateTrade(userId, trade.id, {
    closePrice: row.closeRate ?? null,
    closeFillPrice,
    closePriceSource: CLOSE_PRICE_SOURCE.venueRate,
    closeAt: closedAt,
    // TRD-118: the venue displays the close to the MINUTE, so this instant is ROUNDED, not observed — 36 of 36
    // `venue_rate` closes sit exactly on a minute boundary. Naming it lets `autopsy`'s window flag the row
    // instead of silently sampling the path against a guessed end.
    closeAtSource: sourceForVenueClose(row.reason),
    grossPnl: withholdPnl ? null : (row.netPnl ?? null),
    status: 'closed',
    // Phase 3 (migration 036): the venue's OWN funding adjustment. This is the ground truth the
    // stated-rate prediction gets validated against — `grossPnl` above already has it subtracted,
    // which is why the number was invisible until it had a column. `swapNights` is written under the
    // convention in force NOW so a future convention change cannot silently re-interpret this row.
    fundingCost: row.funding == null ? null : Number(row.funding),
    fundingSource: row.funding == null ? 'not_available' : 'venue_actual',
    swapNights: trade.openAt && closedAt
      ? nightsFor(trade.openAt, closedAt, clocks[trade.symbol] == null ? DEFAULT_FUNDING_MINUTE_UTC : clocks[trade.symbol])
      : null,
    // Say WHERE this close came from — the venue closed it, we only recorded it.
    note: `venue closed — ${row.reason || 'reason not shown'}`
      + (withholdPnl ? ' · P&L WITHHELD: origin=venue, openPrice is the mirror price not the true entry (2026-10-26)' : ''),
    ...(holdingMinutes != null ? { holdingMinutes } : {}),
  });
  await log.write(userId, 'trade_closed', {
    tradeId: trade.id,
    symbol: trade.symbol,
    direction: trade.direction,
    closePrice: row.closeRate ?? null,
    closeFillPrice,
    closePriceSource: CLOSE_PRICE_SOURCE.venueRate,
    closeAtSource: sourceForVenueClose(row.reason),
    openRate: row.openRate ?? null,
    netPnl: row.netPnl ?? null,
    closeReason: row.reason || null,
    closeReasonLabel: reasonLabel(row.reason),
    closeValue: row.closeValue ?? null,
    funding: row.funding ?? null,
    venueClosedAt: row.closedAt,
    venuePositionId: String(row.positionId),
    source: 'venue-close-sync',
    wasStatus: trade.status,
  }, { actor: 'system:venue-sync', correlationId: log.corrId('venue-close') });
  // Post-trade autopsy (MFE/MAE/holding/slippage) — same call the executor makes
  // on its own closes, so venue-closed trades are not invisible to analytics.
  // The deterministic metrics ALWAYS run (they are free, and they are the only
  // record of how much of the move the exit captured). Only the LLM write-up is
  // gated on freshness: a historical backfill of a dozen old rows must not spend
  // the day's token budget.
  const FRESH_MS = 2 * 60 * 60 * 1000;
  const fresh = !!(closedAt && Date.now() - closedAt.getTime() < FRESH_MS);
  if (settings) {
    require('./autopsy').runOnClose(userId, settings, {
      ...trade,
      closePrice: row.closeRate ?? trade.closePrice,
      // TRD-108 (2026-09-21): hand the autopsy the FILL as well, or its slippage would fall back to the
      // venue's stated rate — the very level this fix exists to stop measuring against the market.
      closeFillPrice,
      closeAt: closedAt,
    }, { llm: fresh }).catch(() => {});
  }
}

// Heal every unresolved trade we can. `rows` = webtrader.readClosedPositions().
async function syncVenueCloses(userId, rows, { settings = null, dryRun = false } = {}) {
  const open = Array.isArray(rows) ? rows.filter((r) => r && r.positionId) : [];
  const unresolved = await store.getUnresolvedTrades(userId);
  // TRD-49: one registry read for the whole pass, so every row it writes is counted on the same
  // clock the venue actually bills on.
  const clocks = await resolveSwapClocks(userId, unresolved.map((t) => t.symbol));
  const used = new Set();
  const healed = [];
  const unmatched = [];
  for (const t of unresolved) {
    const row = matchVenueClose(t, open, used);
    if (!row) { unmatched.push({ tradeId: t.id, symbol: t.symbol, status: t.status }); continue; }
    used.add(String(row.positionId));
    healed.push({
      tradeId: t.id,
      symbol: t.symbol,
      direction: t.direction,
      netPnl: row.netPnl,
      closeRate: row.closeRate,
      reason: row.reason,
      closedAt: row.closedAt,
      wasStatus: t.status,
    });
    if (!dryRun) await applyClose(userId, t, row, settings, clocks);
  }
  if (healed.length && !dryRun) {
    await log.write(userId, 'reconciliation', {
      source: 'venue-close-sync',
      checked: unresolved.length,
      healed: healed.length,
      netPnl: Math.round(healed.reduce((a, h) => a + (h.netPnl || 0), 0) * 100) / 100,
      trades: healed.map((h) => `#${h.tradeId} ${h.symbol} ${h.netPnl >= 0 ? '+' : ''}${h.netPnl} (${h.reason})`),
      stillUnresolved: unmatched.length,
    }, { actor: 'system:venue-sync' });
  }
  return {
    checked: unresolved.length,
    healed,
    unmatched,
    netPnl: Math.round(healed.reduce((a, h) => a + (h.netPnl || 0), 0) * 100) / 100,
    venueRows: open.length,
  };
}

module.exports = { matchVenueClose, syncVenueCloses, applyClose, reasonLabel };
