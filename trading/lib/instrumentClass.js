'use strict';
// trading/lib/instrumentClass.js — 2026-10-18 (owner: "dont gate. any 24/7 stocks are available to be used").
//
// WHY A CURATED CLASS AND NOT A FEED LOOKUP: the venue's TradingHours payload is the authority when it is
// present, and `sessionState` already lets an explicit `isTraded === false` close an instrument. But the feed
// can be SILENT — measured 2026-10-18: `sessionFeed.get()` returned null for every symbol while the shared
// tab sat on the watchlist page. In that state the STOCK-CFD weekend calendar (Fri 21:00-Sun 21:00 UTC) was
// closing CRYPTO too, so the desk skipped every weekend wake and could not manage or enter a 24/7 instrument
// while the venue was happily trading it (trade #1319 was closed by the venue's own take-profit for +S$22.98
// during one of those skipped wakes).
//
// The set is deliberately SMALL and explicit rather than inferred from a symbol's name: a wrong guess here
// would either trade a closed instrument or refuse an open one. Adding a name is a one-line, reviewable act.
const ALWAYS_OPEN_SYMBOLS = ['Bitcoin', 'Ethereum'];

/** True when the instrument trades 24/7 and the stock-CFD weekend calendar must not close it. */
function isTwentyFourSeven(symbol) {
  const s = String(symbol || '').trim().toLowerCase();
  return ALWAYS_OPEN_SYMBOLS.some((x) => x.toLowerCase() === s);
}

module.exports = { isTwentyFourSeven, ALWAYS_OPEN_SYMBOLS };
