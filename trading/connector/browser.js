// trading/connector/browser.js — the Plus500 demo venue implementation.
// All bridge navigation lives here; nobody else touches plus500/* directly
// for trading actions. Ordering actions re-check the demo guard like the old
// executor.demoPage did.
/* global document */ // preflight builds a browser-context snippet for the bridge page
'use strict';

const browser = require('../plus500/browser');
const webtrader = require('../plus500/webtrader');
const capture = require('../plus500/capture');
const healthMod = require('../plus500/health');
const accountPoller = require('../agent/accountPoller');
const sessionFeed = require('../plus500/sessionFeed');
const store = require('../store');

// --- P0-2 (2026-09-10): order reliability --------------------------------
// 6 of 7 rejections were bridge failures, in TWO distinct classes:
//   (a) DOM-state (row not visible, set-limits field dead)  -> preflight
//   (b) bridge lifecycle (page.goto ERR_ABORTED, execution context destroyed,
//       post-submit row never appeared)                     -> journal + retry
//
// 2026-09-13 (TRD-42 / workstream E): the classifier moved to connector/errorClass.js and is
// no longer binary. `other` was the LARGEST bucket (5 of 7 failures) and meant only "not a
// page.goto problem", so the desk could not tell a stale close from a dead selector from an
// UNKNOWN SUBMIT OUTCOME. Each of those needs a different response, and the ambiguous one is a
// risk event rather than a reliability event. `err.code` is now honoured ahead of the message.
const { classifyBridgeError, isRetryable } = require('./errorClass');

// -------------------------------------------------------------------------------------------------
// ★ THE SHARED-BRIDGE RULE (2026-09-16).
//
// `plus500/browser` is a SINGLETON: ONE Playwright Browser handle for the whole service, shared by
// the 1s account poller, the 60s mirror pollers, the session feed and the watchdog. `disconnect()`
// closes THAT handle, so every one of those consumers loses its Page object at the same instant
// ("Target page, context or browser has been closed") — while Chrome itself keeps running, so the
// failure looks like a venue problem rather than a lifecycle one.
//
// This module used to call `browser.disconnect()` in FOUR places: after a fresh account read, after
// a positions read, after every ticket, and on the not_demo guard. `getAccount({ fresh: true })`
// alone is the wake's floor step, so the desk dropped the bridge on EVERY WAKE (~10 min), which is
// what produced the churn in server.err.log — `Chrome disconnected` then a re-attach, repeatedly —
// and the mirror's `page...has been closed` errors. Worse, each drop left the next `newPage()` to
// re-attach through a single-shot probe that could decide a healthy Chrome was a stale port holder.
//
// watchdog.js, maintenance.js, instrumentProbe.js and routes.js all carry this same note. This file
// was the last consumer that never got it. A short-lived consumer must never close a long-lived
// shared object: the handle is meant to live for the whole service lifetime (see the spawn comment
// in plus500/browser.js), and `ensureBrowser()` re-attaches transparently if Chrome really dies.
// -------------------------------------------------------------------------------------------------

