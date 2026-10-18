// ★ TRD-EXE-18 — the venue price was COMPUTED and then DROPPED one layer up.
//
// MEASURED LIVE 2026-10-01, which is why these tests exist: every recorded `session_probe` event carried
// `venueMid: null` (2 of 2). `searchInstrument` already falls back to the loaded category table when the ticket
// does not render, and returns a real price tagged `source: 'table'`. `openInstrument` discarded `hit.buy` /
// `hit.sell` from its own return value, and `probeSession` — which calls it — then re-ran the SAME ticket read
// that had just failed. The countermeasures were not broken; the number never arrived.
//
// ⚠ These are SOURCE assertions, and they are deliberately about ORDER and SHAPE rather than about a captured
// string. Two earlier tests in this workstream went red for the wrong reason — one pinned an expression the edit
// changed, one searched for text that only existed inside a comment — and both were fixed by making the
// assertion describe the behaviour instead of the code that happens to implement it.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const WEB = 'trading/plus500/webtrader.js';
const EXEC = 'trading/agent/executor.js';

// Comments are stripped so the assertions are about CODE. `//` is only treated as a comment start at the beginning
// of a line or after whitespace, so URLs (`https://…`) survive intact.
function code(rel) {
  const raw = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}

// ⚠ BRACE-MATCHED, not "up to the next function". `probeSession` is the last function in the file, so a
// next-function slicer runs off the end into `module.exports` — which lists `placeOrder`, and made the
// navigation-only assertion below fail for entirely the wrong reason.
const sliceFn = (src, name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i === -1) return null;
  const open = src.indexOf('{', i);
  if (open === -1) return null;
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const c = src[k];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(i, k + 1);
    }
  }
  return src.slice(i);
};

test('★ openInstrument carries the venue price OUT instead of discarding it', () => {
  const body = sliceFn(code(WEB), 'openInstrument');
  assert.ok(body, 'openInstrument must exist');
  // The search path: the price came from `searchInstrument`, which returns it either from the ticket or from the
  // category table. This is the value that was being thrown away.
  assert.match(body, /buy, sell, priceSource: buy != null \|\| sell != null \? \(search\.source \|\| 'search'\) : null/,
    'the search path must return the price it already obtained');
  // The category path has no search hit, so the card its own click opened is the only source that exists there.
  assert.match(body, /buy: catPx\.buy, sell: catPx\.sell, priceSource: catPx\.source/,
    'the category path must read the card it just opened');
});

test('★★ probeSession keeps the openInstrument RESULT — discarding it WAS the defect', () => {
  const body = sliceFn(code(WEB), 'probeSession');
  assert.ok(body, 'probeSession must exist');
  assert.match(body, /const opened = \(await openInstrument\(page, settings, symbol\)\) \|\| \{\}/,
    'the result must be kept; a bare `await openInstrument(...)` is the defect this row removes');
});

test('★★ the navigation price comes FIRST and readTicket is the FALLBACK', () => {
  const body = sliceFn(code(WEB), 'probeSession');
  const nav = body.indexOf('priceNum(opened.buy)');
  const ticket = body.indexOf('ticketPrice(await readTicket(page)');
  assert.ok(nav > -1, 'the navigation result must be read');
  assert.ok(ticket > nav, 'the ticket read must come AFTER it — it is the read measured failing on this page');
  assert.match(body, /if \(buy == null && sell == null\) \{/,
    'the fallback is entered only when the navigation produced nothing');
});

test('★ the ticket extraction exists ONCE, so the readers cannot drift apart', () => {
  const web = code(WEB);
  assert.equal((web.match(/function ticketPrice\(/g) || []).length, 1,
    'three readers of one element is three chances to disagree');
  const body = sliceFn(web, 'probeSession');
  assert.ok(!body.includes('parseFloat(String(s).replace'),
    'probeSession must not re-implement the ticket parse a third time');
});

test('★ WHICH source produced the price is reported, not inferred', () => {
  const body = sliceFn(code(WEB), 'probeSession');
  assert.match(body, /priceSource/, 'the source travels with the price');
  // And it survives the failure path: a probe that threw still has a shape a caller can read.
  assert.match(body, /venueMid: null, priceSource: null/,
    'the failure return must carry the same shape');
});

test('★ the executor records the venue price source beside the price it explains', () => {
  const exec = code(EXEC);
  assert.match(exec, /venuePriceSource: probe && probe\.priceSource \? probe\.priceSource : null/);
  const mid = exec.indexOf('venueMid: probe && probe.venueMid');
  const src = exec.indexOf('venuePriceSource:');
  assert.ok(mid > -1 && src > mid, 'a null price and a price from the wrong page are different facts');
});

test('the probe is STILL navigation-only — the safety argument is unchanged by this fix', () => {
  const body = sliceFn(code(WEB), 'probeSession');
  // ⚠ The whole reason the probe is allowed to exist: it cannot write a size, a level, or click Buy/Sell. Reading
  // a price does not weaken that, and this test is here so a future edit cannot quietly claim it does.
  for (const forbidden of ['placeOrder', 'fillPips', '#amount-input', 'button-buy', 'button-sell', 'fillRate']) {
    assert.ok(!body.includes(forbidden), `probeSession must NOT touch ${forbidden}`);
  }
});
