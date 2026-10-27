// trading/agent/wakePipeline.js — TRD-12 Phase 0: the wake orchestration,
// extracted from waker.js with per-step instrumentation. Scheduling, alert
// checks and the digest stay in waker.js; this module runs ONE wake.
// Every step logs {name, startedAt, ms, skipped?, error?} into the live
// registry so GET /api/trading/pipeline can mirror the desk in real time.
'use strict';

const store = require('../store');
const quant = require('./quant');
const aggregator = require('./aggregator');
const { sessionState, aggregateSession } = require('./sessions');

const TICK_SLA_MS = 15 * 60000; // quant staleness SLA (shared with quant.js consumers)

const live = {
  wake: null,          // in-flight or most-recent wake record
  lastResult: null,    // last finished wake result (was waker.state.lastResult)
  lastWakeAt: null,    // was waker.state.lastWakeAt
  // TRD-51 fix 3 (2026-09-14): the dead-man switch needs a clock a FAILING wake
  // cannot reset. `lastWakeAt` above is the last ATTEMPT — it was the only clock,
  // and finishWake() runs in a `finally`, so a wake that threw still advanced it.
  // Measured 2026-09-14: the desk failed 8 wakes in a row (09:37:45 -> 13:05:38)
  // and the staleness clock read ~10 minutes the whole time, so the watchdog only
  // paged because one pair of consecutive ATTEMPTS happened to exceed the
  // threshold. `lastSuccessAt` is the last wake that completed WITHOUT throwing;
  // `startedAt` is the first attempt, so that a desk which has never completed a
  // wake is still measurable rather than reading "no_wake_yet" forever.
  lastSuccessAt: null,
  startedAt: null,
  queued: null,        // a wake request that arrived while another was running
  seq: 0,
  // TRD-71: the last logged live-eligibility ledger signature. The gate observes on every wake, but
  // the FINDING (which pairs have a lab case) only matters when it moves, so the desk logs the
  // ledger once per change rather than once per wake.
  labGateSig: null,
};
// Bridge conflict registry: which script currently holds the shared Plus500
// page, plus a short history of overlapping claims (wasted-time detector).
const bridge = { holder: null, since: null, overlaps: [], lastClaimAt: null };

function beginWake(userId, trigger) {
  live.seq += 1;
  if (!live.startedAt) live.startedAt = new Date().toISOString();
  live.wake = { wakeId: live.seq, userId, trigger, at: new Date().toISOString(), steps: [], done: false };
}

// The step that actually threw, so a failed wake can name it. Steps record `error`
// inside step()'s catch and then rethrow, so the culprit is the LAST step carrying an
// error — not necessarily the last step recorded, because the queue can still be
// appending when the error unwinds through it.
function failingStep(wake = live.wake) {
  const steps = wake && Array.isArray(wake.steps) ? wake.steps : [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i] && steps[i].error) return steps[i];
  }
  return null;
}

function finishWake(result, { failed = false } = {}) {
  if (live.wake) {
    live.wake.done = true;
    live.wake.doneAt = new Date().toISOString();
    live.wake.failed = !!failed;
    live.wake.summary = result && typeof result === 'object'
      ? { action: result.action, reason: result.reason, skipped: result.skipped, durationMs: result.durationMs, mode: result.mode }
      : null;
  }
  live.lastResult = result && typeof result === 'object' ? { at: new Date().toISOString(), ...result } : null;
  // Last ATTEMPT — every wake, successful or not. Kept because the pipeline mirror and
  // /status read it as "when did we last try", which is a different question from
  // "when did we last work". The watchdog must NOT use it (TRD-51 fix 3).
  live.lastWakeAt = new Date();
  // Last SUCCESS — only a wake that completed without throwing. This is the clock the
  // dead-man switch watches: a failure must not silence the alarm that exists for it.
  if (!failed) live.lastSuccessAt = live.lastWakeAt;
  // TRD-12: a wake that arrived while another was running is QUEUED, never
  // superseded — run it the moment this one finishes.
  const q = live.queued;
  live.queued = null;
  if (q && q.userId) {
    setTimeout(() => {
      run(q.userId, q.trigger, { manual: q.manual, alert: q.alert })
        .catch((e) => require('./log').error(q.userId, 'queued_wake', e));
    }, 500);
  }
}

// EVERY STEP GETS A DEADLINE (2026-09-15).
//
// A step that never settles hangs the wake, and a wake that never settles STRANDS THE SCHEDULER: the
// loop's re-arm is only reachable after `await runWake(...)` resolves. Measured twice on the live desk
// in one afternoon: `capture` held the shared bridge while the page map returned `hrefs: 0`, wrote no
// tick and recorded no wake event, and the desk then stopped waking entirely (26 minutes at 10:29, and
// again at 10:52) while every other loop and /healthz kept reporting healthy.
//
// A deadline turns an invisible hang into a FAILED wake with a NAMED step. The hung promise cannot be
// cancelled, so it is abandoned rather than killed - which is exactly why the failure is reported
// through the step record: the operator needs to know which step to go and look at.
//
// 300s = HALF the default 10-minute wake interval, and that is the DERIVATION rather than a taste: a step
// may not consume more than half an interval, because beyond that the desk cannot hold its cadence even
// when every step SUCCEEDS. The headroom is not theoretical - `capture` was measured at 109,663ms on a
// wake that completed normally (2026-09-15 10:52), which is 100x every other step and sat only 10s under
// a 120s bound. A deadline tighter than the slowest legitimate step converts normal operation into FAILED
// wakes, which is a worse failure than the one being fixed.
// Per-step tuning is available through `opts.timeoutMs`, and the value used is recorded on the step so it
// can never be a hidden default.
const DEFAULT_STEP_TIMEOUT_MS = 5 * 60000;

// The disaster-floor step's OWN bound (2026-09-15). Derived, not chosen:
//   - above the 45s `page.goto` timeout this desk already tolerates, so a slow-but-legitimate bridge read
//     is not converted into a timeout;
//   - far under the 300s default, because the floor is ONE account read and nothing in the wake should
//     wait half a cadence for a monitor;
//   - and because the wake CONTINUES after this step times out, a false positive costs 90s of cadence
//     rather than a lost wake - which is what makes a tight bound the cheap side of the trade.
const FLOOR_STEP_TIMEOUT_MS = 90000;

// The hard tier's auto-close sweep's OWN bound (F19, 2026-09-18). Derived, not chosen:
//   - the sweep's close IS a ticket, and the ticket path waits up to 240s for the shared page before it
//     even starts working, so a bound meaningfully under the step default would convert a slow-but-
//     legitimate close into an abandoned one — the same mistake as a deadline tighter than the slowest
//     legitimate step, which the default's own note records;
//   - it IS the step default (300s = half a cadence), and that is the point: this step runs only while the
//     tier is hard, where the wake is abandoned immediately afterwards anyway and no entry is allowed. A
//     sweep that consumes the whole budget costs one delayed heartbeat in the one state where a delayed
//     heartbeat costs nothing — while a sweep that is cut short leaves the book open.
const AUTOCLOSE_STEP_TIMEOUT_MS = DEFAULT_STEP_TIMEOUT_MS;

function withDeadline(promise, ms, name) {
  if (!(Number(ms) > 0)) return promise;
  let timer = null;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`step '${name}' exceeded its ${ms}ms deadline`);
      // TAGGED, never string-matched: `step()` has to tell a DEADLINE from a step that legitimately threw
      // (see the `optional` note in its catch), and matching on the wording breaks the day it is reworded.
      e.deadline = true;
      e.step = name;
      reject(e);
    }, ms);
    // A deadline must never be the reason the process stays alive.
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  // `race` attaches a handler to BOTH promises, so abandoning the original when the deadline fires
  // cannot surface later as an unhandled rejection.
  return Promise.race([promise, expired]).finally(() => { if (timer) clearTimeout(timer); });
}

// Run one step inside the current wake record. `fn` may be async; the step
// captures duration, skip reasons and errors WITHOUT changing behavior.
async function step(name, fn, opts = {}) {
  const w = live.wake;
  const rec = { name, startedAt: new Date().toISOString() };
  if (w) w.steps.push(rec);
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_STEP_TIMEOUT_MS;
  try {
    const r = fn ? await withDeadline(fn(), timeoutMs, name) : null;
    rec.ms = Date.now() - t0;
    if (opts.skipped) rec.skipped = opts.skipped;
    if (r && r.skipped) rec.skipped = r.skipped;
    return r;
  } catch (e) {
    rec.ms = Date.now() - t0;
    rec.timeoutMs = timeoutMs;
    rec.error = String(e.message || e).slice(0, 160);
    // ★ AN OPTIONAL STEP'S DEADLINE DEGRADES INSTEAD OF KILLING THE WAKE (owner decision, 2026-09-15).
    //
    // Measured live: the `floor` step hit this deadline twice in one hour (18:53, 19:09) and each time the
    // ENTIRE wake died - no bars, no quant, no deliberation, no execution. But the SAME unreadable equity on
    // the ERROR path kills nothing: `monitorFloor` catches its own read failure and returns
    // `{skipped:true, reason:'equity_unreadable'}`, and the wake carries on. One condition, two opposite
    // outcomes, decided only by whether the bridge failed fast or slow. That inconsistency is the defect;
    // the fail-open choice matches what the error path already did, which is the owner's call to make and
    // not this function's.
    //
    // `optional` forgives a DEADLINE ONLY. A step that genuinely throws still fails the wake, so this can
    // never drift into being a blanket catch that hides real breakage (pinned by a test).
    if (opts.optional && e && e.deadline === true) {
      rec.timedOut = true;
      return { skipped: 'timeout', timeoutMs, error: rec.error };
    }
    throw e;
  }
}

// The verdict of an auto-close sweep, in the one word the pipeline mirror can render beside the step.
// A bare `autoclose 12ms` says "something ran" and nothing else — which is the ambiguity F32 is about,
// one level down. `auto_close_off` and `closed 1/1` are the two facts an operator actually wants here.
function autoCloseVerdict(r) {
  if (!r || !r.attempted) return { ...r, skipped: (r && r.reason) || 'not_applicable' };
  if (r.error) return { ...r, skipped: 'error' };
  return { ...r, skipped: `closed ${r.closed}/${r.attempted}` };
}

// Scripts that navigate the shared bridge page claim it; overlapping claims
// during a wake = a real conflict the user asked to surface.
function bridgeUse(script, active) {
  const now = Date.now();
  if (active) {
    if (bridge.holder && bridge.holder !== script) {
      bridge.overlaps.push({ with: bridge.holder, script, at: new Date().toISOString() });
      if (bridge.overlaps.length > 20) bridge.overlaps.shift();
    }
    bridge.holder = script;
    bridge.since = new Date().toISOString();
    bridge.lastClaimAt = now;
  } else if (bridge.holder === script) {
    bridge.holder = null;
    bridge.since = null;
  }
}

