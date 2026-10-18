// trading/agent/accountPoller.js — TRD-11: per-tick demo account strip.
// Polls #accountStatus on the bridge tab every settings.account.pollSeconds WITHOUT navigating
// (the strip is persistent on Plus500 pages). Persists a TradingEvent kind 'account' when the
// numbers changed (>= 15s since last write) so /account + concierge /status + Health card stay fresh.
// Read-only — never touches the wake loop or the user's pause.
//
// ⚠ CADENCE, MEASURED 2026-09-14 (TRD-70). This header used to claim "default 30" while the code
// default was `|| 1`, and the dashboard chart claimed "live reads normally land every 1s". Neither
// was true of the implementation: the loop was `pollOnce(); sleep(1s)`, and pollOnce performs TWO
// CDP round-trips (readAccountStatus + readPositionsLive), so the real period was `1s + work`.
// Measured over 20s with pollSeconds = 1: `live.readAt` advanced 9 times — mean 2.4s, stalls to
// ~6s. The loop is now FIXED-RATE (the period is measured from the start of the cycle), so a fast
// read does land near 1s, but the honest number for a consumer is still "about a second, sometimes
// several": treat a few seconds of a flat value as normal and only a much longer gap as a fault.
'use strict';

const store = require('../store');
// TRD-PNL-4 (#1484): the unit the account strip is denominated in, READ FROM SETTINGS rather than restated.
const { currencyOf } = require('./accountCurrency');
// TRD-PNL-7 / P1a: the USD->SGD rate, DERIVED from position rows the poller is already reading (`position_pnl`
// carries `pnl` in the account's currency beside rates in the instrument's). See `fxRate.js` for why it is
// derived and paired rather than assumed or sampled once.
const { deriveRate } = require('./fxRate');

let running = false;
let live = null;         // in-memory latest account strip — the mirror
let livePositions = null; // in-memory latest position rows (1s cadence)
let last = null;          // last persisted values
let lastWriteAt = 0;
let cachedPage = null;    // reused bridge tab (no per-second page lookups)
let inFlight = false;
let lastAccepted = null;  // 2026-09-11: last PLAUSIBLE reading (flicker guard)
// ★ THE ACCOUNT CURRENCY, CACHED WHERE THE SETTINGS ARE ALREADY READ (TRD-PNL-4 / #1484). The loop refreshes
// `settings` every CFG_TTL_MS for the cadence and the kill tier anyway, so the unit rides along at NO extra
// query. Module-scoped rather than threaded through `pollOnce`/`acceptSample` because the CAPTURE path calls
// `acceptSample` too and has no settings in hand — and a payload that carries the unit on one write path and
// not the other is how a reader learns to distrust the field.
let accountCurrency = null;
let rejected = 0;         // consecutive rejections (telemetry once per run)
let lastTickAt = 0;       // 2026-09-11: fine-equity-tick cadence (<=5s writes)
let lastPruneAt = 0;      // hourly retention prune
// TRD-106 (2026-09-19): cadence for persisting the POSITION rates this loop already reads. A module
// constant rather than a setting on purpose — `pollOnce(userId)` has no settings object, and the loop
// deliberately stopped reading them per-iteration (see the cached-config comment in `start()`) so the
// poll budget stays on the page reads. 10s gives ~6 samples inside a one-minute trade, which is what the
// autopsy needs (`ticks.length >= 3`), while a 1s cadence would write ~86k rows a day per position.
const POSITION_TICK_MIN_INTERVAL_MS = 10000;
// TRD-PNL-1 (2026-09-25): the NET P/L path. The venue reports each open position's own NetPL, and
// `positionsEval` already parses it into `row.pnl` — but it only ever went into ONE MUTABLE COLUMN
// (`Trades.floatingPnl`), so every earlier sample of a trade's path was overwritten and discarded.
// This rides the SAME read: no new bridge call, no navigation and no pageLock contention — and the number
// is Plus500's own, so the venue-mixing trap of TRD-101 cannot arise.
//
// ★ THE CADENCE IS 60s, NOT THE TICK GATE'S 10s, AND THAT IS A RETENTION DECISION. Measured 2026-09-25:
// `retention.tickDays` (store.js:74, resolved in `agent/retention.resolveTickDays`) prunes **PriceTicks
// only** — `TradingEvents`, where this is written, has NO retention at all. At the tick cadence this would
// add ~8,640 rows/day/open position to an unpruned table that currently holds ~65,000 rows in total, i.e.
// roughly doubling its growth rate to buy samples the deliverable does not need: the RANGE is accumulated
// in memory and emitted once at close, so this stream is only a RESTART-DURABLE CHECKPOINT. The ORDER of
// the path, which is what an exit study actually needs, is already available at 10s from `PriceTicks`.
// If the cadence is ever raised back toward the tick gate, the retention question above must be answered
// first rather than inherited.
const POSITION_PNL_MIN_INTERVAL_MS = 60000;
// ⚠ REVERTED 2026-09-20 — THE TICK GATE IS NOT SESSION-AWARE, AND THE REASON IS A MEASUREMENT.
//
// There was a second interval here (60m for a symbol whose session is shut, `POSITION_TICK_CLOSED_INTERVAL_MS`),
// added on the belief that the desk was paying a 10-second cadence all weekend for a number that could not
// move. It was not: `store/ticks.js` silently DEDUPES a tick whose bid+ask equal the last stored one while
// that row is younger than `DEDUPE_WINDOW_MS = 60000`, so a frozen price was ALREADY capped at ~1 write a
// minute — measured 54-58/hour against a predicted 60. A session gate stacked on dedupe bought nothing, and
// it cost something real: a second cadence rule that sent this diagnosis down the wrong path twice, and a
// failure mode where a calendar entry wrongly saying "shut" would coarsen a series that should be dense.
//
// The NAV SKIP it was bundled with is KEPT (`decidePositionsNav` -> `sessions_closed`), because that one
// avoids a NAVIGATION, and navigation is the expensive operation on this shared tab: the worst cycle
// measured was 44.5s, caused by `page.goto: Timeout 45000ms exceeded` in the mirror. Evaluations cost 7ms
// (`account_poll_stats`).
// Per-symbol last-write clock (replaces the single `lastPosTickAt`, which could only ever express one cadence).
const lastPosTickBySymbol = new Map();
// TRD-PNL-1: keyed on POSITION, not symbol — two positions on one symbol are two different P/L series.
const lastPosPnlByPosition = new Map();   // key -> last emitted ms, drives the cadence
const posPnlRanges = new Map();           // key -> running { first, last, min, max, n }, emits on close
// ★ P1a (2026-10-01): FX PAIRS, built from the SAME read that feeds `posPnlRanges` above — no extra navigation,
// no extra query, and no new data source. `a` is the position's FIRST sample and `b` its LATEST, so the pair
// always spans the widest move observed rather than two arbitrary adjacent polls, which is what makes the
// signal gate reachable inside one position's lifetime.
// ⚠ Closed pairs are KEPT for a bounded window because the rate is dynamic and one open position is not always
// enough for the median; they are pruned by age so a stale rate cannot outlive its evidence.
const fxPairs = new Map();                // key -> { a, b, closedAt }
const FX_PAIR_MAX_AGE_MS = 6 * 3600 * 1000;
// TRD-106 (2026-09-19): how often the POLLER may spend a bridge NAVIGATION to put the shared tab back
// on /open-positions. Measured before this existed: 121 `position_poll` ticks in two hours, gaps 60-70s
// — one per mirror cycle — so the fix is not a faster read, it is a read that is DEFINITIVE more often.
// Deliberately slow: each navigation is a `page.goto` that must hold `pageLock`, and the payoff is that
// the tab then STAYS parked and the 10s tick gate runs at its own rate. `positionNavSeconds: 0` disables.
const POSITION_NAV_MIN_INTERVAL_MS = 300000;
let lastPosNavAt = 0;
let lastPosNavLog = null;  // nav-skip telemetry once per transition, never per second
let lastPosMode = null;    // read-mode telemetry once per transition (see readDisposition)
let lastPosUrl = null;     // the tab's PATH at the last read (see urlPath — this is the missing witness)
let lastUrlLogAt = 0;      // url-only changes are throttled; mode changes never are
let lastStatsLogAt = 0;    // one poller stats row a minute (see the loop for why it is not 'on overrun')
// Read-mode counters, so "which of the two TRD-106 causes is costing samples" is answerable from a
// running process instead of from a code reading. Surfaced through getStatus().
//
// ⚠ `readMsSum`/`readMsMax`/`rowsRead` were added 2026-09-20 for ONE decision: the poller spends a
// `page.evaluate` on the SHARED tab every second (~3,600/hour, ~86k/weekend), and the question
// "should the session gate move from the WRITE to the READ?" cannot be answered without knowing what
// that read costs. The write side is already capped at ~1/min by the store's dedupe
// (`store/ticks.js` DEDUPE_WINDOW_MS = 60000) whenever the price is frozen, so gating writes saves
// ~59 INSERTs an hour and nothing else; the READ is the only real candidate cost, and it was
// unmeasured. Measure first: this is the third time in one session that reasoning about a rate
// without reading the layer that produces it gave a confident wrong answer.
const posStats = { reads: 0, onPage: 0, sawDom: 0, rows: 0, navs: 0, modeTransitions: 0, urlTransitions: 0, readMsSum: 0, readMsMax: 0, readMsOver100: 0, rowsRead: 0, tickAttempts: 0, tickInserted: 0, tickDeduped: 0, pnlSamples: 0, pnlRanges: 0 };
// Url-only changes are logged at most this often; a mode change always logs regardless.
const POSITION_URL_LOG_MIN_MS = 5000;

