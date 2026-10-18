// trading/agent/providers/congress.js — TRD-11: Quiver Quantitative Congress
// trading data provider (free tier, needs a token from quiverquant.com).
// Endpoint: GET api.quiverquant.com/beta/live/congresstrading (Bearer token).
// Normalizes disclosure rows defensively (field names have drifted over
// time); keeps PURCHASES only for the strategy, but stores everything.
// Also enriches the tickers with Yahoo mids (writes PriceTicks) so the paper
// broker can fill and mark US-ticker positions.
'use strict';

const https = require('https');
const store = require('../../store');
const yahoo = require('./yahoo');

const ENDPOINT = 'https://api.quiverquant.com/beta/live/congresstrading';

function getJson(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(
      { hostname: u.hostname, path: u.pathname + u.search, timeout: 30000,
        headers: { 'User-Agent': 'oswald trading-agent congress provider', Accept: 'application/json', Authorization: `Bearer ${token}` } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 200) {
            try { resolve(JSON.parse(text)); } catch { reject(new Error('bad json from quiver')); }
          } else if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error(`quiver auth ${res.statusCode} — get a free token at quiverquant.com/dashboard`));
          } else {
            reject(new Error(`quiver http ${res.statusCode}: ${text.slice(0, 120)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('quiver timeout')));
  });
}

const pick = (row, ...keys) => {
  for (const k of keys) if (row[k] != null && row[k] !== '') return row[k];
  return null;
};

// Normalize one Quiver row -> {ticker, member, chamber, party, transaction,
// date, amount}. transaction = purchase|sale|exchange|other.
function normalize(row) {
  const ticker = String(pick(row, 'Ticker', 'ticker') || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) return null;
  const txRaw = String(pick(row, 'Transaction', 'transaction', 'Type', 'type') || '').toLowerCase();
  const transaction = /purchase|buy/.test(txRaw) ? 'purchase'
    : /sale/.test(txRaw) ? 'sale'
      : /exchange/.test(txRaw) ? 'exchange' : 'other';
  const dateRaw = pick(row, 'TransactionDate', 'transactionDate', 'ReportDate', 'reportDate');
  const date = dateRaw ? new Date(dateRaw) : null;
  if (date && Number.isNaN(date.getTime())) return null;
  return {
    ticker,
    member: String(pick(row, 'Representative', 'Senator', 'Member', 'member') || 'unknown').slice(0, 80),
    chamber: String(pick(row, 'Chamber', 'chamber') || 'unknown').slice(0, 20),
    party: String(pick(row, 'Party', 'party') || '').slice(0, 20),
    transaction,
    date: date ? date.toISOString() : null,
    amount: Number(pick(row, 'Amount', 'amount')) || null,
  };
}

// Pull + store: full normalized set into TradingEvents kind 'congress', plus
// yahoo ticks for every ticker seen in the last `priceEnrich` days so the
// paper broker can fill/mark them.
async function pullCongressTrades(userId, settings) {
  const c = (settings && settings.congress) || {};
  const token = c.token || process.env.QUIVER_API_KEY;
  if (!token) throw new Error('congress.token missing — get a free key at quiverquant.com/dashboard (or set QUIVER_API_KEY)');
  const rows = await getJson(ENDPOINT, token);
  if (!Array.isArray(rows)) throw new Error('quiver returned an unexpected payload');
  const trades = rows.map(normalize).filter(Boolean);
  if (!trades.length) throw new Error('quiver returned no usable trades');

  const lookbackDays = Number(c.lookbackDays) || 30;
  const cutoff = Date.now() - lookbackDays * 86400000;
  const recent = trades.filter((t) => t.date && new Date(t.date).getTime() >= cutoff);
  const buys = recent.filter((t) => t.transaction === 'purchase');

  // Enrich the tickers that appear in the recent window with live yahoo mids.
  const tickers = [...new Set(recent.map((t) => t.ticker))].slice(0, 25);
  const prices = {};
  const ticks = [];
  const now = new Date();
  for (const ticker of tickers) {
    try {
      const q = await yahoo.fetchQuote(ticker);
      prices[ticker] = { price: q.mid, at: q.at.toISOString() };
      ticks.push({ venue: 'yahoo', symbol: ticker, bid: q.mid, ask: q.mid, source: 'yahoo_rest', capturedAt: now });
    } catch { /* unmapped/delisted — price just stays null */ }
  }
  if (ticks.length) await store.addTicks(userId, ticks);

  const payload = {
    pulledAt: new Date().toISOString(),
    total: trades.length,
    recent: recent.length,
    buys: buys.length,
    sells: recent.filter((t) => t.transaction === 'sale').length,
    lookbackDays,
    trades: recent.map((t) => ({ ...t })),
    prices,
  };
  await store.logEvent(userId, 'congress', payload);
  return payload;
}

module.exports = { pullCongressTrades, normalize, ENDPOINT };
