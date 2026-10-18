// trading/agent/paper.js — TRD-11: paper-trading broker for the central AI.
// Simulated fills at provider mids with a simple cost model (slippage on entry
// AND exit + fee on notional both sides). Ledger = PaperTrades table;
// equity = initial capital + realized P&L + mark-to-market float. This is a
// SEPARATE option from the live Plus500 demo path — never touches the bridge.
'use strict';

const store = require('../store');
const { nightsFor, fundingMinuteFromText, DEFAULT_FUNDING_MINUTE_UTC } = require('./time');

function round2(n) { return Math.round(n * 100) / 100; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function cfg(settings) {
  const p = settings.paper || {};
  return {
    initialCapital: Number(p.initialCapital) || 10000,
    maxPositions: Math.max(1, Number(p.maxPositions) || 4),
    sizePct: clamp(Number(p.sizePct) || 5, 0.5, 20),
    feePct: Number(p.feePct ?? 0.05) / 100,
    slippagePct: Number(p.slippagePct ?? 0.05) / 100,
    // TRD-11: dynamic spread (the rate you buy + spread = break-even on
    // opening) + overnight funding charged per night held.
    spreadPct: Number(p.spreadPct ?? 0.1) / 100,
    swapDailyPct: Number(p.swapDailyPct ?? 0.02) / 100,
    // TRD-49: the venue's overtime-funding clock, stated the way the venue publishes it ('5:00 AM').
    // Paper mirrors Plus500, so its default IS the venue's default rather than midnight — a paper
    // hold that crosses 05:00 pays a night, because that is when the venue charges one. The knob is
    // the display text and not a UTC minute, so whoever changes it is copying a fact off the venue
    // rather than doing timezone arithmetic.
    swapClockMinuteUtc: (() => {
      const m = fundingMinuteFromText(p.fundingTime);
      return m == null ? DEFAULT_FUNDING_MINUTE_UTC : m;
    })(),
    minOrder: Number(p.minOrder) || 50,
  };
}

// TRD-12 Phase 3: swap accrues per calendar night crossed.
// TRD-49 (2026-09-14): "calendar night" means a crossing of the VENUE'S funding clock, not of UTC
// midnight. The old body below (kept in spirit, not in code) counted `Date.UTC(y,m,d)` differences,
// i.e. UTC day boundaries — the same off-by-one that made the venue's own charges look impossible.
// Weekends still count (overnight funding applies Sat/Sun), and the triple-roll Wednesday rule is
// untouched: this changes WHEN a night is deemed crossed, not HOW MANY nights a week holds.
const nightsHeld = (openAt, swapClockMinuteUtc = null, now = Date.now()) =>
  nightsFor(openAt, now, swapClockMinuteUtc);
const swapCost = (c, size, openPrice, nights) => Number(openPrice) * Number(size) * c.swapDailyPct * nights;
const openFill = (c, price, side) => {
  const halfSpread = c.spreadPct / 2;
  const slip = side === 'buy' ? 1 + c.slippagePct : 1 - c.slippagePct;
  return Number(price) * (1 + (side === 'buy' ? halfSpread : -halfSpread)) * slip;
};

async function midOf(userId, symbol, venue, fallback) {
  const tick = await store.latestTick(userId, symbol, venue);
  if (tick) {
    const mid = ((Number(tick.ask) || 0) + (Number(tick.bid) || 0)) / 2 || Number(tick.bid) || Number(tick.ask) || 0;
    if (mid > 0) return mid;
  }
  return fallback;
}

// Best available price for a symbol: Plus500 demo strip first (the source of
// truth for paper), then yahoo/binance/okx, else null.
async function bestPrice(userId, symbol) {
  for (const venue of ['plus500', 'yahoo', 'binance', 'okx']) {
    const tick = await store.latestTick(userId, symbol, venue);
    if (tick) {
      const mid = ((Number(tick.ask) || 0) + (Number(tick.bid) || 0)) / 2 || Number(tick.bid) || Number(tick.ask) || 0;
      if (mid > 0) return { price: mid, venue };
    }
  }
  return null;
}

async function equity(userId, settings) {
  const c = cfg(settings);
  const open = await store.listPaperTrades(userId, { status: 'open', limit: 200 });
  const closed = await store.listPaperTrades(userId, { status: 'closed', limit: 2000 });
  const realized = closed.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  let unrealized = 0;
  let swapAccrued = 0;
  for (const t of open) {
    const mid = await midOf(userId, t.symbol, t.venue, Number(t.openPrice));
    const px = mid > 0 ? mid : Number(t.openPrice);
    const nights = nightsHeld(t.openAt, c.swapClockMinuteUtc);
    const swap = swapCost(c, t.size, t.openPrice, nights);
    swapAccrued += swap;
    unrealized += (t.direction === 'buy' ? px - Number(t.openPrice) : Number(t.openPrice) - px) * Number(t.size) - swap;
  }
  const equity = c.initialCapital + realized + unrealized;
  return {
    initial: c.initialCapital,
    realized: round2(realized),
    unrealized: round2(unrealized),
    swapAccrued: round2(swapAccrued),
    equity: round2(equity),
    pnlPct: round2(((equity - c.initialCapital) / c.initialCapital) * 100),
    openPositions: open.length,
    closedCount: closed.length,
  };
}

async function closeTrade(userId, settings, trade, { price, reason = null, decisionId: _decisionId = null }) {
  const c = cfg(settings);
  // Closing: you cross the spread against you + slippage; overnight funding
  // accrues for every night held.
  const halfSpread = c.spreadPct / 2;
  const slip = trade.direction === 'buy' ? 1 - c.slippagePct : 1 + c.slippagePct;
  const fill = Number(price) * (1 + (trade.direction === 'buy' ? -halfSpread : halfSpread)) * slip;
  const nights = nightsHeld(trade.openAt, c.swapClockMinuteUtc);
  const swap = swapCost(c, trade.size, trade.openPrice, nights);
  const gross = (trade.direction === 'buy' ? fill - Number(trade.openPrice) : Number(trade.openPrice) - fill) * Number(trade.size);
  const fees = (Number(trade.openPrice) + fill) * Number(trade.size) * c.feePct;
  const pnl = round2(gross - fees - swap);
  const row = await store.updatePaperTrade(userId, trade.id, {
    closePrice: fill, closeAt: new Date(), pnl, fees: round2(fees + swap), status: 'closed', reason,
  });
  await store.logEvent(userId, 'paper_trade', {
    action: 'close', symbol: trade.symbol, direction: trade.direction, units: Number(trade.size),
    openPrice: Number(trade.openPrice), fill: round2(fill), pnl, fees: round2(fees), swap: round2(swap), nights, reason,
  });
  return row;
}

// Execute a central verdict against the paper ledger. Exits first, then
// entries (opposite existing positions are closed, then re-opened).
async function executeVerdict(userId, settings, verdict, quantResult, extraPrices = {}, opts = {}) {
  const c = cfg(settings);
  const actions = verdict.actions || [];
  const opened = [];
  const closed = [];
  if (!actions.length) return { opened, closed, equity: await equity(userId, settings), skipped: 'no_actions' };

  const open = await store.listPaperTrades(userId, { status: 'open', limit: 50 });
  const priceOf = (symbol) => {
    const s = (quantResult.symbols || []).find((x) => x.symbol === symbol && x.price != null);
    if (s) return { price: Number(s.price), venue: s.venue || 'yahoo' };
    // TRD-11: congress/signal tickers outside the quant snapshot (US equities).
    const e = extraPrices[symbol];
    if (e && Number(e.price) > 0) return { price: Number(e.price), venue: e.venue || 'yahoo' };
    return null;
  };

  // Pass 1: exits + closing opposite positions.
  for (const a of actions) {
    const px = priceOf(a.symbol);
    if (!px) continue;
    for (const t of open.filter((x) => x.symbol === a.symbol && x.status === 'open')) {
      const mustClose = a.side === 'close' || t.direction !== a.side;
      if (!mustClose) continue;
      const mid = await midOf(userId, t.symbol, t.venue, px.price);
      closed.push(await closeTrade(userId, settings, t, { price: mid || px.price, reason: a.reason || 'central verdict', decisionId: verdict.promptId || null }));
      open.splice(open.indexOf(t), 1);
    }
  }

  // Pass 2: entries (skip when we just closed on a 'close' action, and skip
  // entirely when the kill switch is SOFT = exits only).
  const eq = await equity(userId, settings);
  if (!opts.entriesBlocked) for (const a of actions) {
    if (a.side === 'close') continue;
    const px = priceOf(a.symbol);
    if (!px) continue;
    const already = open.some((x) => x.symbol === a.symbol && x.direction === a.side && x.status === 'open');
    if (already) continue;
    if (open.length >= c.maxPositions) continue;
    const sizePct = clamp(Number(a.sizePct) || c.sizePct, 0.5, 20);
    const notional = eq.equity * sizePct / 100;
    if (notional < c.minOrder) continue;
    const units = notional / px.price;
    const fill = openFill(c, px.price, a.side);
    // TRD-12 Phase 3: take-profit = 3xATR from entry (1.5R with the 2xATR
    // turtle stop), derived from the live quant snapshot.
    let tp = null;
    const qs = (quantResult && quantResult.symbols || []).find((x) => x.symbol === a.symbol);
    if (qs && qs.atr14 && qs.price) {
      tp = a.side === 'buy' ? +(Number(qs.price) + 3 * Number(qs.atr14)).toFixed(4) : +(Number(qs.price) - 3 * Number(qs.atr14)).toFixed(4);
    }
    const row = await store.createPaperTrade(userId, {
      symbol: a.symbol, venue: px.venue, direction: a.side, size: units,
      openPrice: fill, reason: a.reason || null,
      decisionId: verdict.promptId || null, reasoning: verdict.reasoning || null,
      takeProfitPrice: tp,
    });
    await store.logEvent(userId, 'paper_trade', {
      action: 'open', symbol: a.symbol, direction: a.side, units, fill: round2(fill),
      sizePct: round2(sizePct), reason: a.reason || null,
    });
    opened.push(row);
    open.push(row);
  }

  return { opened, closed, equity: await equity(userId, settings), skipped: null };
}

async function reset(userId) {
  await store.clearPaperTrades(userId);
  await store.logEvent(userId, 'paper_reset', { at: new Date().toISOString() });
}

// Manual open from the dashboard (feedback = the row itself + this event).
async function openManual(userId, settings, { symbol, direction, sizePct = null, strategyId = null }) {
  const c = cfg(settings);
  const side = direction === 'sell' ? 'sell' : 'buy';
  const open = await store.listPaperTrades(userId, { status: 'open', limit: 50 });
  const already = open.some((x) => x.symbol === symbol && x.direction === side && x.status === 'open');
  if (already) throw new Error(`${symbol} already has an open ${side} paper position`);
  if (open.length >= c.maxPositions) throw new Error(`paper max positions (${c.maxPositions}) reached — close one first`);
  const px = await bestPrice(userId, symbol);
  if (!px) throw new Error(`no price for ${symbol} — run a capture/snapshot first`);
  const eq = await equity(userId, settings);
  const pct = Math.max(0.5, Math.min(20, Number(sizePct) || c.sizePct));
  const notional = eq.equity * pct / 100;
  if (notional < c.minOrder) throw new Error(`order too small (${notional.toFixed(2)} < min ${c.minOrder})`);
  const units = notional / px.price;
  const fill = openFill(c, px.price, side);
  const row = await store.createPaperTrade(userId, {
    symbol, venue: px.venue, direction: side, size: units,
    openPrice: fill, reason: 'manual (dashboard)',
    decisionId: null, reasoning: null,
    // TRD-89: an optional strategy tag, so a sim position is attributable. Absent means untagged, which
    // the review authority resolves to 'decider' with the source recorded as no_strategy_recorded.
    strategyId: strategyId || null,
  });
  await store.logEvent(userId, 'paper_trade', {
    action: 'manual_open', symbol, direction: side, units, fill: round2(fill), sizePct: round2(pct),
    venue: px.venue, note: `spread ${settings.paper?.spreadPct ?? 0.1}% + swap ${settings.paper?.swapDailyPct ?? 0.02}%/night apply`,
  });
  return row;
}

module.exports = { equity, executeVerdict, closeTrade, reset, openManual, bestPrice, cfg };