// The tab's PATH, for telemetry only.
//
// ⚠ WHY THIS EXISTS (2026-09-20): `onPage` is a boolean, and a boolean cannot say WHERE the tab went.
// Measured over 20 hours: 54-58 `position_poll` rows per hour with gaps of 60-70s, against ~64 reads per
// hour that had rows at all — so the 10s tick gate was never the binding constraint and the question was
// only ever "why are rows absent 98% of the time". The two candidate answers were opposites: the mirror
// cycle dragging the SHARED tab to /trade/alerts between parks (a pathing artifact), or the Plus500 app
// redirecting itself away from /open-positions when the market is shut (a calendar artifact). No row said
// which, so neither could be confirmed or excluded. One string per read settles it.
function urlPath(page) {
  try { return new URL(String(page.url())).pathname || '/'; } catch { return null; }
}

// One read's duration into the counters. A separate function so the rule is in one place: a read that
// takes >100ms is counted as well as summed, because on a shared tab the slow tail is the cost that
// matters (the mean can be 5ms while one read in fifty holds the tab for a third of a second).
function recordReadMs(stats, ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  stats.readMsSum += ms;
  if (ms > stats.readMsMax) stats.readMsMax = ms;
  if (ms > 100) stats.readMsOver100 += 1;
}

// ---------------------------------------------------------------------------
// ★ "WHEN WE READ" vs "WHEN WE GOT A USABLE VALUE" (TRD-70, 2026-09-14).
//
// `live` is only assigned on an ACCEPTED sample, so `live.readAt` means "the last
// plausible reading" — but the dashboard read it as "the last time we read", and the two
// are not the same thing. Measured: with the venue strip emitting its known transitional
// frame (pnl 0 with equity ≈ prev.equity − prev.pnl) every few seconds, `live.readAt`
// sat still for 5-6s at a time while the poller was reading perfectly well, so the panel
// showed a frozen number with NOTHING to distinguish "the poller stopped" from "we are
// reading fine and rejecting what we see". That is the same never-silent failure class as
// the wake failures: the desk knew, and could not say so.
//
// `status` therefore travels WITH the live value and records the read side independently:
//   lastReadAt      — a strip was successfully read, whatever its VALUES looked like
//   rejectedStreak  — consecutive reads whose values failed the flicker guard
//   lastRejectAt / lastRejectedValue — what was rejected and when, for diagnosis
// Consumers must keep the two apart: an old `readAt` with a fresh `lastReadAt` is a
// FLICKER (keep the last good value, say why), while a stale `lastReadAt` is a dead feed.
// ---------------------------------------------------------------------------
const status = {
  lastReadAt: null,        // last successful strip READ, values not judged
  acceptedAt: null,        // last ACCEPTED strip (mirrors live.readAt)
  rejectedStreak: 0,
  lastRejectAt: null,
  lastRejectedValue: null,
  flashes: 0,              // TRD-RSK-17: single reads at a wild level that did NOT survive confirmation
};
// How often a sustained rejection streak is worth a row. The guard logs the FIRST
// rejection of a streak already; this makes a long one visible instead of a single
// easily-missed row at the start.
const REJECT_LOG_EVERY = 30;

function getLive() {
  // ★ P1a: the derived fx rate rides the object `risk.js` ALREADY reads (`getLive().equity` at risk.js:373), so
  // making it available costs no plumbing. A refusal travels as `fxWhy` rather than as an absent key, because
  // "no rate" and "the rate is 1" must never be the same shape to a caller.
  const fx = getFxRate();
  const fxFields = { fxSgd: fx && fx.ok ? fx.rate : null, fxBasis: fx };
  if (live) return { ...live, ...status, ...fxFields };
  // Never accepted a sample, but possibly reading and rejecting — say so rather than null,
  // so the caller can tell "no data because we cannot read" from "no data because the
  // venue's frames are transitional".
  if (!status.lastReadAt) return null;
  return { equity: null, available: null, pnl: null, margin: null, source: 'rejected-only', ...status };
}
function getLivePositions() { return livePositions; }
function getStatus() {
  return {
    ...status,
    switchPending: pendingSwitch ? { since: new Date(pendingSwitch.firstAt).toISOString(), reads: pendingSwitch.reads, equity: pendingSwitch.eq.equity } : null,
    positions: { ...posStats, lastNavAt: lastPosNavAt, lastMode: lastPosMode },
  };
}

// 2026-09-11 incongruity guard. The Plus500 strip occasionally renders a
// transitional frame: P&L shows 0 while equity/available still carry the
// PRE-P&L value — observed on 2026-09-09 as dozens of +2.5% spikes, and again
// 2026-09-11 at SMALL scale (eq 4028.46 / pnl 0 between 4025.92/-2.54 pairs:
// exactly +|pnl| away). The EXACT identity is `equity ≈ prev.equity − prev.pnl`
// (the balance with the floating P&L stripped out) — scale-independent, so it
// catches 2-dollar and 110-dollar flickers alike. The coarse 0.25% jump rule
// stays as a fallback for drifting cases. Persisting these corrupts the equity
// curve AND skews risk sizing (live equity feeds position caps).
function isPlausibleSample(acc, prev) {
  if (!acc || acc.equity == null) return false;
  if (!prev || prev.equity == null) return true; // first sample: nothing to compare
  if (isAccountSwitch(acc, prev)) return true;   // account change — never a strip flicker
  if (acc.pnl === 0 && prev.pnl !== 0 && prev.pnl != null) {
    const noPnlEquity = prev.equity - prev.pnl; // balance without the floating P&L
    if (Math.abs(acc.equity - noPnlEquity) <= Math.max(0.5, Math.abs(prev.equity) * 0.0002)) return false;
    if (Math.abs(acc.equity - prev.equity) > Math.max(2, Math.abs(prev.equity) * 0.0025)) return false;
  }
  return true;
}

