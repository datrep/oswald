// test/bridge-shared-lifecycle.test.js — the shared-bridge rule (2026-09-16).
//
// WHAT WENT WRONG. `trading/plus500/browser.js` owns a SINGLETON: one Playwright Browser handle for
// the whole service, shared by the 1s account poller, the 60s mirror pollers, the session feed and the
// watchdog. `connector/browser.js` called `browser.disconnect()` in FOUR places — one of them in
// `getAccount({ fresh: true })`, which is the wake's floor read — so the desk closed that shared
// handle every ~10 minutes. Closing it does not stop Chrome; it only throws away the handle, which
// kills the Page object of every other consumer mid-flight. The proof is in the desk's own logs:
// `server.err.log` for the following hour is `Chrome disconnected` / `attached to existing Chrome`
// five times over — never a launch — and the mirror read immediately after each one says
// `Target page, context or browser has been closed`.
//
// The disconnects also created the load that made the ONE-SHOT `/json/version` probe in
// `plus500/browser.js` time out under its 3s ceiling, which made the `catch` fall through to
// `killPortHolder` — a taskkill of the HEALTHY, logged-in Chrome tree. Both halves are pinned here:
// the connector must not disconnect, and the probe must retry before anything is killed.
//
// STRUCTURAL for the connector (requiring it pulls in the CDP browser manager, and the one time this
// repo required a browser-touching module from a unit test it attached to the desk's LIVE Chrome),
// BEHAVIOURAL for `probeExistingCdp`, which is plain HTTP against a port this test opens itself.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { code } = require('./_source');

const CONNECTOR = 'trading/connector/browser.js';
const BRIDGE = 'trading/plus500/browser.js';
const DISCOVERER = 'trading/agent/discoverer.js';

// Required lazily, inside the behavioural tests. `probeExistingCdp` is a pure HTTP probe, so this is
// safe — but the module as a whole manages the desk's Chrome, so it is not touched at import time.
const probeExistingCdp = (...args) => require('../trading/plus500/browser').probeExistingCdp(...args);

// ---------------------------------------------------------------------------------------------
// A fake CDP endpoint, so the retry can be exercised without a Chrome anywhere near this
// ---------------------------------------------------------------------------------------------

