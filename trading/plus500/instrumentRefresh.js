'use strict';
// trading/plus500/instrumentRefresh.js — the DAILY contract-spec refresh (funding rates + minimum size).
//
// ★ WHY THIS EXISTS, AND WHY NOT MORE OFTEN. `Instruments` is the only lane that supplies `fundingBuyPct` /
// `fundingSellPct` / `unitAmount` / `leverageRaw`, and it is fed ONLY by `instrumentProbe.run()` — a UI probe that
// navigates the shared tab and clicks a row so the contract-spec sidebar mounts. Nothing scheduled it, so measured
// 2026-10-27 the registry held 44 rows across 24 symbols and its newest row was **2026-10-01 (26 days stale)**.
//
// That staleness reaches the live path: `executor.js` prices overnight carry per position through
// `instruments.carryPctFor`, which reads these rates. A wrong funding rate is a wrong cost on a held position.
//
// ⚠ AND IT IS NOT THE SPREAD LANE. `InstrumentQuotes` was ALSO 26 days stale, and the obvious conclusion — schedule
// the probe for the quotes too — was wrong: the spread is measured far better from `spreadSubmitPct` (the venue's own
// ticket labels, read inside `placeOrder`) and `spreadSignalPct` (the desk tick at the decision), which agree to
// within 3%. The probe is scheduled for the facts NOTHING ELSE supplies, and for nothing more.
//
// ⚠⚠ ONE TAB, AND IT IS THE SHARED ONE. `instrumentProbe.run` acquires the `ticket` page lock (orders wait up to 240s
// on it) and parks the tab back to `/open-positions` in its own `finally`. This module therefore does NOT open a page,
// does NOT close one, and does NOT run on a cadence that can meet an active session: once a day, inside a quiet-hour
// window, and only if the last successful refresh is more than 23h old.
const KIND = 'instrument_refresh';
const DEFAULTS = {
  enabled: true,
  // INSTRUMENTS re-read per run — ONE navigation each, with the 'ticket' lock held for the walk.
  // ⚠ RENAMED FROM `scan`, which described the MECHANISM rather than the job and hid the mismatch: it was a count of
  // rows on whatever page the tab happened to be on, not a count of instruments the desk needs.
  symbols: 6,
  quietHoursUtc: [2, 3, 4],    // the window the refresh may start in
  minIntervalHours: 23,        // one run a day, with an hour of slack
};

const lastRunAt = async (userId) => {
  try {
    const pool = await require('../db').getPool();
    const r = await pool.request().input('userId', require('../db').sql.Int, userId).query(
      `SELECT TOP 1 createdAt FROM TradingEvents
        WHERE userId = @userId AND kind = '${KIND}' AND JSON_VALUE(payload,'$.ok') = 'true'
        ORDER BY id DESC`);
    return r.recordset[0] ? new Date(r.recordset[0].createdAt) : null;
  } catch {
    return null;
  }
};

// PURE, so "may I run now" is testable without a browser, a clock or a database.
function shouldRun({ now = new Date(), lastAt = null, cfg = DEFAULTS } = {}) {
  if (!cfg || cfg.enabled !== true) return { run: false, reason: 'disabled' };
  const hour = now.getUTCHours();
  if (!(cfg.quietHoursUtc || []).includes(hour)) return { run: false, reason: `outside_quiet_hours (${hour}Z)` };
  if (lastAt) {
    const ageH = (now.getTime() - new Date(lastAt).getTime()) / 3600000;
    if (Number.isFinite(ageH) && ageH < (cfg.minIntervalHours || 23)) {
      return { run: false, reason: `recent (${ageH.toFixed(1)}h ago)` };
    }
  }
  return { run: true, reason: 'due' };
}