// 2026-09-11 (owner patch): ACCOUNT-SWITCH guard. The user can flip the
// Plus500 tab between the demo account and a real-money account; the strip
// then reports a totally different equity level (live: 4025 -> 22.28 in one
// poll). Without this, every consumer treated the switch as a -99% day:
// daily-loss halt vetoed all entries, the disaster floor tripped a HARD kill
// (autoClose) and the equity curve recorded the $22 dip. Factor-5x breaks are
// not P&L — log the switch and re-baseline day-start + the kill/risk equity
// baselines to the new account level. The kill TIER is never auto-cleared
// here (fail-secure): a latched kill stays until a human releases it.
function isAccountSwitch(acc, prev) {
  if (!acc || acc.equity == null || !prev || prev.equity == null) return false;
  const cur = Number(acc.equity);
  const was = Number(prev.equity);
  if (!(cur > 0) || !(was > 0)) return false;
  const ratio = cur / was;
  return ratio < 0.2 || ratio > 5;
}

// ★★ TRD-RSK-17 (#1503, 2026-10-02): A SWITCH IS CONFIRMED, NOT ASSUMED.
//
// MEASURED CASE (docs/incident-2026-10-02-ui-fallback-pause.md §6): 30 s after the desk resumed, ONE strip
// read returned the OTHER account's level (22.28 — the real-money account, while the desk runs demo ~3956).
// `isAccountSwitch` trusted that single read, so one frame re-based `day_start` AND both equity baselines to
// 22.28 for six seconds until the next read bounced back — two spurious account_switch events and two
// settings writes. The epoch guard caught it (its first live catch). The flash ran LOW, which is the benign
// direction; the same mechanism running HIGH on a low-equity account computes as a −99 % day ⇒ HARD kill
// + autoClose.
//
// THE FIX IS CONFIRMATION, AND IT IS NEARLY FREE: a genuine switch (the owner flips the tab) persists across
// reads indefinitely; a transitional frame does not. The new level must appear on SWITCH_CONFIRM_READS
// consecutive reads before any rebase — below 2 the 06:54Z flash still passes, and the cost to a real switch
// is about one poll period (1 s nominal, 2.4 s measured mean).
const SWITCH_CONFIRM_READS = 2;

let pendingSwitch = null; // { eq: { equity, pnl }, firstAt, reads } — a wild level awaiting confirmation

// PURE — BOTH switch sites (acceptSample for the capture path, pollOnce for the loop) call THIS, so the
// confirmation rule cannot diverge between them. That is not tidiness: the two-sites-one-patched defect has
// already cost this module once (P1b — "the first version patched only acceptSample", found as a fresh
// account event with the currency but no rate).
//   action: 'none'    normal sample (use `pending` to CLEAR any stale window)
//           'pending' the wild level's first (or Nth) unconfirmed read — the sample must NOT be accepted
//           'confirm' the wild level persisted — rebase now; `confirmedAfterReads`/`Ms` record the evidence
//           'flash'   back at the old level — the wild read was a FLASH: log it, then accept normally
function switchDecision(acc, prev, pending, nowMs = Date.now()) {
  const oldEq = prev && prev.equity != null ? Number(prev.equity) : null;
  if (!acc || acc.equity == null || !(Number(acc.equity) > 0) || !(oldEq > 0)) return { action: 'none', pending: null };
  const reading = { equity: Number(acc.equity), pnl: acc.pnl };
  if (pending) {
    if (!isAccountSwitch(acc, prev)) {
      return { action: 'flash', pending: null, flash: { from: oldEq, to: pending.eq.equity, heldMs: nowMs - pending.firstAt } };
    }
    if (!isAccountSwitch(acc, pending.eq)) {
      const reads = pending.reads + 1;
      if (reads >= SWITCH_CONFIRM_READS) {
        return { action: 'confirm', pending: null, confirmedAfterReads: reads, confirmedAfterMs: nowMs - pending.firstAt };
      }
      return { action: 'pending', pending: { ...pending, reads } };
    }
    // A DIFFERENT wild level — the window restarts at the new level; neither is rebased on one read.
    return { action: 'pending', pending: { eq: reading, firstAt: nowMs, reads: 1 } };
  }
  if (isAccountSwitch(acc, prev)) return { action: 'pending', pending: { eq: reading, firstAt: nowMs, reads: 1 } };
  return { action: 'none', pending: null };
}

// ONE writer for the flash row, called from both sites — a flash logged on one path and not the other is the
// same asymmetry this fix exists to remove.
async function logSwitchFlash(userId, dec, source) {
  status.flashes += 1;
  await store.logEvent(userId, 'account_flash', {
    source, from: dec.flash.from, to: dec.flash.to, heldMs: dec.flash.heldMs,
    note: 'a wild account level that did not survive confirmation — NOT a switch; no baseline, day_start or settings write was touched',
  }).catch(() => { /* audit best-effort */ });
}

async function rebaselineForSwitch(userId, acc, source, { confirmedAfterReads = null, confirmedAfterMs = null } = {}) {
  const to = Number(acc.equity);
  const from = lastAccepted ? Number(lastAccepted.equity) : null;
  await store.logEvent(userId, 'account_switch', {
    from, to, ratio: from > 0 ? +(to / from).toFixed(4) : null, at: new Date().toISOString(), source,
    ...(confirmedAfterReads != null ? { confirmedAfterReads, confirmedAfterMs } : {}),
  }).catch(() => { /* audit best-effort */ });
  const today = new Date().toISOString().slice(0, 10);
  await store.logEvent(userId, 'day_start', { date: today, equity: to, rebased: 'account_switch', source }).catch(() => { /* best-effort */ });
  const settings = await store.getSettings(userId).catch(() => null);
  if (settings) {
    const patch = {};
    if (Number(settings.kill?.initialEquity) !== to) patch.kill = { initialEquity: to };
    if (Number(settings.risk?.initialEquity) !== to) patch.risk = { initialEquity: to };
    if (Object.keys(patch).length) await store.saveSettings(userId, patch).catch(() => { /* best-effort */ });
  }
  return { from, to };
}

// Shared acceptance path — capture banks the strip through this too so both
// writers use the same guard and the same lastAccepted baseline.
async function acceptSample(userId, acc, source = 'capture') {
  // TRD-RSK-17: the confirmation gate runs FIRST — a wild single read is held, not accepted (switchDecision).
  const sw = switchDecision(acc, lastAccepted, pendingSwitch);
  pendingSwitch = sw.pending;
  if (sw.action === 'pending') return { accepted: false, reason: 'switch_unconfirmed', reads: sw.pending.reads };
  if (sw.action === 'confirm') await rebaselineForSwitch(userId, acc, source, { confirmedAfterReads: sw.confirmedAfterReads, confirmedAfterMs: sw.confirmedAfterMs });
  if (sw.action === 'flash') await logSwitchFlash(userId, sw, source);
  if (!isPlausibleSample(acc, lastAccepted)) return { accepted: false, reason: 'implausible' };
  lastAccepted = { equity: acc.equity, pnl: acc.pnl, at: new Date().toISOString() };
  // TRD-PNL-4 (#1484): the unit travels WITH the number. An account event whose payload cannot say what its
  // money is denominated in is the defect this closes - a report reading 4063.37 had nothing to reconcile a
  // declared cost against. Stamped from the settings-derived cache, so it is one fact in one place.
  //
  // ★ P1b (2026-10-01): THE DERIVED RATE RIDES THE SAME EVENT, giving the desk a RATE TIME SERIES it has never
  // had. Why this is the right carrier: a CLOSE needs the rate at the moment of the close, and a close cannot
  // derive it — by the time `pnl_range` is written the position is gone and the pair with it. With the rate
  // stamped on every account sample, the rate at any close becomes a lookup against the nearest sample instead
  // of an inference after the fact, which is exactly the gap `venueClose.js` names ("a real conversion would
  // also need the fx rate ... at the close").
  // ⚠ A REFUSAL IS RECORDED AS ONE (`fxSgd: null` plus the reason), never omitted: an absent key and a rate
  // that could not be derived must not look the same to whoever reads the series later.
  // Cost: `getFxRate` iterates the pair map and sorts a handful of values, on a ~1s cadence. Measured small.
  const fx = getFxRate();
  await store.logEvent(userId, 'account', {
    ...acc, at: new Date().toISOString(), source, ...(accountCurrency ? { currency: accountCurrency } : {}),
    ...(fx && fx.ok
      ? { fxSgd: fx.rate, fxN: fx.n, fxGate: fx.gate, fxSpreadPct: fx.spreadPct }
      : { fxSgd: null, fxWhy: (fx && fx.reason) || 'not_derived' }),
  });
  return { accepted: true };
}

