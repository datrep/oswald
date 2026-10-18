// trading/agent/newsKeywords.js — S1 of the news aggregator (open-work §4.19 / TRD-NEW-1).
//
// Pure keyword composer: watchlist display names -> one deterministic search query per symbol.
// No network, no DB, no model — this file exists so the query shape is TESTABLE in isolation and
// cannot drift between the fetcher, the digest and (later) S3.
//
// THE SHAPE, from the corrected design brief (§4):
//     ticker OR (display name AND category term)          — never the display name alone
// The left side exists to break ties for ambiguous display names (a symbol like `Sugar` or `Oil`
// matches a thousand unrelated pages); the right side keeps the item anchored to the instrument's
// family. For instruments whose "ticker" is a future placeholder a search engine cannot resolve
// (`GC=F`, `SI=F` — Yahoo proxies, not tradeable names), the left side is DROPPED rather than sent:
// a query token that only means something to the desk's own feed is noise to a web search.
//
// Categories come from pulse.categorize() — the exported single source of truth (brief §4: reuse,
// do not re-derive). SYMBOL_MAP is the provider registry the category function itself reads.
'use strict';

const { SYMBOL_MAP } = require('./providers');
const { categorize } = require('./pulse');

// Category label used INSIDE the query text. Deliberately generic English (what a news page would
// say), not the desk's internal category code: searxng searches the open web, not this database.
const CATEGORY_TERM = {
  crypto: 'crypto',
  commodities: 'commodity',
  singapore: 'Singapore',
  'hong-kong': 'Hong Kong',
  equities: 'stock',
};

// A "ticker" token only goes on the left of the OR when a search engine can resolve it:
//   - crypto: the exchange base (BTCUSDT -> BTC) is a universally recognised token;
//   - plain symbols (1928.HK, D05.SI): resolvable with the exchange suffix attached;
//   - futures proxies (=F) and non-token identifiers: NOT resolvable -> dropped.
function newsTickerFor(symbol, entry, category) {
  const e = entry || {};
  if (category === 'crypto' && e.binance && /USDT$/.test(e.binance)) return e.binance.replace(/USDT$/, '');
  const y = String(e.yahoo || '');
  if (y && !y.includes('=') && !/^\^/.test(y)) return y;
  return null;
}

// ★ MEASURED QUIRK THIS MODULE MUST CORRECT FOR ITS OWN PURPOSE — NOT FIX IN PASSING.
// Gold carries a binance PROXY key (PAXGUSDT, added for data collection), and pulse.categorize()
// keys on `entry.binance` FIRST — so Gold classifies as 'crypto'. That is existing desk behaviour
// (other readers see it too) and it is not this module's to change during a freeze. But a web-search
// query built from it would be wrong twice over: `PAXG OR (Gold AND crypto)` returns Paxos-token
// news for a futures-position desk. RULE: when the symbol has a futures-proxy yahoo series
// (ends with '=F'), the QUERY category is commodities and the binance token is not used — the proxy
// key means "a tradable data feed exists", not "gold news is crypto news".
function queryCategoryFor(display, entry) {
  const y = String((entry || {}).yahoo || '');
  if (y.endsWith('=F')) return 'commodities';
  return categorize(display);
}

// One query per symbol. Pure — pinned by test/news-keywords.test.js.
function keywordFor(symbol) {
  const display = String(symbol || '').trim();
  if (!display) return null;
  const entry = SYMBOL_MAP[display] || {};
  const category = queryCategoryFor(display, entry);
  const term = CATEGORY_TERM[category] || category;
  const ticker = newsTickerFor(display, entry, category);
  const phrase = display.includes(' ') ? `"${display}"` : display;
  const right = `(${phrase} AND ${term})`;
  return {
    symbol: display,
    category,
    ticker,
    query: ticker ? `${ticker} OR ${right}` : right,
  };
}

// All composed queries for a watchlist, stable order, duplicates removed (two display names can
// never currently collide on a query, but the guarantee belongs here, not in the caller).
function keywordsFor(symbols = []) {
  const seen = new Set();
  const out = [];
  for (const s of symbols) {
    const k = keywordFor(s);
    if (!k || seen.has(k.query)) continue;
    seen.add(k.query);
    out.push(k);
  }
  return out;
}

module.exports = { keywordFor, keywordsFor, newsTickerFor, queryCategoryFor, CATEGORY_TERM };
