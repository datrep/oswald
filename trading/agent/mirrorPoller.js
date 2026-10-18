// trading/agent/mirrorPoller.js â€” TRD-11: Plus500 source-of-truth mirroring.
// Cycle (default 60s): /open-positions (connector read -> executor.reconcile
// mirrors venue-only rows as open, and phantom-flags local-open rows missing
// on the venue â€” including on a fully FLAT venue read, see assessEmptyTrust)
// then /trade/alerts (readPlus500Alerts -> upsert local TradingAlerts with
// note 'mirrored:plus500'), then back to /trade so the account strip poller
// keeps its page. Read-only besides the local mirror tables â€” never trades,
// honors the wake pause.
'use strict';

const store = require('../store');

let running = false;
let inCycle = false;
let wasSkippedHard = false; // logs the hard-kill pause ONCE per transition
let wasSkippedParked = false; // 2026-10-03 PARK: logs the park stand-down ONCE per transition
// ★ 2026-10-05 (#1511 / soft-nav): venue-alerts mirror cadence. The alerts read HARD-NAVIGATES to
// /trade/alerts (readPlus500Alerts → goto), so reading it EVERY 60 s cycle alone was ~60 full page
// loads/hour. 1-in-5 cycles ≈ every 5 min; venue-alert arrivals are mirrored up to ~4 min later.
const ALERTS_READ_EVERY_CYCLES = 5;
let cyclesSinceAlertsRead = ALERTS_READ_EVERY_CYCLES; // first cycle reads immediately
let wasBridgeBusy = false; // logs the bridge-busy skip ONCE per transition
let lastUntrustedReason = null; // logs the empty-read distrust ONCE per transition
// 2026-09-12: the venue closes most positions ITSELF (venue-native SL/TP shows up
// as "Profit call"/"Loss call"; Oil/Silver also close at session end). reconcile
// can only flag those `phantom`, so after any phantom â€” and every ~15 min besides,
// to heal history â€” we read the venue's closed list and record the real close.
let cyclesSinceCloseSync = 0;
const CLOSE_SYNC_EVERY = 15;