// The mirror's rule for an empty read (`mirrorPoller.assessEmptyTrust`), restated here because requiring
// mirrorPoller from this module would be a cycle (the mirror imports getLive from here): the account strip
// must be FRESH and the margin must be ~0 before an empty venue read may be called flat. The numbers are
// kept identical on purpose (120s, 0.005) — two thresholds for one fact is how the desk ends up with two
// answers.
function stripSaysFlat(account, nowMs = Date.now()) {
  if (!account) return false;
  const at = account.readAt || account.acceptedAt;
  if (!at) return false;
  const ageMs = nowMs - new Date(at).getTime();
  if (!Number.isFinite(ageMs) || ageMs > 120000) return false;
  if (account.margin == null) return false;
  return Math.abs(Number(account.margin)) <= 0.005;
}

// ---------------------------------------------------------------------------
// TRD-106 (2026-09-19): WHAT A POSITIONS READ MAY BE USED FOR.
//
// The row says "the shortest trades can never have an excursion measured". The first fix persisted this
// read; it then persisted it at one sample per MINUTE, because every decision hung off a single boolean
// whose name claimed more than its test did:
//
//   `onPage` is `page.url().includes('/open-positions')` — a SUBSTRING TEST. Used as the gate for rows
//   that had already been parsed, it throws away real evidence whenever the URL disagrees with the DOM,
//   which is exactly what an app that rewrites its own URL does. Three facts, three separate uses:
//
//     rows    — position rows were parsed. EVIDENCE BY ITSELF; nothing can make it less true.
//     sawDom  — the positions DOM rendered, so `rows === 0` is a FLAT venue and not a blank page.
//     onPage  — the URL says /open-positions. A label, recorded, and never the gate for `rows`.
//
// ⚠ AND THE EMPTY CASE NEEDS A SECOND WITNESS, which this function did not ask for until 09-20. Measured
// live with ONE position open on the venue: `mode: flat_definitive` fired **75 times in four hours** — the
// URL said /open-positions while the DOM had not rendered a single row. That is a half-rendered page, not
// a flat account, and calling it flat is how a real position disappears from the overlay. So `definitive`
// now requires the positions DOM **or** a fresh strip whose margin is ~0 — the same corroboration the
// mirror already demands. An empty read with one witness is reported as `empty_untrusted` instead.
//
// Pure, so these uses are pinned by tests instead of inferred from a live loop.
function readDisposition(pos, { account = null, nowMs = Date.now() } = {}) {
  const items = pos && Array.isArray(pos.items) ? pos.items : [];
  const rows = items.length;
  const onPage = !!(pos && pos.onPage);
  const sawDom = !!(pos && pos.sawDom);
  const definitive = sawDom || (onPage && stripSaysFlat(account, nowMs));
  const mode = rows ? (onPage ? 'rows_on_page' : 'rows_off_url')
    : definitive ? 'flat_corroborated'
      : (onPage || sawDom) ? 'empty_untrusted'
        : 'no_positions_dom';
  return {
    rows, onPage, sawDom, definitive, mode,
    setOverlay: rows > 0,
    clearOverlay: rows === 0 && definitive,
  };
}

// The session, as the desk knows it (never as a guess). A throw is "unknown", not "closed".
function sessionOpen(symbol) {
  try { return require('../plus500/sessionFeed').isOpen(symbol); } catch { return null; }
}

// Pure: which of these rows may become a tick RIGHT NOW, and is there anything here that can move at all?
//
// Split out of `readDisposition` on 2026-09-20 because the two questions are different: the disposition says
// what a read MEANS (rows are evidence; an empty read needs a witness), while this says what is worth
// WRITING. The CALENDAR is still read here, but only to answer `nothingToWatch` for the navigator — it
// deliberately does NOT change the interval any more (see the reverted gate above the constants). A cadence
// rule that consults the market schedule is a rule that can be wrong about the schedule in a way no reader
// of the series can detect.
function positionTickPlan({ rows, nowMs, lastBySymbolMs, isOpen = () => null, everyMs = POSITION_TICK_MIN_INTERVAL_MS }) {
  const due = [];
  let live = 0, shut = 0;
  for (const row of rows || []) {
    const symbol = row && row.name;
    if (!symbol) continue;
    let open = null;
    try { open = isOpen(symbol); } catch { open = null; }
    if (open === false) shut += 1; else live += 1;
    const lastMs = Number(lastBySymbolMs && lastBySymbolMs.get ? lastBySymbolMs.get(symbol) : 0) || 0;
    if (Number(nowMs) - lastMs >= everyMs) due.push({ symbol, row, open, everyMs });
  }
  // `nothingToWatch` is for the NAVIGATOR: there are positions and every one of them is in a shut session,
  // so a navigation would buy a rate that cannot move. No rows at all is deliberately NOT this case — then
  // we do not know the book, which is exactly when parking the tab is worth paying for.
  return { due, live, shut, nothingToWatch: (rows || []).length > 0 && live === 0 };
}

// TRD-PNL-1 (2026-09-25): may this cycle spend a NET P/L sample, and which tracked positions have gone?
//
// Pure, and deliberately separate from `positionTickPlan`, because the two answer different questions and
// must key on different things:
//   · the TICK plan keys on `symbol` — a price is a property of the market;
//   · this keys on `positionId` — a net P/L is a property of the POSITION. Two positions on the same
//     symbol are two different series, and reusing the symbol key (or the store's price dedupe) would
//     both merge them and discard a sample where the price held still while the P/L moved.
//
// `voided` is the half that makes a path COMPLETE. `position_poll` only ever sees OPEN positions, so a
// position that stops being reported has closed — and without this the last row of every path sits one
// poll short of the actual exit. Returning the disappearances (rather than deleting them in here) keeps
// the event a value the caller can assert on.
function positionPnlPlan({ rows, nowMs, lastByPositionMs, everyMs = POSITION_PNL_MIN_INTERVAL_MS }) {
  const due = [];
  const seen = new Set();
  for (const row of rows || []) {
    const key = positionKey(row);
    if (!key) continue;
    seen.add(key);
    // ★ ABSENCE IS GUARDED BEFORE COERCION. `Number(null) === 0` and `Number('') === 0`, so coercing first
    // turns an unread P/L into a sample sitting at exactly breakeven — a claim the read never made. This is
    // the trap `reanchorLevels` names in its own comment ("the same `Number(null) === 0` trap TRD-43
    // named"), and the first draft of this function walked straight into it; the unit test caught it.
    const raw = row.pnl;
    if (raw == null || raw === '') continue;
    const pnl = Number(raw);
    if (!Number.isFinite(pnl)) continue;
    const lastMs = Number(lastByPositionMs && lastByPositionMs.get ? lastByPositionMs.get(key) : 0) || 0;
    if (Number(nowMs) - lastMs >= everyMs) due.push({ key, pnl, row });
  }
  const voided = [];
  if (lastByPositionMs && lastByPositionMs.keys) {
    for (const key of lastByPositionMs.keys()) if (!seen.has(key)) voided.push(key);
  }
  return { due, voided };
}

