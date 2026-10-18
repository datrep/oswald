// ★★ 2026-10-02 — every watchlist symbol must have a venue category, or it cannot be reached at all.
//
// THE DEFECT THIS PINS. `openInstrument` SEARCHES FIRST and returns `via: 'search'` on a hit; the category is
// consulted ONLY when the search misses. So a symbol absent from `SYMBOL_CATEGORY` fails quietly most of the
// time — right up until search misses, at which point it THROWS `no category mapping for <symbol>` instead of
// landing on a page. Measured live:
//
//     POST /watchlist/open {"symbol":"Natural Gas"}  ->  "no category mapping for Natural Gas"
//     POST /watchlist/open {"symbol":"Gold"}         ->  via=search   (mapped, and search hits anyway)
//
// Two of the four symbols added on 2026-09-30 ('natural gas', 'soybeans') were missing. Soybeans hid it because
// risk vetoed it on `venue_minimum` before it ever reached the order path; Natural Gas did not, and its order
// attempts died with `order ticket did not open`.
//
// ⚠ WHY THIS IS A COVERAGE TEST AND NOT TWO MORE PINS. Pinning `'natural gas': 'commodities'` would fix this
// instance and leave the next symbol to fail at the venue. The map is a PER-SYMBOL fact maintained by hand, so
// the assertion has to be over the WATCHLIST, not over the two lines that were wrong.
//
// ⚠ AND WHY THE LIST IS STATIC. The real watchlist lives in `TradingSettings.settings` (a JSON string in SQL),
// which a unit test cannot read without a database. This list is a MEASURED copy — taken from
// `settings.watchlist.symbols` on 2026-10-01, the same ten the desk reports as its `universe` — and it is
// deliberately the thing that has to be updated alongside the map. A symbol added to the desk and not to this
// list is still unpinned; that gap is stated rather than hidden.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { code } = require('./_source');

const nl = (s) => s.replace(/\r\n/g, '\n');
const webtrader = nl(code('trading/plus500/webtrader.js'));

// Measured from `settings.watchlist.symbols` on 2026-10-01 (10 symbols, matching the desk's reported universe).
const WATCHLIST = [
  'Bitcoin', 'Gold', 'Oil', 'Arabica Coffee', 'Silver', 'Sugar',
  'SGX', 'Natural Gas', 'Soybeans', 'Ethereum',
];

/** The keys of the `SYMBOL_CATEGORY` literal, lower-cased. */
function mappedSymbols() {
  const block = /const SYMBOL_CATEGORY = \{([\s\S]*?)\n\};/.exec(webtrader);
  assert.ok(block, 'SYMBOL_CATEGORY must still be a literal in webtrader.js');
  const keys = new Set();
  for (const m of block[1].matchAll(/(?:^|,)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g)) {
    const k = m[1] ?? m[2] ?? m[3];
    if (k) keys.add(k.toLowerCase());
  }
  return keys;
}

test('★★ every watchlist symbol has a venue category — the Natural Gas / Soybeans omission', () => {
  const mapped = mappedSymbols();
  assert.ok(mapped.size >= 10, `expected the map to be non-trivial, parsed ${mapped.size} keys`);
  const missing = WATCHLIST.filter((s) => !mapped.has(s.toLowerCase()));
  assert.deepStrictEqual(
    missing,
    [],
    `these watchlist symbols have NO category entry, so they can only be reached when the SEARCH happens to ` +
      `hit — and throw 'no category mapping' when it does not: ${missing.join(', ')}`
  );
});

test('★ the two symbols added 2026-09-30 are mapped — the regression, pinned directly', () => {
  // Belt-and-braces against the coverage list above being edited to match a broken map.
  const mapped = mappedSymbols();
  for (const s of ['natural gas', 'soybeans']) {
    assert.ok(mapped.has(s), `${s} must be mapped; its absence is the live 2026-10-02 failure`);
  }
});

test('★ the map still resolves every category it names — a key pointing at a missing URL is the same outage', () => {
  const urls = /const CATEGORY_URLS = \{([\s\S]*?)\n\};/.exec(webtrader);
  assert.ok(urls, 'CATEGORY_URLS must still be a literal');
  const known = new Set();
  for (const m of urls[1].matchAll(/(?:^|,)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g)) {
    const k = m[1] ?? m[2] ?? m[3];
    if (k) known.add(k.toLowerCase());
  }
  const block = /const SYMBOL_CATEGORY = \{([\s\S]*?)\n\};/.exec(webtrader);
  const used = new Set();
  for (const m of block[1].matchAll(/:\s*(?:'([^']+)'|"([^"]+)")\s*,/g)) {
    const v = m[1] ?? m[2];
    if (v) used.add(v.toLowerCase());
  }
  const orphans = [...used].filter((c) => !known.has(c));
  assert.deepStrictEqual(orphans, [], `categories referenced but with no URL: ${orphans.join(', ')}`);
});

test('the search path is still tried BEFORE the category, which is what made this fail only sometimes', () => {
  // The ordering IS the defect's camouflage: if the category were consulted first, an unmapped symbol would fail
  // every time and would have been caught long ago. Pinned so a refactor cannot quietly change which one wins.
  const searchReturn = webtrader.indexOf("via: 'search'");
  const categoryThrow = webtrader.indexOf('no category mapping for');
  assert.ok(searchReturn > -1 && categoryThrow > -1, 'both landmarks must exist');
  assert.ok(searchReturn < categoryThrow, 'the search return must precede the category throw');
});
