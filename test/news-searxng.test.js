// test/news-searxng.test.js — 2026-10-03: S1 fetch layer pins (open-work 4.19 / TRD-NEW-1).
//
// These pins hold the three degradation classes and the row mapping BEFORE the loop consumes them,
// because the failure this desk keeps paying for is not "the fetch broke" — it is "the fetch broke
// and the record looked quiet". A named reason per failure is the whole point; an exception that
// escapes would be the same defect wearing a stack trace.
//
// Run with: npm run test:unit  (or: node --test test/news-searxng.test.js)
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const s = require('../trading/agent/providers/news/searxng');

test('buildSearchUrl — pinned query contract (json format, categories, time_range)', () => {
  const u = s.buildSearchUrl('http://127.0.0.1:18080', 'BTC OR (Bitcoin AND crypto)');
  assert.ok(u.startsWith('http://127.0.0.1:18080/search?'), u);
  assert.ok(u.includes('format=json'));
  assert.ok(u.includes('categories=news'));
  assert.ok(u.includes('time_range=day'));
  assert.ok(u.includes('q=BTC+OR+%28Bitcoin+AND+crypto%29') || u.includes('q=BTC%20OR%20(Bitcoin%20AND%20crypto)'), u);
  // trailing slash on the base must not produce '//search'
  const v = s.buildSearchUrl('http://127.0.0.1:18080/', 'gold');
  assert.ok(v.includes('/search?') && !v.includes('//search'), v);
});

test('parseSearchResponse — the three degradation classes are NAMED, never thrown', () => {
  const ok = s.parseSearchResponse(200, '{"results":[]}', 'u');
  assert.strictEqual(ok.ok, true);

  const fmt = s.parseSearchResponse(403, '{"error":"Format not allowed"}', 'u');
  assert.strictEqual(fmt.ok, false);
  assert.strictEqual(fmt.reason, s.DEGRADE_REASONS.format);

  const down = s.parseSearchResponse(502, 'bad gateway', 'u');
  assert.strictEqual(down.ok, false);
  assert.strictEqual(down.reason, s.DEGRADE_REASONS.unreachable);

  const bad = s.parseSearchResponse(200, '<html>nope</html>', 'u');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, s.DEGRADE_REASONS.badjson);
});

test('mapResults — field mapping, drops unopenable items, absence stays NULL', () => {
  const body = {
    results: [
      { url: 'https://www.reuters.com/markets/gold-x', title: 'Gold steadies', content: 'snip', engine: 'bing news', score: 1.5, publishedDate: '2026-10-03T08:00:00+00:00' },
      { url: '', title: 'no url — dropped' },
      { url: 'https://x.example/y', title: '' },
      { url: 'https://example.com/z', title: 'No date item' },
    ],
    unresponsive_engines: [['brave.news', 'too many requests'], ['startpage news', 'CAPTCHA']],
  };
  const m = s.mapResults('Gold', '(Gold AND commodity)', body, { maxPerSymbol: 10 });
  assert.strictEqual(m.rows.length, 2, 'only the two openable items survive');
  assert.strictEqual(m.dropped, 2);
  assert.strictEqual(m.rows[0].source, 'reuters.com');
  assert.strictEqual(m.rows[0].engine, 'bing news');
  assert.ok(m.rows[0].publishedAt instanceof Date);
  assert.strictEqual(m.rows[1].publishedAt, null, 'missing date is NULL, never the epoch');
  assert.strictEqual(m.rows[1].score, null);
  assert.deepStrictEqual(m.unresponsive, ['brave.news:too many requests', 'startpage news:CAPTCHA']);
});

test('mapResults — itemHash is deterministic (dedupe key) and per-symbol', () => {
  const body = { results: [{ url: 'https://a.example/1', title: 'T' }] };
  const a = s.mapResults('Gold', 'q', body).rows[0].itemHash;
  const b = s.mapResults('Gold', 'q', body).rows[0].itemHash;
  const c = s.mapResults('Silver', 'q', body).rows[0].itemHash;
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c, 'same article under two symbols stays two rows');
  assert.strictEqual(a.length, 64);
});

test('mapResults — maxPerSymbol caps the row set', () => {
  const body = { results: Array.from({ length: 40 }, (_, i) => ({ url: `https://e.example/${i}`, title: `t${i}` })) };
  assert.strictEqual(s.mapResults('Gold', 'q', body, { maxPerSymbol: 5 }).rows.length, 5);
});
