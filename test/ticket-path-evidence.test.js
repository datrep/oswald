// EXE-NG-1 — an "order ticket did not open" row must be able to explain itself.
//
// THE INCIDENT. Four Natural Gas attempts on 2026-10-01 were recorded as the same eight words — `order ticket did
// not open`, `errorClass: "other"` — for TWO different faults: a ticket that never appeared (27190ms, 26623ms,
// 26927ms) and a ticket that DID appear but whose submit never became clickable (50158ms). The discriminator —
// which click path reached the ticket — was computed inside `placeOrder` and then discarded, so no reader could
// tell them apart and the row cost a forensics session.
//
// THE ROOT CAUSE, now measured. `SYMBOL_CATEGORY` had no `'natural gas'` entry, so the whole category block was
// SKIPPED and every attempt went down the search fallback — whose click is an UNSCOPED
// `document.querySelector('.button-buy')`. Probed read-only on 2026-10-02: the commodity page carries **22**
// `.button-buy` elements and the FIRST is not inside an instrument row. `clickInstrumentRow` scopes its query to
// the row; the fallback does not. With the category entry added, Natural Gas now reaches its ticket via
// `via: 'category'` in 14.5s with every control present and enabled.
//
// ⚠ SO THESE TESTS PIN TWO THINGS, AND THE SECOND IS THE ONE THAT IS EASY TO GET WRONG:
//   1. the reach path is EXTRACTED, so the diagnostic probe cannot drift from the code it claims to measure;
//   2. the evidence has a READER. Computing `ticketVia`/`ticketCensus` and not carrying them to the journal
//      would reproduce, one layer up, the exact defect this enrichment exists to remove.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('★ the reach path is EXTRACTED, so the probe measures the same code `placeOrder` runs', () => {
  const src = read('trading/plus500/webtrader.js');
  assert.match(src, /async function openTicket\(page, settings, \{ symbol, direction \}\)/,
    'the probe and placeOrder must share one implementation');
  // placeOrder must CALL it rather than keep a second copy of row -> category -> search.
  const po = src.slice(src.indexOf('async function placeOrder('));
  const head = po.slice(0, po.indexOf('await jitterDelay(400, 1100)'));
  assert.match(head, /const reach = await openTicket\(page, settings, \{ symbol, direction \}\)/,
    'placeOrder delegates to openTicket');
  assert.doesNotMatch(head, /SYMBOL_CATEGORY\[/, 'and no longer carries its own copy of the category walk');
});

test('★ the failure carries WHICH PATH and WHAT WAS ON THE PAGE — both, not one', () => {
  const src = read('trading/plus500/webtrader.js');
  assert.match(src, /const e = new Error\('order ticket did not open'\)/);
  assert.match(src, /e\.ticketVia = reach\.via/, 'which click path produced the click');
  assert.match(src, /e\.ticketCensus = await ticketCensus\(page\)/, 'and what the page looked like when it did not open');
});

test('★★ AND THERE IS A READER — the evidence must reach the journal, or it is computed and discarded', () => {
  const src = read('trading/connector/browser.js');
  assert.match(src, /\.\.\.\(e\.ticketVia \|\| e\.ticketCensus \? \{ ticketPath: \{ via: e\.ticketVia \|\| null, \.\.\.\(e\.ticketCensus \|\| \{\}\) \} \} : \{\}\)/,
    'the attempt row is the ONLY place these can land: the line above keeps 140 characters of message');
  // The message slice alone would have lost them, which is the whole point of the assertion above.
  assert.match(src, /error: String\(e\.message \|\| e\)\.slice\(0, 140\)/, 'the message is still the terse form');
});

test('the census reports the UNFILTERED `.button-buy` count, because that is the evidence', () => {
  const src = read('trading/plus500/webtrader.js');
  const fn = src.slice(src.indexOf('async function ticketCensus('), src.indexOf('async function placeOrder('));
  assert.ok(fn.length > 200, 'the slice must find the function — an empty slice passes every assertion below');
  assert.match(fn, /querySelectorAll\('\.button-buy'\)/,
    'the count is what shows the fallback\'s global query had to choose among many');
  assert.match(fn, /firstInsideRow/, 'and whether the one querySelector would take is even a row button');
  assert.match(fn, /amountInput/, 'the field whose absence IS the failure');
  assert.match(fn, /tradeButton/, 'and the submit, for the other signature (opened but never clickable)');
  // ⚠ Read-only by construction: the census must never click, fill or submit.
  assert.doesNotMatch(fn, /\.click\(|\.fill\(|waitForSelector/, 'the census READS the DOM and nothing else');
});