// `plan[i]` is what the (i+1)-th request gets: a number = answer with valid CDP JSON after that many
// ms (the last entry repeats), or 'not-cdp' = answer with JSON that has no debugger URL.
function endpoint(plan) {
  const hits = [];
  const timers = new Set();
  const server = http.createServer((req, res) => {
    hits.push(String(req.url));
    const step = plan[Math.min(hits.length, plan.length) - 1];
    const send = (body) => {
      try {
        res.setHeader('content-type', 'application/json');
        res.end(body);
      } catch { /* the client already gave up on this probe — that is the point of the test */ }
    };
    if (step === 'not-cdp') { send(JSON.stringify({ Browser: 'definitely-not-a-debugger' })); return; }
    const t = setTimeout(() => send(JSON.stringify({
      Browser: 'Chrome/140.0.0.0',
      webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`,
    })), Number(step) || 0);
    timers.add(t);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      hits,
      stop: () => new Promise((done) => {
        for (const t of timers) clearTimeout(t);
        timers.clear();
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(() => done());
      }),
    }));
  });
}

test('a SLOW CDP answer is retried instead of being read as a dead port', async () => {
  // The regression, exactly: the old probe gave `/json/version` one 3s shot. A healthy Chrome that
  // took longer than that threw into the `catch`, and the caller killed it. Here the first probe
  // times out and the SAME endpoint answers the second one — which must be enough to attach.
  const ep = await endpoint([120, 0]);
  try {
    const r = await probeExistingCdp(ep.port, { timeoutMs: 60, attempts: 3, gapMs: 20 });
    assert.equal(r.ok, true, 'a slow answer must still lead to an attach, not to a kill');
    assert.ok(r.attempts >= 2, 'it must have PROBED AGAIN rather than drawn a conclusion');
    assert.ok(ep.hits.length >= 2, 'more than one probe must actually have been issued');
  } finally {
    await ep.stop();
  }
});

test('an answer that is not a CDP endpoint IS definitive', async () => {
  const ep = await endpoint(['not-cdp']);
  try {
    const r = await probeExistingCdp(ep.port, { timeoutMs: 300, attempts: 3, gapMs: 10 });
    assert.equal(r.ok, false);
    assert.equal(r.answered, true, 'it identified itself — that is what makes clearing the port safe');
    assert.equal(r.attempts, 1, 'probing again after a definitive answer is pointless');
  } finally {
    await ep.stop();
  }
});

test('silence is reported as silence, and it is measured', async () => {
  // A timeout is NOT a definitive answer: the caller has to be able to tell "something else holds this
  // port" from "our Chrome is not talking". Only the first one is a dead port holder.
  const ep = await endpoint([4000]);
  try {
    const r = await probeExistingCdp(ep.port, { timeoutMs: 40, attempts: 3, gapMs: 10 });
    assert.equal(r.ok, false);
    assert.equal(r.answered, false, 'a timeout must never look like a verdict');
    assert.equal(r.attempts, 3, 'every probe must be spent before a holder is called wedged');
    assert.ok(r.waitedMs >= 100, 'the time actually spent must be reported, not assumed');
  } finally {
    await ep.stop();
  }
});

test('a healthy endpoint attaches on the first probe, without paying for the retries', async () => {
  const ep = await endpoint([0]);
  try {
    const r = await probeExistingCdp(ep.port, { timeoutMs: 1000 });
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 1, 'the happy path must not be slower than it was');
    assert.equal(ep.hits.length, 1);
  } finally {
    await ep.stop();
  }
});

// ---------------------------------------------------------------------------------------------
// Structural — the connector must never close what it does not own
// ---------------------------------------------------------------------------------------------

test('the connector never closes the SHARED bridge', () => {
  const src = code(CONNECTOR);
  // Every one of these four was a real disconnect site. Named so the pin fails loudly if one returns.
  assert.match(src, /async function getAccount\(/, 'getAccount is the wake floor read — it must not close the bridge');
  assert.match(src, /async function getPositions\(/);
  assert.match(src, /async function demoPage\(/);
  assert.match(src, /withOrderReliabilityInner/, 'the ticket path is the fourth site');
  assert.doesNotMatch(src, /browser\.disconnect\(/, 'disconnecting the singleton kills every other consumer mid-flight');
  // The same two calls maintenance.js is pinned against, for the same reason.
  assert.doesNotMatch(src, /page\.close\(/, 'closing the last tab exits Chrome');
  assert.doesNotMatch(src, /ensureBrowser\(/, 'the connector borrows the browser, it does not manage it');
});

test('the discoverer BORROWS the bridge and gives it back without closing it', () => {
  const src = code(DISCOVERER);
  assert.doesNotMatch(src, /bridge\.disconnect\(/, 'discovery runs INSIDE the live service, beside the pollers');
  assert.match(src, /bridgeUse\('discover', false\)/, 'it must still release its bridge-use claim');
});

test('the CDP probe is multi-attempt, and the attach path goes through it', () => {
  const src = code(BRIDGE);
  assert.match(src, /const CDP_PROBE_ATTEMPTS = \d+/, 'the attempt count must be a named constant, not a literal');
  assert.match(src, /const probe = await probeExistingCdp\(port\);/, 'connectOrLaunch must use the retrying probe');
  // Order matters more than presence: the kill must be downstream of the decision, never the default.
  assert.ok(
    src.indexOf('probeExistingCdp(port)') < src.indexOf('await killPortHolder(port);'),
    'the probe must run BEFORE anything is killed',
  );
  assert.match(src, /if \(probe\.answered\)/, 'killing is only justified on a definitive answer');
  assert.match(src, /answered nothing in \$\{probe\.attempts\} probe/, 'and a silent holder must say so in the log');
});

test('disconnect() names its caller, because nothing in the service may call it', () => {
  const src = code(BRIDGE);
  assert.match(src, /async function disconnect\(why = /, 'an unexplained disconnect is what made this invisible for hours');
  assert.match(src, /disconnect\(\) called by \$\{why\}/, 'it must announce itself in the log');
});
