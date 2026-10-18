// trading/agent/strategies/congress.js — TRD-11: Congress Buys strategy.
// SHADOW-ONLY ranking of US tickers from official congressional disclosures
// (via the Quiver provider). Score = recency-weighted buy flow + distinct
// members + amount tier, minus recent sales, optionally nudged by price
// momentum. It never trades on its own — the central AI sees the latest
// congress_signal event and may act on it in paper mode.
'use strict';

const store = require('../../store');
const yahoo = require('../providers/yahoo');

const PARAMS = [
  { key: 'lookbackDays', label: 'Lookback days', type: 'number', def: 30, min: 7, max: 180, step: 1 },
  { key: 'minBuys', label: 'Min buys to rank', type: 'number', def: 2, min: 1, max: 10, step: 1, tightens: 'higher' },
  { key: 'topN', label: 'Top N', type: 'number', def: 5, min: 1, max: 15, step: 1, tightens: 'lower' },
  { key: 'momentumFilter', label: 'Price momentum nudge', type: 'bool', def: true },
];

const DEFAULTS = { lookbackDays: 30, minBuys: 2, topN: 5, momentumFilter: true };

function round4(n) { return Math.round(n * 10000) / 10000; }

// Recency decay: half-life ~45 days.
function decay(daysAgo) { return Math.pow(0.5, Math.max(0, daysAgo) / 45); }

function amountMult(amount) {
  if (!amount) return 1;
  if (amount >= 500000) return 2.5;
  if (amount >= 100000) return 2;
  if (amount >= 50000) return 1.5;
  return 1;
}

// Rank tickers from a stored 'congress' pull. Shadow-only — no liveSignal /
// backtest, so the quant loop and backtester never touch it.
async function rank(userId, settings, { latest = null } = {}) {
  const ev = latest || await store.latestEvent(userId, 'congress');
  if (!ev || !ev.payload || !Array.isArray(ev.payload.trades)) {
    return { evaluated: 0, top: [], bottom: [], note: 'no congress pull yet — run a pull (needs Quiver token)' };
  }
  const p = ev.payload;
  const cfg = { ...DEFAULTS, ...((settings && settings.strategies && settings.strategies.params && settings.strategies.params.congress) || {}) };
  const now = Date.now();
  const byTicker = {};
  for (const t of p.trades) {
    const age = t.date ? (now - new Date(t.date).getTime()) / 86400000 : cfg.lookbackDays;
    if (age > cfg.lookbackDays) continue;
    const bucket = (byTicker[t.ticker] = byTicker[t.ticker] || { ticker: t.ticker, buys: 0, sells: 0, members: new Set(), buyScore: 0, sellScore: 0, maxAmount: 0 });
    if (t.transaction === 'purchase') {
      bucket.buys++;
      bucket.members.add(t.member);
      bucket.buyScore += 1 * amountMult(t.amount) * decay(age);
      bucket.maxAmount = Math.max(bucket.maxAmount, t.amount || 0);
    } else if (t.transaction === 'sale') {
      bucket.sells++;
      bucket.sellScore += 1.2 * amountMult(t.amount) * decay(age);
    }
  }
  const rows = Object.values(byTicker)
    .filter((b) => b.buys >= Number(cfg.minBuys))
    .map((b) => {
      const flow = b.buyScore - b.sellScore;
      const memberBonus = 0.5 * (b.members.size - 1);
      return {
        symbol: b.ticker,
        buys: b.buys,
        sells: b.sells,
        members: b.members.size,
        maxAmount: b.maxAmount || null,
        flow: round4(flow),
        score: round4(flow + memberBonus),
        price: null,
        pct20d: null,
      };
    })
    .sort((a, b) => b.score - a.score);

  // Momentum nudge (optional): 20-day % move from Yahoo 1d bars, capped at
  // ±2 points — flow stays the primary signal, momentum breaks ties.
  if (cfg.momentumFilter && rows.length) {
    const p1 = Math.floor(Date.now() / 1000) - 45 * 86400;
    for (const row of rows) {
      try {
        const bars = await yahoo.fetchChart(row.symbol, '1d', { period1: p1, period2: Math.floor(Date.now() / 1000) });
        const closes = bars.filter((b) => b.closePrice != null).map((b) => Number(b.closePrice));
        if (closes.length >= 20) {
          const pct20d = ((closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21]) * 100;
          row.pct20d = round4(pct20d);
          row.score = round4(row.score + Math.max(-2, Math.min(2, pct20d / 10)));
          row.price = round4(closes[closes.length - 1]);
        }
      } catch { /* delisted/unknown — keep flow-only score */ }
    }
    rows.sort((a, b) => b.score - a.score);
  }

  const top = rows.slice(0, Number(cfg.topN));
  const bottom = rows.slice(-3).reverse();

  // Named-politician following (owner config, e.g. Dan Meuser / Tim Moore):
  // surface their disclosures + page Telegram on NEW hits.
  const watch = (settings && settings.congress && settings.congress.watchPoliticians) || [];
  const hits = [];
  if (watch.length) {
    for (const t of p.trades) {
      const m = String(t.member || '');
      if (watch.some((w) => m.toLowerCase().includes(String(w).toLowerCase()))) {
        hits.push({ member: t.member, ticker: t.ticker, transaction: t.transaction, amount: t.amount ?? null, date: t.date ?? null, committee: t.committee || null });
      }
    }
  }
  if (hits.length) {
    const key = hits.map((h) => `${h.member}|${h.ticker}|${h.transaction}|${h.date}`).join(';');
    const lastHit = await store.latestEvent(userId, 'politician_alert');
    if (!lastHit || lastHit.payload.key !== key) {
      await store.logEvent(userId, 'politician_alert', { key, hits: hits.slice(0, 10) });
      await require('../../lib/http').telegramAlert(`OSWALD congress watch: ${hits.slice(0, 5).map((h) => `${h.member} ${h.transaction} ${h.ticker}${h.amount ? ` ($${h.amount})` : ''}`).join(' | ')}`).catch(() => {});
    }
  }

  await store.logEvent(userId, 'congress_signal', {
    at: new Date().toISOString(),
    evaluated: rows.length,
    top,
    bottom,
    politicianHits: hits.slice(0, 10),
    note: `congress flow rank from ${p.pulledAt || 'pull'} (${p.buys} buys / ${p.sells} sells in ${p.lookbackDays}d)`,
  });
  return { evaluated: rows.length, top, bottom, note: 'congress flow rank' };
}

module.exports = {
  id: 'congress',
  name: 'Congress Buys (Quiver)',
  description: 'Ranks US tickers by recent congressional PURCHASE flow (recency + amount + distinct members, minus sales) from Quiver disclosure data. Shadow-only — feeds the central AI in paper mode.',
  params: PARAMS,
  DEFAULTS,
  rank,
};