// The identity of a position. `positionId` when the DOM gave one; otherwise the best available triple.
// One position's FX evidence: its FIRST sample and its LATEST, from rows already in hand.
// ⚠ Returns null quietly on an unreadable row — the `Number(null) === 0` trap would otherwise turn a missing
// `currentRate` into a zero, and a zero here divides into an infinity rather than being skipped.
function fxPairObserve(pairs, key, row, pnl) {
  if (!pairs || !key || !row) return null;
  const rate = row.currentRate == null || row.currentRate === '' ? null : Number(row.currentRate);
  const size = row.size == null || row.size === '' ? null : Number(row.size);
  const p = pnl == null || pnl === '' ? null : Number(pnl);
  if (!Number.isFinite(rate) || !Number.isFinite(size) || !Number.isFinite(p)) return null;
  const point = { symbol: row.name || null, direction: row.direction || null, size, pnl: p, rate };
  const cur = pairs.get(key);
  if (!cur) { pairs.set(key, { a: point, b: null, closedAt: null }); return null; }
  cur.b = point;
  return cur;
}

// The live rate, or a NAMED refusal. Recomputed on demand from the open pairs plus recently-closed ones;
// bounded work (one sort over a handful of positions) so it is safe on the hot path.
function getFxRate() {
  const now = Date.now();
  for (const [k, v] of fxPairs) {
    if (v && v.closedAt && now - v.closedAt > FX_PAIR_MAX_AGE_MS) fxPairs.delete(k);
  }
  const pairs = [];
  for (const [, v] of fxPairs) if (v && v.a && v.b) pairs.push(v);
  return deriveRate(pairs);
}

// The fallback is WEAKER than the id — it cannot tell two same-size positions in one direction apart —
// so it is NAMED here rather than passed off as equivalent.
function positionKey(row) {
  if (!row) return null;
  const id = row.positionId;
  if (id != null && String(id).trim() !== '') return `id:${String(id).trim()}`;
  if (!row.name) return null;
  return `sym:${row.name}:${row.direction || '?'}:${row.size == null ? '?' : row.size}`;
}

// The running range for one position. `first` is kept because a path's OPENING sample is not recoverable
// from min/max, and `n` is kept so a one-sample `pnl_range` is visible as thin rather than implied solid.
function pnlRangeObserve(ranges, key, row) {
  if (!ranges || !key) return null;
  // Same `Number(null) === 0` guard as `positionPnlPlan` above: an unread P/L must not widen or shift the
  // range, and must not be counted as a sample.
  const raw = row && row.pnl;
  if (raw == null || raw === '') return ranges.get(key) || null;
  const pnl = Number(raw);
  if (!Number.isFinite(pnl)) return ranges.get(key) || null;
  const cur = ranges.get(key);
  if (!cur) {
    const next = { positionId: (row && row.positionId) != null ? row.positionId : null,
      symbol: (row && row.name) || null, direction: (row && row.direction) || null,
      first: pnl, last: pnl, min: pnl, max: pnl, n: 1 };
    ranges.set(key, next);
    return next;
  }
  cur.last = pnl;
  if (pnl < cur.min) cur.min = pnl;
  if (pnl > cur.max) cur.max = pnl;
  cur.n += 1;
  return cur;
}

// Pure: may this cycle spend a NAVIGATION to make the next read definitive?
// Owner decision 2026-09-19: yes — on a slow cadence, under `pageLock`.
//   · A HARD kill means ZERO bridge navigation (the contract mirrorPoller states). This poller is the
//     one loop that keeps running through a HARD kill, so it is the one loop that must not navigate;
//     otherwise that contract quietly stops being true — the TRD-47 defect in a new place.
//   · The throttle is separate from the kill: a tab parked somewhere else does not need a navigation
//     every second to fix it, and the tick gate is 10s regardless.
function decidePositionsNav({ killTier, lastNavAt = 0, nowMs = Date.now(), everyMs = POSITION_NAV_MIN_INTERVAL_MS, nothingToWatch = false } = {}) {
  if (killTier === 'hard') return { go: false, reason: 'kill_switch_hard' };
  const every = Number(everyMs);
  if (!Number.isFinite(every) || every <= 0) return { go: false, reason: 'disabled' };
  // TRD-106 (2026-09-20): a shut book cannot move, so a navigation buys nothing. Checked BEFORE the throttle
  // because it is the more informative reason in the log, and because it is what makes the whole weekend
  // quiet instead of one park every five minutes for no samples.
  if (nothingToWatch) return { go: false, reason: 'sessions_closed' };
  const since = Number(nowMs) - Number(lastNavAt);
  if (Number.isFinite(since) && since < every) return { go: false, reason: 'throttled' };
  return { go: true, reason: 'park' };
}

// The throttle as configured. `positionNavSeconds: 0` disables the click-through entirely and the poller
// returns to evaluate-only reads; absent keeps the 5-minute default.
function navEveryMsFor(cfg) {
  const v = cfg && cfg.positionNavSeconds;
  if (v === 0 || v === '0') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n * 1000 : POSITION_NAV_MIN_INTERVAL_MS;
}

// Move the SHARED tab to /open-positions. `tryAcquire`, never `acquire`: this is the hot path, and a
// cycle that cannot get the bridge is simply a cycle that keeps its evaluate-only read.
async function parkPositionsPage(page) {
  const pageLock = require('../plus500/pageLock');
  if (!pageLock.tryAcquire('positions-nav')) {
    return { ok: false, reason: 'bridge_busy', heldBy: pageLock.status().holder };
  }
  try {
    await page.goto('https://app.plus500.com/open-positions', { timeout: 20000, waitUntil: 'domcontentloaded' });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'goto_failed', detail: String(e.message || e).slice(0, 100) };
  } finally {
    pageLock.release('positions-nav'); // no-op unless this cycle holds it
  }
}

