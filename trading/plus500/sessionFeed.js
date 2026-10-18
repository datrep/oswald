// trading/plus500/sessionFeed.js — passive venue-session listener (TRD-12).
// ZERO clicks: the Plus500 SPA already polls its backend (CometAsyncHandler
// long-poll). Those responses carry, per open position, the instrument's
//   - IsTraded            (market open right now?)
//   - CurrentTradingInterval {DateTime, EndDateTime}   (null when closed)
//   - NextTradingInterval    {DateTime, EndDateTime}   (next session, LOCAL tz)
// We attach ONE CDP Network listener to the shared bridge page and maintain
// a per-symbol registry. Consumers (review chair, executor, quant, sessions
// guard, UI) read the registry instead of poking the DOM — no button clicks,
// no extra navigation (the user's "links instead of buttons" direction).
//
// THAT LISTENER MUST SURVIVE A RECONNECT (2026-09-15). Chrome blips; when it does, `ensureBrowser`
// builds a new Browser and new Pages, so a handler bound to the old page goes silently dead. The feed
// re-arms on every connect (see `startTracking`) and watches its own silence. Before this, a frozen
// feed was indistinguishable from a quiet market — and it is what closed the desk on 2026-09-15.
/* global document */ // page.evaluate callbacks run in the browser context
'use strict';

// The browser module is held rather than destructured: `attach()` and the reconnect subscription go
// through it at CALL time, so a test can substitute `newPage`/`onConnect` without having to reload this
// module. A destructured `const { newPage } = ...` freezes the reference at require time and made the
// reconnect path untestable — which is part of why the defect below survived.
const browser = require('./browser');

const registry = new Map();   // key: lowercase symbol -> entry
const byPid = new Map();      // key: positionId    -> entry
const STALE_MS = 10 * 60000;  // a symbol's entry is 'stale' after 10 min

const state = {
  tracking: false,
  startedAt: null,
  lastResponseAt: null,
  responses: 0,
  parseErrors: 0,
  lastError: null,
  // ★ THE FIELDS THAT MAKE SILENCE VISIBLE (2026-09-15). None of these existed, so a feed that had
  // stopped updating was indistinguishable from a quiet market: `lastResponseAt` was only ever read by
  // nobody, and the registry simply aged out into `get() === null`, which every consumer reads as
  // "unknown, carry on". Six hours of blind venue data looked exactly like a calm Tuesday.
  attachments: 0,
  attachedAt: null,
  pageUrl: null,
  reattaches: 0,
};

// The page object the response listener is currently bound to. Held so a reconnect can DETACH the dead
// one rather than leaking a handler per blip.
const binding = { page: null, handler: null };

// A symbol's session entry is only trusted for STALE_MS, so silence older than that is a real gap in
// what the desk knows — not a lull. `SILENT_AFTER_MS` is deliberately the same number: one constant,
// so "the feed is stale" and "the feed is silent" cannot drift apart.
const SILENT_AFTER_MS = STALE_MS;

