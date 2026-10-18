// test/analyses-parser.test.js — TRD-PRM-1 P1 pins: the premium-analyses parser is pure, so the
// classification and the NAMED failure statuses are pinned without a browser (brief Rev 2 §2 P1).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const parser = require('../trading/agent/analysesParser');

// Mirrors the real oil analysis (rawText already in AnalysesNotes, id 2) — the fixture the study
// will classify against.
const OIL = [
  'Oil Intraday: Key Resistance Focus 91.70',
  'Important level to watch - 91.70 (4-hour chart) Bollinger Mid-Average',
  'Potential Downside Bias: while this level remains intact, the risks are for price weakness to test support at 88.55 (September 29th low). Breaks below 88.55 could open moves to 85.09 (August 31st low).',
  'Potential Upside Bias: Breaks above 91.70 could lead to further price strength towards the next resistance at 94.69 (September 29th high), then 96.50 (September 28th high).',
  'Volatility drivers: Middle East geopolitics; Friday 13:30 BST US Non-farm Payrolls.',
].join('\n');

const WEEKLY = [
  'Premium Market Analyses',
  'Breaking down the week ahead',
  'Risk sentiment struggled for direction after President Trump rejected the most recent proposal from Iran to reopen the Strait of Hormuz.',
  'Volatility drivers: Friday US Non-farm Payrolls.',
].join('\n');

test('oil analysis: five levels extracted, with the analysis\' own words kept', () => {
  const p = parser.parseAnalysis(OIL, { view: 'Oil' });
  assert.equal(p.kind, 'instrument');
  assert.equal(p.symbol, 'Oil');
  assert.equal(p.parseStatus, 'ok');
  assert.equal(p.levels.length, 5);
  const byPrice = new Map(p.levels.map((l) => [l.price, l]));
  assert.ok(byPrice.has(96.5) && byPrice.has(94.69) && byPrice.has(88.55) && byPrice.has(85.09) && byPrice.has(91.7));
  assert.equal(byPrice.get(88.55).levelKind, 'support');
  assert.equal(byPrice.get(85.09).levelKind, 'support');
  assert.equal(byPrice.get(94.69).levelKind, 'resistance');
  assert.equal(byPrice.get(96.5).levelKind, 'resistance');
  assert.equal(byPrice.get(91.7).levelKind, 'pivot');
  assert.equal(byPrice.get(91.7).timeframeHint, '4h');
  assert.match(byPrice.get(88.55).label, /September 29th low/);
  for (const l of p.levels) assert.ok(l.snippet && l.snippet.length > 5, 'every level carries its snippet');
});

test('weekly view: stored as weekly, no levels expected, still ok', () => {
  const p = parser.parseAnalysis(WEEKLY, { view: 'weekly' });
  assert.equal(p.kind, 'weekly');
  assert.equal(p.symbol, null);
  assert.equal(p.parseStatus, 'ok');
  assert.equal(p.levels.length, 0);
  assert.match(p.title || '', /Breaking down the week ahead/i);
});

test('named failures: short text -> page_missing; a page without level pairs -> no_levels', () => {
  assert.equal(parser.parseAnalysis('', { view: 'Oil' }).parseStatus, 'page_missing');
  const junk = 'Oil Intraday: something short happened today and the desk saw it. '.repeat(4);
  assert.equal(parser.parseAnalysis(junk, { view: 'Oil' }).parseStatus, 'no_levels');
});

test('classification and hint helpers are the frozen vocabulary', () => {
  assert.equal(parser.classifyLevel('September 28th high'), 'resistance');
  assert.equal(parser.classifyLevel('September 29th low'), 'support');
  assert.equal(parser.classifyLevel('support zone below'), 'support');
  assert.equal(parser.classifyLevel('resistance band'), 'resistance');
  assert.equal(parser.classifyLevel('4-hour chart Bollinger Mid-Average'), 'pivot');
  assert.equal(parser.classifyLevel('next target'), 'target');
  assert.equal(parser.classifyLevel('weekly open'), 'level');
  assert.equal(parser.timeframeHint('4-hour chart'), '4h');
  assert.equal(parser.timeframeHint('daily pivot'), '1d');
  assert.equal(parser.timeframeHint('September 29th high'), null);
});

test('duplicates by price+kind collapse to one; the tail append only fires without a role word', () => {
  const dup = 'Watch 91.70 (4-hour chart) Bollinger Mid-Average. Above 91.70 (4-hour chart) Bollinger Mid-Average. Near 12.34 (zone high).';
  const p = parser.parseAnalysis(`${dup}\n${dup}\n${dup}`, { view: 'Gold' });
  const pivots = p.levels.filter((l) => l.price === 91.7 && l.levelKind === 'pivot');
  assert.equal(pivots.length, 1);
  const zoned = p.levels.find((l) => l.price === 12.34);
  assert.equal(zoned.levelKind, 'resistance');
  assert.match(zoned.label, /zone high/);
});