async function pollOnce(userId, { killTier = 'off', navEveryMs = POSITION_NAV_MIN_INTERVAL_MS, parked = false } = {}) {
  if (inFlight) return { skipped: 'overlap' };
  // 2026-10-03 PARK (operator-scope): while parked the 1s strip stands down entirely — no reads, no
  // page lookups, no stats churn (it kept writing stats straight through today's closed-page window).
  if (parked) return { skipped: 'parked' };
  inFlight = true;
  try {
    const browser = require('../plus500/browser');
    const webtrader = require('../plus500/webtrader');
    const alive = await browser.chromeAlive();
    if (!alive) { cachedPage = null; return { skipped: 'chrome_off' }; }
    if (!cachedPage || cachedPage.isClosed()) {
      cachedPage = await browser.newPage();
    }
    const acc = await webtrader.readAccountStatus(cachedPage);
    // A strip was READ. Record that before judging the values, so a rejection streak is
    // distinguishable from a dead feed (see the `status` note at the top).
    if (acc && acc.equity != null) status.lastReadAt = new Date().toISOString();
    if (!acc || acc.equity == null) return { skipped: 'no_account_strip' };
    if (!isPlausibleSample(acc, lastAccepted)) {
      rejected += 1;
      status.rejectedStreak = rejected;
      status.lastRejectAt = new Date().toISOString();
      status.lastRejectedValue = acc;
      // First of a streak (as before) AND every REJECT_LOG_EVERY thereafter, so a sustained
      // streak is visible in the event log rather than a single row at its start.
      if (rejected === 1 || rejected % REJECT_LOG_EVERY === 0) {
        await store.logEvent(userId, 'telemetry', { source: 'account_sample_rejected', value: acc, prev: lastAccepted, streak: rejected }).catch(() => {});
      }
      return { skipped: 'implausible_sample', readAt: status.lastReadAt, rejectedStreak: rejected };
    }
    rejected = 0;
    // RECOVERY is worth a row: without it a reader cannot tell how long the flicker lasted.
    if (status.rejectedStreak > 0) {
      await store.logEvent(userId, 'telemetry', {
        source: 'account_sample_recovered', rejectedStreak: status.rejectedStreak,
        description: `venue strip returned ${status.rejectedStreak} unusable frame(s) before this one`,
      }).catch(() => {});
      status.rejectedStreak = 0;
    }
    // TRD-RSK-17: the same confirmation gate as the capture path — both call the ONE pure decider.
    const sw = switchDecision(acc, lastAccepted, pendingSwitch);
    pendingSwitch = sw.pending;
    if (sw.action === 'pending') return { skipped: 'switch_unconfirmed', readAt: status.lastReadAt, pendingReads: sw.pending.reads };
    if (sw.action === 'confirm') await rebaselineForSwitch(userId, acc, 'poller', { confirmedAfterReads: sw.confirmedAfterReads, confirmedAfterMs: sw.confirmedAfterMs });
    if (sw.action === 'flash') await logSwitchFlash(userId, sw, 'poller');
    lastAccepted = { equity: acc.equity, pnl: acc.pnl, at: new Date().toISOString() };
    live = { ...acc, readAt: new Date().toISOString() };
    status.acceptedAt = live.readAt;
    // 2026-09-11: persist the fine series (<=5s) so the equity curve survives
    // page reloads / new sessions — fire-and-forget, never blocks the 1s loop.
    if (Date.now() - lastTickAt >= 5000) {
      lastTickAt = Date.now();
      store.addEquityTick(userId, { equity: acc.equity, pnl: acc.pnl }).catch(() => {});
    }
    if (Date.now() - lastPruneAt >= 3600000) {
      lastPruneAt = Date.now();
      store.pruneEquityTicks(30).catch(() => {});
    }
    // TRD-11: positions at the SAME 1s cadence — evaluate-only read when the
    // tab shows /open-positions (the account strip lives there too).
    // 2026-09-11: clear on a DEFINITIVE empty read so the overlay can never serve a closed position
    // forever; a read from another page with no position DOM is inconclusive and keeps the snapshot.
    // TRD-106 (2026-09-19): what the read may BE USED FOR now travels in one decide-once object
    // (`readDisposition`) instead of a chain of `pos.items && pos.onPage` tests — see that function for
    // why the URL is a label and not a gate. Two changes here: (a) a throttled, kill-gated navigation is
    // spent when the DOM says the tab has no positions on it at all; (b) the tick write no longer asks
    // the URL for permission to use a row it just parsed.
    try {
      // Timed because "what does the 1s positions read cost the shared tab?" is the only question the
      // read-vs-write session-gate decision turns on (see posStats). Both reads count: the evaluate-only
      // one and the re-read after a park.
      const readT0 = Date.now();
      let pos = await webtrader.readPositionsLive(cachedPage);
      recordReadMs(posStats, Date.now() - readT0);
      if (!(pos && pos.sawDom)) {
        const lastKnown = positionTickPlan({ rows: (livePositions && livePositions.items) || [], nowMs: Date.now(), lastBySymbolMs: lastPosTickBySymbol, isOpen: sessionOpen });
        const dec = decidePositionsNav({ killTier, lastNavAt: lastPosNavAt, nowMs: Date.now(), everyMs: navEveryMs, nothingToWatch: lastKnown.nothingToWatch });
        if (dec.go) {
          lastPosNavAt = Date.now();
          const urlBefore = urlPath(cachedPage);
          const navT0 = Date.now();
          const park = await parkPositionsPage(cachedPage);
          const tookMs = Date.now() - navT0;
          if (park.ok) {
            posStats.navs += 1;
            const reT0 = Date.now();
            pos = await webtrader.readPositionsLive(cachedPage);
            recordReadMs(posStats, Date.now() - reT0);
          } else {
            posStats[`nav_${park.reason}`] = (posStats[`nav_${park.reason}`] || 0) + 1;
          }
          // BOTH OUTCOMES, and this is the row that was missing (2026-09-20). Until now only the
          // SKIP reasons had rows, so a park that ran and succeeded, and a park that ran and FAILED,
          // were both invisible — and an invisible failure is indistinguishable from "the fix does
          // nothing", which is exactly how TRD-106 was read when its cadence did not move.
          await store.logEvent(userId, 'telemetry', {
            source: 'position_nav', ok: !!park.ok, reason: park.ok ? 'parked' : park.reason,
            heldBy: park.heldBy || null, tookMs, urlBefore, urlAfter: urlPath(cachedPage),
            sawDomAfter: !!(pos && pos.sawDom), rowsAfter: pos && Array.isArray(pos.items) ? pos.items.length : null,
            killTier: killTier || 'off',
          }).catch(() => {});
        } else if (dec.reason !== lastPosNavLog) {
          lastPosNavLog = dec.reason;
          await store.logEvent(userId, 'telemetry', { source: 'position_nav_skipped', reason: dec.reason, killTier: killTier || 'off' }).catch(() => {});
        }
      }
      const disp = readDisposition(pos, { account: live });
      posStats.reads += 1;
      if (disp.onPage) posStats.onPage += 1;
      if (disp.sawDom) posStats.sawDom += 1;
      if (disp.rows) posStats.rows += 1;
      // Reads that actually carried rows. Together with `ticks` this is the dedupe's fingerprint: with a
      // frozen price the two should sit at roughly 60:1, which is the store's DEDUPE_WINDOW_MS doing its job
      // rather than the capture losing samples — the distinction that took a wrong answer twice today.
      if (disp.rows) posStats.rowsRead += 1;
      // A MODE change always logs; a URL-only change logs at most every 5s, because the tab oscillates
      // faster than the mode does and the shape is what matters, not every sample of it.
      const url = urlPath(cachedPage);
      const modeChanged = disp.mode !== lastPosMode;
      const urlChanged = url !== lastPosUrl;
      if (modeChanged || (urlChanged && Date.now() - lastUrlLogAt >= POSITION_URL_LOG_MIN_MS)) {
        if (modeChanged) posStats.modeTransitions += 1;
        if (urlChanged) { posStats.urlTransitions += 1; lastUrlLogAt = Date.now(); }
        lastPosMode = disp.mode;
        lastPosUrl = url;
        await store.logEvent(userId, 'telemetry', { source: 'position_read_mode', mode: disp.mode, url, onPage: disp.onPage, sawDom: disp.sawDom, rows: disp.rows, killTier: killTier || 'off' }).catch(() => {});
      }
      if (disp.setOverlay || disp.clearOverlay) {
        livePositions = disp.setOverlay ? { at: new Date().toISOString(), items: pos.items } : null;
        // TRD-106 (2026-09-19): THE DESK WAS THROWING AWAY ITS OWN SERIES.
        //
        // ⚠ SUPERSEDED THE SAME DAY, and corrected rather than deleted: this read does NOT land every
        // 1-6s. MEASURED in `PriceTicks` (source `position_poll`): **121 ticks in two hours, gaps
        // 60-70s** — one per mirror cycle. The "mean 2.4s, stalls to 6s" quoted below is the ACCOUNT
        // STRIP's cadence (`live.readAt`, TRD-70); it was never the positions read's, and putting one
        // number in the other's sentence is how the earlier draft of this fix overstated its own win.
        // The cause is `readDisposition`'s subject: a parsed row was being discarded by a URL substring
        // test. The paragraphs below still describe what the desk loses, at ~1/min rather than ~1/2s.
        //
        // This loop already reads every open position's price every ~1-6s (measured mean interval 2.4s,
        // stalls to 6s), and the value went into ONE MUTABLE COLUMN (`Trades.currentRate`), overwriting
        // the last one. Meanwhile the post-trade autopsy reconstructs MFE/MAE from PriceTicks captured on
        // the WAKE cadence — ~10 MINUTES apart — so any trade shorter than about half an hour had no
        // measurable path at all: measured, 15 of 44 closed agent trades, averaging 6.7 minutes held
        // against 182.2 for the measurable ones, concentrated in exactly the fast strategies whose edge is
        // thinnest relative to the round trip. Two of them could never be refused by the net-edge screen
        // (TRD-105) because their path could not be measured (TRD-106).
        //
        // WHY THIS AND NOT A FASTER CAPTURE: persisting this read costs NO new bridge call, NO navigation
        // and NO pageLock contention — the load is already being spent — and the number is Plus500's own,
        // so the venue-mixing trap of TRD-101 cannot arise (the autopsy reads ticks pinned to the trade's
        // venue, and a plus500 trade measured from yahoo is a different instrument, not better resolution).
        //
        // Fire-and-forget and rate-limited exactly like the equity tick above: this loop is the hot path
        // and must never be blocked by a write.
        //
        // ⚠ `name` IS the symbol here, not `symbol`: readPositionsLive returns
        // {name, direction, value, currentRate, orderRate}, and the rest of the desk already matches on
        // `name === symbol` (app.js liveOf does exactly that). Reading `p.symbol` would yield zero rows
        // with no error anywhere.
        //
        // ⚠ The venue must be the same string the trade carries, because the autopsy reads ticks with
        // `ticksSince(symbol, trade.venue)`. `Trades.venue` is 'plus500' for every desk position, and these
        // rows come off the Plus500 page, so the literal is correct by construction rather than by luck.
        if (disp.rows) {
          // TRD-106 (2026-09-20): the ONLY place that decides whether a row becomes a tick.
          //
          // ⚠ THE CALENDAR IS NOT A GATE HERE ANY MORE — this comment claimed it was until 2026-09-21, which
          // is the kind of stale prose that makes a reader trust a gate that does not exist. The
          // closed-session interval was REVERTED (see the constants block): `positionTickPlan` returns
          // `everyMs = POSITION_TICK_MIN_INTERVAL_MS` (10s) for every row that is due, whether the instrument
          // is open or shut — a shut symbol is exactly where a path is most needed, and the store's own
          // dedupe already bounds what an unchanged price can write. `isOpen` IS still passed and still used,
          // but only to count `live`/`shut` rows for telemetry and to feed `nothingToWatch`, which gates the
          // NAVIGATION (5-minute throttle) and never the tick.
          const plan = positionTickPlan({ rows: pos.items, nowMs: Date.now(), lastBySymbolMs: lastPosTickBySymbol, isOpen: sessionOpen });
          posStats.liveRows = (posStats.liveRows || 0) + plan.live;
          posStats.shutRows = (posStats.shutRows || 0) + plan.shut;
          if (plan.due.length) {
            const at = new Date();
            const ticks = plan.due
              .filter((d) => d.row && d.row.name && Number(d.row.currentRate) > 0)
              .map((d) => ({
                symbol: d.symbol, venue: 'plus500',
                bid: Number(d.row.currentRate), ask: Number(d.row.currentRate),
                source: 'position_poll', capturedAt: at,
              }));
            for (const d of plan.due) lastPosTickBySymbol.set(d.symbol, Date.now());
            if (ticks.length) {
              // ⚠ ATTEMPTS, NOT ROWS. This counter used to be called `ticks`, and reading it as "rows written"
              // produced a 6x error on 2026-09-20 (6 attempts a minute against 1 stored row): the store's
              // `addTicks` DEDUPES an unchanged bid+ask inside DEDUPE_WINDOW_MS, and it returns what it did.
              // Both halves are recorded now, because their RATIO is the dedupe made visible — the gate can
              // ask for 6 a minute and a frozen price will only ever store 1.
              posStats.tickAttempts += ticks.length;
              store.addTicks(userId, ticks)
                .then((r) => {
                  const res = r || {};
                  posStats.tickInserted += Number(res.inserted) || 0;
                  posStats.tickDeduped += Number(res.deduped) || 0;
                })
                .catch(() => {});
            }
          }
          // TRD-PNL-1 (2026-09-25): THE NET P/L PATH. Fire-and-forget and rate-limited exactly like the
          // tick write above — this loop is the hot path and must never be blocked by a write.
          const pnlPlan = positionPnlPlan({
            rows: pos.items, nowMs: Date.now(), lastByPositionMs: lastPosPnlByPosition,
            everyMs: POSITION_PNL_MIN_INTERVAL_MS,
          });
          for (const d of pnlPlan.due) {
            lastPosPnlByPosition.set(d.key, Date.now());
            pnlRangeObserve(posPnlRanges, d.key, d.row);
            fxPairObserve(fxPairs, d.key, d.row, d.pnl);
            posStats.pnlSamples += 1;
            store.logEvent(userId, 'position_pnl', {
              positionId: d.row.positionId != null ? d.row.positionId : null,
              symbol: d.row.name, direction: d.row.direction != null ? d.row.direction : null,
              size: d.row.size != null ? d.row.size : null, units: d.row.units != null ? d.row.units : null,
              pnl: d.pnl, currentRate: d.row.currentRate != null ? d.row.currentRate : null,
              openingRate: d.row.openingRate != null ? d.row.openingRate : null,
              venue: 'plus500', source: 'position_poll', net: true, at: new Date().toISOString(),
            }).catch(() => {});
          }
          // ★★ TRD-EXE-3 residual (2026-09-30) — THE READ-BACK, AND IT IS FREE HERE.
          //
          // These are the same venue rows the P/L sample above was just taken from, and each one carries the
          // venue's own SIZE alongside its price. `Trades.size` is the desk's number, computed at submit and
          // never re-read; this is the only place in the loop where the two can be compared without another
          // navigation, so the read-back rides the sample that is already happening.
          //
          // Deliberately NOT awaited and NOT allowed to throw: this loop is the poller's hot path, and a
          // record correction must never be able to stop the desk from reading its own positions.
          if (pnlPlan.due.length) {
            require('./sizeReconcile').reconcileAt(userId, pnlPlan.due.map((d) => d.row), { at: new Date().toISOString() })
              .then((r) => { posStats.sizesCorrected = (posStats.sizesCorrected || 0) + (Number(r && r.corrected) || 0); })
              .catch(() => {});
          }
          // The other half, and the one `position_poll` structurally cannot see: it reads OPEN positions
          // only, so a position that stops being reported has closed. Without this the terminal sample of
          // every path is lost and the range would stop one poll short of the real exit.
          for (const gone of pnlPlan.voided) {
            const r = posPnlRanges.get(gone);
            posPnlRanges.delete(gone);
            lastPosPnlByPosition.delete(gone);
            // The FX pair is NOT deleted on close — a completed position is still a valid first/last
            // measurement, and it is often the only one with a large enough move to clear the gate. It is
            // timestamped instead and pruned by age in `getFxRate`, so it contributes while it is still
            // evidence about the CURRENT rate and drops out when it is not.
            const fx = fxPairs.get(gone);
            if (fx) fx.closedAt = Date.now();
            if (!r) continue;
            posStats.pnlRanges += 1;
            store.logEvent(userId, 'pnl_range', {
              positionId: r.positionId, symbol: r.symbol, direction: r.direction,
              first: r.first, last: r.last, min: r.min, max: r.max, samples: r.n,
              venue: 'plus500', source: 'position_poll', net: true,
              note: 'net P/L range observed while the position was open, from the venue own reported NetPL; ' +
                'samples is the count of real reads behind min/max, so a thin range is visible as thin',
              at: new Date().toISOString(),
            }).catch(() => {});
          }
        }
      }
    } catch { /* positions optional on non-positions pages */ }
    const changed = !last
      || Math.abs((acc.available ?? 0) - (last.available ?? 0)) > 0.005
      || Math.abs((acc.equity ?? 0) - (last.equity ?? 0)) > 0.005
      || Math.abs((acc.pnl ?? 0) - (last.pnl ?? 0)) > 0.005
      || Math.abs((acc.margin ?? 0) - (last.margin ?? 0)) > 0.005;
    if (changed && Date.now() - lastWriteAt >= 30000) {
      // ★ P1b: THE SAME TWO FIELDS AS `acceptSample`, AND THAT IS NOT DUPLICATION FOR ITS OWN SAKE — these are
      // two DIFFERENT writers of the same event kind (this is the loop's 30s write; `acceptSample` is the capture
      // path's). ⚠ The first version of this change patched only `acceptSample`, and the live check then showed a
      // fresh account event with the currency but NO rate — which is how the second writer was found. A series
      // that carries the rate on some samples and not others is worse than one that never does, because a
      // consumer cannot tell a missing rate from an unrecorded one.
      const fx = getFxRate();
      await store.logEvent(userId, 'account', {
        ...acc, at: new Date().toISOString(), ...(accountCurrency ? { currency: accountCurrency } : {}),
        ...(fx && fx.ok
          ? { fxSgd: fx.rate, fxN: fx.n, fxGate: fx.gate, fxSpreadPct: fx.spreadPct }
          : { fxSgd: null, fxWhy: (fx && fx.reason) || 'not_derived' }),
      });
      last = { ...acc };
      lastWriteAt = Date.now();
      return { persisted: acc };
    }
    return { live: acc };
  } catch (e) {
    cachedPage = null;
    return { skipped: String(e.message || e).slice(0, 80) };
  } finally {
    inFlight = false;
  }
}