// "YYYY-MM-DD HH:MM:SS.mmm" arrives in the user's LOCAL time zone.
function localDate(s) {
  if (!s) return null;
  const d = new Date(s.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

function normSymbol(name) {
  return String(name || '').trim().toLowerCase();
}

function upsert(entry) {
  if (!entry || !entry.symbol) return;
  // Drop null fields BEFORE merging: a shallow source (SingleTradeInstrument)
  // must not clobber interval data already learned from OPositionsList.
  const clean = {};
  for (const [k, v] of Object.entries(entry)) if (v != null) clean[k] = v;
  const key = normSymbol(clean.symbol);
  const prev = registry.get(key);
  const next = { ...(prev || {}), ...clean, symbol: clean.symbol, updatedAt: Date.now() };
  registry.set(key, next);
  if (clean.pid != null) byPid.set(String(clean.pid), next);
}

function isFresh(entry, now = Date.now()) {
  return !!(entry && now - entry.updatedAt < STALE_MS);
}

function get(symbol) {
  const e = registry.get(normSymbol(symbol));
  return e && isFresh(e) ? e : null;
}

function getByPid(pid) {
  const e = byPid.get(String(pid));
  return e && isFresh(e) ? e : null;
}

// Market open right now, per the venue itself? null = unknown.
function isOpen(symbol) {
  const e = get(symbol);
  return e ? e.isTraded : null;
}

function nextOpenAt(symbol) {
  const e = get(symbol);
  if (!e) return null;
  if (e.isTraded) return null; // open now, no 'next open'
  const from = (e.next && e.next.from) || null;
  return from instanceof Date ? from : localDate(from);
}

function summary() {
  const out = [];
  for (const e of registry.values()) {
    if (!isFresh(e)) continue;
    out.push({
      symbol: e.symbol,
      positionId: e.pid ?? null,
      open: !!e.isTraded,
      current: e.current ? { from: e.current.from, to: e.current.to } : null,
      next: e.next ? { from: e.next.from, to: e.next.to } : null,
      updatedAt: new Date(e.updatedAt).toISOString(),
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function status() {
  const silentForMs = state.lastResponseAt ? Date.now() - state.lastResponseAt : (state.startedAt ? Date.now() - state.startedAt : null);
  return {
    ...state,
    tracked: registry.size,
    // `silent` is the honest answer to "is this feed telling the desk anything", and it is TRUE when the
    // listener is gone as well as when it is merely quiet. Read it before trusting an empty registry:
    // an empty registry means "no entry", which every caller treats as "unknown, allow".
    silentForMs,
    silent: state.tracking ? (silentForMs != null && silentForMs > SILENT_AFTER_MS) : false,
    attached: !!binding.page,
  };
}

// Walk raw JSON for session-bearing objects. Returns array of parsed entries.
function harvest(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const it of obj) harvest(it, out);
    return out;
  }
  // Open positions list (the rich source).
  if (Array.isArray(obj.OPositionsList)) {
    for (const p of obj.OPositionsList) {
      if (!p || typeof p !== 'object') continue;
      const symbol = p.InstrumentName || (p.Instrument && (p.Instrument.InstrumentEnglishName || p.Instrument.Name)) || null;
      if (!symbol) continue;
      const next = p.NextTradingInterval || (p.Instrument && p.Instrument.TradeRelated && p.Instrument.TradeRelated.NextTradingInterval) || null;
      out.push({
        symbol,
        pid: p.PID != null ? p.PID : null,
        instrumentId: p.InstrumentID != null ? p.InstrumentID : null,
        isTraded: !!p.IsTraded,
        current: p.CurrentTradingInterval
          ? { from: p.CurrentTradingInterval.DateTime, to: p.CurrentTradingInterval.EndDateTime }
          : null,
        next: next ? { from: next.DateTime, to: next.EndDateTime } : null,
        source: 'OPositionsList',
      });
    }
  }
  // Single-instrument payload (search-select / instrument focus).
  const sit = obj.SingleTradeInstrument;
  if (sit && typeof sit === 'object') {
    const symbol = sit.InstrumentEnglishName || sit.Name || null;
    if (symbol) {
      const next = sit.NextTradingInterval || (sit.TradeRelated && sit.TradeRelated.NextTradingInterval) || null;
      out.push({
        symbol,
        pid: null,
        instrumentId: sit.ID != null ? sit.ID : null,
        isTraded: sit.IsTraded != null ? !!sit.IsTraded : null,
        current: sit.CurrentTradingInterval
          ? { from: sit.CurrentTradingInterval.DateTime, to: sit.CurrentTradingInterval.EndDateTime }
          : null,
        next: next ? { from: next.DateTime, to: next.EndDateTime } : null,
        source: 'SingleTradeInstrument',
      });
    }
  }
  // Position info panel (GetOpenPositionInfoImm): interval + Position ID.
  const vm = obj.OpenPositionInfoVM;
  if (vm && Array.isArray(vm.Elements)) {
    let pid = null;
    let interval = null;
    for (const el of vm.Elements) {
      for (const g of el.GroupExpanderGenericList || []) {
        if (g.Header === 'Position ID' && g.Value != null) pid = g.Value;
        if (g.Header === 'Next trading session' && g.Value && g.Value.DateTime) {
          interval = { from: g.Value.DateTime, to: g.Value.EndDateTime };
        }
      }
    }
    if (pid != null && interval) {
      const existing = getByPid(String(pid));
      if (existing) upsert({ symbol: existing.symbol, pid: String(pid), next: interval, source: 'OpenPositionInfo' });
    }
  }
  return out;
}

function handleBody(text, _url) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { state.parseErrors++; return; }
  const rows = harvest(parsed);
  for (const r of rows) upsert(r);
  state.lastResponseAt = Date.now();
  state.responses++;
}

const WATCH_URLS = /CometAsyncHandler\.ashx|GetOpenPositionInfoImm|GetSingleTradeInstrumentImm/;

// ★ RE-ARM, DO NOT GUARD AGAINST RE-ENTRY (2026-09-15).
//
// This function used to open with `if (state.tracking) return;` and be called exactly once from server
// boot. That made the listener a ONE-SHOT: `ensureBrowser()` builds a BRAND NEW Browser (and every Page)
// when Chrome reconnects, so `page.on('response')` stayed bound to a dead page and the registry froze
// for the rest of the process's life. The guard was not protecting anything — it was the defect. Found
// live on 2026-09-15: `[trading.browser] Chrome disconnected` at 12:15Z, and the venue session state
// never recovered, which is what eventually closed the desk.
//
// `attach()` is idempotent, so being called on every reconnect is cheap.
async function startTracking() {
  if (state.tracking) return;
  state.tracking = true;
  state.startedAt = Date.now();
  if (typeof browser.onConnect === 'function') {
    browser.onConnect(() => {
      state.reattaches += 1;
      attach('reconnect').catch(() => {});
    });
  }
  await attach('boot');
  startSilenceWatch();
}

// Bind the response listener to the CURRENT bridge page. Idempotent: safe to call on every reconnect,
// and it refuses to stack a second handler on the same page object.
//
// Playwright's own interception (NOT a raw CDP Network session) is required: the CometAsyncHandler
// long-poll responses are chunked/streamed, and CDP's Network.getResponseBody refuses them
// ("No data found for resource"). page.on('response') buffers them fine.
let attaching = null;
function attach(reason = 'manual') {
  if (attaching) return attaching;
  attaching = (async () => {
    const page = await browser.newPage();
    if (binding.page === page && binding.handler) return;   // already listening here
    detach();
    const handler = async (resp) => {
      const url = resp.url();
      if (!url || !WATCH_URLS.test(url) || !url.includes('trade.plus500.com')) return;
      try {
        const text = await resp.text();
        handleBody(text, url);
      } catch { /* streamed/no body */ }
    };
    page.on('response', handler);
    // A closed page means the binding is dead even when no 'disconnected' fires (tab closed, navigated
    // away). Clearing it lets the silence watch re-attach instead of reporting a healthy quiet feed.
    page.on('close', () => { if (binding.page === page) detach(); });
    binding.page = page;
    binding.handler = handler;
    state.attachedAt = Date.now();
    state.attachments += 1;
    state.pageUrl = String(page.url() || '').slice(0, 160);
    console.error(`[trading.sessionFeed] listening on the bridge page (${reason}, attach #${state.attachments})`);
  })()
    .catch((e) => {
      state.lastError = String((e && e.message) || e).slice(0, 200);
      console.error('[trading.sessionFeed] attach failed:', state.lastError);
    })
    .finally(() => { attaching = null; });
  return attaching;
}

function detach() {
  if (binding.page && binding.handler) {
    try { binding.page.off('response', binding.handler); } catch { /* the page is already gone */ }
  }
  binding.page = null;
  binding.handler = null;
}

// ★ THE WATCHDOG, AND WHY IT IS NOT DECORATION. The feed going quiet is the failure this file did not
// previously notice, and the consequence was never "no data" — it was a FALSE VERDICT. With every entry
// stale, `get()` returns null, and `sessions.sessionState` read that as "the venue has not said
// anything" and fell through to the corporate-event fallback, which closed all twelve symbols. Silence
// was therefore indistinguishable from a shutdown. It is now reported, re-attached when the binding is
// gone, and exposed in `status()` so a health check can see it.
let watchTimer = null;
let offLogged = false; // 2026-10-03: once-per-transition log for parked / chrome-off
function startSilenceWatch() {
  if (watchTimer) return;
  watchTimer = setInterval(async () => {
    const s = status();
    if (!s.silent) { offLogged = false; return; }
    const mins = Math.round((s.silentForMs || 0) / 60000);
    if (!binding.page) {
      // ★ 2026-10-03 — RE-ATTACH ONLY WHEN THERE IS A BROWSER TO RE-ATTACH TO. This watch used to
      // call `attach()` unconditionally, and `attach()` → `browser.newPage()` → `ensureBrowser()` →
      // `connectOrLaunch()` LAUNCHES Chrome when it is gone — measured live today: an operator closed
      // the page and this watch relaunched Chrome on its own ~10 minutes later. Chrome-off is a KNOWN
      // state and parked is an OPERATOR state: neither is a fault to repair by manufacturing a browser.
      const settings = await require('../store').getSettings(1).catch(() => null);
      if (settings && settings.bridge && settings.bridge.parked) {
        if (!offLogged) { offLogged = true; console.error(`[trading.sessionFeed] silent ${mins}m — PARKED, not re-attaching`); }
        return;
      }
      const alive = await require('./browser').chromeAlive().catch(() => false);
      if (!alive) {
        if (!offLogged) { offLogged = true; console.error(`[trading.sessionFeed] silent ${mins}m — chrome off (a known state), not re-attaching`); }
        return;
      }
      offLogged = false;
      console.error(`[trading.sessionFeed] silent for ${mins}m and NOT attached — re-attaching`);
      attach('silence').catch(() => {});
      return;
    }
    console.error(`[trading.sessionFeed] silent for ${mins}m with a live page — the venue is not polling; venue session state is UNKNOWN and every consumer is on its fallback`);
  }, 60000);
  if (typeof watchTimer.unref === 'function') watchTimer.unref();
}

// Fallback: force-refresh one symbol's session via the row Info panel
// (2 UI ops: click + Escape). Only used when the registry is stale for a
// symbol that still has an open position — the passive stream normally
// keeps everything fresh on its own.
async function forceRefresh(symbol) {
  const page = await browser.newPage();
  const row = await page.evaluate((sym) => {
    const rows = [...document.querySelectorAll('[data-testid^="OpenPosition."]')];
    const hit = rows.find((r) => {
      const t = (r.textContent || '').toLowerCase();
      return t.includes(sym.toLowerCase());
    });
    return hit ? hit.getAttribute('data-testid') : null;
  }, symbol);
  if (!row) return false;
  await page.evaluate((tid) => {
    const b = document.querySelector(`[data-testid="${tid}.Button.Info"]`);
    if (b) b.click();
  }, row).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  await page.keyboard.press('Escape').catch(() => {});
  return true;
}

module.exports = { startTracking, get, getByPid, isOpen, nextOpenAt, summary, status, forceRefresh, STALE_MS, SILENT_AFTER_MS, attach, detach };

// Playwright's own interception (NOT a raw CDP Network session) is used inside `attach`: the
// CometAsyncHandler long-poll responses are chunked/streamed, and CDP's Network.getResponseBody
// refuses them ("No data found for resource"), so `page.on('response')` is the only mechanism that
// can read them.
