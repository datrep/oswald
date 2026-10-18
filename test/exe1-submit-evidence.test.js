// test/exe1-submit-evidence.test.js — TRD-EXE-1 (#1454), the diagnostic half of item 4.
//
// ★ THE DEFECT THIS MAKES DIAGNOSABLE. `.positions-orders` holds BOTH positions and QUEUED ORDERS, and the submit
// check anchors on `PositionRow.` — so a queued order cannot match, the check reports
// "position row did not appear after submit (order may have failed)", and the desk retries. On 2026-09-28 that
// produced 7 submits in 100 minutes (Arabica 4 / Sugar 3) whose orders were sitting in the venue's book.
//
// ★ WHY THE CLASSIFICATION FIX IS *NOT* IN THIS CHANGE. Telling a position row from a queued order needs the
// venue's ORDER-row testid prefix, and that cannot be observed from the code — it exists only while a market is
// closed and an order is genuinely queued. Guessing it would risk labelling a position as a queued order, which is
// strictly worse than the current ambiguity. So this change only makes the next occurrence SELF-DOCUMENTING: the
// failure path now reports what the container actually held, which turns "may have failed" into a named row.
//
// Structural, because requiring `webtrader` attaches to the desk's LIVE Chrome on :9224.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { code } = require('./_source');

const nl = (s) => s.replace(/\r\n/g, '\n');
const wt = nl(code('trading/plus500/webtrader.js'));

const from = wt.indexOf("const freshRaw = await page.waitForFunction(");
const to = wt.indexOf('const posId = String(fresh.testid');
const block = from >= 0 && to > from ? wt.slice(from, to) : '';

test('the submit check still anchors on PositionRow — item 4 is NOT silently half-applied', () => {
  // The scan must keep matching exactly what it matched before. If a later change makes it match other prefixes
  // WITHOUT the venue's real order-row testid, this fails and forces the classification to be a real decision.
  assert.ok(block, 'the submit-check block must exist');
  assert.match(block, /\.positions-orders \[data-testid\^="PositionRow\."\]/, 'the anchored scan must survive');
  assert.match(block, /const id = ids\.find\(\(x\) => !prev\.includes\(x\)\);/);
});

test('a failed submit now reports what .positions-orders actually held', () => {
  assert.match(block, /const present = await page\.evaluate/, 'the failure path must read the container');
  assert.match(block, /\.positions-orders \[data-testid\]/, 'it must read EVERY testid, not only PositionRow.');
  assert.match(block, /was EMPTY \(nothing appeared — genuinely ambiguous\)/);
  assert.match(block, /could not be read/);
  assert.match(block, /held \$\{present\.length\} row\(s\)/, 'a non-empty container must be named');
  assert.match(block, /\.positions-orders \$\{shape\}/, 'and the shape must ride on the thrown error');
});

test('the diagnostic did NOT change what counts as success', () => {
  // The load-bearing property: a queued order must STILL not be silently treated as a filled position. The only
  // success path remains a NEW `PositionRow.` testid.
  const successPaths = [...block.matchAll(/return JSON\.stringify\(\{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(successPaths.length, 2, 'exactly two returns: the rejection and the position row');
  assert.match(block, /return JSON\.stringify\(\{ testid: id, text:/, 'the success return is still the PositionRow one');
  assert.match(block, /throw new Error\(`position row did not appear after submit/, 'the no-match path still throws');
});

test('the evidence read is wrapped so a page error cannot mask the real failure', () => {
  // If reading the container itself throws (navigation, detached context), the ORIGINAL failure must still be what
  // is reported — otherwise a diagnostic would replace the finding it exists to explain.
  assert.match(block, /\.catch\(\(\) => null\);\s*$|\.catch\(\(\) => null\)/);
  assert.match(block, /const shape = present == null \? 'could not be read'/);
});
