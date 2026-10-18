// trading/agent/strategies/multiFactor.js — Equities multi-factor (TRD-10).
// SHADOW-ONLY: ranks equity symbols, never trades. Composite score:
//   momentum (12-1) x0.5 + trend (SMA50 vs SMA200) x0.3 + low-vol x0.2
//   + optional fundamentals (P/E sanity, ROE) via Yahoo quoteSummary.
// Uses stored 1d Yahoo bars — symbols without history are skipped honestly.
'use strict';

const store = require('../../store');
const { sma } = require('../indicators');
const { SYMBOL_MAP } = require('../providers');

const PARAMS = [
  { key: 'topN', label: 'Top N long / short', type: 'number', def: 5, min: 1, max: 20, step: 1, tightens: 'lower' },
  { key: 'minBars', label: 'Min daily bars', type: 'number', def: 120, min: 60, max: 500, step: 10 },
  { key: 'fundamentals', label: 'Use Yahoo fundamentals (P/E, ROE)', type: 'bool', def: true },
];

function paramsWith(cfg) {
  return {
    topN: Number(cfg && cfg.topN != null ? cfg.topN : 5),
    minBars: Number(cfg && cfg.minBars != null ? cfg.minBars : 120),
    fundamentals: !(cfg && cfg.fundamentals === false),
  };
}

const round4 = (n) => Math.round(n * 10000) / 10000;

// Equity tickers only (SG/HK/A-shares/other listed exchanges).
function isEquityTicker(ticker) {
  return /\.(SI|HK|SS|SZ|T|L|AX|TW)$/.test(String(ticker || ''));
}

// 12-1 momentum in %; requires at least ~252 bars but tolerates fewer.
function momentum12m1(closes) {
  const n = closes.length;
  if (n < 40) return null;
  const lookback = Math.min(252, n - 2);
  const past = closes[n - 1 - lookback];
  const skip = closes[Math.min(n - 1, n - 22)];
  if (!past || !skip) return null;
  return ((skip / past) - 1) * 100;
}

function vol20(closes) {
  const n = closes.length;
  if (n < 22) return null;
  const rets = [];
  for (let i = n - 20; i < n; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  return Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length) * 100;
}

async function rank(userId, settings, { quoteSummary = null } = {}) {
  const cfg = paramsWith((settings.strategies && settings.strategies.params && settings.strategies.params.multi) || {});
  const universe = (settings.watchlist?.universe || []).map((u) => u.symbol);
  const rows = [];

  for (const name of universe) {
    const ticker = SYMBOL_MAP[name] && SYMBOL_MAP[name].yahoo;
    if (!ticker || !isEquityTicker(ticker)) continue;
    try {
      const bars = await store.listBars(userId, { timeframe: '1d', symbol: name, venue: 'yahoo', limit: 300 });
      if (bars.length < cfg.minBars) continue;
      const closes = bars.map((b) => b.closePrice).filter((v) => v != null);
      if (closes.length < cfg.minBars) continue;
      const mom = momentum12m1(closes);
      const s50 = sma(closes, 50);
      const s200 = sma(closes, 200);
      const vol = vol20(closes);
      if (mom == null || s50 == null || s200 == null || vol == null) continue;
      const trend = s50 > s200 ? 1 : -1;
      // Composite: momentum 0.5, trend 0.3, low-vol 0.2 (vol scaled 0..~3%/day).
      const volPenalty = Math.max(0, Math.min(1, vol / 3)) * 0.2;
      let score = mom * 0.5 + trend * 0.3 * 10 - volPenalty * 10;
      let pe = null;
      let roe = null;
      if (cfg.fundamentals && quoteSummary) {
        const f = await quoteSummary(ticker).catch(() => null);
        if (f) {
          pe = f.pe ?? null;
          roe = f.roe ?? null;
          if (pe != null) score += pe > 0 && pe < 30 ? 1 : pe <= 0 ? -2 : -1;
          if (roe != null) score += roe > 10 ? 1 : roe < 0 ? -1 : 0;
        }
      }
      rows.push({
        symbol: name, ticker, mom: round4(mom), trend: trend > 0 ? 'up' : 'down',
        volPct: round4(vol), pe: pe == null ? null : round4(pe), roe: roe == null ? null : round4(roe),
        score: round4(score),
      });
    } catch { /* per-symbol isolation */ }
  }

  rows.sort((a, b) => b.score - a.score);
  const top = rows.slice(0, cfg.topN);
  const bottom = rows.slice(-cfg.topN).reverse();
  return { evaluated: rows.length, topN: cfg.topN, top, bottom, all: rows };
}

// TRD-12 Phase 3: multi-factor LIVE signal (trend-following). Deterministic,
// same interface as turtleUltimate.liveSignal. Fires only for EQUITY tickers
// on the watchlist (crypto/commodities keep using turtle). Entries = uptrend
// confirmation (SMA50 above SMA200, price above SMA50, ADX trend); exits =
// 2xATR trailing from the open position (same convention as turtle).
function liveSignal({ highs: _highs, lows: _lows, closes, atr14, adx14, price, prevPrice: _prevPrice, params, openTrade }) {
  const n = closes.length;
  if (n < 60) return null;
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  if (s50 == null || s200 == null || atr14 == null || atr14 <= 0) return null;
  const stopMult = Number(params && params.atrStopMultiple != null ? params.atrStopMultiple : 2);

  if (openTrade) {
    // Trailing stop: peak/trough from the open position's context.
    const stop = openTrade.direction === 'buy' ? openTrade.peak - stopMult * atr14 : openTrade.trough + stopMult * atr14;
    const hit = openTrade.direction === 'buy' ? price <= stop : price >= stop;
    if (hit) return { type: 'exit', direction: openTrade.direction === 'buy' ? 'sell' : 'buy', basis: `multi trailing ${stopMult}xATR`, strategy: 'multi' };
    return null;
  }
  // Entry: golden-cross trend confirmed by price + ADX.
  if (!(s50 > s200) || !(price > s50) || !(adx14 > 20)) return null;
  return { type: 'entry', direction: 'buy', basis: 'multi trend (SMA50>SMA200, price>SMA50, ADX>20)', strategy: 'multi' };
}

module.exports = {
  id: 'multi',
  name: 'Equities Multi-Factor',
  description: 'Ranks equities by momentum (12-1) + trend (SMA50/200) + low volatility, with optional P/E + ROE fundamentals. Live: trend-following entries on equity tickers (golden cross + ADX), 2xATR trailing exits.',
  params: PARAMS,
  paramsWith,
  rank,
  liveSignal,
  isEquityTicker,
};
