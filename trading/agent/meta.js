// trading/agent/meta.js — Meta Ultimate shadow (TRD-10).
// A meta-layer that NEVER trades. Every wake it reads the market state and
// publishes a verdict: regime (trend/range), trend direction, confidence,
// suggested position scale, recent strategy win-rate. Verdicts are logged as
// 'meta' events (shadow) — later phases may let the meta layer gate/scale the
// primary strategy; today it is advisory + visible in the UI only.
'use strict';

const store = require('../store');
const { adx, atr, sma } = require('./indicators');

const VENUE_PREF = ['yahoo', 'binance', 'okx', 'plus500_chart', 'plus500'];
const round4 = (n) => Math.round(n * 10000) / 10000;

async function barsFor(userId, symbol) {
  for (const venue of VENUE_PREF) {
    const bars = await store.listBars(userId, { timeframe: '1h', symbol, venue, limit: 300 });
    if (bars.length >= 50) return { bars, venue };
  }
  return null;
}

async function evaluateMeta(userId, settings) {
  const symbols = (settings.watchlist?.symbols || []).map((s) => s.symbol);
  const closed = await store.getClosedTrades(userId, 10);
  const winRate = closed.length
    ? Math.round((closed.filter((t) => Number(t.grossPnl) > 0).length / closed.length) * 100)
    : null;

  let data = null;
  let chosen = null;
  for (const sym of symbols) {
    data = await barsFor(userId, sym);
    if (data) { chosen = sym; break; }
  }

  const base = { winRate, closedCount: closed.length, at: new Date().toISOString(), note: 'shadow verdict — not executed' };
  if (!data) {
    const verdict = { ...base, regime: 'unknown', trend: 'unknown', confidence: 0, scaleFactor: 0.5, reason: 'no bars' };
    await store.logEvent(userId, 'meta', verdict);
    return verdict;
  }

  const highs = data.bars.map((b) => b.high).filter((v) => v != null);
  const lows = data.bars.map((b) => b.low).filter((v) => v != null);
  const closes = data.bars.map((b) => b.closePrice).filter((v) => v != null);
  const adx14 = adx(highs, lows, closes, 14);
  const atr14 = atr(highs, lows, closes, 14);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const price = closes[closes.length - 1];
  const trend = s50 != null && s200 != null ? (s50 > s200 ? 'up' : 'down') : 'unknown';
  const regime = adx14 != null && adx14 > 25 ? 'trend' : 'range';
  const confidence = adx14 != null ? round4(Math.max(0, Math.min(1, adx14 / 40))) : 0;
  const scaleFactor = regime === 'trend' ? 1 : 0.5;

  const verdict = {
    ...base,
    regime, trend, confidence, scaleFactor,
    adx14: adx14 == null ? null : round4(adx14),
    atrPct: atr14 != null && price ? round4((atr14 / price) * 100) : null,
    sma50: s50 == null ? null : round4(s50), sma200: s200 == null ? null : round4(s200),
    symbol: chosen, venue: data.venue,
  };
  await store.logEvent(userId, 'meta', verdict);
  return verdict;
}

module.exports = { evaluateMeta };
