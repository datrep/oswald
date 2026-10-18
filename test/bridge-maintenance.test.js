// test/bridge-maintenance.test.js — TRD-46 pins:
//   "the shared Plus500 tab leaks (one renderer held 875 MB of a 1,515 MB tree) and the only thing
//    that reclaims it is a reload — but the reload must never land mid-ticket."
//
// The lock itself is pure state and is tested BEHAVIOURALLY. The reload module is NOT required here:
// requiring it pulls in the CDP browser manager, and the one time this repo required a browser-touching
// module from a unit test it attached to the desk's LIVE Chrome. So the module is checked
// structurally, against its source, which is the same trade-off TRD-48's test made.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pageLock = require('../trading/plus500/pageLock');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Assertions run against CODE, not prose. Both failures this test file had on its first run were a
// `doesNotMatch` matching the words inside a comment that was explaining why the call is absent —
// which is a test that fails on documentation rather than on behaviour. `://` is preserved so URLs in
// strings survive the strip.
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// ---------------------------------------------------------------------------------------------
// The lock — the whole reason this is a coordinated action
// ---------------------------------------------------------------------------------------------

test('a maintenance reload cannot start while a ticket holds the tab', async () => {
  assert.equal(pageLock.tryAcquire('ticket'), true);
  try {
    // The ticket owns the tab. A reload that proceeded here is the 6289 defect again.
    assert.equal(pageLock.tryAcquire('maintenance'), false, 'a reload must not steal the tab');
    assert.equal(pageLock.held(), true);
    assert.equal(pageLock.status().holder, 'ticket');
  } finally {
    pageLock.release('ticket');
  }
  assert.equal(pageLock.held(), false, 'the ticket released it');
});

test('a ticket cannot start while a reload holds the tab, and a foreign name cannot free it', async () => {
  const got = await pageLock.acquire('maintenance', { waitMs: 1000 });
  assert.equal(got.acquired, true);
  try {
    assert.equal(pageLock.tryAcquire('ticket'), false, 'the exclusion must work in BOTH directions');
    // Owner-checked release: a flow that merely believes it is done must not free someone else's claim.
    pageLock.release('mirror');
    assert.equal(pageLock.held(), true, 'a foreign release is a no-op');
    assert.equal(pageLock.status().holder, 'maintenance');
  } finally {
    pageLock.release('maintenance');
  }
  assert.equal(pageLock.held(), false);
});

test('a bounded acquire gives up instead of queueing forever', async () => {
  assert.equal(pageLock.tryAcquire('ticket'), true);
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => pageLock.acquire('maintenance', { waitMs: 300 }),
      /bridge busy \(ticket\)/,
      'a maintenance reload must be able to give up rather than hold a request open behind a ticket',
    );
    assert.ok(Date.now() - t0 >= 250, 'it should have actually waited');
  } finally {
    pageLock.release('ticket');
  }
  assert.equal(pageLock.held(), false, 'a FAILED acquire must not leave the lock taken');
});

// ---------------------------------------------------------------------------------------------
// The reload module — structural, because requiring it would attach to live Chrome
// ---------------------------------------------------------------------------------------------

const MAINT = 'trading/plus500/maintenance.js';

test('the reload takes the lock, and releases it on every path (including a failed reload)', () => {
  const src = code(MAINT);
  assert.match(src, /pageLock\.acquire\(HOLDER,\s*\{\s*waitMs\s*\}\)/, 'it must WAIT for the tab, not assume it is free');
  assert.match(src, /finally\s*\{[\s\S]*pageLock\.release\(HOLDER\)/, 'release must be in a finally block');
  assert.match(src, /if \(!\(await browser\.chromeAlive\(\)\)\)/, 'it must not try to reload a bridge that is down');
  // A busy bridge is a SKIP, never a forced pre-emption.
  assert.match(src, /skipped: 'bridge_busy'/);
});

test('the reload uses the shared tab and never closes it', () => {
  const src = code(MAINT);
  assert.match(src, /browser\.newPage\(\)/, 'the shared tab is what must be reloaded');
  assert.match(src, /page\.reload\(/, 'reload is the primitive');
  // The two calls that kill the desk's bridge. Reload is safe precisely because it is neither.
  assert.doesNotMatch(src, /page\.close\(/, 'closing the last tab exits Chrome');
  assert.doesNotMatch(src, /browser\.disconnect\(|ensureBrowser\(/, 'disconnecting kills the venue feed');
  // And it must not navigate: the account poller caches the Page handle and the mirror parks on
  // /open-positions, so changing the URL underneath them trades one problem for another.
  assert.doesNotMatch(src, /page\.goto\(/, 'a maintenance reload must not move the tab');
});

test('the reload waits for the SPA to actually come back, and reports rather than throws', () => {
  const src = code(MAINT);
  assert.match(src, /settle\(page/, 'a reload that returns early leaves the next reader an empty document');
  assert.match(src, /bodyChars/, 'the settle signal must be observable, not a fixed sleep');
  assert.match(src, /reloadError/, 'a failed reload must be reported, not swallowed');
  // Never throw for a bridge condition: the caller is a maintenance endpoint and a 500 would read as
  // "the desk is broken" when only the optional cleanup was skipped.
  assert.doesNotMatch(src, /throw new Error\('bridge busy/, 'a busy bridge is a return value here');
});

test('the reload is journalled, so the plateau is attributable later', () => {
  const src = code(MAINT);
  assert.match(src, /logEvent\(userId, 'telemetry', \{ source: 'maintenance_reload'/);
  assert.match(src, /reclaimedMb/);
});

// ---------------------------------------------------------------------------------------------
// The memory measurement
// ---------------------------------------------------------------------------------------------

test('memory is measured on the bridge tree only, and a failed measurement cannot break anything', () => {
  const src = code('trading/plus500/browser.js');
  assert.match(src, /function profileMemoryMb\(\)/, 'the measurement must exist');
  // Filtering on the profile dir is what stops the number moving when the user opens their own Chrome.
  assert.match(src, /PROFILE_DIR\.replace[\s\S]{0,120}CommandLine -like/, 'filter by the profile on the command line');
  assert.match(src, /Name='chrome\.exe'/);
  // A measurement must never be able to fail the action that wanted it.
  assert.match(src, /catch \{[\s\S]{0,80}return null;[\s\S]{0,80}\}/, 'spawn/shell failure -> null, not a throw');
  assert.match(src, /if \(process\.platform !== 'win32'\) return null;/);
  assert.doesNotMatch(src, /performance\.memory/, 'the JS heap is not what leaks — the renderer is');
});

test('the route exists, and the CLI goes through the API rather than around the lock', () => {
  const routes = code('trading/routes.js');
  assert.match(routes, /router\.post\('\/bridge\/maintenance-reload'/, 'the endpoint must exist');
  assert.match(routes, /router\.get\('\/bridge\/memory'/);
  const cli = code('trading/scripts/reload-bridge.js');
  // The lock is IN-PROCESS, so an out-of-process reload would take no lock at all.
  assert.match(cli, /bridge\/maintenance-reload/, 'the CLI must post to the desk');
  assert.doesNotMatch(cli, /require\(['"]\.\.\/plus500\/maintenance/, 'the CLI must not reload the tab itself');
  assert.match(cli, /dryRun=1/, 'the default must be a dry run');
});