// ★★ WHICH SYMBOLS, AND WHY "WHATEVER IS ON THE PAGE" WAS THE WRONG QUESTION.
//
// The first version ran `instrumentProbe.run({ scan: 6 })`, which clicks rows on whatever route the shared tab happens
// to be on. AGENTS.md §3 parks that tab on `/open-positions`, and `scanChain` reads `[data-instrument-id]` — measured
// 2026-10-27 02:54Z: `rowsOnPage: 0, scanned: 0`, against a registry whose newest row was 2026-10-01. A DISCOVERY walk
// had been scheduled as a REFRESH, and those want opposite things: discovery wants breadth over an unknown list,
// refresh wants the desk's own book to stay current.
//
// So the set is the BOOK — OPEN POSITIONS first (they carry funding cost right now), then the watchlist. A symbol the
// desk holds and cannot re-read is a stale cost; a symbol nobody holds is interest, not need.
//
// ⚠ THE CAP IS THE SAME ORDER OF MAGNITUDE THE SCAN USED, for the same reason: `instrumentProbe.run({ symbol })`
// navigates and clicks with the 'ticket' lock held, so an unbounded walk delays orders. It caps THIS RUN, not
// coverage — whatever is left over is counted in the event rather than silently dropped.
async function symbolsToRefresh(userId, settings, cfg, store) {
  const want = [];
  const seen = new Set();
  const push = (s) => {
    const v = typeof s === 'string' ? s : (s && s.symbol);
    if (!v || seen.has(v)) return;
    seen.add(v);
    want.push(v);
  };
  let openError = null;
  try {
    for (const t of (await store.getOpenTrades(userId)) || []) push(t.symbol);
  } catch (e) {
    // An unreadable book must not cancel the refresh — but it must not read as "no open positions" either.
    openError = String((e && e.message) || e).slice(0, 160);
  }
  const wl = settings && settings.watchlist && Array.isArray(settings.watchlist.symbols) ? settings.watchlist.symbols : [];
  for (const s of wl) push(s);
  const cap = Math.max(1, Number(cfg.symbols) || 6);
  return { take: want.slice(0, cap), total: want.length, cappedOut: Math.max(0, want.length - cap), openError };
}

// PURE, so every branch is testable without a browser, a clock or a database.
function refreshReason({ plan, refreshed, failed } = {}) {
  const took = plan && Array.isArray(plan.take) ? plan.take.length : 0;
  if (!took) return plan && plan.openError ? 'no_symbols_book_unreadable' : 'no_symbols';
  const okCount = Array.isArray(refreshed) ? refreshed.length : 0;
  if (!okCount) {
    const first = failed && failed[0] && failed[0].reason ? failed[0].reason : 'unknown';
    return `nothing_refreshed (${first})`;
  }
  return failed && failed.length ? 'partial' : 'refreshed';
}

// One refresh. NEVER throws: this rides a timer and a browser, and an unhandled rejection here would take a loop down
// for a reason that has nothing to do with trading. Every outcome is an event with a NAMED reason, because a refresh
// that silently does nothing is indistinguishable from a registry that needs nothing.
async function runOnce(userId, { now = new Date(), cfg = DEFAULTS, settings = null } = {}) {
  const store = require('../store');
  const verdict = shouldRun({ now, lastAt: await lastRunAt(userId), cfg });
  if (!verdict.run) return { ok: false, skipped: verdict.reason };

  const plan = await symbolsToRefresh(userId, settings, cfg, store);
  const refreshed = [];
  const failed = [];
  for (const symbol of plan.take) {
    try {
      // `run({ symbol })` navigates to THIS instrument and clicks its Info chevron — the only way the contract spec
      // mounts — and parks the tab back in its own `finally`.
      const out = await require('./instrumentProbe').run({ symbol, force: false, settings });
      if (!out || out.skipped) { failed.push({ symbol, reason: (out && out.skipped) || 'no_result' }); continue; }
      const reg = await require('../agent/instruments').captureFromObservation(userId, out);
      // ⚠ `instruments`, NOT `captured`. `captureFromObservation` has never returned a `captured` field, so the old
      // event recorded `captured: null` on every run — a key that looked like a measurement and was always blank.
      if (reg && reg.instruments > 0) refreshed.push({ symbol, instruments: reg.instruments, quotes: reg.quotes });
      else failed.push({ symbol, reason: 'captured_nothing' });
    } catch (e) {
      failed.push({ symbol, reason: String((e && e.message) || e).slice(0, 140) });
    }
  }

  // ⚠⚠ `ok` IS NOT "THE CALL RETURNED". The first version computed `ok = !error && !!out`, so the only run this module
  // has ever made reported `ok: true, rowsOnPage: 0, scanned: 0` — it read NOTHING and said it was fine. That is worse
  // than a plain failure, because `lastRunAt` filters on `ok='true'`: the empty run RESET the 23h throttle, so the
  // probe suppressed its own retry for a day and the registry stayed frozen while reporting health.
  const ok = refreshed.length > 0;
  const payload = {
    ok,
    reason: refreshReason({ plan, refreshed, failed }),
    symbols: plan.take,
    total: plan.total,
    cappedOut: plan.cappedOut,
    openError: plan.openError,
    refreshed: refreshed.length,
    failed: failed.slice(0, 12),
    at: new Date().toISOString(),
  };
  await store.logEvent(userId, KIND, payload).catch(() => {});
  return payload;
}

module.exports = { KIND, DEFAULTS, shouldRun, runOnce, lastRunAt, symbolsToRefresh, refreshReason };
