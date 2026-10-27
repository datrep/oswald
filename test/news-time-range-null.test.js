// test/news-time-range-null.test.js — 2026-10-26.
//
// ONE PARAMETER WAS DESTROYING THE FIELD THAT MATTERED. `settings.news.timeRange` defaulted to `'day'`, which
// reads as a sensible recency bound. Measured on the owner's instance:
//
//     categories=news                -> 30 results, 21 DATED   (bing news + duckduckgo news + wikinews)
//     categories=news&time_range=day -> 10 results,  0 dated   (bing news only)
//
// `time_range` does not filter for recency — it restricts the query to engines that IMPLEMENT time filtering, and
// the only such engine here (`bing news`) never emits `publishedDate`. The request for freshness deleted the field
// freshness is measured with. The default is now `null`, and the horizon is applied locally on the real date.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { newsConf, DEFAULTS } = require('../trading/agent/newsAggregator');
const { buildSearchUrl } = require('../trading/agent/providers/news/searxng');

test('the default sends NO time_range, because its absence is the fix', () => {
  assert.strictEqual(DEFAULTS.timeRange, null);
  assert.strictEqual(newsConf({}).timeRange, null);
  assert.strictEqual(newsConf(null).timeRange, null);
});

test('A NULL DEFAULT MUST NOT BECOME THE STRING "null" — the near-miss that shipped once', () => {
  // `String(n.timeRange ?? DEFAULTS.timeRange)` was the original resolver. The moment the default became null it
  // produced the four-character string `"null"`, the query went out as `time_range=null`, the instance answered
  // HTTP 400, and the cycle reported `searxng_unreachable` — a config typo wearing a network fault's clothes.
  for (const s of [{}, { news: {} }, { news: { timeRange: undefined } }, { news: { timeRange: null } }]) {
    const v = newsConf(s).timeRange;
    assert.strictEqual(v, null, `expected real null for ${JSON.stringify(s)}, got ${JSON.stringify(v)}`);
    assert.notStrictEqual(v, 'null');
  }
});

test('an explicit override still works, so the parameter is not gone — just not the default', () => {
  assert.strictEqual(newsConf({ news: { timeRange: 'week' } }).timeRange, 'week');
  assert.strictEqual(newsConf({ news: { timeRange: 'day' } }).timeRange, 'day');
});

test('the URL builder omits the parameter entirely for null and a literal "null" would have sent it', () => {
  const off = buildSearchUrl('http://x', 'gold', { categories: 'news', timeRange: null });
  assert.ok(!/time_range/.test(off), `null must produce no time_range at all, got ${off}`);
  const on = buildSearchUrl('http://x', 'gold', { categories: 'news', timeRange: 'day' });
  assert.ok(/time_range=day/.test(on));
  // the failure mode, pinned so nobody "fixes" the resolver back into it
  const bad = buildSearchUrl('http://x', 'gold', { categories: 'news', timeRange: 'null' });
  assert.ok(/time_range=null/.test(bad));
});

test('the recency horizon defaults to 48h and 0 disables it as a stated decision', () => {
  assert.strictEqual(DEFAULTS.maxAgeHours, 48);
  assert.strictEqual(newsConf({}).maxAgeHours, 48);
  assert.strictEqual(newsConf({ news: { maxAgeHours: 0 } }).maxAgeHours, 0);
  assert.strictEqual(newsConf({ news: { maxAgeHours: 'bogus' } }).maxAgeHours, 48);
});