// How long to wait so the NEXT cycle STARTS `periodMs` after the previous one started.
// Pure, so the fixed-rate arithmetic is pinned rather than inferred from a live loop: the whole
// point of the fix is that the period is measured from the start of the cycle, not appended to it.
// Never negative (a cycle slower than its period simply starts again immediately) and never
// shorter than zero, so this cannot spin.
function nextDelayMs(periodMs, workMs) {
  const p = Number(periodMs);
  const w = Number(workMs);
  if (!Number.isFinite(p)) return 0;
  if (!Number.isFinite(w)) return Math.max(0, p);
  return Math.max(0, p - w);
}

function start(userId = 1) {
  if (running) return;
  running = true;
  // Cached settings: the loop used to hit the DB for getSettings() EVERY iteration, which at a
  // 1s cadence is a query per second for a value that changes almost never. Re-reading it only
  // when the cadence or the enable flag is needed keeps the poll budget on the page reads.
  let cfg = {};
  let cfgAt = 0;
  let killTier = 'off'; // TRD-106: the click-through's kill gate, from the same cached settings read
  let parked = false;   // 2026-10-03 PARK: rides the same cached settings read (no extra query)
  // Per-minute extremes since the last stats row. `workMsMax` is the point: a 44.5s cycle was measured
  // on 2026-09-19 and the row that caught it happened to be emitted at that instant — reporting the
  // minute's WORST cycle makes catching the next one a certainty rather than a coincidence.
  let workMsMax = 0;
  let slowCycles = 0;
  const CFG_TTL_MS = 10000;
  (async function loop() {
    while (running) {
      // FIXED-RATE, not sleep(1s)-plus-work (TRD-70, 2026-09-14). The old shape was
      //     await pollOnce(); await sleep(secs * 1000);
      // so the real period was `1s + the duration of two CDP round-trips`
      // (readAccountStatus + readPositionsLive). Measured over 20s: `live.readAt` advanced only
      // 9 times, mean interval 2.4s, stalls to ~6s — while the config said pollSeconds = 1 and
      // the panel was labelled a 1s live strip. The cadence is now measured from the START of
      // the cycle, so a fast read genuinely lands at ~1s and a slow one simply shortens the
      // sleep. Nothing is scheduled tighter than `secs`, so this cannot add load.
      const t0 = Date.now();
      if (t0 - cfgAt > CFG_TTL_MS) {
        const settings = await store.getSettings(userId).catch(() => null);
        cfg = (settings && settings.account) || {};
        // TRD-PNL-4 (#1484): the declared unit, from the SAME read the cadence comes from.
        accountCurrency = currencyOf(settings);
        // TRD-106: the click-through is gated on the kill tier, so the tier must be read somewhere — and
        // it must NOT be read per iteration (the query-per-second this cache exists to avoid), nor from a
        // second source, or the two would drift and one of them would be wrong at the worst moment.
        killTier = (settings && settings.kill && settings.kill.tier) || 'off';
        parked = !!(settings && settings.bridge && settings.bridge.parked);
        cfgAt = Date.now();
      }
      if (cfg.enabled !== false) {
        try { await pollOnce(userId, { killTier, parked, navEveryMs: navEveryMsFor(cfg) }); } catch { /* transient */ }
      }
      const secs = Math.max(1, Number(cfg.pollSeconds) || 1);
      const periodMs = secs * 1000;
      const workMs = Date.now() - t0;
      const delayMs = nextDelayMs(periodMs, workMs);
      if (workMs > workMsMax) workMsMax = workMs;
      if (workMs > periodMs) slowCycles += 1;
      // ★ ONE ROW A MINUTE, and it reports the minute's WORST cycle plus what the reads cost.
      //
      // The first version of this logged ONLY when a single cycle beat its period — which is exactly the
      // shape that produces no data when you need it: on a quiet weekend every cycle is fast, so the read
      // cost stayed unmeasured, and a slow cycle was only caught if the sample happened to land on it.
      // Both of the questions this exists to answer ("is our own loop the cadence?" and "what does the 1s
      // positions read cost the shared tab?") are answerable from minute-shaped aggregates, so aggregate.
      if (Date.now() - lastStatsLogAt >= 60000) {
        lastStatsLogAt = Date.now();
        await store.logEvent(userId, 'telemetry', {
          source: 'account_poll_stats',
          workMsMax, slowCycles, periodMs, delayMs, overran: slowCycles > 0,
          reads: posStats.reads, navs: posStats.navs,
          readMsAvg: posStats.reads ? Math.round(posStats.readMsSum / posStats.reads) : null,
          readMsMax: posStats.readMsMax, readMsOver100: posStats.readMsOver100,
          rowsRead: posStats.rowsRead, tickAttempts: posStats.tickAttempts,
          tickInserted: posStats.tickInserted, tickDeduped: posStats.tickDeduped,
          mode: lastPosMode, url: lastPosUrl,
        }).catch(() => {});
        workMsMax = 0;
        slowCycles = 0;
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  })();
  console.log('[trading] account poller started (live mirror of the Plus500 demo strip)');
}

function stop() { running = false; }

module.exports = {
  start, stop, pollOnce, getLive, getLivePositions, getStatus, nextDelayMs, isPlausibleSample, isAccountSwitch,
  switchDecision, SWITCH_CONFIRM_READS,
  acceptSample, readDisposition, stripSaysFlat, positionTickPlan, sessionOpen, decidePositionsNav, navEveryMsFor,
  positionPnlPlan, positionKey, pnlRangeObserve, fxPairObserve, getFxRate, FX_PAIR_MAX_AGE_MS,
  parkPositionsPage, urlPath, recordReadMs, POSITION_NAV_MIN_INTERVAL_MS,
};
