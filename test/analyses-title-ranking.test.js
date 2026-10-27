// test/analyses-title-ranking.test.js — 2026-10-27. `title` is the identity field of an append-only ledger.
//
// ⚠ THE BUG THIS PINS. `extractTitle` took the FIRST line matching ONE pattern that included the bare word
// "analysis". Every page of the premium hub opens with chrome, and one of those chrome lines is the site tagline:
//
//     1  Premium Market Analyses
//     2  Your gateway to in-depth analysis and weekly trends.   <- contains "analysis", matched, PICKED
//     3  Weekly Newsletter
//     4  Instrument Analyses
//     5  Breaking down the week ahead                           <- the actual heading
//
// Measured over the ledger on 2026-10-27: 80 of 163 rows carried the tagline as their title (58 instrument, 22
// weekly). This is not cosmetic — 58 instrument rows carried 45 DIFFERENT analyses under one title, a corpus that
// cannot be partitioned.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseAnalysis, extractTitle } = require('../trading/agent/analysesParser');

const TAGLINE = 'Your gateway to in-depth analysis and weekly trends.';

// Verbatim line order from a real weekly capture (2026-10-27).
const WEEKLY = [
  'Premium Market Analyses',
  TAGLINE,
  'Weekly Newsletter',
  'Instrument Analyses',
  'Breaking down the week ahead',
  'Corellian Academy',
  'Monday 19 October 2026',
  '',
  'Risk sentiment stabilised to start the new week as traders tried to look past the nervousness created by the',
  'recent sell off in AI stocks and the elevated level of geopolitical uncertainty in the Middle East to focus on an',
  'important period of earnings from the US mega cap stocks. US and Asian indices rebounded, prefi',
].join('\n');

// Verbatim line order from a real instrument capture: same chrome, real heading at line 7.
const GOLD = [
  'Premium Market Analyses',
  TAGLINE,
  'Weekly Newsletter',
  'Instrument Analyses',
  'Oil',
  'Natural Gas',
  'Nasdaq 100',
  'Nasdaq 100 Intraday: Key Resistance Focus 29787',
  'Corellian Academy',
  'Thursday 22 October 2026',
  '',
  'Important level to watch - 29787 (4-hour chart) Bollinger Mid-Average',
  'Potential Downside Bias: while prices remain below the resistance at 29787 the risks are for further declines',
  'to test support at 29393 (October 20th low). Closing breaks below 29393 could open moves to 29228 (October',
  '18th low), 29100 (October 17th low) and 29004 (October 15th low).',
].join('\n');

test('★ the weekly view is titled by its heading, not by the site tagline', () => {
  const p = parseAnalysis(WEEKLY, { view: 'weekly' });
  assert.equal(p.kind, 'weekly');
  assert.equal(p.title, 'Breaking down the week ahead');
  assert.notEqual(p.title, TAGLINE);
});

test('★ an instrument view is titled by its heading, not by the tagline above it', () => {
  const p = parseAnalysis(GOLD, { view: 'Gold' });
  assert.equal(p.kind, 'instrument');
  assert.equal(p.title, 'Nasdaq 100 Intraday: Key Resistance Focus 29787');
});

test('a strong marker beats a weak one wherever each appears in the text', () => {
  // The tagline FIRST and the heading LAST is the real page order, so a first-match rule loses. The reverse
  // order is asserted too, so the rule cannot be "the last match" by accident.
  assert.equal(extractTitle(`${TAGLINE}\nMiddle\nGold Intraday: Key Support Focus 4180`), 'Gold Intraday: Key Support Focus 4180');
  assert.equal(extractTitle(`Gold Outlook\n${TAGLINE}\nTail`), 'Gold Outlook');
});

test('the bare word "analysis" is still a fallback for a heading with no stronger word', () => {
  // Not every page uses `intraday`/`outlook`. Dropping the weak pattern entirely would have lost these.
  assert.equal(extractTitle(`${TAGLINE}\nWeekly Analysis of Positioning`), 'Weekly Analysis of Positioning');
});

test('a page with ONLY chrome still returns the tagline — the residual, stated rather than hidden', () => {
  // ⚠ This is deliberately NOT "fixed" into null. If a capture reached no analysis, the rawText and `parseStatus`
  // are what carry that fact; returning null here would look like a parser crash instead of a thin page.
  assert.equal(extractTitle(TAGLINE), TAGLINE);
});

test('the length guard survives the ranking — a long paragraph is not a title', () => {
  const long = 'x'.repeat(200) + ' intraday';
  assert.notEqual(extractTitle(`${long}\nBreaking down the week ahead`), long);
  assert.equal(extractTitle(`${long}\nBreaking down the week ahead`), 'Breaking down the week ahead');
});

test('no text at all is null, not an empty string', () => {
  assert.equal(extractTitle(''), null);
  assert.equal(extractTitle(null), null);
  assert.equal(extractTitle('   \n  \n'), null);
});
