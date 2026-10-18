// test/ui-format-guards.test.js — TRD-UI-3 / TRD-UI-1 (2026-09-22).
//
// WHY THIS FILE EXISTS. The lab scoreboard shipped with every route contract passing, the endpoint's
// shape matching field for field, and the panel rendering
//     PF=01/01/1970, 07:30:00 p=01/01/1970, 07:30:00
// because `pf` (a profit factor, 0.375) and `p` (a p-value, 0.919) were passed to `fmt`, which is
// `new Date(iso).toLocaleString(...)` — a DATE formatter. The UNIX EPOCH appeared in a column that looked
// like a timestamp. Every number was correct and every drawn cell was nonsense, which is worse than a
// blank because it reads as data.
//
// NOTHING ELSE COULD CATCH IT. The unit suite has no DOM, `ui-routes.test.js` only asks whether a route is
// REACHABLE from a screen, and a response-shape check confirms a field EXISTS without saying anything about
// how it is drawn. So this is a SOURCE pin — the same instrument `parity-liveness.test.js` uses when a
// rule's correctness lives in the wiring rather than in a pure function, and it is written the same way:
// assert the rule, and assert that the premise still holds so the pin cannot silently stop meaning
// anything.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'public', 'js', 'app.js'), 'utf8');

// ⚠ STRIP COMMENTS BEFORE ASSERTING, and this is not tidiness. The first version of the pingRow pin
// asserted `doesNotMatch(body, /c\.ok \?/)` and FAILED ON CORRECT CODE, because the code comment that
// explains WHY not to write a truthiness test CONTAINS the string `c.ok ? ... : ...`. A source pin has to
// assert on what the code DOES, not on what the prose beside it says. (Same trap as TRD-72's bundle test,
// which asserted the absence of a symbol name that the honesty line prints by design.)
const codeOnly = (s) => s.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');

// The body of one top-level function, without needing to know what follows it.
function fnBody(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const rest = src.slice(start + 1);
  const end = rest.indexOf('\nasync function ');
  const end2 = rest.indexOf('\nfunction ');
  const cut = [end, end2].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  return cut === undefined ? rest : rest.slice(0, cut);
}

test('the premise: fmt is a DATE formatter and num is the NUMERIC one', () => {
  // If these ever converge, this file stops protecting anything and should be deleted rather than
  // silently passing.
  assert.match(src, /const fmt = \(iso\) => \{/, 'fmt changed shape — re-read this file before trusting it');
  assert.match(src, /new Date\(iso\)\.toLocaleString/, 'fmt must stay date-based, or the whole pin is moot');
  assert.match(src, /const num = \(v, dp = null\)/, 'num changed shape — re-read this file before trusting it');
});

test('★ the lab scoreboard renders pf and p with the NUMBER formatter, never the date one', () => {
  const body = codeOnly(fnBody('refreshLabScoreboard') || '');
  assert.ok(body, 'refreshLabScoreboard is gone — if the panel was removed, delete this pin with it');
  const numeric = body.split('\n').filter((l) => /bits\.push\(`(PF|p)=/.test(l));
  assert.equal(numeric.length, 2, `expected the two numeric stage fields, found ${numeric.length}`);
  for (const l of numeric) {
    assert.doesNotMatch(l, /fmt\(/, `a numeric stage field is being drawn by the DATE formatter: ${l.trim()}`);
    assert.match(l, /num\(/, `a numeric stage field must go through num(): ${l.trim()}`);
  }
});

test('every fmt() call in the scoreboard is fed a TIMESTAMP field, by name', () => {
  // The general rule the specific bug was an instance of: in a type-free renderer the only thing stopping
  // the wrong helper being reached for is the field's NAME, so the names are what get asserted.
  const body = codeOnly(fnBody('refreshLabScoreboard') || '');
  const calls = [...body.matchAll(/fmt\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(calls.length > 0, 'the scoreboard should still draw at least one timestamp');
  for (const c of calls) {
    assert.match(c, /At$/, `"${c}" is formatted as a date, and that field name is not a timestamp (must end in At)`);
  }
});

test('the ping panel reads ok as THREE states, so a pending probe is not reported as a failure', () => {
  // TRD-UI-1: `POST /ping/browser` answers {status:"started"} with NO `ok` field, so `c.ok ? ... : ...`
  // prints NOT ok for a healthy probe that has not finished. The third state is the whole fix.
  const body = codeOnly(fnBody('pingRow') || '');
  assert.ok(body, 'pingRow is gone');
  assert.match(body, /c\.ok === true/, 'the ok test must be an explicit three-way on true/false/absent');
  assert.match(body, /pending/, 'an absent ok must render as a distinct pending state');
  assert.doesNotMatch(body, /c\.ok \?/, 'a truthiness test on ok collapses pending into failure');
});