// 2026-10-18: every venue await inside this cycle gets a hard deadline (ADR-8 — page.evaluate has NO
// default timeout). The mirror holds the SHARED pageLock for its whole cycle; one hung evaluate used to
// hold it indefinitely and starve other consumers — measured on the desk as a recurring
// `bridge busy (mirror) — lock wait exceeded for ticket` (28 hits across one weekend, caller: the
// candidate-capture lane's 240 s instrument-bars probe). The race makes the cycle fail NAMED and hands
// the lock back through the existing finally; worst-case mirror hold is now ~115 s, under every ticket wait.
const MIRROR_DEADLINES_MS = { positions: 45000, closedPositions: 20000, alerts: 20000, park: 30000 };
function withDeadline(p, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label}: no result within ${ms}ms (half-dead CDP session) — releasing the bridge lock`);
      e.mirrorTimeout = true;
      reject(e);
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// 2026-09-11 (Bitcoin #22 incident): an EMPTY positions read may only
// phantom-flag local-open rows when the INDEPENDENT 1s account strip agrees
// the venue is flat (fresh read, margin 0). Two different page reads must
// concur before the ledger is distrusted, so a half-rendered positions page
// can never phantom a real position. Pure helper â€” unit-tested.
function assessEmptyTrust(acct, nowMs = Date.now()) {
  if (!acct || acct.readAt == null) return { trusted: false, reason: 'account_strip_missing' };
  const ageMs = nowMs - new Date(acct.readAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > 120000) return { trusted: false, reason: 'account_strip_stale' };
  if (acct.margin == null) return { trusted: false, reason: 'margin_unknown' };
  if (Math.abs(Number(acct.margin)) > 0.005) return { trusted: false, reason: 'margin_not_zero' };
  return { trusted: true, reason: 'account_flat' };
}

async function upsertMirroredAlerts(userId, items) {
  const existing = await store.listAlerts(userId);
  let added = 0;
  for (const a of items) {
    if (!a.instrument || a.threshold == null) continue;
    const th = parseFloat(String(a.threshold).replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(th)) continue;
    const dup = existing.some((e) => e.symbol === a.instrument
      && Math.abs(Number(e.threshold) - th) < 0.005
      && (e.note || '').includes('mirrored:plus500'));
    if (dup) continue;
    const t = String(a.type || '').toLowerCase();
    // TRD-11: three Plus500 metrics -> local metric types.
    let metric = 'price';
    if (/buyers/.test(t)) metric = 'buyersPct';
    else if (/change/.test(t)) metric = 'changePct';
    let direction = 'above';
    if (metric === 'price') direction = /sell/.test(t) ? 'below' : 'above';
    else direction = 'crosses'; // magnitude crossing (|value| >= threshold)
    await store.createAlert(userId, {
      symbol: a.instrument, direction, threshold: th, metric,
      note: `mirrored:plus500 (${a.type || 'price'})`,
    });
    added++;
  }
  return added;
}

async function cycle(userId) {
  const pageLock = require('../plus500/pageLock');
  if (inCycle) return { skipped: 'overlap' };
  inCycle = true;
  try {
    // HARD kill = zero bridge navigation: the mirror poller (open-positions ->
    // trade/alerts) stands down until the kill is released. The account strip
    // poller is navigation-free and keeps running.
    const settings = await store.getSettings(userId);
    if (settings.kill && settings.kill.tier === 'hard') {
      if (!wasSkippedHard) {
        wasSkippedHard = true;
        await store.logEvent(userId, 'telemetry', { source: 'mirror_pause', reason: 'kill_switch_hard' });
      }
      return { skipped: 'kill_switch_hard' };
    }
    wasSkippedHard = false;    // 2026-10-03 PARK (operator-scope): stand down wholly while parked — no reads, no navigation.
    if (settings.bridge?.parked) {
      if (!wasSkippedParked) {
        wasSkippedParked = true;
        await store.logEvent(userId, 'telemetry', { source: 'mirror_pause', reason: 'parked' });
      }
      return { skipped: 'parked' };
    }
    wasSkippedParked = false;    // 2026-09-11: REAL mutual exclusion â€” never navigate the shared tab while
    // a ticket flow (place/close) or a wake capture owns it. Skip, don't wait:
    // the mirror is opportunistic; the next cycle is ~60s away. (The old race
    // killed an Oil entry ticket mid set-limits â€” see plus500/pageLock.js.)
    if (!pageLock.tryAcquire('mirror')) {
      if (!wasBridgeBusy) {
        wasBridgeBusy = true;
        await store.logEvent(userId, 'telemetry', { source: 'mirror_bridge_busy', heldBy: pageLock.status().holder });
      }
      return { skipped: 'bridge_busy' };
    }
    wasBridgeBusy = false;
    const browser = require('../plus500/browser');
    const webtrader = require('../plus500/webtrader');
    const executor = require('./executor');
    const alive = await browser.chromeAlive();
    if (!alive) return { skipped: 'chrome_off' };
    const page = await browser.newPage();

    // 1. Positions mirror.
    let posResult = { skipped: 'n/a' };
    try {
      // 2026-09-11: read via the CONNECTOR (demo guard included) and
      // reconcile on EVERY cycle â€” including a fully FLAT venue. The old
      // `if (pos.items.length)` gate meant a venue that went flat (Bitcoin
      // #22 closed unseen ~2026-09-10 17:00Z) never got its local-open rows
      // phantom-flagged, so the desk kept serving a position the venue no
      // longer had.
      const connector = require('../connector').getConnector(settings);
      const pos = await withDeadline(connector.getPositions(settings, { keepOpen: true }), MIRROR_DEADLINES_MS.positions, 'mirror_positions');
      const empty = !(pos.items || []).length;
      const trust = empty
        ? assessEmptyTrust(require('./accountPoller').getLive())
        : { trusted: true, reason: 'venue_rows' };
      if (trust.trusted) {
        lastUntrustedReason = null;
        // TRD-52: `emptyTrusted` is the caller ASSERTING that an empty venue read was corroborated
        // (the account strip is fresh and margin is ~0). reconcile needs it to bound unconfirmed
        // submits: expiring one on an empty read nobody vouched for would lose a real position.
        const rec = await executor.reconcile(userId, settings, { keepOpen: true, preRead: pos, emptyTrusted: true });
        posResult = {
          venue: (pos.items || []).length,
          matched: (rec.matched || []).length,
          phantom: (rec.phantomed || []).length,
          venueOnly: (rec.venueOnly || []).length,
          recovered: (rec.recovered || []).length,
          unconfirmedExpired: (rec.expired || []).length,
          unconfirmedOpen: rec.unconfirmedOpen ?? null,
          reason: rec.reason,
        };
        // Venue-close sync: a phantom is usually NOT a lost fill â€” it is the
        // venue having closed the position for us. Read /closed-positions and
        // write the real close back (price, P&L, reason, time).
        cyclesSinceCloseSync += 1;
        if ((rec.phantomed || []).length > 0 || cyclesSinceCloseSync >= CLOSE_SYNC_EVERY) {
          try {
            const closed = await withDeadline(webtrader.readClosedPositions(page), MIRROR_DEADLINES_MS.closedPositions, 'mirror_closed_positions');
            // â˜… THE `await` IS LOAD-BEARING. syncVenueCloses is an async function
            // (venueClose.js:142). Without the await, `sync` is a Promise, so
            // `sync.venueRows` and `sync.checked` silently read as undefined and
            // `sync.healed.length` throws
            //   "Cannot read properties of undefined (reading 'length')"
            // which the catch below faithfully logged as a venue-close FAILURE
            // roughly ten times an hour while the sync itself was working fine.
            // Worse than the noise: the `cyclesSinceCloseSync = 0` reset sits after
            // the field reads, so the throw skipped it and the throttle never
            // re-armed â€” the sync then ran on EVERY cycle instead of every
            // CLOSE_SYNC_EVERY. The `closed &&` guard is the same class of defect:
            // readClosedPositions returning undefined must not become a TypeError.
            const sync = await require('./venueClose').syncVenueCloses(userId, closed && closed.items, { settings });
            posResult.closeSync = {
              venueRows: sync.venueRows, checked: sync.checked,
              healed: sync.healed.length, netPnl: sync.netPnl,
              stillUnresolved: sync.unmatched.length,
            };
            cyclesSinceCloseSync = 0;
          } catch (e) {
            posResult.closeSync = { error: String(e.message || e).slice(0, 120) };
            // NEVER silent: a broken read here would hide real closes â€” which is
            // exactly the bug this sync exists to fix. At most once per ~15 min.
            await store.logEvent(userId, 'telemetry', { source: 'venue_close_sync_error', error: posResult.closeSync.error }).catch(() => {});
          }
        }
      } else {
        posResult = { venue: 0, reconcile: 'skipped', reason: trust.reason };
        if (lastUntrustedReason !== trust.reason) {
          lastUntrustedReason = trust.reason;
          await store.logEvent(userId, 'telemetry', { source: 'mirror_empty_untrusted', reason: trust.reason });
        }
      }
    } catch (e) {
      posResult = { error: String(e.message || e).slice(0, 120) };
    }

    // 2. Alerts mirror — THROTTLED 1-in-5 cycles (2026-10-05, #1511/soft-nav): the read hard-navigates
    // to /trade/alerts, so at every-cycle cadence it alone was ~60 full page loads/hour. ~5 min
    // freshness; the desk's own 15 s crossing watch reads local rows, not the venue page.
    let alertResult = { skipped: 'cadence' };
    cyclesSinceAlertsRead += 1;
    if (cyclesSinceAlertsRead >= ALERTS_READ_EVERY_CYCLES) {
      cyclesSinceAlertsRead = 0;
      try {
        const al = await withDeadline(webtrader.readPlus500Alerts(page), MIRROR_DEADLINES_MS.alerts, 'mirror_alerts');
        const added = await upsertMirroredAlerts(userId, al.items || []);
        alertResult = { listed: (al.items || []).length, added };
      } catch (e) {
        alertResult = { error: String(e.message || e).slice(0, 120) };
      }
    }

    // 3. Park the tab on /open-positions: the account strip lives there too,
    // so the 1s poller reads account + positions from the same page.
    // ★ 2026-10-05 (#1511 / soft-nav): ONLY NAVIGATE WHEN OFF-PARK. This line used to run a FULL page
    // load EVERY 60 s cycle (~1,400 hard app-boots/day) — the desk's single largest contribution to
    // hard-navigation traffic on Plus500 and the standing risk to the venue session. If the tab is
    // already parked (the normal resting state), there is nothing to do. Soft navigation is NOT yet
    // available for this route: crafted AND real anchor clicks hard-load (measured 2026-10-05,
    // temp/soft-nav-test*.js), so the rare off-park return keeps the plain goto behind the guard.
    try {
      const here = String(page.url() || '');
      if (!/\/open-positions/.test(here)) {
        // SOFT FIRST (2026-10-05, #1511): the app's own nav button is a client-side route change —
        // no document load, no splash. Hard goto only as fallback (and it is what produced the
        // truncated first render + loading screens the operator called out).
        const soft = await withDeadline(webtrader.softParkOpenPositions(page), MIRROR_DEADLINES_MS.park, 'mirror_park').catch(() => ({ ok: false, via: 'error' }));
        if (!soft.ok) {
          await webtrader.withConnRetry(() => page.goto('https://app.plus500.com/open-positions', { timeout: 45000, waitUntil: 'domcontentloaded' }));
        }
        await store.logEvent(userId, 'telemetry', { source: 'mirror_park_nav', via: soft.ok ? soft.via : 'goto', from: here.slice(0, 120), to: String(page.url() || '').slice(0, 120) }).catch(() => {});
      }
    } catch { /* leave whatever page */ }

    if (posResult.error || alertResult.error) {
      await store.logEvent(userId, 'error', { where: 'mirror', error: JSON.stringify({ pos: posResult, alerts: alertResult }).slice(0, 400) });
    }
    return { pos: posResult, alerts: alertResult };
  } finally {
    pageLock.release('mirror'); // no-op unless this cycle holds it
    inCycle = false;
  }
}

// TRD-11: alert watch loop (15s) â€” metric-aware crossings. While the agent is
// PAUSED crossings are logged only; otherwise they wake the desk like a
// Plus500 push notification would.
let alertCheckTimer = null;
async function alertLoop(userId) {
  const { checkAlerts, runWake } = require('./waker');
  try {
    const fired = await checkAlerts(userId);
    if (!fired.length) return;
    const settings = await store.getSettings(userId);
    if (settings.wake?.paused) {
      for (const a of fired) {
        await store.logEvent(userId, 'alert_crossed', { symbol: a.symbol, metric: a.metric || 'price', note: 'agent paused â€” logged only, no wake' });
      }
    } else {
      await runWake(userId, 'alert', { alert: fired[0] });
    }
  } catch { /* transient */ }
}

function start(userId = 1) {
  if (running) return;
  running = true;
  (async function loop() {
    while (running) {
      const settings = await store.getSettings(userId).catch(() => null);
      const cfg = (settings && settings.mirror) || {};
      if (cfg.enabled !== false) {
        try { await cycle(userId); } catch { /* transient */ }
      }
      const secs = Math.max(15, Number(cfg.pollSeconds) || 60);
      await new Promise((r) => setTimeout(r, secs * 1000));
    }
  })();
  // TRD-11: metric-aware alert watch every 15s.
  alertCheckTimer = setInterval(() => alertLoop(userId).catch(() => {}), 15000);
  console.log('[trading] mirror poller started (Plus500 positions + alerts, 60s; alert watch 15s)');
}

function stop() { running = false; if (alertCheckTimer) clearInterval(alertCheckTimer); }

module.exports = { start, stop, cycle, upsertMirroredAlerts, assessEmptyTrust };
