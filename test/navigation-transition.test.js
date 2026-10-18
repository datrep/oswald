// test/navigation-transition.test.js — TRD-66 (2026-09-22).
//
// ★ WHAT WAS ACTUALLY WRONG, measured rather than inferred. TRD-66 was found by a loop doing
// `POST /watchlist/open` THEN `POST /instruments/probe` as two requests. On 2026-09-22, at the pacing that
// originally failed, 6 symbols produced:
//     3 of 6 second requests ARRIVED at a route the caller never asked for
//       (/open-positions, /trade/all-commodities, /trade/all-popular)
//     symbol #3 returned the original symptom verbatim: `not_demo: page has no content (0 chars)`
// The one-call shape `POST /instruments/probe {symbol}` — which takes the ticket lock across the open AND the
// read — walked ALL 12 symbols cleanly at the SAME pacing. So the cause is not rate-limiting and not "the SPA
// gives up after N": it is that pageLock is IN-PROCESS state, so no client can hold the shared tab across two
// HTTP calls, and the desk's own mirror pollers move that tab in between.
//
// This file pins the two things that make that survivable: the probe RECORDS the transition at three points,
// so a future occurrence is evidence rather than three guards each blaming itself; and the racy route says so,
// so the next client does not rediscover it the expensive way.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const probeSrc = fs.readFileSync(path.join(__dirname, '..', 'trading', 'plus500', 'instrumentProbe.js'), 'utf8');
const routesSrc = fs.readFileSync(path.join(__dirname, '..', 'trading', 'routes.js'), 'utf8');
const codeOnly = (s) => s.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
const probe = codeOnly(probeSrc);
const routes = codeOnly(routesSrc);

test('the premise: the one-call shape still opens INSIDE the lock', () => {
  // If the lock stops spanning the open and the read, the safe shape stops being safe and everything below is
  // protecting the wrong thing. Order matters: acquire, then open, then read.
  const acquire = probe.indexOf("pageLock.acquire('ticket'");
  const open = probe.indexOf('openInstrument(page, settings || {}, symbol)');
  // ⚠ Two separate traps, both hit here before the pin said anything true.
  //   (1) `probeCurrentPage(page)` first matches the FUNCTION DEFINITION near the top of the file.
  //   (2) `await probeCurrentPage(page)` first matches the SCAN branch, which sits BEFORE the symbol branch.
  // So the read must be searched for STARTING AT the open, i.e. the read belonging to this branch — not the
  // first read in the file, which belongs to a different code path that has nothing to do with the race.
  const read = probe.indexOf('await probeCurrentPage(page)', open);
  assert.ok(acquire !== -1, 'the probe no longer takes the ticket lock');
  assert.ok(open !== -1, 'the probe no longer opens the requested instrument');
  assert.ok(read !== -1, 'the probe no longer reads the page');
  assert.ok(acquire < open && open < read, 'the open and the read must both happen AFTER the lock is taken');
});

test('★ the probe records the transition at three points rather than inferring it', () => {
  // before    - the shared tab AS THE REQUEST FOUND IT (already blank != blanked by us; the original
  //             measurement could not tell those apart, which is why the cause stayed unknown for a week)
  // afterOpen - what the navigation produced
  // after     - what the read left behind, i.e. what the NEXT symbol inherits
  assert.match(probe, /const pageBefore = await readPageState\(\);/, 'the arrival state must be recorded');
  assert.match(probe, /const pageAfterOpen = symbol \? await readPageState\(\) : null;/, 'the post-navigation state must be recorded');
  assert.match(probe, /const pageAfter = await readPageState\(\);/, 'the inherited state must be recorded');
  assert.match(probe, /page: \{ before: pageBefore, afterOpen: pageAfterOpen, after: pageAfter \}/,
    'all three must reach the response, or the walk cannot locate the transition');
  // The two fields that make the reading decidable: the URL says WHICH page, the length says whether it RENDERED.
  assert.match(probe, /url: String\(location\.href\)/, 'the URL is what identifies a foreign route');
  assert.match(probe, /bodyLen: document\.body \? document\.body\.innerText\.length : 0/, 'the body length is what identifies a dead render');
  // Read-only: these must not click, navigate or close anything.
  const reader = probe.slice(probe.indexOf('const readPageState = ()'), probe.indexOf('const pageBefore ='));
  assert.doesNotMatch(reader, /\.click\(|goto\(|\.close\(|mouse\./, 'the page-state reader must not interact with the page');
});

test('★ the racy route says so, because the race cannot be fixed from inside it', () => {
  // pageLock is in-process, so the pair CANNOT be made safe server-side. The honest remedy is to name the
  // hazard and the safe call where a client will see it, since a blank page otherwise reads as `not_demo` and
  // a batch caller then treats a healthy symbol as unusable.
  assert.match(routes, /const WATCHLIST_OPEN_RACE_WARNING =/, 'the warning must be defined once, not inlined twice');
  // ⚠ Asserted in PIECES: the warning is built from several concatenated string literals, so a single regex
  // spanning "the safe call" and "instead" cannot match — the word sits in the NEXT literal after `' + '`.
  assert.match(routes, /Use POST \/instruments\/probe \{symbol\}/, 'the warning must name the SAFE call, not just the hazard');
  assert.match(routes, /holds the page lock across the open AND the read/, 'and say WHY it is safe, or the warning is just a rule');
  const openRoute = routes.slice(routes.indexOf("router.post('/watchlist/open'"));
  const body = openRoute.slice(0, openRoute.indexOf('\n}));'));
  assert.equal((body.match(/warning: WATCHLIST_OPEN_RACE_WARNING/g) || []).length, 2,
    'BOTH success paths must carry it — a recovered page is the likeliest place to hide the hazard');
  // And the recovery that already existed must stay: a dead render is not a statement about the account.
  assert.match(body, /if \(!demo\.demo && demo\.blank\)/, 'the dead-render recovery must stay on this route');
});

test('★ the probe response distinguishes "no contract" from "the page is blank"', () => {
  // The failure detail is the whole diagnostic. `demo marker NOT found` and `page has no content (0 chars)`
  // need OPPOSITE responses — one is a refusal, the other a recovery — and the first version could not tell
  // them apart, which is why the cause stayed unknown for a week.
  const wt = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'trading', 'plus500', 'webtrader.js'), 'utf8'));
  assert.match(wt, /const blank = text\.trim\(\)\.length <= 20;/, 'assertDemo must report blankness structurally');
  assert.match(wt, /not evidence about the account/, 'a blank page must not be described as an account problem');
  assert.match(wt, /demo marker NOT found in \$\{text\.length\} chars of body text/, 'a real miss must report the length it searched');
});