function pipelineStatus() {
  const w = live.wake;
  return {
    running: !!(w && !w.done),
    inFlight: w && !w.done ? { wakeId: w.wakeId, trigger: w.trigger, at: w.at, steps: w.steps } : null,
    last: w ? { wakeId: w.wakeId, trigger: w.trigger, at: w.at, doneAt: w.doneAt, done: w.done, failed: !!w.failed, failedStep: (failingStep(w) || {}).name || null, steps: w.steps, summary: w.summary } : null,
    bridge: { holder: bridge.holder, since: bridge.since, overlaps: bridge.overlaps.slice(-5) },
    lastResult: live.lastResult ? { at: live.lastResult.at, action: live.lastResult.action, reason: live.lastResult.reason, durationMs: live.lastResult.durationMs } : null,
    lastWakeAt: live.lastWakeAt ? live.lastWakeAt.toISOString() : null,
    // TRD-51 fix 3: the clock a failing wake cannot reset, plus whether this desk has
    // EVER completed a wake since the process started.
    lastSuccessAt: live.lastSuccessAt ? live.lastSuccessAt.toISOString() : null,
    startedAt: live.startedAt || null,
    neverSucceeded: !live.lastSuccessAt,
  };
}

// ---------------------------------------------------------------------------
// ONE WAKE. The body is the previous waker.runWake, unchanged in behavior,
// wrapped in instrumented steps.
// ---------------------------------------------------------------------------
async function run(userId, trigger = 'manual', { manual = false, alert = null, userInput = null } = {}) {
  if (live.wake && !live.wake.done) {
    // Never let one wake supersede another: a manual wake requested while a
    // scheduled/alert wake is running is queued and runs right after it; the
    // scheduler's heartbeat keeps an overdue deadline until any in-flight
    // wake completes, so scheduled wakes survive manual ones too.
    live.queued = { userId, trigger, manual, alert, at: new Date().toISOString() };
    return { skipped: 'wake_in_progress', queued: true, current: live.wake.trigger };
  }
  beginWake(userId, trigger);
  const started = Date.now();
  // DESIGN BIBLE v1: one correlationId per logical operation (the wake);
  // every wake event + error inside carries it, with actor attribution.
  const corr = require('./log').corrId('wake');
  const wakeActor = trigger === 'manual' ? `human:${userId}` : 'scheduler';
  const log = require('./log');

  const body = async () => {
    const settings = await store.getSettings(userId);
    const now = new Date();

    const paperMode = !!(settings.paper && settings.paper.enabled);

    // STEP: TRD-26 fresh-data gate (2026-09-11) — market-INDEPENDENT lab
    // work: runs on EVERY wake (including closed-market skips) so an
    // intermittent machine catches up on the first wake after each boot.
    // Self-throttled 6h inside the module; fire-and-forget so trading
    // decisions never wait on lab backtests. Evaluate-on-run: no deadlines —
    // the windows are earliest dates, and lateness only widens the fresh W4.
    await step('trd26', async () => {
      const lastGate = await store.latestEvent(userId, 'trd26_check');
      const gateAgeMin = lastGate ? (Date.now() - new Date(lastGate.createdAt).getTime()) / 60000 : Infinity;
      if (gateAgeMin <= 360) return { skipped: 'throttled' };
      require('./trd26').checkAndFire(userId, settings)
        .catch((e) => log.error(userId, 'trd26_gate', e, { correlationId: corr }));
      return { queued: true };
    });

    // STEP: the HARD tier's auto-close — BEFORE the guard that makes it unreachable (F19, 2026-09-18).
    //
    // `killswitch.setTier` only FLAGS `autoClose`; the only thing that ever closed the book was a block
    // inside the `floor` step below, and the `session` step returns before the floor is ever reached when
    // the tier is hard. So the flag's only reader was unreachable in exactly the state that sets it: the
    // dashboard's own dialog promised "closes 1 open position(s) at market" and nothing was closed
    // (verified 2026-09-17 — tier hard, autoClose true, the position still open, no event of any kind).
    //
    // The step is BOUNDED and OPTIONAL for the same reason `floor` is: a close is the most bridge-dependent
    // thing this desk does, and a wake that cannot close the book must still go on to record its own
    // `kill_switch_hard` skip rather than fail. The gate on `settings` only decides whether to TRY — the
    // sweep re-reads the tier itself, so a stale snapshot can cost one attempt and can never skip the
    // promise: the mid-wake floor-breach path below calls the same sweep, and so does `POST /kill`.
    //
    // Deliberately NOT gated on `paperMode`: the sim desk's dialog counts paper positions and promises to
    // close them, and its closes are free.
    if (settings.kill && settings.kill.tier === 'hard') {
      const sweep = await step('autoclose', async () => {
        const r = await require('./executor').autoCloseSweep(userId, { caller: `wake:${trigger}`, correlationId: corr, actor: 'system:kill' });
        return autoCloseVerdict(r);
      }, { optional: true, timeoutMs: AUTOCLOSE_STEP_TIMEOUT_MS });
      if (sweep && sweep.skipped === 'timeout') {
        // The sweep is ABANDONED, not cancelled — it may still close the book, and it traces its own
        // outcome when it does. This row is the other half of the fact: the WAKE could not wait for it.
        await store.logEvent(userId, 'telemetry', { source: 'autoclose_sweep_unbounded', reason: 'timeout', timeoutMs: AUTOCLOSE_STEP_TIMEOUT_MS, correlationId: corr });
      }
    }

    // STEP: session guard
    const sessionGuard = await step('session', async () => {
      if (!paperMode && settings.kill && settings.kill.tier === 'hard') {
        await log.write(userId, 'wake', { trigger, skipped: 'kill_switch_hard' }, { actor: wakeActor, correlationId: corr });
        return { skipped: 'kill_switch_hard' };
      }
      // A8: MarketSessionGuard — aggregate over the watchlist (+ alert symbols).
      const symbols = (settings.watchlist?.symbols || []).slice();
      if (alert && !symbols.some((s) => s.symbol === alert.symbol && s.venue === alert.venue)) {
        symbols.push({ symbol: alert.symbol, venue: alert.venue });
      }
      let session = { state: 'open', detail: 'no watchlist symbols' };
      if (symbols.length) {
        const states = await Promise.all(symbols.map((s) => sessionState(userId, s.symbol, s.venue, now)));
        // The aggregate is a tested function rather than four inline lines: it used to collapse twelve
        // per-symbol verdicts into the bare string "all venues closed", discarding the reason — which is
        // how the desk spent a trading day recording that the market was shut while it was open.
        session = aggregateSession(states, symbols);
      }
      if (session.state === 'closed' && settings.wake?.marketHoursOnly) {
        await log.write(userId, 'wake', { trigger, skipped: 'market_closed', detail: session.detail }, { actor: wakeActor, correlationId: corr });
        return { skipped: 'market_closed', session };
      }
      return { session };
    });
    if (sessionGuard.skipped) return sessionGuard;

    const session = sessionGuard.session;
    const openTrades = await store.getOpenTrades(userId);
    const closedTrades = await store.getClosedTrades(userId, 3);
    const digest = await store.latestEvent(userId, 'digest');
    // IMPLIED GOAL: the meta regime is fetched BEFORE quant — the
    // mean-reversion voter is regime-gated (ranges only).
    const metaEvent = await store.latestEvent(userId, 'meta');

    // STEP: capture (TRD-2 frontend prices on each wake). TRD-12 Phase 1:
    // venue access goes through the connector abstraction. Reusable so the
    // stale-data guard can re-run it before the chairs deliberate.
    const doCapture = async () => {
      // IMPLIED GOAL #4: micro-wakes skip the slow bridge capture — they
      // exist to act on stop/TP proximity FAST.
      if (trigger === 'micro') return { skipped: 'micro_wake' };
      if (settings.bridge?.captureOnWake === false) return { skipped: 'capture_on_wake_off' };
      if (!(settings.watchlist?.symbols || []).length) return { skipped: 'empty_watchlist' };
      try {
        const cap = await require('../connector').getConnector(settings).getQuotes(userId, settings);
        if (cap.captured) await store.logEvent(userId, 'telemetry', { source: 'plus500_frontend', captured: cap.captured, symbols: cap.symbols, missing: cap.missing || [] });
        else await store.logEvent(userId, 'telemetry', { source: 'plus500_frontend', captured: 0, reason: cap.reason });
        return cap;
      } catch (e) {
        await log.error(userId, 'capture_on_wake', e, { correlationId: corr });
        throw e;
      }
    };
    await step('capture', doCapture);

    // STEP: disaster floor (demo path only).
    // ★ OPTIONAL + BOUNDED (owner decision, 2026-09-15). This is the desk's ONLY automatic disaster-floor
    // check (the other caller of `monitorFloor` is a manual route), and it is also the most bridge-dependent
    // step in the wake: it takes a FRESH account read, so a page that is navigating or wedged makes it wait.
    const floorRes = await step('floor', async () => {
      if (paperMode || settings.kill?.disasterFloorPct == null) return { skipped: paperMode ? 'paper_mode' : 'no_floor' };
      try {
        const mon = await require('./executor').monitorFloor(userId, settings);
        // F19: ONE sweep, shared with the guard above and with `POST /kill`. It re-reads the kill state
        // rather than reading the caller's snapshot, and that is load-bearing here: `monitorFloor` has
        // just WRITTEN the hard tier, while `settings` (fetched at the top of this wake) still carries the
        // pre-breach value — so the old `settings.kill?.autoClose` was tested against the state from
        // BEFORE the breach that set it, and a breach on a desk that was `off` skipped its own sweep.
        if (mon.tier === 'hard') {
          await require('./executor').autoCloseSweep(userId, {
            caller: mon.reason === 'floor_breached' ? 'floor_step' : 'floor_step:already_hard',
            correlationId: corr,
            actor: 'system:floor',
          });
        }
        if (mon.reason === 'floor_breached') {
          await store.logEvent(userId, 'telemetry', { source: 'disaster_floor', equity: mon.equity });
        }
        return mon;
      } catch (e) {
        await log.error(userId, 'monitor_floor', e, { correlationId: corr });
        throw e;
      }
    }, { optional: true, timeoutMs: FLOOR_STEP_TIMEOUT_MS });
    if (floorRes && floorRes.skipped === 'timeout') {
      // Never silent: a floor that could not be read is a fact about the desk, not a private hiccup. The
      // wake continues (the owner's decision above), so this event is the only trace it leaves.
      await store.logEvent(userId, 'telemetry', { source: 'disaster_floor_unread', reason: 'timeout', timeoutMs: FLOOR_STEP_TIMEOUT_MS, correlationId: corr });
    }

    // ★ TRD-BAR-1: hoisted so the failure rides the wake event even though the step no longer throws. Declared
    // here rather than inside the step because the payload is written at the END of the wake, long after the step
    // has returned.
    let barsError = null;

    // STEP: bars + tick retention (throttled: every 15 min max).
    //
    // ★★ TRD-BAR-1 (2026-09-27): HOUSEKEEPING DOES NOT GET TO ABORT A TRADING WAKE.
    //
    // MEASURED, and the measurement is what changed the diagnosis. This step accounted for **51 of the 67 failed
    // wakes** in 14 days, and the obvious reading — "the bars work is too slow" — is wrong: run through the desk's
    // own endpoint with the venue closed, the whole step takes **197 ms**, the hot tables are all indexed
    // (`TradingEvents(userId, createdAt)`, `EquityTicks(userId, at)`, `PriceBars`' unique key matches the MERGE's
    // ON clause exactly), and a census of the hottest reads returns in **44 ms**. The 60 s error is
    // `shared/db.js`'s deliberately-set `requestTimeout` firing, and that file says of itself: "it is HEADROOM, not
    // a cure... a larger timeout converts 'aborted request' into 'slow request'". So this step is not the disease.
    //
    // ⚠ WHY IT IS NEVERTHELESS WHERE 51 OF 67 DIE: it runs on EVERY wake (the throttle only skips the work, not the
    // step) while the other steps run less often — so it is the most FREQUENT sampler of a database that stalls,
    // and it is the step most likely to be holding a request when a stall lands.
    //
    // ⚠⚠ AND ITS FAILURE WAS FATAL, WHICH IS THE ACTUAL BUG. A failed wake evaluates NO EXITS and NO POSITION
    // REVIEW — the desk stops managing open positions because a tick-prune did not finish. That asymmetry is the
    // same one the `optional` ruling above was made for on 2026-09-15 ("the ENTIRE wake died - no bars, no quant,
    // no deliberation, no execution"), and the same reasoning the `autoclose` budget carries: a wake that dies
    // leaves the book unattended. `optional` cannot be used here because it forgives a DEADLINE only, and this
    // failure is a thrown SQL timeout — so the tolerance is local to this step and named, rather than widening
    // `optional` into the blanket catch its own comment forbids.
    //
    // A stale-bars condition is already guarded elsewhere: `quant`'s staleness SLA refuses new ENTRIES on old bars.
    // So a failed prune degrades into "no new entries, but the book is still managed", which is strictly safer than
    // "no wake at all".
    await step('bars', async () => {
      try {
        const lastBars = await store.latestEvent(userId, 'bars_built');
        const ageMin = lastBars ? (Date.now() - new Date(lastBars.createdAt).getTime()) / 60000 : Infinity;
        if (ageMin > 15) {
          const built = await require('./bars').buildAll(userId);
          if (built.ticksDeleted) {
            await store.logEvent(userId, 'telemetry', { source: 'tick_retention', deleted: built.ticksDeleted });
          }
          return built;
        }
        return { skipped: 'within_15m' };
      } catch (e) {
        // Logged at the same place and with the same kind as before, so nothing that reads `bars_build` changes.
        await log.error(userId, 'bars_build', e, { correlationId: corr });
        // ⚠ `skipped` is what the step mirror renders — returning it keeps the failure VISIBLE on the wake instead
        // of letting a swallowed error make the step look like it succeeded, which is the defect class this
        // codebase keeps closing. `barsError` carries it onto the wake event as well.
        barsError = {
          message: String(e.message || e).slice(0, 160),
          code: e.code || null,
          at: new Date().toISOString(),
          note: 'bars/tick retention failed — the wake continued, so exits and position review still ran.',
        };
        return { skipped: 'bars_failed', error: barsError.message };
      }
    });

    // STEP: provider snapshot (Binance/OKX REST, 60s gate inside; forceable).
    const doProviders = async (force = false) => {
      try {
        const snap = await require('./providers').snapshotAll(userId, settings, { force });
        if (snap.ticks) await store.logEvent(userId, 'telemetry', { source: 'provider_snapshot', ticks: snap.ticks, forced: !!force });
        return snap;
      } catch (e) {
        await log.error(userId, 'provider_snapshot', e, { correlationId: corr });
        throw e;
      }
    };
    await step('providers', () => doProviders(false));

    // STEP: quant
    // ★ THE META REGIME'S PROVENANCE TRAVELS WITH IT. `meta.evaluateMeta` derives ONE desk-global regime
    // from the FIRST watchlist symbol that happens to have bars, so the regime gating a symbol is usually
    // NOT that symbol's own — and the verdict already records which symbol and which ADX produced it.
    // Passing only `regime` threw that away, which is how the dashboard came to print
    // "regime trend, ADX 16.83" on Silver: a global judgement attributed to a local measurement.
    const metaPayload = (metaEvent && metaEvent.payload) || null;
    const regimeOpts = metaPayload
      ? {
        regime: metaPayload.regime || null,
        regimeAdx: metaPayload.adx14 == null ? null : metaPayload.adx14,
        regimeSymbol: metaPayload.symbol || null,
      }
      : { regime: null };
    let quantResult = await step('quant', () => quant.evaluate(userId, settings, openTrades, regimeOpts));

    // TRD-12 follow-up (owner): if any tradable series is STALE, refresh the
    // data BEFORE the chairs deliberate — one extra capture + a forced
    // provider snapshot + a re-quant. The chairs never see stale prices
    // unless the refresh itself failed.
    const staleAny = (qr) => (qr.symbols || []).some((s) => (s.status === 'ok' || s.status === 'stale')
      && s.latest && Date.now() - new Date(s.latest.capturedAt).getTime() > quant.BAR_FRESH_MS);
    if (staleAny(quantResult)) {
      await store.logEvent(userId, 'telemetry', { source: 'stale_refresh', reason: 'pre-deliberation auto-refresh', at: new Date().toISOString() });
      try { await step('capture', doCapture); } catch { /* refresh best-effort */ }
      try { await step('providers', () => doProviders(true)); } catch { /* refresh best-effort */ }
      quantResult = await step('quant', () => quant.evaluate(userId, settings, openTrades));
    }

    // ★★ TRD-FED-1 (2026-09-27): A DIVERGENCE THAT IS DETECTED AND NOT LOGGED IS STILL INVISIBLE.
    //
    // The row recorded that Oil/Sugar/Brent show "a tight core with multi-percent spikes - the signature of a
    // feed going STALE", and that **the 09-24 spike (2.293%) and the worse 2026-09-18 one (5.124%) are
    // invisible in every log the desk writes** — both were found by post-hoc analysis of `PriceTicks`. The
    // acceptance item forbids exactly that: *"a divergence that is DETECTED and not LOGGED is still invisible
    // to the next investigation."* It was not logged because it was never detected — `pickTick` chooses ONE
    // candidate and never compared them. It now compares the FRESH ones and returns the number; this writes
    // it down.
    //
    // WHY ONE EVENT PER WAKE AND NOT ONE PER SYMBOL: the condition lasts MINUTES (the 09-24 spike ran ~10),
    // so a per-symbol event would emit a storm during the exact window an operator is trying to read. One
    // event naming every diverging symbol is the same information at a readable rate.
    //
    // WHY 1%: measured, not chosen. Ordinary venue disagreement is a fraction of a percent, while the two
    // recorded events were 2.293% and 5.124%, so 1% separates the populations with room on both sides. It is
    // deliberately LOOSE — the cost of a false fire is one event, and the cost of a miss is the 09-24 state
    // (an unexplained equity move found days later by hand). Tighten it only with a measurement.
    //
    // ⚠ THE COUNT IS CARRIED WITH THE ALARM. `compared` is how many venue PAIRS produced the maximum, and a
    // max over one pair and a max over six are different claims; without it "5.1% divergence" cannot be told
    // from "5.1% between the only two quotes we had".
    try {
      const DIVERGENCE_WARN_PCT = 1.0;
      const flagged = (quantResult.symbols || [])
        .filter((s) => s.priceDivergence && s.priceDivergence.maxSpreadPct >= DIVERGENCE_WARN_PCT)
        .map((s) => ({
          symbol: s.symbol,
          maxSpreadPct: s.priceDivergence.maxSpreadPct,
          venues: s.priceDivergence.venues,
          mids: s.priceDivergence.mids,
          compared: s.priceDivergence.compared,
          freshVenues: s.priceDivergence.freshVenues,
          priceVenue: s.priceVenue || null,
          priceSubstituted: !!s.priceSubstituted,
        }));
      if (flagged.length) {
        await store.logEvent(userId, 'price_divergence', {
          thresholdPct: DIVERGENCE_WARN_PCT,
          symbols: flagged,
          note: 'two or more FRESH venues quoted this symbol at materially different prices in the same read. '
            + 'This is the staleness signature TRD-FED-1 recorded: a tight core with multi-percent spikes. '
            + 'The desk may be pricing from a venue that has quietly stopped updating, and the tick SLA cannot '
            + 'see it because a stale feed keeps returning a well-formed quote.',
        }, { actor: 'system:quant', level: 'warn' }).catch(() => {});
      }
    } catch { /* an observation must never fail a wake */ }

    // TRD-71: the live-eligibility LEDGER, observe mode. Logged ONCE PER CHANGE - the finding is
    // "which in-scope pairs have a lab case", and that only matters when the answer moves. This
    // cannot block anything: lab/gate.js apply() ignores the decision unless gate.enforce is true,
    // and enforce defaults false. Wrapped so an observation can never fail a wake.
    try {
      const lg = quantResult.labGate;
      if (lg && Array.isArray(lg.ledger) && lg.ledger.length) {
        const sig = require('./lab/gate').signature(lg.ledger);
        if (sig !== live.labGateSig) {
          live.labGateSig = sig;
          const notAllowed = lg.ledger.filter((r) => r.action === 'would_refuse');
          await store.logEvent(userId, 'lab_gate', {
            observe: lg.observe === true,
            enforce: lg.enforce === true,
            candidatesUnavailable: !!lg.candidatesUnavailable,
            error: lg.error || null,
            summary: lg.summary,
            // inputSig, NOT sibling-field `signature`: log.js redacts keys matching /signature/i, so the
            // audit value would be stored as "[REDACTED]" and could never be compared against a later wake.
            inputSig: sig,
            pairs: lg.ledger.map((r) => ({ pair: `${r.strategyId}:${r.symbol}`, action: r.action, outcome: r.outcome })),
            notAllowed: notAllowed.length,
            exempt: lg.summary ? lg.summary.exempt : null,
            exemptSharePct: lg.summary ? lg.summary.exemptSharePct : null,
            reason: notAllowed.length
              ? `${notAllowed.length} in-scope pair(s) have a lab case that does not permit them: ${notAllowed.map((r) => `${r.strategyId}:${r.symbol}`).join(', ')}`
              : `nothing refused; ${lg.summary ? lg.summary.exempt : 0} of ${lg.summary ? lg.summary.total : 0} in-scope pair(s) run on an EXEMPTION (no lab case of their own), which is not a validation`,
          });
        }
      }
    } catch { /* observe-only: never let the gate break a wake */ }

    // TRD-75: the INDEPENDENT binding reviewer. OPT-IN (settings.bindingProposer.enabled, default
    // false) because it is an LLM call, and it only runs when its INPUT has moved (shouldPropose).
    // It proposes and RECORDS; it writes no settings, so nothing here can change the desk.
    // NOT wrapped in step(): a step that carries `error` is read as the FAILED STEP of the wake
    // (see failingStep / TRD-51), and an advisory proposal must never make a healthy wake look broken.
    //
    // ⚠ BUT "ADVISORY" MUST NOT MEAN "SILENT" (2026-09-15). A crash in here used to be swallowed with
    // no log at all, which is how a `JSON.parse` defect killed the reviewer for every run after its
    // first and left no trace anywhere — the same shape as the four-day blind meter (TRD-77). A skip is
    // still quiet; a THROW is recorded.
    if (settings.bindingProposer && settings.bindingProposer.enabled === true) {
      try {
        const prop = await require('./bindingProposer').propose(userId, settings);
        if (prop && prop.skipped) {
          // `stranded` distinguishes the two reasons a skip arrives: the cadence did not fire and there is
          // nothing to do, or the cadence did not fire and a decision already taken is being re-offered.
          await store.logEvent(userId, 'telemetry', { source: 'binding_proposer_skipped', reason: prop.skipped, stranded: prop.stranded === true }).catch(() => {});
        }
        // ★ THE APPLY IS NOT AN `else` (corrected 2026-09-15). A re-offered proposal arrives WITH a
        // `skipped` reason - the cadence did not fire because the reviewer's input had not moved, but the
        // decision had already been made and accepted. With `else if (prop.proposal)`, that re-offer took
        // the SKIP branch and was never applied: the stranding this was written to fix, reproduced one
        // branch further along. The skip log and the apply are independent statements.
        const bp = settings.bindingProposer;
        if (prop && prop.proposal) {
          // ★ THE OPS ARE DERIVED *WITH* THE SETTINGS, and that is the whole unlock (2026-09-15). The
          // same binding means two different things - a value change on a pair that already runs, or a
          // SCOPE ADDITION on one that does not - and only the settings can say which. Before this every
          // binding became `setParams`, so a proposal for a symbol with nothing in scope was judged
          // `inert` ("moving its values changes nothing") and dropped. Together with a prompt that
          // presented `scope` as a constraint, that is why every symbol but Gold and Oil came back
          // `unbound` with the reason "scope explicitly permits no strategy".
          const ops = require('./binding').opsFromProposal(prop.proposal, settings);
          if (bp.autoTighten === true) {
            const result = await require('./bindingApply').applyTightening(userId, {
              settings,
              ops,
              accepted: prop.accepted === true,
              overrideRequests: prop.overrideRequests || [],
              reason: 'wake',
            });
            if (!result.applied) {
              await store.logEvent(userId, 'telemetry', { source: 'binding_auto_tighten_held', reason: result.reason, held: result.held || [] }).catch(() => {});
            }
          }
          // WIDENING IS A DIFFERENT SWITCH FROM NARROWING, deliberately. One writer may only ever narrow
          // and one may only ever add scope, so neither can become the other through an edit that nobody
          // would read as a permission change. autoScope defaults OFF.
          if (bp.autoScope === true) {
            const scoped = await require('./bindingApply').applyScope(userId, {
              settings, ops, accepted: prop.accepted === true, reason: 'wake', inputSig: prop.inputSig || null,
            });
            if (!scoped.applied) {
              await store.logEvent(userId, 'telemetry', { source: 'binding_auto_scope_held', reason: scoped.reason, held: scoped.held || [] }).catch(() => {});
            }
          }
        }
      } catch (e) {
        // Advisory means "not a wake failure", NOT "not worth recording". A throw here is a defect in
        // the reviewer, and the desk must be able to see one: it went unseen for every run after the
        // reviewer's first proposal. Cost of the record is one event; cost of the silence was a dead
        // control that reported nothing.
        await store.logEvent(userId, 'error', {
          where: 'binding_proposer', error: String(e && e.message ? e.message : e).slice(0, 200),
          code: (e && e.code) || null, correlationId: corr,
        }).catch(() => {});
      }
    }

    // 2026-09-11: unevaluable instruments get the alternative-proxy agent —
    // propose correlated, evaluable alternatives + pulse the best one.
    // Fire-and-forget; the agent dedupes per target (12h) and never blocks.
    try {
      const noData = (quantResult.symbols || []).find((s) => s.status === 'insufficient_data');
      if (noData) {
        require('./alternatives').suggest(userId, settings, { symbol: noData.symbol, reason: 'insufficient_data' }).catch(() => {});
      }
    } catch { /* advisory only */ }

    // STEP: shadow call (TRD-SHW-1, 2026-09-14). Asks the model what it sees in
    // MARKET STRUCTURE with the desk's own signal withheld — see shadow.js, where
    // the strip is a CONSTRUCTION (whitelist) rather than a subtraction, because
    // removing the signal line from a normal bundle would still leave "no signal —
    // <flat reason>" and hand the model the desk's conclusion anyway. Nothing
    // downstream reads the result; no order, no size. Fire-and-forget so it adds no
    // latency, and it runs on EVERY wake — including the no-proposal ones that now
    // skip the committee — because that is exactly where a leading indicator would
    // have to prove itself.
    try {
      require('./shadowCall').runShadow(userId, settings, quantResult, { at: now })
        // The scorer sweeps on EVERY wake: rows whose horizon has elapsed get scored,
        // the rest wait for a later pass. Chained after the call so a row created now
        // is offered to the scorer in the same pass (it will not be ready yet, which
        // is the correct answer rather than a bug).
        .then(() => require('./shadowScore').scorePending(userId))
        .catch((e) => log.error(userId, 'shadow', e, { correlationId: corr }));
    } catch (e) {
      await log.error(userId, 'shadow', e, { correlationId: corr });
    }

    // STEP: risk bookkeeping (TRD-12 Phase 2) — trailing high-water baseline,
    // day-start equity for the daily-loss halt, equity snapshots, black-swan
    // detector. All cheap + non-fatal.
    await step('risk', async () => {
      const riskMod = require('./risk');
      const liveEq = Number(require('./accountPoller').getLive()?.equity) || Number(settings.kill?.initialEquity) || null;
      if (liveEq && Number.isFinite(liveEq)) {
        await riskMod.ratchetBaseline(userId, settings, liveEq);
        await riskMod.dayStartEquity(userId, settings, liveEq);
        await store.snapshotEquity(userId, { mode: 'demo', equity: liveEq, source: 'wake' });
      }
      // Sim ledger equity is snapshotted in EVERY mode (it is a pure ledger
      // valuation) so the sim-vs-demo divergence monitor always has data.
      try {
        const pe = await require('./paper').equity(userId, settings);
        if (pe && Number.isFinite(pe.equity)) await store.snapshotEquity(userId, { mode: 'sim', equity: pe.equity, pnl: pe.realized != null ? pe.realized : null, source: 'wake' });
      } catch { /* sim snapshot optional */ }
      try { await require('./whitepaper').detectBlackSwan(userId, settings, quantResult, liveEq); } catch { /* non-fatal */ }
      try { await require('./divergence').check(userId, settings); } catch { /* non-fatal */ }
      // TRD-24: pair lifecycle sweep — unhedged auto-unwind + half-close alarm
      // (no-op while no pair trades are open; entries are paused).
      try { await require('./pairs').sweep(userId, settings); } catch { /* non-fatal */ }
      // IMPLIED GOAL #7: weekly parity harness — retires underperforming
      // strategies (bounded by minTrades + win-rate lag thresholds).
      try { await require('./analytics').parityCheck(userId, settings); } catch { /* non-fatal */ }
      // New weekly/monthly/yearly white papers are generated fire-and-forget
      // (self-throttled per period + budget-gated).
      require('./whitepaper').ensureCurrent(userId, settings)
        .then(() => store.logEvent(userId, 'telemetry', { source: 'whitepaper', generated: true }))
        .catch((e) => log.error(userId, 'whitepaper', e, { correlationId: corr }));
      return { liveEq };
    });

    // STEP: telemetry side-quests (meta/multi/congress/pulse) — same behavior.
    await step('telemetry', async () => {
      try { await require('./meta').evaluateMeta(userId, settings); }
      catch (e) { await log.error(userId, 'meta', e, { correlationId: corr }); }

      if (((settings.strategies || {}).enabled || ['turtle']).includes('multi')) {
        const lastMulti = await store.latestEvent(userId, 'multi_signal');
        const ageMin = lastMulti ? (Date.now() - new Date(lastMulti.createdAt).getTime()) / 60000 : Infinity;
        if (ageMin > 360) {
          const yahoo = require('./providers/yahoo');
          require('./strategies/multiFactor').rank(userId, settings, { quoteSummary: yahoo.quoteSummary })
            .then((rank) => store.logEvent(userId, 'multi_signal', rank))
            .catch((e) => log.error(userId, 'multi', e, { correlationId: corr }));
        }
      }

      if (((settings.strategies || {}).enabled || ['turtle']).includes('congress')) {
        const lastC = await store.latestEvent(userId, 'congress');
        const ageMin = lastC ? (Date.now() - new Date(lastC.createdAt).getTime()) / 60000 : Infinity;
        if (ageMin > 720) {
          require('./providers/congress').pullCongressTrades(userId, settings)
            .then(() => require('./strategies/congress').rank(userId, settings))
            .then((rank) => store.logEvent(userId, 'telemetry', { source: 'congress', evaluated: rank.evaluated }))
            .catch((e) => log.error(userId, 'congress', e, { correlationId: corr }));
        }
      }

      if ((settings.pulse || {}).enabled !== false) {
        const lastPulse = await store.latestEvent(userId, 'pulse');
        const ageMin = lastPulse ? (Date.now() - new Date(lastPulse.createdAt).getTime()) / 60000 : Infinity;
        const hours = Math.max(0.25, Number((settings.pulse || {}).intervalHours) || 4);
        if (ageMin > hours * 60) {
          require('./pulse').generatePulse(userId, settings)
            .then((p) => store.logEvent(userId, 'telemetry', { source: 'pulse', promptId: p.promptId, latencyMs: p.latencyMs }))
            .catch((e) => log.error(userId, 'pulse', e, { correlationId: corr }));
        }
      }

      // MULTI-TF BACKFILL (user ask 2026-09-10): keep 5m/1h/4h/1d provider
      // bars fresh for the big-picture section — fire-and-forget, 6h gate.
      const lastMt = await store.latestEvent(userId, 'multi_tf_backfill');
      const mtAgeMin = lastMt ? (Date.now() - new Date(lastMt.createdAt).getTime()) / 60000 : Infinity;
      if (mtAgeMin > 360) {
        require('./providers').backfillMultiTf(userId, settings)
          .then((r) => store.logEvent(userId, 'telemetry', { source: 'multi_tf_backfill', ok: r.ok, attempts: r.attempts }))
          .catch((e) => log.error(userId, 'multi_tf_backfill', e, { correlationId: corr }));
      }

      // PHYSICAL / POSITIONING TELEMETRY (TRD-76): pull the wired sources so the reviewer can CITE a
      // value rather than describe a source as available. Fire-and-forget and cadence-gated at 12h,
      // which is generous for a weekly report and cheap for a daily one — the gate exists so a 10-minute
      // wake cadence does not turn into 144 calls a day to a public API.
      //
      // Deliberately NOT fetched at decision time: the reviewer reads what was RECORDED (telemetry/values),
      // so a wake never borrows a third party's outage and the as-of it cites cannot move underneath it.
      const telValues = require('./telemetry/values');
      const lastTel = await store.latestEvent(userId, telValues.KIND);
      const telAgeMin = lastTel ? (Date.now() - new Date(lastTel.createdAt).getTime()) / 60000 : Infinity;
      if (telAgeMin > 720) {
        telValues.record(userId, { symbols: ((settings.watchlist || {}).symbols || []).map((s) => s.symbol), store })
          .then((r) => {
            const ok = r.written.filter((w) => w.ok).length;
            const bad = r.written.filter((w) => !w.ok).map((w) => `${w.sourceId}: ${w.reason}`);
            return store.logEvent(userId, 'telemetry', { source: 'physical_telemetry', ok, sources: r.written.length, failed: bad });
          })
          .catch((e) => log.error(userId, 'physical_telemetry', e, { correlationId: corr }));
      }
      return { ok: true };
    });

    const pulseEvent = await store.latestEvent(userId, 'pulse');
    // TRD-12 Phase 0: telemetry into LIVE decisions — the demo desk now sees
    // meta/multi/congress the same way the paper desk always did (meta is
    // fetched BEFORE quant so the mean-reversion voter sees the regime).
    const multiEvent = await store.latestEvent(userId, 'multi_signal');
    const congressEvent = await store.latestEvent(userId, 'congress_signal');

    let result;
    if (paperMode) {
      // STEP: deliberate (paper desk: central AI with thinking).
      result = await step('deliberate', async () => {
        const paper = require('./paper');
        const central = require('./central');
        const paperEquity = await paper.equity(userId, settings);

        const killTier = (settings.kill && settings.kill.tier) || 'off';
        if (killTier === 'hard') {
          await log.write(userId, 'wake', { trigger, mode: 'paper', skipped: 'sim_kill_hard' }, { actor: wakeActor, correlationId: corr });
          return { skipped: 'sim_kill_hard' };
        }
        const floorPct = Number(settings.kill?.disasterFloorPct);
        if (floorPct != null && paperEquity.initial > 0) {
          const floorLevel = paperEquity.initial * (1 + floorPct / 100);
          if (paperEquity.equity < floorLevel) {
            // ⚠ TRD-OPS-1: this is a HARD kill — it blocks entries AND closes the book — and it was the only
            // automatic stop that did not alert. `setTier`'s alert flag defaults to FALSE, so a caller that does
            // not ask for one gets silence, and a silent hard stop over an unattended run is the failure that
            // lasts longest. A human-initiated kill may be quiet because the human already knows; this one is not.
            await require('./killswitch').setTier(userId, settings, 'hard', { reason: 'sim_disaster_floor', alert: true });
            await log.write(userId, 'wake', { trigger, mode: 'paper', skipped: 'sim_floor_breached', equity: paperEquity.equity, floorLevel }, { actor: 'system:floor', correlationId: corr });
            return { skipped: 'sim_floor_breached' };
          }
        }
        const verdict = await central.centralDeliberate(userId, settings, {
          now, session, quantResult,
          openPaper: await store.listPaperTrades(userId, { status: 'open', limit: 50 }),
          closedPaper: await store.listPaperTrades(userId, { status: 'closed', limit: 20 }),
          equity: paperEquity,
          pulse: pulseEvent ? pulseEvent.payload : null,
          meta: metaEvent,
          multi: multiEvent,
          congress: congressEvent,
          stateTree: await require('./stateTree').buildStateTree(userId),
          whitepaper: await require('./whitepaper').bundleSections(userId).catch(() => null),
        });
        let executed = null;
        try {
          const congressEv = await store.latestEvent(userId, 'congress_signal');
          const extraPrices = {};
          for (const row of (congressEv?.payload?.top || [])) {
            if (row.price != null) extraPrices[row.symbol] = { price: row.price, venue: 'yahoo' };
          }
          executed = await paper.executeVerdict(userId, settings, verdict, quantResult, extraPrices, { entriesBlocked: killTier === 'soft' });
        } catch (e) {
          await log.error(userId, 'paper_execute', e, { correlationId: corr });
        }
        // TRD-12 Phase 3: deterministic sim take-profit enforcement (the
        // central only manages entries/trailing logic — TP is desk-level).
        try {
          const openPaper = await store.listPaperTrades(userId, { status: 'open', limit: 50 });
          for (const t of openPaper) {
            if (t.takeProfitPrice == null) continue;
            const qs = (quantResult.symbols || []).find((s) => s.symbol === t.symbol && s.price != null);
            const px = qs ? Number(qs.price) : null;
            if (px == null) continue;
            const tp = Number(t.takeProfitPrice);
            const hit = t.direction === 'buy' ? px >= tp : px <= tp;
            if (hit) {
              await paper.closeTrade(userId, settings, t, { price: px, reason: 'take profit hit' });
              await store.logEvent(userId, 'paper_trade', { action: 'close', symbol: t.symbol, reason: 'take profit hit', price: px });
            }
          }
        } catch (e) {
          await log.error(userId, 'paper_takeprofit', e, { correlationId: corr });
        }
        return {
          mode: 'paper',
          action: (executed && (executed.opened.length || executed.closed.length)) ? 'trade' : 'none',
          reason: verdict.headline || `central stance: ${verdict.stance}`,
          llmCalled: true,
          decision: {
            stance: verdict.stance, confidence: verdict.confidence, headline: verdict.headline,
            actions: verdict.actions, risks: verdict.risks, model: verdict.model, thinking: settings.central?.thinking !== false,
            reasoning: verdict.reasoning || null,
          },
          executed: executed ? {
            opened: executed.opened.map((t) => ({ symbol: t.symbol, direction: t.direction, size: t.size, openPrice: t.openPrice })),
            closed: executed.closed.map((t) => ({ symbol: t.symbol, direction: t.direction, pnl: t.pnl })),
            equity: executed.equity,
          } : null,
          session,
          promptId: verdict.promptId,
          quantSummary: quantResult.symbols.map((s) => ({ symbol: s.symbol, status: s.status, signal: s.signal?.type || null })),
        };
      });
      if (result.skipped) {
        result.durationMs = Date.now() - started;
        await log.write(userId, 'wake', { trigger, mode: 'paper', skipped: result.skipped }, { actor: wakeActor, correlationId: corr, durationMs: result.durationMs });
        return result;
      }
      await log.write(userId, 'wake', paperWakePayload(trigger, result), { actor: wakeActor, correlationId: corr, rationale: result.decision.headline || null });
      result.durationMs = Date.now() - started;
      return result;
    }

    // PHASE 2 (2026-09-14): the venue's per-instrument carry + minimum size, gathered once per wake
    // and handed to the chairs. Read from the registry rather than probed: a capture that needs the
    // bridge would collide with the ticket lock, and these are contract facts that do not move.
    let venueCostFacts = null;
    try {
      const syms = (quantResult && quantResult.symbols ? quantResult.symbols : []).map((s) => s.symbol);
      venueCostFacts = await require('./instruments').venueCostFacts(userId, { symbols: syms });
    } catch (e) {
      // Absent facts must be ABSENT, not zero: the prompt says so explicitly when the map is empty.
      await store.logEvent(userId, 'telemetry', { source: 'venue_cost_facts_error', error: String(e.message || e).slice(0, 140) }).catch(() => {});
    }

    // ★ TRD-TRL-1 defect 1(b) (2026-09-30): EVALUATE THE SMALL-LOSS TOLERANCE BEFORE PAYING THE CHAIR.
    //
    // The tolerance gate (`exitWithinTolerance`, defined below) defers an exit whose floating loss sits inside
    // `maxLossAtR x ATR`. It lived ONLY in the execution step — i.e. after the chairs had voted and been paid
    // for. Measured 2026-09-30: **10 of the 23 trailing-stop fires were approved and then deferred**
    // (`chairVote: "yes"`, confidence 0.69-0.82), and on **7 of them the deferred exit was the wake's only
    // signal**, so the entire three-call deliberation bought a decision the executor never placed.
    //
    // ⚠ NOT A SAFETY GATE, AND NOT A SECOND RULE. This calls the SAME pure function against the SAME wake-start
    // book the execution step uses, so the deferral VERDICT is identical; the execution-step check is untouched
    // and still runs, so an exit that becomes placeable in the next few seconds is still placed. What changes is
    // that the chair is not convened on a signal the executor will refuse.
    //
    // ⚠ AND IT READS THE WAKE-START BOOK ON PURPOSE. Option F's fresh-book re-read belongs at the EMISSION
    // point and is not involved here: to reproduce what the deliberation WOULD have been given, this has to use
    // the same book the aggregator was handed.
    const suppressedExits = [];
    try {
      for (const s of (quantResult.symbols || [])) {
        if (!s || s.status !== 'ok' || !s.signal || s.signal.type !== 'exit') continue;
        const t = (openTrades || []).find((x) => x.symbol === s.symbol && x.status === 'open');
        if (!t) continue; // nothing open to defer; the stale case is option F's, at the emission point
        const defer = exitWithinTolerance(settings, quantResult, t);
        if (defer) {
          suppressedExits.push({
            symbol: s.symbol, tradeId: t.id, loss: defer.loss, band: defer.band,
            maxLossAtR: defer.maxLossAtR, clampedFrom: defer.clampedFrom == null ? null : defer.clampedFrom,
          });
        }
      }
    } catch (e) {
      // FAIL OPEN ON A COST GATE. A pre-check that throws must never cost the desk a real exit, so the list is
      // emptied and the wake proceeds exactly as it did before this change.
      suppressedExits.length = 0;
      await store.logEvent(userId, 'telemetry', { source: 'exit_tolerance_precheck_error', error: String(e.message || e).slice(0, 140) }).catch(() => {});
    }

    // ★★ P4 (2026-10-01): ONE observe-only row per wake with the in-flight excursion of every open position.
    // ⚠ FAIL OPEN, like the block above and for the same reason: this is instrumentation, and instrumentation
    // that can cost a wake is worse than no instrumentation. It decides nothing and nothing reads it yet.
    try {
      const scan = liveExcursionScan({ quantResult, openTrades });
      await store.logEvent(userId, 'excursion_live', {
        ...scan,
        source: 'wake_position_review', observeOnly: true,
        note: 'in-flight adverse excursion as a fraction of each position own stop distance; recorded, never acted on. '
          + 'The 0.6 threshold it reports against is a POOLED in-sample maximum (see pre-registration-2026-10-01.md) '
          + 'and `nUnmeasurable` counts open trades the scan could not evaluate, so a thin scan cannot read as a clean one',
        at: new Date().toISOString(),
      }).catch(() => {});
    } catch (e) {
      await store.logEvent(userId, 'telemetry', { source: 'excursion_live_error', error: String(e.message || e).slice(0, 140) }).catch(() => {});
    }

    // STEP: deliberate (demo desk: quant panel + chairs).
    result = await step('deliberate', () => aggregator.decide({
      userId, trigger, now, session, quantResult, settings, openTrades, closedTrades,
      digest: digest ? digest.payload : null, alert, manual: manual || trigger === 'manual',
      pulse: pulseEvent ? pulseEvent.payload : null,
      meta: metaEvent ? metaEvent.payload : null,
      multi: multiEvent ? multiEvent.payload : null,
      congress: congressEvent ? congressEvent.payload : null,
      userInput: userInput || null,
      venueCostFacts,
      suppressedExits: suppressedExits.map((x) => x.symbol),
    }));

    // STEP: execute the approved decision(s) — every per-symbol decision
    // that passed the risk gate + chair vote is executed this wake.
    await step('execute', async () => {
      const executions = [];
      // ★★ TRD-RSK-5 (#1456): entries THIS wake has already approved and placed. The risk gate was handed a
      // book snapshot taken at the start of the wake, so without this list a second entry in the same wake
      // cannot see the first — measured on wake #105365, which was given a 1-position book and opened Gold
      // AND Silver together, 12 seconds after the same gate had refused Silver against an open Gold.
      const approvedThisWake = [];
      const decs = (result.decision && result.decision.decisions) || [];
      const execList = decs.length ? decs : (result.action ? [result.decision].filter(Boolean) : []);
      // ★ A symbol whose exit was ALREADY deferred before deliberation must not be re-processed here. The
      // aggregator still reports the wake as an `exit` (defect 1(b) — a suppressed exit is still an exit the
      // desk signalled), so without this the same deferral would be recorded twice: once pre-deliberation and
      // again by the tolerance branch below.
      const preDeferred = new Set(suppressedExits.map((x) => x.symbol));
      for (const d of execList) {
        if (d.action !== 'entry' && d.action !== 'exit') continue;
        if (d.action === 'exit' && preDeferred.has(d.symbol)) continue;
        try {
          if (d.action === 'entry' && d.symbol) {
            // The quant snapshot entry for this symbol is read FIRST: the F17 gate below is handed the price
            // the decision actually used, and the levels further down are computed from the same snapshot.
            const qs = (quantResult.symbols || []).find((s) => s.symbol === d.symbol);
            const atr = Number(qs && qs.atr14) || null;
            const px = Number(qs && qs.price) || null;

            // F17 (2026-09-18): AN ENTRY ON A STALE FEED IS A BET ON YESTERDAY'S TAPE.
            //
            // 2026-09-17: the venue feed had been frozen ~16h when a scheduled deliberation approved an Oil
            // entry that filled at 95.80 (`Trades #1046`). The audit could not prove the signal came from the
            // stale ticks — it could prove the desk had NO gate that would have stopped it, and that every
            // number needed to stop it was already on the page (F1 → F16 → F17).
            //
            // The check is HERE rather than inside `executor.openTrade` deliberately: this is the AGENT's
            // entry path, which is where the harm was. A manual order is the owner acting on a chip they can
            // see, and silently refusing their click is a different change than the one this finding asks
            // for. (CLOSES are never gated — a position you cannot exit is worse than one you cannot enter.)
            //
            // The gate is handed the PRICE THIS DECISION USED (`priceAgeSec`/`priceSource` off the quant
            // snapshot) rather than only the feed's age: the levels are anchored to that price, so its age is
            // the fact that matters, and it is available per symbol. The feed age remains the gate's own
            // backstop for the case where quant has no entry for the symbol.
            //
            // The refusal is RECORDED, never silent: same shape as the `levels_unavailable` refusal below,
            // and `blocked: true` keeps it out of self-health's "approved entries that never filled" drift
            // count, because a policy refusal is not drift (the TRD-43 asymmetry).
            const gate = await require('./dataPlane').entryGate(userId, settings, {
              symbol: d.symbol,
              priceSource: qs && qs.priceSource,
              priceAgeSec: qs && qs.priceAgeSec,
            });
            if (!gate.ok) {
              executions.push({ symbol: d.symbol, action: 'entry', placed: false, blocked: true, reason: `${gate.reason}: ${gate.detail}` });
              await log.write(userId, 'order_blocked', {
                symbol: d.symbol, direction: d.direction || null, size: d.size ?? null,
                intent: 'open', reason: gate.reason, detail: gate.detail,
                priceAgeSec: gate.ageSec == null ? null : Math.round(gate.ageSec),
                priceSource: gate.priceSource || null,
                feedAgeMin: gate.ageMin == null ? null : Math.round(gate.ageMin),
                limitMin: gate.limitMin,
                note: 'an entry is a decision about the NEXT move — the desk will not make it on a price it cannot see (F17)',
              }, { actor: 'system:wake', level: 'warn', correlationId: corr }).catch(() => {});
              continue;
            }
            // FRESH re-check: the decision was deliberated on a snapshot
            // captured minutes ago — a position for this symbol may exist
            // NOW (user's manual trade or an earlier fill). Never stack a
            // duplicate entry or collide with a mirrored row.
            const freshOpen = await store.getOpenTrades(userId);
            if (freshOpen.some((x) => x.symbol === d.symbol)) {
              executions.push({ symbol: d.symbol, action: 'entry', placed: false, reason: 'already_open_symbol' });
              continue;
            }

            // ★★ TRD-RSK-5 (#1456), 2026-09-28: THE CORRELATION QUESTION, RE-ASKED AGAINST THIS BOOK.
            //
            // The block above re-reads the book for ONE purpose — "is this symbol already held" — and that is
            // a different claim from the one the correlation gate makes ("no two CORRELATED positions open
            // together"). So the fresh read happened and the correlation half of the decision was still made
            // against the stale snapshot.
            //
            // NOTE WHAT THE FRESH BOOK ALONE WOULD HAVE CAUGHT: Gold #1107 filled at 05:26:47.666Z and Silver
            // was submitted at 05:27:10.619Z, so by then `freshOpen` DID contain Gold. The narrow symbol test
            // is the only reason that fill was invisible. `approvedThisWake` covers the remaining window — an
            // entry approved earlier in this same pass whose fill has not landed yet.
            //
            // Refused as a POLICY refusal (`blocked: true` + `order_blocked`), exactly like the F17 entry gate
            // above and for the same reason: self-health counts approved-entries-that-never-filled as drift,
            // and a working guard must not report as a broken desk (the TRD-43 asymmetry).
            const corrClash = await require('./risk').correlationClash(
              userId, settings.risk || {}, d.symbol, freshOpen.concat(approvedThisWake),
              { proposal: { symbol: d.symbol, pairId: d.pairId || null } },
            );
            if (corrClash) {
              executions.push({ symbol: d.symbol, action: 'entry', placed: false, blocked: true,
                reason: `correlation_after_approval: ${corrClash.text}` });
              await log.write(userId, 'order_blocked', {
                symbol: d.symbol, direction: d.direction || null, size: d.size ?? null, intent: 'open',
                reason: 'correlation_intrawake', correlation: corrClash.c, withSymbol: corrClash.withSymbol,
                threshold: corrClash.threshold, bookSize: freshOpen.length + approvedThisWake.length,
                approvedThisWake: approvedThisWake.map((x) => x.symbol),
                note: 'this entry was approved against the wake-start book, and the book has moved since — the '
                  + 'correlation gate is re-asked here because two entries in one wake were never compared to '
                  + 'each other (TRD-RSK-5). The instrument was NOT sized against this position.',
              }, { actor: 'system:wake', level: 'warn', correlationId: corr }).catch(() => {});
              continue;
            }

            // TRD-43 (2026-09-14): FAIL SECURE when the levels cannot be computed.
            //
            // risk.js ALREADY vetoes any proposal whose atr14/price is missing ("insufficient
            // volatility/price data for sizing"), so arriving here without them means the two
            // readers of the same quant snapshot disagree: the gate sized the proposal, this lookup
            // could not. The previous code took that disagreement and placed the order anyway with
            // stopPrice = null — and `webtrader.placeOrder` only issues a venue SL/TP when at least
            // one level is non-null, so the position would have had NO STOP AT ALL. Not a wide
            // stop: no stop. Unbounded risk, and a ledger row that `rMultiple` returns null for,
            // hence invisible to every R-based metric. That is exactly the state TRD-43 exists to
            // end.
            //
            // NOT HYPOTHETICAL: Trades 1033 (origin agent, Gold, buy, size 1, stopPrice NULL) is a
            // real attempt with both levels null at 2026-09-13T17:14:46Z. It failed at the venue
            // for an unrelated reason (the position row never appeared), which is the only reason
            // there is not a stopless trade with a post-epoch entry time.
            //
            // Refusing is the honest outcome — a position whose risk the desk cannot express is
            // worse than no position — and the refusal is RECORDED, so it cannot become a silent
            // skip: `executions` carries placed:false, which self-health's 'drift' check reports as
            // an approved entry that never filled.
            // TRD-97: `maxAdversePct` caps the STOP only (TP keeps the declared distance), so a trade
            // that is 0.30% against the desk is out while a trade that is working keeps its full reward.
            // `d.stopDistance` is still the declared 2xATR — that is the distance risk.js SIZED against,
            // so the dollar risk falls by the same ratio rather than being re-levered by a tighter stop.
            const maxAdv = adverseStopCap(settings, d.symbol);
            const lv = entryLevels({ direction: d.direction, atr14: atr, price: px, stopDistance: d.stopDistance, maxAdversePct: maxAdv.pct, takeProfitOffsetPct: (settings.risk || {}).takeProfitOffsetPct, takeProfitAnchor: (settings.risk || {}).takeProfitAnchor, takeProfitRR: (settings.risk || {}).takeProfitRR });
            if (!lv.ok) {
              const detail = `${lv.reason} (atr14=${atr == null ? 'null' : atr}, price=${px == null ? 'null' : px}, direction=${d.direction || 'null'})`;
              executions.push({
                symbol: d.symbol, action: 'entry', placed: false,
                reason: `levels_unavailable: ${detail} — refusing an entry that would carry no venue stop`,
              });
              await log.write(userId, 'order_blocked', {
                symbol: d.symbol, direction: d.direction || null, size: d.size ?? null,
                reason: 'levels_unavailable', detail,
                note: 'an entry with no stop is unbounded risk and unmeasurable in R (TRD-43)',
              }, { actor: 'system:executor', level: 'warn', correlationId: corr }).catch(() => {});
              continue;
            }
            const { stopPrice, takeProfitPrice } = lv;
            // The cap is RECORDED, never silent: a forward-validation candidate whose stop was overlain
            // must be separable from one that was not, or the TRD-29 track gets quietly redefined.
            if (lv.cappedBy) {
              await log.write(userId, 'stop_capped', {
                symbol: d.symbol, direction: d.direction || null, strategyId: d.strategy || null,
                capPct: lv.capPct, declaredStopDist: lv.declaredStopDist, stopDist: lv.stopDist,
                declaredRR: 1.5, effectiveRR: lv.effectiveRR, price: px,
                // ★ TRD-TP-1 (2026-09-28): WHICH ANCHOR THE TARGET CAME FROM. `effectiveRR` is the observable
                // that changes — under `placed` it goes back to 1.5 on every capped ticket — but the FIELD is
                // what makes the forward track separable at the date the setting moved, which TRD-29 requires
                // before a frozen candidate's geometry is touched. An absent value means `declared` (historic).
                tpAnchor: lv.takeProfitAnchor, tpAnchorDist: lv.takeProfitAnchorDist,
                note: lv.takeProfitAnchor === 'placed'
                  ? 'TRD-97 adverse-exit cap: the stop was tightened to a percentage of price; the take-profit is anchored to the PLACED stop (TRD-TP-1 route 2), so this ticket still carries the declared reward:risk'
                  : 'TRD-97 adverse-exit cap: the stop was tightened to a percentage of price; the take-profit kept the declared distance, so reward:risk rose for this ticket',
              }, { actor: 'system:risk', correlationId: corr }).catch(() => {});
            }

            const execution = await require('./executor').openTrade(userId, settings, {
              symbol: d.symbol,
              direction: d.direction,
              size: d.size,
              decisionId: result.promptId,
              // TRD-94 (2026-09-18): when every chair abstained on a BUDGET CAP the desk still enters —
              // degraded to a fraction of size, quant-only (aggregator.js; deliberate 2026-09-10 policy
              // that a cap is a resource limit, not a malfunction). The chair being unable to deliberate
              // lived ONLY in the wake log, so the book rendered an undeliberated entry exactly like an
              // approved one, and the two could not be told apart from the position list. It is written
              // onto the trade instead, where the position is actually read.
              note: `wake ${trigger}${d.chairVote === 'offline' ? ` · CHAIR OFFLINE (quant-only${d.sizeCalc && d.sizeCalc.degradedFactor ? ` x${d.sizeCalc.degradedFactor}` : ''})` : ''}`,
              stopPrice,
              takeProfitPrice,
              strategyId: d.strategy || null,
              decisionPrice: px, // P2-13: fill telemetry baseline
              // TRD-ANC-1 (2026-09-25): WHEN that price was taken. The venue tick series is FROZEN for the
              // whole anchor->fill window (measured: 0 available ticks in 30 of 30 entries), so the anchor's
              // AGE is the only term describing how far the posted levels can sit from the fill — and it is
              // what the off-by-default `risk.maxAnchorAgeSec` gate judges.
              decisionPriceAsOf: (qs && qs.priceAsOf) || null,
              // F20: the venue the decision price came from, so the re-anchor at submit compares
              // like-for-like rather than across venues (TRD-69).
              priceVenue: (qs && qs.priceVenue) || null,
              // 2026-10-27 (migration 055): THE INSTRUMENT THIS TICKET WAS SIZED AGAINST, recorded rather than
              // reconstructed. `constraintAudit` used to resolve the id by SYMBOL at audit time, against the registry
              // as it is THEN, so a renamed symbol or an expired option chain left the trade unjoinable. This reads
              // the resolution the risk gate already made for this decision (`sizeCalc.venueFloor`) — not a second
              // lookup, so it cannot disagree with the size that was sent.
              venueInstrumentId: (d.sizeCalc && d.sizeCalc.venueFloor && d.sizeCalc.venueFloor.venueInstrumentId) || null,
            }, { keepOpen: true });
            // The cap's disposition travels with the execution: applied, or refused and why. A risk
            // control that did not run must not look the same as one that did.
            executions.push({ symbol: d.symbol, action: 'entry', ...execution, ...(maxAdv.note ? { stopCap: maxAdv.note } : {}) });
            // TRD-RSK-5: record it for the entries that follow in THIS wake — the fill may not have landed
            // yet, so `freshOpen` alone cannot see it.
            if (execution && execution.placed) approvedThisWake.push({ symbol: d.symbol, pairId: d.pairId || null });
          } else if (d.action === 'exit' && d.symbol) {
            const snapshotTrade = openTrades.find((x) => x.symbol === d.symbol && x.status === 'open');
            if (snapshotTrade) {
              // ★ TRD-TRL-1 option F (2026-09-30): AN EXIT MUST BE DECIDED AGAINST A BOOK THAT IS STILL THERE.
              //
              // `snapshotTrade` is from `openTrades`, read ONCE at the top of this wake. The measured instance
              // is in agent/staleExit.js: `trade_closed` at 16:17:17, and at 16:17:21 this pass emitted an exit
              // for the SAME trade and spent three chair calls deliberating a position the record had already
              // closed. The entry path has re-read the book for exactly this reason since 2026-09-10 (the
              // `freshOpen` block above, written for "is this symbol already held"); the exit path never did, so
              // the staleness that is GUARDED on the way in was ACTED ON the way out.
              //
              // ⚠ A SKIPPED EXIT IS RECORDED. A guard that silently does nothing is indistinguishable from a
              // broken desk — the F20 / `reanchor_skipped` lesson, which cost eleven silent no-ops once.
              const guard = require('./staleExit').staleExitGuard({
                snapshotTrade,
                freshOpen: await store.getOpenTrades(userId),
              });
              if (!guard.ok) {
                executions.push({ symbol: d.symbol, action: 'exit', placed: false, reason: `stale_position: ${guard.reason}` });
                await log.write(userId, 'order_blocked', {
                  symbol: d.symbol, intent: 'close', tradeId: snapshotTrade.id,
                  reason: `stale_position_${guard.reason}`,
                  note: 'the exit was deliberated against the wake-start book and the position is no longer open '
                    + 'in the record, so the desk did NOT attempt to close it. Recorded as `order_blocked` and not '
                    + '`order_rejected`, because a guard doing its job must not count as a broken desk (TRD-43); '
                    + 'and the chair calls spent before this point are the cost this guard cannot refund.',
                }, { actor: 'system:wake', level: 'warn', correlationId: corr }).catch(() => {});
                continue;
              }
              const t = guard.trade;
              // Small-loss tolerance (2026-09-10): an exit signal while the
              // floating loss is inside maxLossAtR x ATR (spread/noise zone)
              // is DEFERRED — the venue-native stop remains the hard floor.
              // Profitable exits always go through immediately.
              const defer = exitWithinTolerance(settings, quantResult, t);
              if (defer) {
                executions.push({
                  symbol: d.symbol, action: 'exit', placed: false,
                  reason: `loss_within_tolerance (${defer.loss.toFixed(2)} <= ${defer.band.toFixed(2)} = ${defer.maxLossAtR}xATR) — holding`,
                });
                continue;
              }
              const execution = await require('./executor').closeTrade(userId, settings, t.id, { keepOpen: true, source: result.promptId ? `wake:${result.promptId}` : 'wake' });
              executions.push({ symbol: d.symbol, action: 'exit', ...execution });
            }
          }
        } catch (e) {
          await log.error(userId, 'execution', e, { correlationId: corr, fields: { trigger } });
          executions.push({ symbol: d.symbol || null, error: String(e.message || e).slice(0, 160) });
        }
      }
      // ★ TRD-TRL-1 defect 1(b): the pre-deliberation deferrals are recorded in the SAME shape the execution-step
      // deferral uses, so the census of "why did this fire stop" never splits into two formats and a pre-deferred
      // exit is not invisible. `preDeliberation` is the one addition — without it a reader cannot tell a gate that
      // SAVED a chair call from one that wasted it, which is the entire measurement this change rests on.
      // (The `reason` string is byte-identical to the execution-step branch on purpose: every existing consumer,
      // including the audit query used to size this fix, keeps working.)
      for (const x of suppressedExits) {
        executions.push({
          symbol: x.symbol, action: 'exit', placed: false, blocked: false, preDeliberation: true,
          tradeId: x.tradeId,
          reason: `loss_within_tolerance (${x.loss.toFixed(2)} <= ${x.band.toFixed(2)} = ${x.maxLossAtR}xATR) — holding`,
        });
      }
      if (suppressedExits.length) {
        await log.write(userId, 'telemetry', {
          source: 'exit_deferred_before_deliberation',
          deferred: suppressedExits.map((x) => ({ symbol: x.symbol, tradeId: x.tradeId, loss: +x.loss.toFixed(2), band: +x.band.toFixed(2), clampedFrom: x.clampedFrom })),
          note: 'the small-loss tolerance was evaluated before the chairs, so no deliberation was spent on an exit the executor would refuse (TRD-TRL-1 defect 1(b))',
        }, { actor: 'system:wake', correlationId: corr }).catch(() => {});
      }
      result.executions = executions;
      result.execution = executions[0] || null;
      // Normalize: exits report `closed` while entries report `placed` —
      // unify so the wake event + prompt patch carry one boolean.
      for (const e of executions) {
        if (e.action === 'exit' && e.placed == null) e.placed = e.closed === true;
      }
      // Persist execution outcomes onto the prompt row so the wakes UI can
      // show WHY a decision didn't land (cap, duplicate, bridge failure…).
      if (result.promptId && executions.length) {
        try {
          await store.patchPromptDecision(userId, result.promptId, { executions });
        } catch { /* best-effort enrichment */ }
      }
      return executions;
    });

    // ★★ ONE WAKE, ONE EVENT (TRD-WAK-2, 2026-09-27). THIS IS NOW THE ONLY PLACE A `wake` EVENT IS WRITTEN.
    //
    // It used to be guarded by `if (!String(result.reason || '').startsWith('no_signal'))`, on the stated reasoning
    // that "no-signal skips are already logged by the aggregator, don't duplicate". That guard tests the PROSE of
    // the reason and therefore covers exactly ONE of the three reasons the aggregator logs a wake for — so
    // `positions open, no proposal - committee not convened`, the single most common outcome on this desk, was
    // written TWICE. MEASURED over 14 days: 815 of 1,426 wakes carried a duplicate pair, one carried five.
    //
    // A prose prefix was the wrong instrument for an ownership question, and it is the same class of defect as a
    // test that pins a sentence: it works until the sentence changes. Ownership is now explicit — the aggregator
    // writes no `wake` events at all and returns its fields instead, so there is nothing to test for.
    // ★ TRD-BAR-1: attached AFTER the write expression is built is useless, so it is attached to `result` here,
    // immediately before the payload reads it. A degraded wake must SAY it was degraded, or "the prune failed"
    // and "the prune had nothing to do" render identically on every surface that reads a wake.
    result.barsError = barsError;
    await log.write(userId, 'wake', demoWakePayload(trigger, result, quantResult, session.state, openTrades.length),
      { actor: wakeActor, correlationId: corr, rationale: result.reason || null });
    result.durationMs = Date.now() - started;
    result.session = session;
    result.quantSummary = quantResult.symbols.map((s) => ({ symbol: s.symbol, status: s.status, signal: s.signal?.type || null }));
    return result;
  };

  let outcome;
  let failed = false;
  let failedStepRec = null;
  try {
    outcome = await body();
  } catch (e) {
    failed = true;
    failedStepRec = failingStep();
    await log.error(userId, 'wake', e, { correlationId: corr, fields: { trigger } });
    outcome = { error: String(e.message || e).slice(0, 200) };
    // TRD-51 fix 1 (2026-09-14): A FAILED WAKE MUST LEAVE A ROW THE WAKE LIST CAN RENDER.
    // The list is built from TradingPrompts, and a wake that died before deliberation wrote
    // NOTHING — so the UI rendered four hours of outage as four hours of silence
    // (09:37:45 -> 13:05:38, 8 wakes, all `bars_build` ETIMEOUT). `llmCalled: false` is the
    // established convention for a prompt row that never reached the model (the no-proposal
    // skip and the kill-switch row already use it), so a failed wake joins the SAME stream
    // the UI already reads, in time order, instead of needing a second one.
    try {
      const promptId = await store.createPrompt(userId, {
        triggerType: trigger,
        bundle: null,          // no bundle was built; a failure has no telemetry to show
        response: null,
        decision: {
          action: 'none',
          reason: `wake failed at ${failedStepRec ? failedStepRec.name : 'unknown'} — ${outcome.error}`,
          failed: true,
          failedStep: failedStepRec ? failedStepRec.name : null,
          failedStepMs: failedStepRec && failedStepRec.ms != null ? failedStepRec.ms : null,
          failedAfter: failedStepRec ? failedStepRec.startedAt : null,
          error: outcome.error,
          llmCalled: false,
        },
        model: null, usage: null, latencyMs: null,
      });
      outcome.promptId = promptId;
      outcome.failed = true;
      outcome.failedStep = failedStepRec ? failedStepRec.name : null;
    } catch (e2) {
      // The failure row is best-effort: if the DB is the thing that broke, this write fails
      // too and we must not lose the original error or mask it with a second one.
      await log.error(userId, 'wake_failure_row', e2, { correlationId: corr, fields: { trigger } }).catch(() => {});
    }
    await store.logEvent(userId, 'wake', {
      trigger, action: 'none', failed: true,
      failedStep: failedStepRec ? failedStepRec.name : null,
      promptId: outcome.promptId || null,
      error: outcome.error, llmCalled: false,
    }).catch(() => {});
  } finally {
    finishWake(outcome, { failed });
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Audit-trail + execution helpers (extracted from the pipeline body so the
// event formats live in ONE place per mode).
// ---------------------------------------------------------------------------

// Venue-native stop/take-profit levels: stop = stopDist, TP = 1.5 x stopDist
// (stopDist = 2xATR widened to the min-stop-to-spread floor by risk.js).
// 2026-09-13: moved to ./exitLevels so the rule has ONE implementation that can be
// reconciled against the levels the venue actually received (report S5 — the venue
// TP/stop decided 4 of 7 day-one closes, so they are the majority exit path).
const { entryLevels } = require('./exitLevels');

// ★★ P4 (2026-10-01) — THE IN-FLIGHT EXCURSION, OBSERVE-ONLY.
//
// WHAT WAS MISSING. `autopsy.excursionFraction` has computed the 0.6 counterfactual since #1498, but only AT
// CLOSE — its own comment names the gap ("a live trigger needs the excursion IN FLIGHT, which the position poll
// already samples"). The poller cannot supply it: it knows the venue's rows and NOT the trade's stop distance, so
// it can report a position's P&L but not "how far into its stop" it is. THIS function is where the two live
// together — `openTrades` carries the stop, `quantResult` carries the live price — which is why P4 belongs here
// and not in `accountPoller`.
//
// ⚠ IT REUSES THE EXPRESSION THE TOLERANCE GATE ALREADY USES rather than inventing a second one. `loss` below is
// the SAME `(openPrice - px) * dir` that `exitWithinTolerance` computes, so the excursion and the deferral can
// never disagree about which side of the entry a position is on — two expressions for one question is how this
// review's own currency defect started.
//
// ⚠ AND IT DECIDES NOTHING. Returned for the record, never acted on: §9.1 classifies the 0.6 threshold as a
// distributional claim, so acting on it before the pre-registration in `pre-registration-2026-10-01.md` reports
// would be acting on a pooled number. Observe-only is what makes that discount affordable — nothing to undo.
//
// `unmeasurable` is a NAMED outcome, not a silent skip: an open trade with no live price is a coverage gap and
// has to be countable, or a thin scan reads as a clean one.
function liveExcursionScan({ quantResult, openTrades } = {}) {
  const { excursionFraction, EXCURSION_THRESHOLD } = require('./autopsy');
  const rows = [];
  const unmeasurable = [];
  for (const t of (openTrades || [])) {
    if (!t || t.status !== 'open') continue;
    if (t.openPrice == null || t.stopPrice == null || t.direction == null) {
      unmeasurable.push({ tradeId: t.id == null ? null : t.id, symbol: t.symbol || null, why: 'levels_unrecorded' });
      continue;
    }
    const qs = ((quantResult && quantResult.symbols) || []).find((s) => s.symbol === t.symbol);
    const px = Number(qs && qs.price);
    if (!px) { unmeasurable.push({ tradeId: t.id == null ? null : t.id, symbol: t.symbol || null, why: 'no_live_price' }); continue; }
    const dir = t.direction === 'buy' ? 1 : -1;
    const loss = (Number(t.openPrice) - px) * dir; // >0 when losing - the SAME expression as the tolerance gate
    // ⚠ `Math.max(0, loss)` IS LOAD-BEARING, NOT DEFENSIVE. `excursionFraction` derives its result from
    // `Math.abs(maePct)` because `maePct` is a MAXIMUM ADVERSE excursion and so a magnitude by definition. Handing
    // it a SIGNED move would make a position that is 2% IN PROFIT report an excursion of 1.0 and `wouldCut: true`
    // — a false alert on every winner. The clamp is what keeps a favourable move at zero.
    const adversePct = (Math.max(0, loss) / Number(t.openPrice)) * 100;
    const ex = excursionFraction({ entry: t.openPrice, stopPrice: t.stopPrice, maePct: adversePct });
    if (ex.excursionFraction == null) {
      unmeasurable.push({ tradeId: t.id == null ? null : t.id, symbol: t.symbol || null, why: 'fraction_unavailable' });
      continue;
    }
    rows.push({
      tradeId: t.id == null ? null : t.id, symbol: t.symbol || null, direction: t.direction,
      excursionFraction: ex.excursionFraction, excursionStopDistPct: ex.excursionStopDistPct,
      wouldCut: ex.excursionWouldCut,
    });
  }
  return {
    rows, unmeasurable, threshold: EXCURSION_THRESHOLD,
    n: rows.length, nWouldCut: rows.filter((r) => r.wouldCut).length, nUnmeasurable: unmeasurable.length,
  };
}

// Small-loss tolerance (2026-09-10): returns a deferral description when the
// floating loss is inside maxLossAtR x ATR (spread/noise zone); null when the
// exit should proceed (profitable or loss beyond the band).
function exitWithinTolerance(settings, quantResult, trade) {
  const tol = (settings.risk && settings.risk.exitTolerance) || {};
  const maxLossAtR = Number(tol.maxLossAtR ?? 0.5);
  if (tol.enabled === false || !(maxLossAtR > 0) || trade.openPrice == null) return null;
  const qs = (quantResult.symbols || []).find((s) => s.symbol === trade.symbol);
  const atr = Number(qs && qs.atr14);
  const px = Number(qs && qs.price);
  if (!atr || !px) return null;
  const dir = trade.direction === 'buy' ? 1 : -1;
  const loss = (Number(trade.openPrice) - px) * dir; // >0 when losing
  // TRD-97 (2026-09-19): THE BAND IS CLAMPED TO THE POSITION'S OWN STOP.
  // `maxLossAtR x ATR` is 0.25x the DECLARED 2xATR stop, which was coherent only while the stop was
  // always 2xATR. Once `risk.maxAdversePct` caps a stop the ATR band can be WIDER than the stop it is
  // supposed to sit inside — measured on Oil, the band is 0.402% of price against a 0.30% capped stop,
  // so the deferral would hold a position PAST its own risk control while reporting that the stop was
  // still the floor. Clamped to 60% of the real stop distance so that claim stays true.
  const stopDist = trade.stopPrice != null && trade.openPrice != null
    ? Math.abs(Number(trade.openPrice) - Number(trade.stopPrice))
    : null;
  let band = maxLossAtR * atr;
  let clampedFrom = null;
  if (Number.isFinite(stopDist) && stopDist > 0 && band > stopDist * 0.6) {
    clampedFrom = +band.toFixed(4);
    band = stopDist * 0.6;
  }
  if (!(loss > 0) || loss > band) return null;
  return { loss, band, maxLossAtR, clampedFrom };
}

// TRD-97's adverse-exit cap and its cost floor MOVED to agent/stopPolicy.js under TRD-102 (2026-09-19),
// because `risk.js` has to SIZE against the same capped distance and two copies of a rule that must agree
// is exactly how the declared-vs-capped stop drifted apart in the first place. Re-exported below under
// the same name so the call site and temp/verify-trd97.js are unchanged.
const { adverseStopCap } = require('./stopPolicy');

function demoWakePayload(trigger, result, quantResult, sessionState, openCount) {
  const quantStale = require('./promptBuilder').isStale(quantResult, new Date());
  return {
    trigger, mode: 'demo', action: result.action, reason: result.reason || null,
    symbol: (result.decision && result.decision.symbol) || null,
    direction: (result.decision && result.decision.direction) || null,
    llmCalled: result.llmCalled !== false, promptId: result.promptId || null,
    session: sessionState, stale: quantStale,
    positions: openCount,
    // ★ TRD-WAK-2: THE FIELDS THE AGGREGATOR USED TO WRITE IN A SECOND ROW. They ride here now, because the
    // aggregator no longer emits a wake event — dropping them would trade a duplicated row for a LOST one, which
    // is worse. `blocked` names a refusal that never reached a decision; `quant` is the scout's census; and
    // `committee` is the plan, which is the only record of WHY the committee was or was not convened.
    blocked: result.blocked || null,
    quant: result.quant || null,
    committee: result.committee || null,
    // ★ TRD-BAR-1: a degraded wake says WHY it was degraded. Without this, a failed tick-prune and a prune with
    // nothing to do render identically everywhere a wake is read, which is how 51 lost wakes stayed invisible.
    barsError: result.barsError || null,
    decisions: ((result.decision && result.decision.decisions) || []).map((d) => ({
      symbol: d.symbol, action: d.action, direction: d.direction, size: d.size,
      strategy: d.strategy, sizeCalc: d.sizeCalc || null,
      // ⚠ `reason` per decision was carried ONLY by the aggregator's row. Without it a wake says a decision was
      // `none` but not why, which is the half of the record a reader needs most.
      reason: d.reason || null,
      // ★ TRD-RSK-2: the CODE for a deterministic refusal. `reason` is prose for a human; this is what a report
      // groups by, so "why is the desk not trading" is answerable without reading sentences.
      vetoCodes: d.riskVetoCodes || null,
    })),
    executions: (result.executions || []).map((e) => ({
      symbol: e.symbol, action: e.action, placed: e.placed,
      // F17: `blocked` must survive into the event payload, or self-health's drift check cannot tell a policy
      // refusal ("I will not open on a stale feed") from a decision that failed to reach the venue.
      blocked: e.blocked === true,
      reason: e.reason || null, error: e.error || null,
    })),
  };
}

function paperWakePayload(trigger, result) {
  return {
    trigger, mode: 'paper', action: result.action,
    stance: result.decision.stance, confidence: result.decision.confidence,
    headline: result.decision.headline,
    opened: result.executed?.opened?.length || 0, closed: result.executed?.closed?.length || 0,
    equity: result.executed?.equity || null, promptId: result.promptId,
  };
}

// `adverseStopCap` and `exitWithinTolerance` are exported for the same reason `exitLevels.decideClose`
// was: the cost-floor rule and the tolerance clamp can then be driven through their truth tables without
// a live entry, rather than grepped for.
// `demoWakePayload` joins them (TRD-WAK-2): it is now the ONE place a wake's recorded shape is decided, so its
// field merge — the half of the fix that stops the duplicate from becoming a LOSS — has to be testable directly.
module.exports = { run, step, beginWake, finishWake, pipelineStatus, bridgeUse, failingStep, adverseStopCap, exitWithinTolerance, liveExcursionScan, demoWakePayload, TICK_SLA_MS, withDeadline, DEFAULT_STEP_TIMEOUT_MS, FLOOR_STEP_TIMEOUT_MS, AUTOCLOSE_STEP_TIMEOUT_MS };
