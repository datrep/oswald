// trading/agent/context.js — TRD-12 Phase 1: ONE context module.
// Every LLM consumer renders desk state through helpers here so the same data
// is never reshaped differently in six places:
//   decisionBundle / decisionBundleObj  — the chair bundle (promptBuilder is
//                                          the canonical implementation)
//   positionSection                     — the exit-review context (was review)
//   deskFacts                           — Ask-the-AI facts (was ask.js)
//   centralContext                      — paper central's JSON picture (was central)
'use strict';

const { buildBundle, buildBundleObj, isStale, STALENESS_MS } = require('./promptBuilder');

// ---------------------------------------------------------------------------
// The exit-review chair context for ONE position. Port of review.buildPositionContext.
// ---------------------------------------------------------------------------
async function positionSection(userId, t, { indicators = null, tick = null } = {}) {
  const mid = (((tick && tick.ask) || 0) + ((tick && tick.bid) || 0)) / 2 || (tick && tick.bid) || t.currentRate || null;
  const pnl = t.floatingPnl != null ? Number(t.floatingPnl) : null;
  return [
    `POSITION: ${t.symbol} ${t.direction} ${t.size} opened @ ${t.openPrice} on ${t.openAt ? new Date(t.openAt).toISOString() : '?'}`,
    `CURRENT: mid ${mid != null ? mid : 'n/a'}${pnl != null ? `, floating P/L ${pnl}` : ''}`,
    t.stopPrice ? `STOP LEVEL: ${t.stopPrice} (turtle 2xATR; distance ${mid != null && t.openPrice ? (mid - t.stopPrice).toFixed(3) : 'n/a'})` : 'STOP LEVEL: not set',
    t.takeProfitPrice ? `TAKE PROFIT: ${t.takeProfitPrice}${mid != null ? ` (distance ${(t.takeProfitPrice - mid).toFixed(3)})` : ''}` : null,
    `INDICATORS (1h): ${indicators ? JSON.stringify(indicators).slice(0, 400) : 'none available'}`,
    t.note ? `NOTE: ${t.note}` : null,
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Ask-the-AI facts from the state tree. Port of ask.js context.
// `market` (optional) = the latest quant snapshot [{symbol, venue, price,
// barAgeSec, priceSource, priceAgeSec, atr14, adx14, status, signal}] so the AI can
// answer about ANY watchlist symbol, not just open positions.
// TRD-PRC-1 (2026-09-14): this used to print `tickAgeSec`, which actually held the BAR age.
// The price and the bar series are different clocks, so the age is now labelled with the clock
// it belongs to — answering "12m old" while quoting a live tick is the same conflation the
// bundle was fixed for.
// ---------------------------------------------------------------------------
function deskFacts(tree, strategies, market = null) {
  const w = tree.waker || {};
  const demo = (tree.positions && tree.positions.demo) || [];
  const marketLine = market && market.length
    ? market.map((s) => {
      const sig = s.signal && s.signal.type ? `${s.signal.type}${s.signal.direction ? ' ' + s.signal.direction : ''}` : 'none';
      const src = s.priceSource === 'tick' ? 'live tick' : s.priceSource === 'bar_close' ? 'bar close' : 'price';
      const pxAge = s.priceAgeSec != null ? `, ${src} ${Math.round(s.priceAgeSec / 60)}m old` : '';
      return `${s.symbol}: ${s.price != null ? s.price : 'n/a'} (${s.venue || 'n/a'}${pxAge}; ATR14 ${s.atr14 != null ? s.atr14 : 'n/a'}; ADX14 ${s.adx14 != null ? s.adx14 : 'n/a'}; signal ${sig}; ${s.status || ''})`;
    }).join(' | ')
    : 'no price data captured yet';
  return [
    `MODE: ${tree.mode}`,
    `WAKER: ${w.paused ? 'PAUSED — no scheduled wakes (manual wakes only)' : w.inProgress ? 'waking RIGHT NOW' : 'running'}`
      + (w.nextWakeAt ? `, next wake ${w.nextWakeAt}` : '')
      + (w.lastWakeAt ? `, last wake ${w.lastWakeAt}` : ''),
    `KILL SWITCH: tier ${tree.kill && tree.kill.tier}`
      + (tree.kill && tree.kill.initialEquity != null ? `, baseline equity ${tree.kill.initialEquity}, disaster floor ${tree.kill.disasterFloorPct != null ? tree.kill.disasterFloorPct + '%' : 'off'}` : ''),
    `STRATEGIES ENABLED: ${(tree.strategies || []).join(', ') || 'none'}`,
    `STRATEGY RULES (incl. exit logic): ${(tree.strategies || []).map((id) => { const s = strategies.get(id); return s ? `${id}: ${s.description}` : id; }).join(' | ') || 'none'}`,
    `DEMO (Plus500) OPEN POSITIONS: ${demo.length
      ? demo.map((p) => `${p.symbol} ${p.direction} ${p.size} @ ${p.openPrice} — current ${p.currentRate != null ? p.currentRate : 'n/a'}, P/L ${p.floatingPnl != null ? p.floatingPnl : 'n/a'} (${p.status})`).join('; ')
      : 'none'}`,
    `SIM OPEN POSITIONS: ${(tree.positions && tree.positions.sim || []).length
      ? tree.positions.sim.map((p) => `${p.symbol} ${p.direction} ${p.size} @ ${p.openPrice}`).join('; ')
      : 'none'}`,
    `DEMO ACCOUNT: ${tree.account ? `equity ${tree.account.equity}, available ${tree.account.available}, margin ${tree.account.margin}, pnl ${tree.account.pnl}` : 'unknown'}`,
    tree.paper ? `SIM ACCOUNT: equity ${tree.paper.equity}, pnlPct ${tree.paper.pnlPct}%` : null,
    `WATCHLIST MARKET SNAPSHOT: ${marketLine}`,
    `LAST DECISION: ${tree.lastDecision ? JSON.stringify(tree.lastDecision).slice(0, 300) : 'none yet'}`,
    tree.meta && tree.meta.regime ? `META REGIME (shadow): ${tree.meta.regime}, trend ${tree.meta.trend}, confidence ${tree.meta.confidence}, scale ${tree.meta.scaleFactor}` : null,
    tree.pulse && tree.pulse.headline ? `MARKET PULSE: ${tree.pulse.headline}` : null,
    `ALERTS: ${(tree.alerts && tree.alerts.count) || 0} total, ${(tree.alerts && tree.alerts.active ? tree.alerts.active.length : 0)} active`,
    tree.errors && tree.errors.length ? `RECENT ERRORS: ${tree.errors.map((e) => `${e.where}: ${e.error}`).join(' | ').slice(0, 300)}` : null,
    `NOW: ${new Date().toISOString()}`,
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// The paper central AI's JSON picture. Port of central.js context-building.
// ---------------------------------------------------------------------------
function centralContext(ctx) {
  const symbols = (ctx.quantResult?.symbols || [])
    .map((s) => ({
      symbol: s.symbol, venue: s.venue, status: s.status,
      price: s.price, atr14: s.atr14, adx14: s.adx14,
      donchian: s.donchian, signal: s.signal, indicators: s.indicators || null,
    }))
    .slice(0, 24);
  return {
    at: (ctx.now || new Date()).toISOString(),
    session: ctx.session,
    paperEquity: ctx.equity || null,
    positionsHeld: (ctx.openPaper && ctx.openPaper.length)
      ? ctx.openPaper.map((t) => `${t.symbol} ${t.direction} size ${t.size}`)
      : 'NONE — you are flat',
    openPositions: (ctx.openPaper || []).map((t) => ({
      symbol: t.symbol, direction: t.direction, size: t.size, openPrice: t.openPrice, openAt: t.openAt,
    })),
    closedRecent: (ctx.closedPaper || []).slice(0, 5).map((t) => ({
      symbol: t.symbol, direction: t.direction, pnl: t.pnl, reason: t.reason,
    })),
    marketPulse: ctx.pulse || null,
    meta: ctx.meta?.payload || null,
    multiTop: ctx.multi?.payload?.top?.slice(0, 3) || null,
    multiBottom: ctx.multi?.payload?.bottom?.slice(0, 3) || null,
    congressTop: ctx.congress?.payload?.top?.slice(0, 5) || null,
    machineState: ctx.stateTree || null,
    whitePaper: ctx.whitepaper || null,
    signals: (ctx.quantResult?.symbols || [])
      .filter((s) => s.signal && s.signal.type)
      .map((s) => ({ symbol: s.symbol, type: s.signal.type, direction: s.signal.direction, basis: s.signal.basis, strategy: s.signal.strategy })),
    symbols,
  };
}

module.exports = {
  decisionBundle: buildBundle,
  decisionBundleObj: buildBundleObj,
  isStale,
  STALENESS_MS,
  positionSection,
  deskFacts,
  centralContext,
};