async function waitBridgeReady(timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (await browser.chromeAlive()) {
        // Give the session feed a beat to re-attach the bridge page.
        await new Promise((r) => setTimeout(r, 2500));
        return true;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

// Read-only preflight before clicking anything: page health + instrument-row
// button probe. Advisory — never introduces a NEW failure class.
async function preflightOrder(page, symbol) {
  try {
    const url = String(page.url() || '');
    if (!url.includes('app.plus500.com')) return { ok: false, reason: 'preflight: bridge page not on plus500' };
    const state = await page.evaluate(() => ({
      ready: document.readyState,
      hasApp: !!document.querySelector('#app, .app, [data-testid]'),
    })).catch(() => null);
    if (!state || !state.hasApp) return { ok: false, reason: 'preflight: bridge page unhealthy' };
    const row = await page.evaluate((sym) => {
      const rows = [...document.querySelectorAll('[data-testid^="InstrumentRow."]')];
      for (const r of rows) {
        const n = r.querySelector('.name');
        if (n && (n.textContent || '').replace(/[\u200e\u200f]/g, '').trim() === sym) {
          const buy = r.querySelector('.button-buy, [data-testid$=".Button.Buy"]');
          const sell = r.querySelector('.button-sell, [data-testid$=".Button.Sell"]');
          return { found: true, buy: !!buy, sell: !!sell };
        }
      }
      return { found: false };
    }, String(symbol)).catch(() => ({ found: false }));
    if (row && row.found && !row.buy && !row.sell) {
      return { ok: false, reason: 'preflight: instrument row visible but buy/sell buttons missing' };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

// v1.2 (2026-09-12 audit): owner-scoped — was hardcoded `userId 1`. The owner
// arrives via the order opts bag (placeOrder/closeOrder `{ keepOpen, userId }`);
// when absent we SKIP rather than mis-attribute (journaling is best-effort).
async function journalOrder(userId, order, attempts) {
  try {
    const uid = userId == null ? null : Number(userId);
    if (uid == null || !Number.isFinite(uid)) return;
    await store.logEvent(uid, 'order_attempt', { order, attempts, at: new Date().toISOString() });
  } catch { /* journaling is best-effort */ }
}

// Shared wrapper: preflight -> act -> classify -> journal -> bounded retry
// (lifecycle errors only). Returns the action's fill with .attempts attached.
// 2026-09-11: holds the shared-bridge lock for the ENTIRE ticket flow (demo
// guard navigation + preflight + ticket + venue SL/TP + submit). The mirror's
// 60s cycle once navigated mid-flow and the entry never placed
// (order_rejected 6289 — set-limits never enabled). plus500/pageLock.js.
async function withOrderReliability(settings, order, act, opts = {}) {
  // TRD-42: label WHAT the action was for. The journal recorded only symbol/direction/size, so
  // an honest failure rate could not be computed per intent — and the 41% figure was dominated
  // by CLOSES of positions that no longer existed (state_stale), which is a reconciliation
  // problem rather than an execution one. Closes embedded "close: " in the reason STRING, which
  // is unqueryable. Labelled once here so it reaches every journal call below.
  const intent = opts.intent || (opts.entry ? 'open' : 'close');
  order = { ...order, intent };
  const pageLock = require('../plus500/pageLock');
  await pageLock.acquire('ticket', { waitMs: 240000 });
  try {
    return await withOrderReliabilityInner(settings, order, act, opts);
  } finally {
    pageLock.release('ticket');
  }
}

// `keepOpen` is still ACCEPTED by the public methods (callers pass it) and IGNORED here: nothing in
// this module closes the shared bridge any more, so there is nothing left for it to keep open.
async function withOrderReliabilityInner(settings, order, act, { userId = null, entry = false } = {}) {
  const attempts = [];
  let lastErr = null;
  const MAX_ATTEMPTS = 2; // initial + ONE retry after bridge recovery
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    let phase = 'connect';
    try {
      // v1.2 (2026-09-12 audit): ENTRY orders respect the sticky UI Fallback
      // Pause (fail-secure) — closes/exits keep running; read-only mirror paths
      // are exempt by nature. Fresh settings so a mid-flight resume is honored.
      if (entry && userId != null) {
        const fresh = await store.getSettings(userId).catch(() => settings);
        if (healthMod.isPaused(fresh)) {
          const err = new Error('ui_fallback_pause: entries are blocked until the bridge pause is resumed');
          err.code = 'policy_violation';
          throw err;
        }
      }
      const page = await demoPage(settings);
      try {
        const pre = await preflightOrder(page, order.symbol);
        phase = 'preflight';
        if (!pre.ok) {
          const err = new Error(pre.reason);
          err.code = 'preflight';
          throw err;
        }
        phase = 'place';
        const fill = await act(page);
        fill.attempts = attempts.concat({ attempt, phase: 'filled', ms: Date.now() - t0, ok: true });
        await journalOrder(userId, order, fill.attempts);
        return fill;
      } finally {
        // ★ No disconnect() — see the SHARED-BRIDGE RULE at the top of this file. Closing the shared
        // handle after a ticket killed the venue feed and the mirror pollers mid-cycle.
      }
    } catch (e) {
      const cls = classifyBridgeError(e);
      // TRD-TRL-3: THE 140-CHAR SLICE IS THE ONLY RECORD THIS PATH HAD, and it could not say WHICH card was
      // read or what the venue printed - eight refused entries carried the same unusable sentence. A structured
      // `evidence` bag rides ALONGSIDE the message (the slice is left alone, so no existing consumer changes),
      // and only the trailing-stop path attaches one, so the field is absent everywhere it would be noise.
      attempts.push({
        attempt, phase, ms: Date.now() - t0, ok: false, errorClass: cls, code: e.code || null,
        error: String(e.message || e).slice(0, 140),
        ...(e.trailEvidence ? { evidence: e.trailEvidence } : {}),
        // ⚠ the FILL HISTORY is what named the fault on the first live capture (TRD-TRL-3): the venue committed
        // the first count and ignored every one after it. It rides beside the evidence, not inside it, because
        // `fillPips` writes it before the block that builds `evidence` exists.
        ...(e.trailDiag ? { fillDiag: e.trailDiag } : {}),
        // ★★ EXE-NG-1 (2026-10-02): THE TWO FACTS THAT MAKE THIS ROW EXPLAIN ITSELF.
        // ⚠ AND IT IS NOT OPTIONAL, IT IS THE WHOLE FIX. `placeOrder` now computes `ticketVia` (which click path
        // reached the ticket) and `ticketCensus` (what was on the page when it did not), and THIS LINE is the
        // only thing that carries them to the journal — the line above keeps just 140 characters of MESSAGE.
        // Computed-and-then-discarded is precisely the defect this enrichment exists to remove, so a probe
        // attachment without a reader wired to it would have reproduced it one layer up.
        ...(e.ticketVia || e.ticketCensus ? { ticketPath: { via: e.ticketVia || null, ...(e.ticketCensus || {}) } } : {}),
      });
      lastErr = e;
      if (!isRetryable(cls) || attempt >= MAX_ATTEMPTS) {
        await journalOrder(userId, order, attempts);
        throw e;
      }
      // NOT a failure: this is a retry marker. It was previously pushed with ok:false and no
      // error text, so any metric counting `ok:false` read it as a failed attempt — two of the
      // seven "failures" in the 2026-09-10/11 journal were exactly this (TRD-42). `marker: true`
      // makes the distinction self-describing instead of relying on every consumer knowing that
      // phase 'wait_bridge' is special.
      attempts.push({ attempt, phase: 'wait_bridge', ok: false, marker: true });
      await waitBridgeReady(30000);
    }
  }
  await journalOrder(userId, order, attempts);
  throw lastErr || new Error('order failed (no attempt)');
}

// The demo marker lives in the collapsed account menu and is found via textContent on ANY route
// (assertDemo reads innerText + textContent) — it no longer needs a trade-page landing first.
// ★ 2026-10-05 (#1511): READ THE CURRENT PAGE FIRST. This used to goto('/trade') on EVERY call; the
// mirror's read path calls it every cycle (~86 s), so the desk navigated the shared tab to /trade →
// (SPA redirect) /trade/cryptocurrencies and parked back ~1,000 times/day — the observer's standing
// "~90 s navigation bursts", pure waste AND venue-session risk. The navigation is now a FALLBACK for
// a page that cannot confirm demo (or is blank); the guard still fails closed exactly as before.
async function demoPage(settings) {
  const page = await browser.newPage();
  let demo = await webtrader.assertDemo(page, settings).catch(() => ({ demo: false, blank: false, detail: 'demo check error' }));
  if (!demo.demo) {
    // Blank is not evidence about the account (may need a render); a rendered page without the marker
    // may need the trade landing. Either way: ONE navigation, then re-check, then fail closed.
    await webtrader.gotoPage(page, 'trade', settings).catch(() => {});
    demo = await webtrader.assertDemo(page, settings);
  }
  if (!demo.demo) {
    // ★ No disconnect() — see the SHARED-BRIDGE RULE at the top of this file. This guard fires on a
    // page that is merely blank or mid-reload, and closing the bridge for it took the account
    // poller, the mirror pollers and the session feed down with it while Chrome was healthy.
    const err = new Error('not_demo: ' + (demo.detail || 'demo marker missing'));
    err.demoGuard = true;
    throw err;
  }
  return page;
}

// Quotes: the wake capture (health-gated, search-bar + burst + chart banking).
async function getQuotes(userId, settings) {
  return capture.captureOnce(userId, settings);
}

// Account: fresh read (navigates) or the 1s poller's cached strip.
async function getAccount(settings, { fresh = false } = {}) {
  if (!fresh) {
    const live = accountPoller.getLive();
    if (live && live.equity != null) return live;
  }
  const page = await browser.newPage();
  try {
    return await webtrader.readAccount(page, settings);
  } finally {
    // ★ No disconnect() — see the SHARED-BRIDGE RULE at the top of this file. This is the wake's
    // floor read (executor.monitorFloor), so it used to drop the bridge every ~10 minutes.
  }
}

// `{ keepOpen }` is accepted and ignored — see withOrderReliabilityInner.
async function getPositions(settings) {
  const page = await demoPage(settings);
  try {
    return await webtrader.readPositions(page, settings);
  } finally {
    // ★ No disconnect() — see the SHARED-BRIDGE RULE at the top of this file.
  }
}

async function placeOrder(settings, { symbol, direction, size, stopPrice = null, takeProfitPrice = null, trailingStop = null }, { keepOpen = false, userId = null } = {}) {
  const order = { symbol, direction, size, stopPrice, takeProfitPrice, trailingStop };
  return withOrderReliability(settings, order,
    (page) => webtrader.placeOrder(page, settings, order),
    { keepOpen, userId, entry: true });
}

async function closeOrder(settings, trade, { keepOpen = false, userId = null } = {}) {
  const order = { symbol: trade.symbol, direction: trade.direction === 'buy' ? 'sell' : 'buy', size: trade.size };
  return withOrderReliability(settings, order,
    (page) => webtrader.closePosition(page, settings, trade),
    { keepOpen, userId });
}

async function getSession(symbol) {
  return sessionFeed.get(symbol);
}

// TRD-EXE-16 (2026-10-01): SUPPLY THE SESSION EVIDENCE RATHER THAN RELAX THE GUARD.
//
// The feed's only rich source is `OPositionsList` — the desk's OWN positions — so `isOpen(symbol)` is null for
// every instrument the desk does not already hold, and the executor refuses it. That refusal is deliberate and
// stays (test/venue-session-guard.test.js records why: "unknown -> allow" was an owner-raised defect with seven
// measured failures). What was missing was not a looser rule but the EVIDENCE the rule asks for.
//
// The venue publishes an instrument's session on `SingleTradeInstrument` whenever the page FOCUSES it, and the
// harvest already reads that payload. Focusing is navigation only — no ticket, no order, no field touched — and
// it is the SAME navigation `placeOrder` performs moments later when the row is not already on screen. So this
// runs it earlier, while the answer can still change the decision.
//
// ⚠ IT DOES NOT USE `withOrderReliability`. That wrapper journals attempts and feeds the unresolved-submit
// retry guard, which exists for ORDERS; a navigation recorded as an order attempt would corrupt that guard.
// It follows `getPositions` instead: `demoPage` + a read, with no `disconnect()` (the SHARED-BRIDGE RULE).
async function probeSession(settings, symbol) {
  const page = await demoPage(settings);
  return webtrader.probeSession(page, settings, symbol);
}

// ★ EXE-14 S3 (2026-10-02) — WRITE A POSITION'S LEVELS THROUGH THE POST-ENTRY EDIT CARD.
//
// The mechanism is proved live: `webtrader.setPositionLevels` types the levels, commits with `#trade-button`
// (whose label reads `Update` on that card, `Buy`/`Sell` on the ticket — the check that stops a level edit from
// becoming an order), then reads the levels back FROM THE VENUE ROW rather than from the field it just typed.
//
// ⚠ IT DOES NOT USE `withOrderReliability`, AND THE REASON IS ONE STEP PAST `probeSession`'s. That wrapper
// JOURNALS every attempt as an `order_attempt` and feeds the unresolved-submit retry guard, which exists for
// ORDERS — a level edit recorded as an order attempt corrupts the very journal TRD-42 spent a day cleaning. It
// also RETRIES, and a retried level edit is a SECOND WRITE to a live position: a failure here must surface, not
// be re-attempted blind.
//
// ⚠ IT DOES HOLD `pageLock`, and takes it HERE rather than in the executor so no caller can forget it. The whole
// sequence is navigation plus a click on the SHARED tab, and the mirror's 60s cycle once navigated mid-ticket
// and the entry never placed.
//
// Returns `webtrader.setPositionLevels`'s own record — `before`/`after` read from the venue ROW, the typed
// values, `submitLabel`, and whether a restore was needed. ⚠ A caller MUST persist it: a level change that is
// not recorded is indistinguishable from one that never happened.
async function setPositionLevels(settings, trade, levels) {
  const pageLock = require('../plus500/pageLock');
  await pageLock.acquire('ticket', { waitMs: 240000 });
  try {
    const page = await demoPage(settings);
    return await webtrader.setPositionLevels(page, settings, trade, levels);
  } finally {
    // ★ No disconnect() — see the SHARED-BRIDGE RULE at the top of this file.
    pageLock.release('ticket');
  }
}

module.exports = {
  name: 'browser', kind: 'plus500_demo',
  getQuotes, getAccount, getPositions, placeOrder, closeOrder, getSession, probeSession, setPositionLevels,
  health: healthMod,
};
