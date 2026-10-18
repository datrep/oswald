// trading/agent/executor.js — trade execution + safety (TRD-3).
// DEMO-ONLY: every action re-checks the venue is a demo account. Real-money
// execution requires an explicit future gate (none exists yet).
// Gates, in order: demo guard -> kill tier -> circuit breaker -> caps.
// After a CONFIRMED fill the trade is written to Trades. Phantom-fill
// reconciliation compares our open rows against live venue positions.
'use strict';

const store = require('../store');
const { getConnector } = require('../connector');
const killswitch = require('./killswitch');
// TRD-42: the classifier and its reconciliation contract. NEEDS_RECONCILIATION was written when
// the classes were extracted and then had no consumer — this is the one that makes it load-bearing.
const { classifyBridgeError, NEEDS_RECONCILIATION } = require('../connector/errorClass');
// TRD-43: the same `Number(null) === 0` trap as expectancy.num, applied to INBOUND exit levels at
// the only place that writes them. Lives in exitLevels.js because that module owns the geometry
// and is pure — keeping it there means the guard can be tested without loading the connector.
const { level, reanchorLevels, fillDrift, anchorAgeSec, anchorAgeGate, staleTickForDecision } = require('./exitLevels');
// F20: the re-anchor reads the same series the decision was priced from, so the comparison is
// like-for-like — cross-venue prices are not comparable (TRD-69), which is why the venue is carried
// through from the quant snapshot rather than guessed here.
const ticks = require('../store/ticks');
// TRD-52: the session reader (pure, handles BOTH connector shapes) and the unconfirmed-order rules.
const { sessionClosed } = require('./sessions');
const { matchVenuePosition, suspectedOwn, expiredRows, pendingFor, ageMinutes, UNCONFIRMED_TTL_MIN } = require('./unconfirmed');
// TRD-108 (2026-09-21): names which fact this close's `closePrice` is — the desk's own fill, or the venue's rate.
const { CLOSE_PRICE_SOURCE } = require('./closeFill');
// TRD-118 (2026-09-24): the close TIME's provenance, so a window-based metric can tell an observed instant from
// the venue's minute-rounded display. The desk stamps this one from its own clock.
const { CLOSE_AT_SOURCE } = require('./closeTime');

// ★★ TRD-OPS-3 (2026-10-02): THE CONSTANTS AND THE POLICY MOVED TO `killswitch.js`. They lived here, which
// meant the breaker's rule could not be exercised without a database — and the defect being fixed was a POLICY
// error (counting volume instead of breadth), not a plumbing one.
const { CB_WINDOW_MIN, breakerDecision } = killswitch;

// Circuit breaker: rejected orders across MANY SYMBOLS within the window -> soft kill.
//
// ⚠ NOT "many rejections". A single unreachable instrument produces five in half an hour, and on 2026-10-01
// that soft-killed the desk for 62 minutes while the instrument concerned was already being scoped out. The
// breaker's job is the fault no per-instrument guard can see — the venue logged us out, the bridge died — and
// those arrive as BREADTH. See `killswitch.breakerDecision` for the policy and `store.countRejectedSymbolsSince`
// for the measurement.
async function maybeTripBreaker(userId, settings) {
  const { raw, symbols } = await store.countRejectedSymbolsSince(userId, CB_WINDOW_MIN);
  const d = breakerDecision({ raw, symbols, currentTier: settings.kill?.tier });
  if (d.tripped) {
    await killswitch.setTier(userId, settings, 'soft', { reason: d.reason, alert: true });
    return true;
  }
  return false;
}

// ★★ EXE-14 S4 (2026-10-02) — THE GATE, PURE, SO IT CAN BE PROVED IN **BOTH** DIRECTIONS.
//
// `openTrade` cannot be exercised without a bridge, a ledger and a filled order, so the decision that matters —
// MAY this entry's levels be moved to the fill? — is taken here instead, where a test can drive it. A gate that
// is only ever tested on the ALLOW path is not a gate: the whole risk of EXE-14 is the case where it acts when
// it should not.
//
// Three answers, and the ORDER is the safety property:
//   1. the switch is not exactly `true`  -> do nothing (DEFAULT OFF; absent means off, never "unset means on")
//   2. the strategy is frozen            -> do nothing (moving a TRD-29 forward track's levels voids it)
//   3. the shift is a full stop or more  -> do nothing (`anchor_stale`: this is no longer the deliberated trade)
// Only then is a target computed, and `reanchorLevels` is exact — the span is preserved, so the risk distance
// the desk sized for does not move with the levels.
//
// ⚠ `frozen` is INJECTED rather than looked up, because `frozenTrack.isFrozenStrategy` fails CLOSED on an
// unresolvable id and that rule belongs to it, not to a second copy here. The caller passes its verdict.
function fillAnchorPlan({ settings, strategyId = null, levels, decisionPrice, fillPrice, frozen = null }) {
  const cfg = (settings && settings.risk && settings.risk.fillAnchoredStop) || {};
  if (cfg.enabled !== true) return { act: false, reason: 'disabled' };
  if (frozen && frozen.isFrozen) return { act: false, reason: 'frozen_strategy', frozenReason: frozen.reason || null };
  const target = reanchorLevels({
    stopPrice: levels && levels.stop, takeProfitPrice: levels && levels.tp,
    decisionPrice, freshPrice: fillPrice,
  });
  if (!target.ok) {
    return { act: false, reason: target.reason, shift: target.shift ?? null, shiftPct: target.shiftPct ?? null, stopDist: target.stopDist ?? null };
  }
  return { act: true, reason: null, target, strategyId };
}

async function openTrade(userId, settings, { symbol, direction, size, decisionId = null, note = null, stopPrice = null, takeProfitPrice = null, strategyId = null, origin = 'agent', decisionPrice = null, decisionPriceAsOf = null, priceVenue = null, pairId = null }, { keepOpen = false } = {}) {
  symbol = String(symbol || '').trim();
  if (!symbol) return { placed: false, reason: 'symbol_required' };
  if (!['buy', 'sell'].includes(direction)) return { placed: false, reason: 'direction_must_be_buy_or_sell' };
  const sizeNum = Number(size);
  if (!Number.isFinite(sizeNum) || sizeNum <= 0) return { placed: false, reason: 'size_must_be_positive' };
  // Normalise the levels ONCE, before anything is written or placed: a refused level means no
  // order is sent to the venue, so this must come before placeOrder and outside the try.
  const stop = level(stopPrice), tp = level(takeProfitPrice);
  if (!stop.ok || !tp.ok) return { placed: false, reason: 'level_must_be_positive_number' };
  if (settings.kill?.tier !== 'off') return { placed: false, reason: 'kill_' + settings.kill.tier, tier: settings.kill.tier };

  // TRD-52: a closed instrument is not a REFUSED order, it is a QUEUED one, and the desk paid for that
  // difference with Trades 1033. Plus500 accepted a size-1 Gold buy at 01:14:46 SGT on a Sunday night
  // — the wakes either side of it both logged `market_closed / all venues closed` — queued it for the
  // session open, and filled it five hours later. The desk had already written it off as rejected, so
  // it met its own order as a stranger (Trades 1034) and then let that order block every entry for 45
  // minutes. The wake path refuses closed instruments already; this covers the order path that does
  // not go through a wake.
  //
  // Logged as `order_blocked`, NOT `order_rejected`: the circuit breaker and the self-health rejection
  // counter both read order_rejected, and a policy refusal must not trip either (the TRD-43 asymmetry).
  const venueSession = await getConnector(settings).getSession(symbol);
  const shut = sessionClosed(venueSession);
  if (shut.closed) {
    await store.logEvent(userId, 'order_blocked', {
      symbol, direction, size: sizeNum, intent: 'open',
      reason: 'market_closed', detail: shut.reason, nextOpenAt: shut.nextOpenAt,
    }).catch(() => {});
    return { placed: false, reason: 'market_closed', nextOpenAt: shut.nextOpenAt, detail: shut.reason };
  }

  // ★★ 2026-09-28 — "IT IS BUYING ARABICA COFFEE EVEN THOUGH THE MARKET IS CLOSED." AN ENTRY NEEDS THE VENUE
  // TO SAY **OPEN**, NOT MERELY NOT-CLOSED.
  //
  // WHY THE GUARD ABOVE MISSED IT, and the reason this is a separate check rather than a wider one: the
  // session feed's rich source is `OPositionsList` — THE DESK'S OWN OPEN POSITIONS (sessionFeed.js harvest).
  // `sessionFeed.get(symbol)` returns null for any instrument the desk does not already hold, and
  // `sessionState` treats that null as `open` (the documented "unknown -> allow" rule in `sessionClosed`).
  // ⇒ **the feed can only know the session of instruments the desk is ALREADY IN, which is precisely NOT the
  // set it needs to decide about.** Every CANDIDATE entry is therefore unknown, so the old guard could not
  // fire where it mattered: it protected the symbols that were already open and waved through the new ones.
  //
  // MEASURED, 2026-09-28 (the day the owner raised it): EVERY submit for a HELD symbol succeeded
  // (Gold/Silver/SGX, `ok:true`) and EVERY submit for a symbol with no open position FAILED `ambiguous` after
  // ~45 s — Arabica Coffee x4 and Sugar x3, "position row did not appear after submit", each leaving a venue
  // order the desk could not see (TRD-EXE-1). At 07:07-07:09Z that day it was still happening live:
  // decision #106470 took an Arabica entry (`sessionLock false`, `session: "open"`), #106482 submitted it,
  // and 45,652 ms later the venue still had not shown a position.
  //
  // ⚠ WHY THIS IS PER-SYMBOL AND NOT AN `ENTRY_LOCK_STATES` ENTRY, which is the obvious-looking fix and is
  // WRONG HERE: `aggregator.js` derives its lock from the AGGREGATE state and `pickProposal` then blocks
  // EVERY proposal, so one unheld symbol would stop the whole desk trading. The symbol is known only HERE.
  //
  // ⚠ AND WHY IT IS GATED ON THE FEED BEING USABLE. A feed that is detached, silent, or has no entries at all
  // (the paper connector, a dead bridge) cannot be asked the question, and refusing on ITS silence would be a
  // larger intervention than the defect — the same asymmetry `sessionClosed` already documents. So the stricter
  // rule applies only when the desk is demonstrably receiving sessions (it knows some symbol's), and the old
  // behaviour is preserved exactly when it is not.
  const feed = require('../plus500/sessionFeed');
  const feedStatus = feed.status();
  const feedUsable = !!(feedStatus && feedStatus.attached && !feedStatus.silent && feed.summary().length > 0);
  // ⚠⚠ TRD-EXE-16 (2026-10-01): I TRIED TO RELAX THIS, AND THE EVIDENCE SAYS NOT TO. Recorded so the next
  // reader does not have the same idea.
  //
  // The argument FOR relaxing is real and I hit it live: the feed's only rich source is `OPositionsList` — the
  // desk's own positions — so `isOpen` is null for every instrument the desk does not hold, and because
  // `feedUsable` needs a NON-EMPTY registry, the gate arms the moment the desk holds anything. Measured: with
  // Silver/Bitcoin/Arabica/Gold held, Oil and Sugar were refused at 00:32:58, 00:40:33/36/47 and 00:44:35, while
  // the same call on Gold passed in the same minute. In the steady state that is EVERY new instrument, so the
  // desk could not open a name it did not already own.
  //
  // ★ BUT `test/venue-session-guard.test.js` DOCUMENTS WHY THE STRICT FORM IS HERE, AND IT OUTRANKS THE
  // ARGUMENT. The guard was tightened to demand a POSITIVE verdict precisely because "unknown -> allow" was an
  // OWNER-RAISED defect — "it is buying Arabica Coffee even though the market is closed" — and the measurement
  // was: every submit for a HELD symbol succeeded, every submit for a symbol with NO position failed `ambiguous`
  // after ~45s (Arabica x4, Sugar x3), EACH LEAVING A VENUE ORDER THE DESK COULD NOT SEE.
  //
  // So "unknown -> allow" is not a hypothetical risk, it is a measured 7-occurrence harm — and my case for
  // relaxing had ZERO measured occurrences of an entry actually lost. I had a plausible story and no count,
  // which is the exact failure mode this desk keeps finding in its own analysis. A story is not evidence.
  //
  // ★★ THE CORRECT FIX IS TO SUPPLY THE MISSING EVIDENCE, NOT TO RELAX THE STANDARD. The verdict IS obtainable:
  // the harvest also reads `SingleTradeInstrument` — the instrument the venue page is FOCUSED on — so focusing a
  // candidate before this gate would give a real answer for a symbol the desk does not hold. That belongs
  // upstream of here (the gate must stay before `placeOrder`), it touches the venue card, and it therefore needs
  // a verification design of its own. Until then the strict guard stays and a new instrument is refused, which
  // is the safe direction to be wrong in.
  // ★★ TRD-EXE-16 (2026-10-01): SUPPLY THE EVIDENCE INSTEAD OF LOWERING THE STANDARD.
  //
  // The condition below stays `!== true` — see the note above it, and test/venue-session-guard.test.js, which
  // records that "unknown -> allow" was an owner-raised DEFECT with seven measured failures (Arabica x4, Sugar
  // x3), each leaving a venue order the desk could not see. I tried relaxing this and the evidence said no.
  //
  // What was actually missing was not a looser rule but the EVIDENCE the rule asks for. The venue publishes an
  // instrument's session on `SingleTradeInstrument` whenever the page focuses it, and the harvest already reads
  // that. So before refusing, focus the instrument — navigation only, no ticket, no order — and re-ask.
  //
  // ⚠ THE CHANGE IS MONOTONE. A probe that fails, times out, or lands on the wrong instrument leaves the verdict
  // exactly as it was and the block fires exactly as before. The ONLY outcome that changes is a venue
  // affirmatively reporting OPEN, which is strictly better evidence than the absence it replaces. The desk
  // therefore cannot be moved into a state it would not have entered given a known-open session.
  //
  // ⚠ AND IT IS SWITCHABLE WITHOUT A CODE CHANGE: `risk.sessionPrime = false` restores today's behaviour exactly.
  // Absent means ENABLED, because the default direction of failure here is a wasted navigation, not a bad order.
  let primeNote = null;
  if (feedUsable && feed.isOpen(symbol) !== true) {
    const primeOn = !(settings && settings.risk && settings.risk.sessionPrime === false);
    if (primeOn) {
      try {
        const connector = getConnector(settings);
        if (typeof connector.probeSession === 'function') {
          const probe = await connector.probeSession(settings, symbol);
          // ⚠⚠ MEASURED LIVE 2026-10-01, AND IT IS A FALSE NEGATIVE IN THE OTHER DIRECTION. The first real run
          // logged `not_focused: title_mismatch` while `venueSaysOpen: true` in the SAME event — the probe had
          // worked. The chart title is a PROXY for "did the page move", and the venue did not render it inside
          // the wait window; the session payload arrived anyway. So the note now says only what it can support:
          // the LANDING was not confirmed. The VERDICT is the authority and it is recorded beside it, which is
          // why the gate opened correctly despite the note.
          primeNote = probe && probe.focused ? 'focused' : `landing_unconfirmed: ${probe ? probe.reason : 'no_result'}`;
          // The venue's payload arrives on the page's own JSON stream and the harvest is passive, so poll the
          // feed rather than assuming it landed. Bounded: ~2s, and only on the path that would otherwise refuse.
          for (let i = 0; i < 8 && feed.isOpen(symbol) !== true; i++) {
            await new Promise((r) => setTimeout(r, 250));
          }
          await store.logEvent(userId, 'session_probe', {
            symbol, intent: 'open', primeNote, venueSaysOpen: feed.isOpen(symbol),
            // ★ B1a: the venue's OWN live price, read on the page we are already standing on, against the price
            // the decision was built from. RECORDED ONLY — no level moves, so this cannot touch the frozen
            // TRD-29 track. The gap is the stale-price drift, and it is the measurement that decides whether the
            // adverse fill skew collapses with a fresh reference or is genuine adverse selection.
            venueBuy: probe && probe.buy != null ? probe.buy : null,
            venueSell: probe && probe.sell != null ? probe.sell : null,
            venueMid: probe && probe.venueMid != null ? probe.venueMid : null,
            // ★ TRD-EXE-18: WHICH SOURCE PRODUCED THE VENUE PRICE. Measured live 2026-10-01: `venueMid` was null
            // on 2 of 2 events because the price the navigation had already obtained was discarded one layer up.
            // Recording the source is what makes the next check decisive — it separates "the read failed" from
            // "we read the wrong place", and a null venue price alone cannot tell those apart.
            venuePriceSource: probe && probe.priceSource ? probe.priceSource : null,
            decisionPrice: Number(decisionPrice) || null,
            staleDriftPct: probe && probe.venueMid != null && Number(decisionPrice) > 0
              ? +(((probe.venueMid - Number(decisionPrice)) / Number(decisionPrice)) * 100).toFixed(4)
              : null,
            note: 'focused the instrument to learn its session before refusing the entry; navigation only. The '
              + 'venue price is recorded beside the decision price and NO LEVEL IS CHANGED (TRD-EXE-17).',
          }).catch(() => {});
        } else primeNote = 'connector_has_no_probe';
      } catch (err) { primeNote = `probe_threw: ${String(err && err.message).slice(0, 80)}`; }
    } else primeNote = 'disabled';
  }
  if (feedUsable && feed.isOpen(symbol) !== true) {
    const verdict = feed.isOpen(symbol);
    await store.logEvent(userId, 'order_blocked', {
      symbol, direction, size: sizeNum, intent: 'open',
      reason: 'venue_session_unconfirmed',
      venueSaysOpen: verdict,
      // ⚠ two DIFFERENT unknowns share this one number: `instrument_absent` (the desk does not hold it, the
      // normal case for a candidate) and `session_unknown` (the feed has an entry but its IsTraded was null).
      // The prose distinguished CLOSED from UNKNOWN but not these two, so a coverage gap and a missing holding
      // read alike. `feed.get` resolves which it is.
      detail: `the venue's session for ${symbol} is ${verdict === false ? 'CLOSED' : (feed.get(symbol) ? 'UNKNOWN' : 'UNKNOWN (instrument not held)')} while the desk holds sessions for ${feed.summary().length} other symbol(s)`,
      sessionProbe: primeNote,
      note: 'the session feed can only report instruments the desk already holds (its source is the venue\'s open-position list), so an entry candidate is UNKNOWN by default — and unknown is not a licence to submit (TRD-EXE-16 focuses the instrument first so this refusal is made on evidence rather than on absence). Refusing costs an opportunity; submitting to a shut venue costs a ~45s stall and an order the desk cannot see (TRD-EXE-1).',
    }).catch(() => {});
    return { placed: false, blocked: true, reason: 'venue_session_unconfirmed', venueSaysOpen: verdict };
  }

  // ★★ TRD-EXE-1 (2026-09-28): ONE UNRESOLVED SUBMIT PER SYMBOL — THE RETRY GUARD.
  //
  // `status='unconfirmed'` means the desk SENT an order and does not know whether the venue took it.
  // Nothing refused a second submit for that symbol, so a wake that still liked the signal simply sent
  // another one. Measured 2026-09-28: SEVEN submits in 100 minutes — Arabica Coffee x4 (8.6695 units)
  // and Sugar x3 (30.9739) — every one recorded `ambiguous`, while the venue was holding ALL of them in
  // its ORDER BOOK. The owner had to cancel them by hand. **One stale order became seven**, and each
  // extra one is unmanaged exposure the desk has no row, no stop and no P&L for.
  //
  // The guard is per SYMBOL and deliberately blunt: the desk does not know its own position for that
  // symbol, so it must not add to it. It is a POLICY refusal, not a venue rejection, so it returns
  // `blocked: true` — self-health's drift check counts "approved entries that never filled", and a
  // working guard must not report as a broken one (the TRD-43 asymmetry) — and it logs `order_blocked`
  // rather than `order_rejected` for the same reason: the circuit breaker and the rejection counter
  // both read the latter, so a policy refusal must not feed either.
  //
  // ★ IT DOES NOT RESOLVE THE ROW ITSELF, ON PURPOSE. Resolution is reconcile's job, and this runs
  // inside a wake that already holds the venue lock (`keepOpen: true` from wakePipeline), so a nested
  // mirror cycle here would contend for the very page it is holding. The mirror cycle runs every ~60 s
  // and either MATCHES the row to a venue position or expires it, so the refusal is bounded by that
  // cadence — and the AGE is named in the refusal, so a symbol stuck past its TTL is visible rather
  // than merely quiet. That is the difference between a bounded refusal and a dead control.
  const pending = await store.getUnconfirmedTrades(userId).catch(() => []);
  const unresolved = pendingFor(pending, symbol);
  if (unresolved) {
    const ageMin = ageMinutes(unresolved);
    const stale = ageMin != null && ageMin > UNCONFIRMED_TTL_MIN;
    await store.logEvent(userId, 'order_blocked', {
      symbol, direction, size: sizeNum, intent: 'open',
      reason: 'unconfirmed_pending',
      blockingTradeId: unresolved.id, ageMin, ttlMin: UNCONFIRMED_TTL_MIN, stale,
      detail: `#${unresolved.id} ${unresolved.symbol} ${unresolved.direction} submitted `
        + `${ageMin == null ? 'at an unreadable time' : ageMin + 'm ago'} is still awaiting reconciliation`,
      note: stale
        ? `the pending submit is PAST its ${UNCONFIRMED_TTL_MIN}m TTL and reconcile has not resolved it yet — this refusal is bounded by the next mirror cycle, so a symbol STUCK here means that cycle is not running`
        : 'the desk does not know whether it holds this symbol, so it will not add to it (TRD-EXE-1)',
    }).catch(() => {});
    return { placed: false, blocked: true, reason: 'unconfirmed_pending', blockingTradeId: unresolved.id, ageMin };
  }

  const open = await store.getOpenTrades(userId);
  // TRD-12: the cap guards the AGENT's positions — the user's mirrored
  // Plus500 rows (origin 'venue') and dashboard-submitted rows (origin
  // 'manual') don't count. Origin is authoritative; the note check stays
  // as a fallback for legacy rows.
  const agentOpen = open.filter((t) => String(t.origin || 'agent') === 'agent'
    && !String(t.note || '').includes('mirrored from Plus500'));
  const maxPos = Number(settings.risk?.maxPositions);
  if (Number.isFinite(maxPos) && agentOpen.length >= maxPos) return { placed: false, reason: 'cap_max_positions', maxPositions: maxPos };
  const today = await store.countNewTradesToday(userId);
  const dailyCap = Number(settings.risk?.maxNewTradesPerDay);
  if (Number.isFinite(dailyCap) && today >= dailyCap) return { placed: false, reason: 'cap_daily_trades', maxNewTradesPerDay: dailyCap };

  // ---- F20 (18/09): anchor at SUBMIT, not at the snapshot ------------------------------------------
  // The levels arrived as absolute prices derived from the decision snapshot; the venue will fill at
  // whatever price it finds. Re-reading the symbol's own newest tick at the SAME venue the decision
  // used, and shifting both levels by the move, makes the geometry that reaches the venue the geometry
  // the owner accepted (see reanchorLevels — the shift is exact and preserves the risk).
  //
  // A tick read that fails is INERT on purpose: F17's gate is the safety control and it runs upstream,
  // so this is a refinement and must never become a new way for an approved entry to die. The refusal
  // below is a DECISION, not a read failure, and it does block.
  //
  // 2026-09-18, an hour after this shipped, it had been inert for ELEVEN consecutive agent entries and
  // nothing said so. `fresh.mid` read a column that does not exist on PriceTicks — the table stores
  // bid/ask and the code computes the mid with `midOf` — so the price was NaN, every branch was skipped,
  // and an inert control that reports nothing is indistinguishable from a working one. That is exactly
  // the F32 defect class, written into the fix for F20. The skip is now NAMED every time.
  const dp = Number(decisionPrice);
  let levels = { stop: stop.value, tp: tp.value };
  let reanchor = null;
  // ★ 2026-10-05 (additive telemetry, owner-approved): spread-at-signal state. Captured from the SAME tick
  // read the re-anchor performs when it runs — this adds no query of its own. NULL when no venue price source
  // exists for this entry, and NULL is the honest value: a spread that was never read must not be invented.
  let signalSpread = { pct: null, tickAgeSec: null };
  // ⚠ TRD-EXE-11 (#1489): ONE VARIABLE WAS DOING TWO JOBS AND ITS NAME DESCRIBED NEITHER OF THEM.
  //
  // `reanchorNote` is WHY THE RE-ANCHOR DID NOT RUN. That is a DEGRADATION, not a gate: the levels are posted as
  // computed from the decision snapshot, which IS the F20 behaviour, and the reason is recorded on the trade. It
  // MUST NOT become a gate — the venue tick series is frozen during entries (measured: 0 available ticks in 30 of
  // 30 windows), so `no_fresh_tick` is the COMMON case, and gating on it would stop the desk trading at all.
  //
  // `blockReason` is the OTHER family, and it IS a gate. These three say THE ORDER IS NOT FIT TO PLACE, and they
  // used to fall into the same variable — so an entry with `levels_missing` reached the venue with `stopPrice:
  // null` and `takeProfitPrice: null`, **A POSITION WITH NO STOP AT ALL**, while the only record of it read as a
  // re-anchor note. The two families have OPPOSITE correct behaviours, which is why one name could not be right.
  let reanchorNote = null;
  let blockReason = null;
  if (stop.value == null || tp.value == null) blockReason = 'levels_missing';
  else if (!(dp > 0)) blockReason = 'decision_price_missing';
  if (blockReason) {
    await store.logEvent(userId, 'order_blocked', {
      symbol, direction, size: sizeNum, intent: 'open', reason: blockReason,
      decisionPrice: Number.isFinite(dp) ? dp : null, priceVenue: priceVenue || null,
      stopPrice: stop.value == null ? null : stop.value,
      takeProfitPrice: tp.value == null ? null : tp.value,
      note: 'refusing rather than submitting an order the desk cannot describe: without BOTH levels the venue '
        + 'carries no stop at all, and without a decision price the geometry the desk records is meaningless',
    }, { actor: 'system:executor', level: 'warn' }).catch(() => {});
    return { placed: false, reason: blockReason, priceVenue: priceVenue || null };
  }
  // `price_venue_missing` deliberately STAYS a note and does NOT join the gate above. The venue stop still
  // protects the position without a tick source, the desk has no evidence it should refuse, and the existing pin
  // in `test/entry-anchor.test.js` states the intent plainly: a missing venue must SKIP the comparison, not cross
  // it. It skips the tick read exactly as before.
  // ⚠ The three gate conditions have NEVER fired in the recorded history (0 `reanchor_skipped` events of any
  // reason), so this gate is a correctness fix that changes no observed behaviour - which is also why it carries
  // no evidence about how often it will fire. It is logged as `order_blocked` so the first occurrence is visible.
  if (!priceVenue) reanchorNote = 'price_venue_missing';
  // ⚠⚠ TRD-EXE-15 (2026-10-01): GIVE THE RE-ANCHOR A PRICE THE DECISION DID NOT COME FROM.
  //
  // `quant.js` builds the decision price from `ticks.latestTick`, and this block used to read `latestTick` AGAIN
  // for the "fresh" price. For an instrument the desk does not hold nothing writes a new tick in between, so both
  // reads returned THE SAME ROW and `shift` was 0 in 73 of 73 events — the control measuring the desk against
  // itself. `staleTickForDecision` then made that honest; this makes it USEFUL, by preferring a price read off the
  // venue's own page.
  //
  // ★ IT NEEDS NO WRITE PATH. The re-anchor runs BEFORE `placeOrder`, so the shifted levels are simply the ones
  // submitted — no post-fill edit, no new DOM capability. That is what makes this far cheaper than EXE-14 despite
  // being the same idea, and it is why it is being built first.
  //
  // ⚠ GATED AND DEFAULT OFF, FOR THE SAME REASON AS EXE-14: it MOVES THE STOP LEVEL, and the frozen forward
  // candidate (TRD-29) must not have its levels moved. `risk.reanchorToLive` absent means OFF.
  // ★★ S5 (2026-10-01): THE INLINE LIST IS GONE, AND THE HUNT FOR A REAL MARKER IS DONE.
  //
  // What stood here was `const FROZEN_STRATEGIES = ['survgold','survoil']` with a note saying a genuine marker was
  // still required and that `params: []` could not serve. The hunt found NO marker existed at all — freeze-ness
  // lived only in prose — and `params: []` was measured to be true of all 18 survivors AND replicas, because it is
  // a property of the generator rather than of the frozen pair. A marker has now been created on the strategies
  // themselves (`forwardFrozen`) and is read through ONE implementation shared with EXE-14.
  //
  // ⚠ NOTE THE GATE'S FAIL-CLOSED RULE, WHICH IS NOT THE OBVIOUS ONE: no strategy id at all (an owner/dashboard
  // order) is ALLOWED, because it cannot be part of a frozen track; an id that does NOT RESOLVE is REFUSED,
  // because an id the desk cannot look up is one whose freeze status is unknown. See frozenTrack.js.
  const { frozenReason } = require('./frozenTrack');
  const frozen = frozenReason(strategyId);
  const reanchorLive = !!(settings && settings.risk && settings.risk.reanchorToLive === true)
    && !frozen.frozen;
  if (!reanchorNote) {
    try {
      // ⚠ A PROBE THAT FAILS IS NOT AN ERROR HERE. The venue price is an IMPROVEMENT on the desk's own tick; if it
      // cannot be read the existing path runs unchanged, which is the behaviour the desk has today.
      let venuePx = null;
      if (reanchorLive) {
        try {
          const probe = await getConnector(settings).probeSession(settings, symbol);
          venuePx = probe && probe.venueMid != null ? probe.venueMid : null;
        } catch { /* fall through to the desk's own tick */ }
      }
      const fresh = await ticks.latestTick(userId, symbol, priceVenue);
      const tickPx = fresh ? ticks.midOf(fresh) : null;
      // ★ 2026-10-05 (additive telemetry): the desk tick's OWN round-trip spread, 6 dp — what the desk could
      // see at decision time — plus the tick's age, because a spread from a 3-minute-old tick is a different
      // fact. Same row the re-anchor compares against; no extra read.
      if (fresh) {
        const sb = Number(fresh.bid), sa = Number(fresh.ask);
        const smid = ticks.midOf(fresh);
        if (sb > 0 && sa > 0 && smid > 0 && sa >= sb) signalSpread.pct = +(((sa - sb) / smid) * 100).toFixed(6);
        if (fresh.capturedAt) {
          const tickAge = Math.round((Date.now() - new Date(fresh.capturedAt).getTime()) / 1000);
          if (Number.isFinite(tickAge)) signalSpread.tickAgeSec = Math.max(0, tickAge);
        }
      }
      // ⚠ WHICH SOURCE WAS USED IS RECORDED, not inferred from whether the shift is non-zero. A venue price that
      // happens to equal the decision price and a tick that is simply old both produce shift = 0, and they are
      // very different facts — the first means the market did not move, the second means nothing was measured.
      const freshPx = venuePx != null ? venuePx : tickPx;
      const freshSource = venuePx != null ? 'venue_page' : 'desk_tick';
      if (!(Number.isFinite(freshPx) && freshPx > 0)) {
        reanchorNote = venuePx == null && !fresh ? 'no_fresh_tick' : 'fresh_tick_has_no_price';
      } else if (freshSource === 'desk_tick' && staleTickForDecision(fresh, decisionPriceAsOf)) {
        // ⚠⚠ TRD-EXE-15 (2026-10-01): THE "FRESH" PRICE IS READ FROM THE SAME TABLE THE DECISION PRICE CAME FROM.
        //
        // `quant.js:383` reads `ticks.latestTick` to build the DECISION price. This block reads `latestTick` again
        // for the "fresh" price. For an instrument the desk does NOT hold, nothing writes a new tick in between —
        // plus500's ticks come from `position_poll`, i.e. from positions the desk already has — so BOTH READS
        // RETURN THE SAME ROW, and `shift = fresh - decision` is 0 BY CONSTRUCTION rather than because the market
        // was calm.
        //
        // Measured 2026-10-01: **73 `entry_reanchored` events, 73 with `shift = 0`** — every one, against a fill
        // drift the same entries recorded at 74% adverse / 1.083x average. And the newest tick at each open was
        // 39-132s old. So the control was not observing a quiet market. It was measuring the desk against itself.
        //
        // ★ THIS CHANGES NO LEVEL. A `shift` of 0 shifts nothing, so refusing to CALL it a success alters only the
        // record. But that is the whole point: the plan read this control as "inert", and an inert control that
        // reports success is indistinguishable from a working one (F32) — which is how the four entries above were
        // summarised as "the re-anchor ran" when it had measured nothing at all. The live behaviour is identical;
        // the claim about it is now true.
        //
        // ⚠ AND IT DOES NOT BLOCK. `reanchorNote` is a DEGRADATION, not a gate — the venue tick series moves
        // slowly by construction, so gating on this would stop the desk entering, which is a far larger change
        // than the one being described. The levels still post from the decision snapshot, exactly as F20 intends.
        reanchorNote = 'no_tick_since_decision';
        await store.logEvent(userId, 'reanchor_no_tick', {
          symbol, direction, size: sizeNum, intent: 'open', priceVenue,
          decisionPrice: dp, decisionPriceAsOf: decisionPriceAsOf || null,
          tickCapturedAt: fresh.capturedAt || null, tickPrice: freshPx,
          tickAgeSec: fresh.capturedAt ? Math.round((Date.now() - new Date(fresh.capturedAt).getTime()) / 1000) : null,
          note: 'the venue tick is not newer than the price the decision was built from, so the re-anchor has '
            + 'nothing to compare and must not report a shift of zero as agreement. Levels unchanged (a zero '
            + 'shift shifts nothing), so this alters the record and not the order (TRD-EXE-15).',
        }, { actor: 'system:executor', level: 'warn' }).catch(() => {});
      } else {
        const ra = reanchorLevels({ stopPrice: stop.value, takeProfitPrice: tp.value, decisionPrice: dp, freshPrice: freshPx });
        if (ra.ok) {
          levels = { stop: ra.stopPrice, tp: ra.takeProfitPrice };
          // ★ S5: the gate's verdict travels with the re-anchor, so "the level did not move" is distinguishable
          // from "the venue price was unavailable" — the two produce the same shift and different causes.
          reanchor = { ...ra, freshSource, venuePx, gate: frozen.reason };
        } else if (ra.reason === 'anchor_stale') {
          await store.logEvent(userId, 'order_blocked', {
            symbol, direction, size: sizeNum, intent: 'open', reason: 'anchor_stale',
            detail: `the price moved ${ra.shiftInStops.toFixed(2)} stop distances (${ra.shiftPct}%) between the decision and the ticket`,
            decisionPrice: dp, freshPrice: freshPx, priceVenue, shift: ra.shift, stopDist: ra.stopDist,
            note: 'refusing rather than re-anchoring into a position whose stop is already at the money (F20)',
          }, { actor: 'system:executor', level: 'warn' }).catch(() => {});
          return { placed: false, reason: 'anchor_stale', shift: ra.shift, shiftInStops: ra.shiftInStops, priceVenue };
        } else reanchorNote = ra.reason;
      }
    } catch (err) { reanchorNote = `read_failed: ${String(err && err.message).slice(0, 80)}`; }
  }

  // TRD-ANC-1 (2026-09-25): THE ANCHOR-AGE GATE, and the reason it is the available lever.
  //
  // The levels are built from a snapshot price and the position opens at the venue's FILL. Measured on 30
  // entries: the anchor is 1-3s old at the snapshot but the fill lands a **median 65s** later (max 524s),
  // and the drift grows with it (|drift| 0.016% youngest half vs 0.043% oldest, Spearman +0.305).
  //
  // ★ The venue's own `priceTickStale` cannot catch this: `TICK_SLA_MS` is **15 minutes**, so it returned
  // false on a **427-second-old** price (#1082, the largest drift in the whole set). And the re-anchor's
  // only refusal is a PRICE-distance test, not an age test — and it is inert anyway, because the venue tick
  // series is FROZEN during an entry (0 available ticks in 30 of 30 windows).
  //
  // ★ OFF BY DEFAULT. Absent/non-positive means NOT GATED, so this changes nothing until the owner sets
  // `risk.maxAnchorAgeSec`. See `exitLevels.anchorAgeGate` for the three-valued contract and why it
  // REFUSES rather than clamps.
  const dpAsOf = decisionPriceAsOf == null || decisionPriceAsOf === '' ? null : decisionPriceAsOf;
  const anchorAge = anchorAgeSec({ asOf: dpAsOf });
  const ageGate = anchorAgeGate({
    anchorAgeSec: anchorAge,
    maxAgeSec: settings && settings.risk ? settings.risk.maxAnchorAgeSec : null,
  });
  if (ageGate.refuse) {
    await store.logEvent(userId, 'order_blocked', {
      symbol, direction, size: sizeNum, intent: 'open', reason: 'anchor_too_old',
      detail: `the price the levels were built from was ${anchorAge.toFixed(1)}s old at submit, over the ${ageGate.maxAgeSec}s cap`,
      decisionPrice: dp, decisionPriceAsOf: dpAsOf ? new Date(dpAsOf).toISOString() : null,
      anchorAgeSec: anchorAge, maxAnchorAgeSec: ageGate.maxAgeSec, priceVenue,
      note: 'refusing rather than posting levels anchored to a price older than the configured cap (TRD-ANC-1); '
        + 'the venue tick series is frozen during an entry, so the levels cannot be corrected at submit',
    }, { actor: 'system:executor', level: 'warn' }).catch(() => {});
    return { placed: false, reason: 'anchor_too_old', anchorAgeSec: anchorAge, priceVenue };
  }

  try {
    const connector = getConnector(settings);
    const t0 = Date.now();
    // TRD-TRL-2 (#1485): the venue-native trailing stop, BEST-EFFORT. The venue stop is the mandatory exit and the
    // trail SITS ON IT; a trail the desk cannot state is refused rather than approximated. `entry` is the decision
    // price the levels were built from - the desk's own estimate of the fill - and the bridge re-plans against the
    // LIVE rate, so a stale estimate can only affect which distance is asked for, never how it is verified.
    const trailCfg = (settings && settings.risk && settings.risk.trailingStop) || {};
    const trailingStop = trailCfg.enabled === true
      ? { enabled: true, entry: dp, probePips: trailCfg.probePips }
      : null;
    const fill = await connector.placeOrder(settings, { symbol, direction, size: sizeNum, stopPrice: levels.stop, takeProfitPrice: levels.tp, trailingStop }, { keepOpen, userId });
    // P2-13 (2026-09-10): fill telemetry — slippage = fill vs decision price.
    // ★ TRD-ANC-1 (2026-09-25): THE SIGN IN THE ORIGINAL COMMENT WAS INVERTED. It claimed "signed so
    // positive = filled better than decided (in the trade's favor)". The formula below actually yields
    // POSITIVE = ADVERSE, the industry convention: a buy filling HIGHER and a sell filling LOWER both
    // produce a positive number (verified by evaluating it on a favourable buy and a favourable sell —
    // both come out negative). No arithmetic changed here, only the claim about it: the wrong claim is
    // what an analysis would invert the sign on. `fillDrift().betterThanDecided` is the normalised one.
    // (`dp` is read above: F20 needs it before the order, not after.)
    const slippagePct = dp > 0 && fill.price != null
      ? Math.round(((Number(fill.price) - dp) / dp) * (direction === 'buy' ? 1 : -1) * 10000) / 100
      : null;
    const fillDelayMs = Date.now() - t0;
    // TRD-TRL-2 (#1485): a trail that was ASKED FOR and not placed has to be visible. A refusal never blocked the
    // entry (it happens before the card is touched); an unverified trail throws inside the bridge and never
    // reaches here at all, because an order must not carry a level the desk cannot state.
    if (trailingStop && fill.trailingStop) {
      const t = fill.trailingStop;
      const kind = t.placed ? (t.degraded ? 'trailing_stop_degraded' : 'trailing_stop_placed') : 'trailing_stop_refused';
      await store.logEvent(userId, kind, {
        symbol, direction, ...t,
        note: !t.placed
          ? 'the trail was refused before the ticket card was touched; the venue stop governs'
          : t.degraded
            ? 'the requested distance could NOT be verified, so a trail WIDER than the stop was set instead - the '
              + 'stop still fires first, so this removes the ratchet rather than changing the exit. Investigate: '
              + 'the read-back path may be misreading the venue'
            : 'venue-native trailing stop set on the ticket and read back inside tolerance',
      }, { actor: 'system:executor', level: t.placed && !t.degraded ? 'info' : 'warn' }).catch(() => {});
    }
    // TRD-ANC-1: the geometry the ticket ACTUALLY carries, measured from the FILL. Read-only on purpose —
    // it changes no level, because these levels belong to a FROZEN forward-validation candidate (TRD-29)
    // and moving them would void the track. The observation has to be possible without the change.
    const intendedStopDist = reanchor && Number.isFinite(Number(reanchor.stopDist))
      ? Number(reanchor.stopDist)
      : Math.abs(dp - Number(levels.stop));
    const geometry = fillDrift({
      direction, anchorPrice: dp, fillPrice: fill.price,
      stopPrice: levels.stop, takeProfitPrice: levels.tp, intendedStopDist,
    });
    // ★ 2026-10-05 (additive telemetry): the VENUE's own round-trip spread at submit — from the ticket labels
    // `placeOrder` already had open (no navigation) — and the audit's decision→fill latency as a ROW fact.
    // Both NULL when underivable; neither changes any level, gate or order.
    const submitSpread = (() => {
      const tb = Number(fill.ticketBuy), ts = Number(fill.ticketSell);
      if (!(tb > 0) || !(ts > 0)) return { pct: null, source: null };
      return { pct: +((Math.abs(tb - ts) / ((tb + ts) / 2)) * 100).toFixed(6), source: fill.ticketSource || null };
    })();
    const signalToFillSec = (() => {
      if (!dpAsOf || !fill.filledAt) return null;
      const ms = new Date(fill.filledAt).getTime() - new Date(dpAsOf).getTime();
      return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : null;
    })();
    const id = await store.createTrade(userId, {
      symbol, direction, size: sizeNum,
      units: fill.units ?? null,
      openPrice: fill.price ?? null,
      openAt: fill.filledAt ? new Date(fill.filledAt) : new Date(),
      plus500PositionId: fill.positionId ?? null,
      status: 'open',
      decisionId,
      note: note || 'executor open',
      origin: origin || 'agent',
      stopPrice: levels.stop,
      takeProfitPrice: levels.tp,
      // TRD-12 light order state machine: when + how long the fill took.
      filledAt: fill.filledAt ? new Date(fill.filledAt) : new Date(),
      fillDelayMs,
      strategyId: strategyId || null,
      slippagePct,
      pairId: pairId || null,
      spreadSignalPct: signalSpread.pct,
      signalTickAgeSec: signalSpread.tickAgeSec,
      spreadSubmitPct: submitSpread.pct,
      spreadSubmitSource: submitSpread.source,
      signalToFillSec,
      anchorAgeSec: anchorAge == null ? null : +Number(anchorAge).toFixed(3),
    });
    await store.logEvent(userId, 'fill_telemetry', {
      symbol, direction, size: sizeNum, decisionPrice: dp || null, fillPrice: fill.price ?? null,
      slippagePct, fillDelayMs, strategyId: strategyId || null, at: new Date().toISOString(),
      // 2026-10-05 (additive telemetry): spread + latency, mirrored from the trade row. `anchorAgeSec` is
      // ALREADY recorded below by TRD-ANC-1 (raw float) — deliberately NOT repeated here.
      spreadSignalPct: signalSpread.pct, signalTickAgeSec: signalSpread.tickAgeSec,
      spreadSubmitPct: submitSpread.pct, spreadSubmitSource: submitSpread.source,
      signalToFillSec,
      // TRD-ANC-1: the drift and the realised geometry, so what the ticket ACTUALLY carries is a recorded
      // fact rather than something each analysis re-derives — and gets wrong. `Trades.slippagePct` cannot
      // serve this: `autopsy.js` overwrites it with the EXIT slippage on close (measured 27 of 29 rows).
      driftPct: geometry.ok ? geometry.driftPct : null,
      betterThanDecided: geometry.ok ? geometry.betterThanDecided : null,
      worseEntry: geometry.ok ? geometry.worseEntry : null,
      beyondWarn: geometry.ok ? geometry.beyondWarn : null,
      // TRD-ANC-1: how old the anchor was at SUBMIT, and whether the gate would have refused it. Recorded
      // unconditionally, so the threshold can be chosen from data no matter how the gate is configured.
      anchorAgeSec: anchorAge,
      decisionPriceAsOf: dpAsOf ? new Date(dpAsOf).toISOString() : null,
      anchorAgeGated: ageGate.gated,
      anchorAgeWouldRefuse: ageGate.gated ? ageGate.refuse : null,
      maxAnchorAgeSec: ageGate.maxAgeSec,
      realisedStopDist: geometry.realisedStopDist == null ? null : geometry.realisedStopDist,
      stopDistPct: geometry.stopDistPct == null ? null : geometry.stopDistPct,
      intendedStopDist,
      stopDistRatio: geometry.stopDistRatio == null ? null : geometry.stopDistRatio,
      realisedRR: geometry.realisedRR == null ? null : geometry.realisedRR,
      // Whether the re-anchor that reported success had in fact moved anything.
      reanchorInert: !!(reanchor && Number(reanchor.shift) === 0),
    }).catch(() => {});
    // TRD-ANC-1: an INERT re-anchor plus a fill beyond the drift WARN band is precisely the case the
    // mechanism exists to catch and cannot. Recorded as its own fact so it cannot pass as a success.
    if (reanchor && Number(reanchor.shift) === 0 && geometry.ok && geometry.beyondWarn) {
      await store.logEvent(userId, 'reanchor_inert', {
        symbol, direction, size: sizeNum, tradeId: id,
        decisionPrice: dp, fillPrice: fill.price ?? null,
        driftPct: geometry.driftPct, worseEntry: geometry.worseEntry,
        realisedStopDist: geometry.realisedStopDist, realisedRR: geometry.realisedRR,
        intendedStopDist,
        note: 'the F20 re-anchor reported success (shift=0) while the fill landed beyond the drift WARN band; '
          + 'it compares the desk own latest tick against the decision price, so it cannot see the venue fill',
        at: new Date().toISOString(),
      }, { actor: 'system:executor', level: 'warn' }).catch(() => {});
    }
    // F20: the re-anchor is OBSERVABLE, not inferred — an entry whose levels moved between the decision
    // and the ticket is a fact the ledger should carry, and it is the only way to tell a working fix
    // from a silent one.
    if (reanchor) {
      await store.logEvent(userId, 'entry_reanchored', {
        symbol, direction, size: sizeNum, tradeId: id, priceVenue,
        decisionPrice: dp, decisionPriceVenue: priceVenue,
        stopBefore: stop.value, tpBefore: tp.value,
        stopAfter: levels.stop, tpAfter: levels.tp,
        shift: reanchor.shift, shiftPct: reanchor.shiftPct, shiftInStops: +reanchor.shiftInStops.toFixed(4),
        stopDist: reanchor.stopDist,
        // ★ TRD-ANC-1: this note used to assert UNCONDITIONALLY that the levels were shifted. Measured
        // 2026-09-25: `shift` is 0 on 30 of 30 events, so it asserted something that had not happened —
        // the "inert control that reports nothing" class the block above this one warns about. The note now
        // says which of the two things actually occurred.
        note: Number(reanchor.shift) === 0
          ? 're-anchor ran but shifted NOTHING (shift=0): the levels still sit on the decision price, and '
            + 'this event cannot see the venue fill, so it does not confirm the ticket matches the decision'
          : 'levels shifted to the price the order was submitted at; risk distance unchanged (F20)',
      }).catch(() => {});
    } else if (origin === 'agent') {
      // The other half of the fix: an inert re-anchor must SAY it was inert. Before this, a NaN price
      // made the block disappear without trace for eleven entries.
      await store.logEvent(userId, 'reanchor_skipped', {
        symbol, direction, size: sizeNum, tradeId: id, reason: reanchorNote,
        priceVenue: priceVenue || null, decisionPrice: dp || null,
        note: 'levels posted as computed from the decision snapshot (F20) — this event exists so an inert re-anchor cannot pass as a working one',
      }).catch(() => {});
    }
    // ══════════════════════════════════════════════════════════════════════════════════════════════════════
    // ★★ EXE-14 S4 (2026-10-02) — ANCHOR THE LEVELS TO THE FILL. **DEFAULT OFF.**
    //
    // WHAT IT FIXES. The levels are computed from the DECISION price and the venue fills later, so both ABSOLUTE
    // levels arrive measured from a price this position never had. Measured live 2026-10-02: `#1151` and `#1125`
    // each carry a realised R:R of **0.652 against a declared 1.5** (floor 0.75) because the fill landed
    // 0.241%/0.243% from the anchor that built them. That IS the whole `field_levels` (F20) finding. Moving both
    // levels by `fill - decision` makes realised R:R equal the declared one BY CONSTRUCTION — `reanchorLevels`
    // is exact (the span is preserved), so the risk the desk sized for is unchanged.
    //
    // ⚠ WHY IT IS OFF, AND WHY THAT IS NOT TIMIDITY: this is the only change in the desk that MOVES A STOP on a
    // LIVE position. It is gated three ways — this switch, the frozen-track gate, and `reanchorLevels`'s own
    // `anchor_stale` refusal (once the market has travelled a full stop distance the trade is no longer the one
    // that was deliberated, and the desk refuses rather than re-anchoring into a position whose stop is already
    // at the money). ⚠ It also moves levels on a FROZEN forward-validation candidate (TRD-29) if that gate were
    // ever removed, which is why the gate is checked FIRST and fails CLOSED on an unresolvable id.
    //
    // ⚠ EVERY ATTEMPT IS JOURNALLED, INCLUDING THE ONES THAT DO NOTHING, AND THE HOLD IS WRITTEN BEFORE ANY
    // WRITE IS ATTEMPTED. A level change that is not recorded is indistinguishable from one that never happened;
    // recording only the successes would lose exactly the attempts that went wrong. Three outcomes get a row:
    // held (frozen), held (could not compute), and the attempt itself with the VENUE'S own read-back.
    //
    // ⚠ IT CANNOT FAIL THE ENTRY. The position is already open and its levels are already at the venue; a level
    // edit that fails leaves a live position that is no worse off than it was a moment ago. So the whole block
    // is contained, and a failure is recorded rather than thrown.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════════
    {
      const { isFrozenStrategy, frozenReason } = require('./frozenTrack');
      const plan = fillAnchorPlan({
        settings, strategyId, levels, decisionPrice: dp, fillPrice: fill.price,
        frozen: { isFrozen: isFrozenStrategy(strategyId), reason: frozenReason(strategyId) },
      });
      // ⚠ NOTHING IS WRITTEN WHEN THE SWITCH IS OFF — not even a "held" row. On a desk that has not enabled the
      // feature that would be one row per entry, forever, saying only that a setting is off; the setting is
      // already legible in the settings journal. Only an ATTEMPT at the feature earns a record.
      if (plan.reason !== 'disabled') {
        const attempt = { tradeId: id, symbol, direction, strategyId: strategyId || null, at: new Date().toISOString() };
        try {
          if (!plan.act) {
            await store.logEvent(userId, 'level_reanchor_held', {
              ...attempt, reason: plan.reason,
              shift: plan.shift ?? null, shiftPct: plan.shiftPct ?? null, stopDist: plan.stopDist ?? null,
              frozenReason: plan.frozenReason ?? null,
              note: plan.reason === 'frozen_strategy'
                ? 'EXE-14 held: moving these levels would void the frozen forward track (TRD-29)'
                : 'EXE-14 could not compute a fill-anchored level, so NO level was moved',
            }, { actor: 'system:executor', level: 'warn' }).catch(() => {});
          } else {
            const target = plan.target;
            let result = null; let error = null;
            try {
              const connector = getConnector(settings);
              result = typeof connector.setPositionLevels === 'function'
                ? await connector.setPositionLevels(settings, { plus500PositionId: fill.positionId ?? null }, {
                  stopPrice: target.stopPrice, takeProfitPrice: target.takeProfitPrice,
                })
                : { ok: false, reason: 'connector_has_no_setPositionLevels' };
            } catch (e) { error = String((e && e.message) || e).slice(0, 200); }
            await store.logEvent(userId, 'level_reanchored', {
              ...attempt,
              decisionPrice: dp, fillPrice: fill.price ?? null,
              stopBefore: levels.stop, tpBefore: levels.tp,
              stopAfter: target.stopPrice, tpAfter: target.takeProfitPrice,
              shift: target.shift, shiftPct: target.shiftPct, shiftInStops: target.shiftInStops,
              // ⚠ THE VENUE'S OWN READ-BACK, NOT THE NUMBER WE TYPED. `webtrader.setPositionLevels` re-reads the
              // position ROW after committing, so `confirmed` means the venue AGREES — and `restoreOk` records
              // whether it had to put the original level back. A level change the venue did not confirm is not a
              // level change, and that distinction is the whole point of EXE-14's verification step.
              venueBefore: result ? result.before : null,
              venueAfter: result ? result.after : null,
              submitLabel: result ? result.submitLabel : null,
              confirmed: !!(result && result.ok),
              restoreOk: result ? result.restoreOk : null,
              error: error || (result && !result.ok ? result.reason : null),
              note: 'EXE-14: levels moved to the FILL so the realised R:R equals the declared one',
            }, { actor: 'system:executor', level: (result && result.ok) ? 'info' : 'warn' }).catch(() => {});
          }
        } catch (e) {
          await store.logEvent(userId, 'level_reanchor_held', {
            ...attempt, reason: 'threw', error: String((e && e.message) || e).slice(0, 200),
            note: 'EXE-14 threw before it could act — NO level was moved; the entry is unaffected',
          }, { actor: 'system:executor', level: 'warn' }).catch(() => {});
        }
      }
    }
    const log = require('./log');
    await log.write(userId, 'trade_opened', { tradeId: id, symbol, direction, size: sizeNum, fill, fillDelayMs }, { actor: 'system:executor', correlationId: log.corrId('order') });
    return { placed: true, tradeId: id, fill, slippagePct };
  } catch (e) {
    // TRD-48 (2026-09-14): classify at the point of failure, and RECONCILE when the outcome is
    // unknown. An `ambiguous` submit — "position row did not appear after submit" — means the desk
    // does not know whether the order landed: the venue may hold a position the desk has no row for,
    // which is an orphan with no stop on either side. The close path has had this since TRD-42; the
    // OPEN path logged the rejection and moved on, so the only reason it has never bitten is that the
    // one occurrence (Trades 1033, 2026-09-13T17:14:46Z) happened to leave the venue flat and the
    // periodic account snapshot incidentally showed it.
    //
    // Safe to fire here even though the desk is mid-wake: `withOrderReliability` released the ticket
    // lock in its own `finally` before rethrowing, so the mirror's cycle can take the page.
    const cls = classifyBridgeError(e);
    // TRD-52: SPLIT the two meanings that were sharing one label. `NEEDS_RECONCILIATION` means the
    // venue may be holding a position the desk has no row for — a RISK fact. Folding it into
    // order_rejected did three wrong things at once: it understated the one failure class that can
    // leave an unmanaged position, it fed the 30-min circuit breaker (so an unconfirmed order could
    // soft-kill the desk), and it taught self-health to count it as a venue refusal. It now has its own
    // kind, its own row state and a resolution path, and it is NOT counted by the breaker.
    const unconfirmed = NEEDS_RECONCILIATION.has(cls);
    // ⚠⚠ TRD-TRL-5 (2026-10-01): A TRAIL VERIFICATION FAILURE IS NOT AN ORDER REJECTION.
    //
    // Measured: 18 `order_rejected` events on 2026-10-01 and EVERY ONE was a trailing-stop abort — not a single
    // venue refusal. On 2026-09-30 there were 9 more. The breaker counts `order_rejected`, so five aborts inside
    // 30 minutes SOFT-KILLED THE DESK at 05:21:25 and it stopped trading. A CONFIGURATION problem reached a
    // SAFETY mechanism built for a different failure, and the dashboard said nothing until someone looked.
    //
    // ★ AND THE ABORT HAPPENS BEFORE ANYTHING IS SUBMITTED. The trail is set on the ticket and verified, and ONLY
    // THEN is the order sent — so a trail abort means THE VENUE NEVER RECEIVED AN ORDER. There is nothing for it
    // to have rejected. Logging it as one misreports what happened to the ledger, to self-health's refusal
    // counter and to the breaker at the same time.
    //
    // ★ SO IT JOINS `order_blocked` — the same asymmetry TRD-43 and TRD-52 already established (see this
    // function's header and the venue-session guard above): the desk DECLINING to submit is not the venue
    // REFUSING, and only the second may trip the breaker. `order_blocked` is also what
    // `venue-session-guard.test.js` requires of a policy refusal, for exactly this reason.
    //
    // ⚠ DETECTED TWO WAYS, ON PURPOSE. `trailEvidence` is the structured signal the bridge attaches to its own
    // abort, but it has to survive `withOrderReliability`'s rethrow to arrive here — and a detection that
    // silently stopped matching would put these straight back into the breaker. The message prefix is the belt
    // to that braces, and a test pins both.
    const trailRefusal = !!(e && e.trailEvidence)
      || /^trailing stop:/i.test(String((e && e.message) || e));
    if (unconfirmed) {
      await require('./log').write(userId, 'order_unconfirmed', {
        symbol, direction, size: sizeNum, intent: 'open',
        reason: String(e.message || e).slice(0, 200), errorClass: cls,
        note: 'outcome unknown — awaiting venue reconcile',
      }, { actor: 'system:executor', level: 'warn' });
    } else if (trailRefusal) {
      await require('./log').write(userId, 'order_blocked', {
        symbol, direction, size: sizeNum, intent: 'open',
        reason: 'trail_unverified',
        detail: String(e.message || e).slice(0, 200),
        errorClass: cls,
        note: 'the trailing stop could not be verified, so the desk DECLINED TO SUBMIT and NOTHING REACHED THE '
          + 'VENUE. Recorded as order_blocked and NOT order_rejected, because the breaker reads order_rejected '
          + 'and a control that cannot verify itself must not be able to shut the desk down (TRD-TRL-5).',
      }, { actor: 'system:executor', level: 'warn' });
      // ⚠ NO maybeTripBreaker HERE, DELIBERATELY — that absence is the entire point of this branch.
    } else {
      await require('./log').write(userId, 'order_rejected', {
        symbol, direction, size: sizeNum,
        reason: String(e.message || e).slice(0, 200),
        errorClass: cls,
        intent: 'open',
      }, { actor: 'system:executor', level: 'warn' });
      await maybeTripBreaker(userId, settings);
    }
    if (unconfirmed) {
      // Fire-and-forget: a reconciliation failure must not turn a rejected order into a thrown one,
      // and the reason it could not run is itself worth recording.
      require('./mirrorPoller').cycle(userId).then((r) => {
        // The cycle's own report says whether the venue held something we did not. Surfaced on the
        // order_rejected trail so the orphan question is answered in the same place the failure is.
        return store.logEvent(userId, 'telemetry', {
          source: 'forced_reconcile_after_open_failure',
          errorClass: cls, symbol,
          matched: (r && r.matched ? r.matched.length : null),
          venueOnly: (r && r.venueOnly ? r.venueOnly.length : null),
          skipped: (r && r.skipped) || null,
        });
      }).catch((err) => store.logEvent(userId, 'telemetry', {
        source: 'forced_reconcile_after_open_failure_error',
        errorClass: cls, error: String((err && err.message) || err).slice(0, 160),
      }).catch(() => {}));
    }
    // TRD-12: rejected attempts are recorded on the ledger too (light state
    // machine) so the desk can see WHY an order never filled.
    // TRD-52: an UNCONFIRMED submit gets `status='unconfirmed'` rather than `rejected`. It is not in
    // getOpenTrades (so it cannot consume a position/trade cap on a position that may not exist) and it
    // is not in getUnresolvedTrades (so the venue-CLOSE sync never tries to close it) — it is resolved
    // by reconcile, which either MATCHES it to a venue position or expires it. `rejectReason` carries
    // the venue's own words even in this branch, because the column name is legacy and the content is
    // exactly what it says: why this row did not become a live trade.
    try {
      await store.createTrade(userId, {
        symbol, direction, size: sizeNum,
        openPrice: null, status: unconfirmed ? 'unconfirmed' : 'rejected',
        decisionId, note: unconfirmed ? 'executor open (unconfirmed — outcome unknown)' : (note || 'executor open (rejected)'),
        origin: origin || 'agent',
        stopPrice: stop.value,
        takeProfitPrice: tp.value,
        rejectReason: String(e.message || e).slice(0, 120),
        pairId: pairId || null,
      });
    } catch { /* rejected/unconfirmed row is best-effort */ }
    if (e && e.demoGuard) return { placed: false, reason: 'not_demo' };
    if (e && e.notCaptured) return { placed: false, reason: 'ui_action_not_captured', detail: e.message };
    return { placed: false, reason: String(e.message || e).slice(0, 160) };
  }
}

// 4.22 (2026-10-03): `source` records WHICH caller closed the trade (`wake:<promptId>` / `review` / `api` /
// `sweep:kill` / `pairs:<id>`). FAIL-OPEN: an absent source never blocks a close — provenance is telemetry,
// and ids are never invented at call time; stamp only what the caller actually holds.
async function closeTrade(userId, settings, tradeId, { keepOpen = false, force = false, source = null } = {}) {
  const trade = await store.getTradeById(userId, tradeId);
  if (!trade) return { closed: false, reason: 'trade_not_found' };
  if (trade.status !== 'open') return { closed: false, reason: 'trade_not_open', status: trade.status };

  // TRD-12: the venue reports this instrument's market as closed — the close
  // cannot execute right now. Refuse with a clear reason instead of spending
  // a doomed UI navigation. `force` bypasses (kill-switch sweep still tries).
  if (!force) {
    // TRD-52: read the session through the SHARED helper. The old inline check read `isTraded ===
    // false` only, and the paper connector reports `{ state }` instead — so on the sim desk this
    // refusal could never fire. A guard that silently does nothing is worse than no guard, because it
    // reads as coverage. (The paper connector also takes (userId, symbol) while every caller passes the
    // symbol first, so its answer is calendar-based rather than instrument-based — recorded here rather
    // than quietly relied on.)
    const shut = sessionClosed(await getConnector(settings).getSession(trade.symbol));
    if (shut.closed) {
      return { closed: false, reason: 'market_closed', nextOpenAt: shut.nextOpenAt, detail: shut.reason };
    }
  }

  try {
    const connector = getConnector(settings);
    const t0 = Date.now();
    const fill = await connector.closeOrder(settings, trade, { keepOpen, userId });
    const closedAt = fill.closedAt ? new Date(fill.closedAt) : new Date();
    // Phase 3 (migration 036): the DESK closed this position, so there is no venue adjustment to read
    // — the cost is ESTIMATED from nights held x the venue's stated per-side rate for this instrument.
    // It is written with `fundingSource` saying so, because an estimate that looks like a measurement
    // is the failure mode this whole column set exists to prevent. `grossPnl` below is the venue's
    // NetPL and therefore already includes whatever it actually charged, so this row records the
    // number behind that, from the best source available.
    const funding = await (async () => {
      try {
        const instr = require('./instruments');
        const facts = await instr.venueCostFacts(userId, { symbols: [trade.symbol] });
        const f = facts[trade.symbol] || null;
        // TRD-49: the estimate's night count must use the venue's OWN funding clock. Counting UTC
        // midnights here would have written an estimate whose nights disagree with the venue's
        // invoice for the same hold — and `swapNights` is the number the funding validator re-scores
        // against that invoice. Falls back to the venue default, not midnight.
        const clockMinute = require('./time').fundingMinuteFromText(f && f.fundingTime);
        // `carryPctFor` returns the COST for THIS trade's side (positive = charged) or null when the
        // instrument has never been captured — so a null rate propagates to `not_available` rather
        // than to a free night.
        return require('./funding').estimateOwnClose(
          { ...trade, closeAt: closedAt },
          {
            ratePct: instr.carryPctFor(f, trade.direction),
            fundingMinuteUtc: clockMinute == null ? require('./time').DEFAULT_FUNDING_MINUTE_UTC : clockMinute,
          },
        );
      } catch {
        // A registry read failure must not block a close, and must not be recorded as "no carry".
        const t = require('./time');
        return {
          swapNights: t.nightsFor(trade.openAt, closedAt, t.DEFAULT_FUNDING_MINUTE_UTC),
          fundingRatePct: null, fundingCost: null, fundingSource: 'not_available',
        };
      }
    })();
    await store.updateTrade(userId, trade.id, {
      closePrice: fill.price ?? null,
      // TRD-108 (2026-09-21): the desk closed this one, so its own price IS the fill — written under BOTH
      // names so `closeFillPrice` means "the fill, or NULL" for every reader, with no conditional.
      closeFillPrice: fill.price ?? null,
      closePriceSource: CLOSE_PRICE_SOURCE.fill,
      closeAt: closedAt,
      // TRD-118: the desk closed this one and stamped its own clock, so the instant is OBSERVED — measured at
      // 0 of 44 `executor close` rows on a minute boundary, against 36 of 36 venue closes.
      closeAtSource: CLOSE_AT_SOURCE.deskObserved,
      grossPnl: fill.pnl ?? null,
      status: 'closed',
      note: 'executor close',
      closeSource: source || null,
      filledAt: fill.closedAt ? new Date(fill.closedAt) : new Date(),
      fillDelayMs: Date.now() - t0,
      ...funding,
    });
    await require('./log').write(userId, 'trade_closed', { tradeId: trade.id, symbol: trade.symbol, fill, closeSource: source || null }, { actor: 'system:executor', correlationId: require('./log').corrId('close') });
    // TRD-12 Phase 2: post-trade autopsy (MFE/MAE/holding/slippage + optional
    // LLM write-up on big losses). Non-fatal — a failed autopsy never blocks
    // the close.
    require('./autopsy').runOnClose(userId, settings, { ...trade, closePrice: fill.price ?? trade.closePrice, closeFillPrice: fill.price ?? null, closeAt: fill.closedAt ? new Date(fill.closedAt) : new Date() }).catch(() => {});
    // n>=50 milestone (2026-09-10): ONE-TIME Telegram alert per strategy when
    // it reaches 50 tagged closed trades — success criterion (b) unlocks.
    if (trade.strategyId) {
      try {
        const stats = await store.listStrategyStats(userId);
        const s = stats.find((x) => x.strategyId === trade.strategyId);
        if (s && s.n >= 50) {
          const prev = await store.latestEvent(userId, 'goal50_reached');
          const seen = prev && prev.payload && Array.isArray(prev.payload.strategies) ? prev.payload.strategies : [];
          if (!seen.includes(trade.strategyId)) {
            await store.logEvent(userId, 'goal50_reached', { strategies: [...seen, trade.strategyId], strategy: trade.strategyId, n: s.n, at: new Date().toISOString() });
            await require('../lib/http').telegramAlert(`OSWALD: ${trade.strategyId} reached ${s.n} tagged live closes — n>=50 criterion unlocked for parity conclusions.`).catch(() => {});
          }
        }
      } catch { /* milestone is best-effort */ }
    }
    return { closed: true, tradeId: trade.id, fill };
  } catch (e) {
    // TRD-42: classify AT THE POINT OF FAILURE and store the class. The journal previously kept
    // only a reason STRING, so a state_stale close (the venue no longer holds the position) was
    // indistinguishable from an execution failure — which is how a 41% "reject rate" got reported
    // when the underlying execution failures were 3 of 17.
    const cls = classifyBridgeError(e);
    // ★ 2026-09-29 (TRD-EXE-8): THE CLOSE PATH STILL SPENDS A NON-FAILURE AS EVIDENCE OF ONE.
    //
    // `closeTrade` reads the row ONCE at the top and refuses unless it is 'open' — but the close it then
    // authorises can occupy the bridge for a minute or more (the same congestion that rejected a sibling
    // Silver close seven minutes earlier with "bridge busy (capture) — lock wait exceeded for ticket"). A
    // venue-side stop adopted by `venue-close-sync` INSIDE that window is invisible to the in-flight
    // attempt, which then reports `state_stale`. Measured, Trades #1130 (Silver sell 9.8339): the adoption
    // wrote `status='closed'` at 14:30:11.793Z (`closePriceSource` venue_rate, `closeAtSource`
    // venue_ui_minute, note "venue closed — Loss call") and logged `reconciliation ... stillUnresolved: 0`;
    // the in-flight close then failed at 14:31:47.430Z. So the row simultaneously claimed it WAS closed at
    // the venue and that the close had been REJECTED.
    //
    // That is TRD-52's error one path over. TRD-52's rule is "an unknown outcome is not a failure, and it
    // must not be spent as evidence of one"; its close-path form is "a position the venue already closed is
    // not a failed close". TRD-52 split the OPEN path out of `order_rejected` and the breaker; the CLOSE
    // path was left writing `order_rejected`, and `state_stale` closes are 7 of the 12 `order_rejected`
    // rows the desk has ever written.
    //
    // THIS CHANGE IS DELIBERATELY THE INERT HALF ONLY. It re-reads the row and skips the `rejectReason`
    // write when the row is already terminal, because `rejectReason` means "this order was rejected" and a
    // close that failed against an already-closed position was NOT a rejection of the trade. Nothing is
    // made unobservable: the journal keeps the event either way, now annotated with what it found. The
    // BREAKER half — whether a close-path `state_stale` should feed `order_rejected` at all, given that
    // `maybeTripBreaker` and self-health both count that kind with no `errorClass` filter — is a
    // risk-control decision and is NOT taken here.
    let rowStatusAtFailure = null;
    try {
      const fresh = await store.getTradeById(userId, trade.id);
      rowStatusAtFailure = fresh ? fresh.status : null;
    } catch { /* an unreadable row must not suppress the journal */ }
    const alreadyResolved = rowStatusAtFailure != null && rowStatusAtFailure !== 'open';
    await require('./log').write(userId, 'order_rejected', {
      symbol: trade.symbol, errorClass: cls, intent: 'close',
      reason: 'close: ' + String(e.message || e).slice(0, 200),
      closeSource: source || null,
      alreadyResolved, rowStatus: rowStatusAtFailure,
    }, { actor: 'system:executor', level: 'warn' });
    // TRD-12: record WHY the close failed on the trade row (light machine) — but never on a row that is
    // already terminal, where "rejected" would contradict the close that row already records.
    if (!alreadyResolved) {
      try { await store.updateTrade(userId, trade.id, { rejectReason: String(e.message || e).slice(0, 120) }); } catch { /* best-effort */ }
    }

    // TRD-42, the remaining half: a close that failed because the venue no longer holds the
    // position means the desk's belief and the venue's state have DIVERGED. Previously that was
    // logged and left to the mirror poller's next 60s cycle. Reconcile now instead.
    //
    // Safe to call here: withOrderReliability releases the 'ticket' lock in a finally BEFORE it
    // rethrows, so the mirror cycle can take its own lock. Only classes whose state actually
    // diverged qualify — forcing a reconcile on a lifecycle timeout or a dom_state failure would
    // spend a bridge navigation to re-learn a state that never disagreed.
    //
    // Fire-and-forget, but WITH a catch that logs: a reconcile failing silently would reproduce
    // the exact class of defect being fixed here. Nothing may delay the caller's error path
    // either — a slow reconcile must never hold up a wake.
    const reconcileTriggered = NEEDS_RECONCILIATION.has(cls);
    if (reconcileTriggered) {
      require('./mirrorPoller').cycle(userId)
        .then((r) => store.logEvent(userId, 'telemetry', { source: 'reconcile_forced_by_order', errorClass: cls, symbol: trade.symbol, tradeId: trade.id, result: r }))
        .catch((err) => store.logEvent(userId, 'error', { where: 'reconcile_forced_by_order', errorClass: cls, symbol: trade.symbol, error: String((err && err.message) || err).slice(0, 160) }));
    }

    if (e && e.demoGuard) return { closed: false, reason: 'not_demo', errorClass: cls, reconcileTriggered };
    if (e && e.notCaptured) return { closed: false, reason: 'ui_action_not_captured', errorClass: cls, reconcileTriggered, detail: e.message };
    return { closed: false, reason: String(e.message || e).slice(0, 160), errorClass: cls, reconcileTriggered };
  }
}

// Phantom-fill reconciliation: Trades(open) <-> live venue positions.
// 2026-09-11: `preRead` lets a caller with a FRESH connector-shaped read skip
// the duplicate navigation (mirror poller). Reconciling against an EMPTY
// venue read is what clears local-open rows whose venue position vanished
// (Bitcoin #22 incident) — callers must only pass a VERIFIED empty read
// (see mirrorPoller.assessEmptyTrust).
async function reconcile(userId, settings, { keepOpen = false, preRead = null, emptyTrusted = false } = {}) {
  try {
    const pos = preRead || await getConnector(settings).getPositions(settings, { keepOpen });
    const venueItems = (pos.items || []).filter((p) => p.name);
    const open = await store.getOpenTrades(userId);
    // TRD-52: submits whose outcome was never confirmed. These are resolved HERE and only here, because
    // reconcile is the one place that knows what the venue actually holds.
    const unconfirmed = await store.getUnconfirmedTrades(userId);

    const matched = [];
    const phantomed = [];
    const venueOnly = [];
    const alreadyRecorded = [];
    const recovered = [];
    const expired = [];
    const venueUsed = new Set();
    const knownPhantom = await store.getPhantomPositionIds(userId);

    for (const t of open) {
      // TRD-12: match by EXACT venue positionId first (two same-symbol rows
      // must never steal each other's match), then fall back to symbol.
      let idx = -1;
      if (t.plus500PositionId) {
        idx = venueItems.findIndex((p, i) => !venueUsed.has(i)
          && String(p.positionId) === String(t.plus500PositionId));
      }
      if (idx === -1) {
        idx = venueItems.findIndex((p, i) => !venueUsed.has(i)
          && String(p.name || '').toLowerCase() === String(t.symbol).toLowerCase()
          && (p.direction ? p.direction === t.direction : true));
      }
      if (idx === -1) {
        // DB says open, venue has no such position -> phantom fill. KEEP the
        // note + origin — a later upgrade must not relabel an agent trade.
        await store.updateTrade(userId, t.id, { status: 'phantom' });
        phantomed.push({ tradeId: t.id, symbol: t.symbol });
        await store.logEvent(userId, 'phantom_fill', { tradeId: t.id, symbol: t.symbol, direction: 'missing_on_venue' });
      } else {
        const p = venueItems[idx];
        venueUsed.add(idx);
        const patch = {};
        if (t.plus500PositionId == null && p.positionId != null) patch.plus500PositionId = p.positionId;
        if (t.openPrice == null && p.openingRate != null) patch.openPrice = p.openingRate;
        if ((t.units == null) && p.units != null) patch.units = p.units;
        // TRD-11: live P/L from the frontend (dynamic spread + adjustments
        // are already inside Plus500's NetPL).
        if (p.currentRate != null) patch.currentRate = p.currentRate;
        if (p.pnl != null) patch.floatingPnl = p.pnl;
        if (Object.keys(patch).length) await store.updateTrade(userId, t.id, patch);
        matched.push({ tradeId: t.id, symbol: t.symbol });
      }
    }

    for (let i = 0; i < venueItems.length; i++) {
      if (venueUsed.has(i)) continue;
      const p = venueItems[i];
      if (p.positionId && knownPhantom.has(String(p.positionId))) {
        // TRD-11: the position STILL exists on Plus500 — upgrade its old
        // phantom mirror row to OPEN so the Positions tab mirrors reality.
        const all = await store.listTrades(userId, { limit: 500 });
        const row = all.find((t) => String(t.plus500PositionId) === String(p.positionId));
        if (row && row.status !== 'open') {
          await store.updateTrade(userId, row.id, {
            status: 'open',
            // TRD-12: NEVER relabel an agent-opened trade as "mirrored" — a
            // transient venue mismatch could phantom it for one cycle.
            note: row.origin === 'agent' ? (row.note || 'agent trade') : 'mirrored from Plus500 (not agent-opened)',
            origin: row.origin || 'venue',
            openPrice: row.openPrice ?? p.openingRate ?? null,
            size: row.size || p.size || 0,
            currentRate: p.currentRate ?? null,
            floatingPnl: p.pnl ?? null,
          });
          alreadyRecorded.push({ positionId: p.positionId, symbol: p.name, upgraded: row.id });
        } else if (row && (p.currentRate != null || p.pnl != null)) {
          await store.updateTrade(userId, row.id, { currentRate: p.currentRate ?? null, floatingPnl: p.pnl ?? null });
          alreadyRecorded.push({ positionId: p.positionId, symbol: p.name });
        } else {
          alreadyRecorded.push({ positionId: p.positionId, symbol: p.name });
        }
        continue;
      }
      // Venue-only fill: mirror it as an OPEN row the agent can see (it did
      // not open it — flagged in the note; next reconcile re-verifies).
      //
      // TRD-52 FIRST, THOUGH: an unsettled submit of ours may be exactly this position. Trades 1033 was
      // the desk's OWN size-1 Gold buy, submitted into a closed session, written off as rejected, and
      // then filled at the open — and this branch adopted it as a stranger (Trades 1034), after which
      // its 107% notional vetoed every entry for 45 minutes. Matching it back is what makes the desk
      // able to reason about its own orders, and it is strictly better than creating a second row:
      // one row, with the original decisionId/stopPrice/stop/takeProfit intent preserved.
      const own = matchVenuePosition(unconfirmed, p);
      if (own) {
        await store.updateTrade(userId, own.id, {
          status: 'open',
          plus500PositionId: p.positionId ?? null,
          openPrice: p.openingRate ?? own.openPrice ?? null,
          units: p.units ?? null,
          size: p.size || own.size,
          currentRate: p.currentRate ?? null,
          floatingPnl: p.pnl ?? null,
          filledAt: new Date(),
          rejectReason: null,
          note: `recovered after unconfirmed submit (was ${own.rejectReason ? 'unconfirmed: ' + String(own.rejectReason).slice(0, 60) : 'outcome unknown'})`,
        });
        recovered.push({ tradeId: own.id, symbol: p.name, direction: p.direction || null, size: p.size ?? null, positionId: p.positionId ?? null });
        await store.logEvent(userId, 'order_recovered', {
          tradeId: own.id, symbol: p.name, direction: p.direction || null, size: p.size ?? null,
          positionId: p.positionId ?? null, openPrice: p.openingRate ?? null,
          note: 'the venue had it all along — matched to the unconfirmed attempt instead of adopting a stranger',
        }, { actor: 'system:executor' });
        continue;
      }
      // ★ TRD-RSK-9 (2026-09-28): BEFORE CALLING IT A STRANGER, ASK WHETHER IT IS OURS WITH THE WRONG SIZE.
      //
      // The matcher above is exact on size (2% tolerance), and on 2026-09-28 that tolerance is what let the
      // defect through: #1110 Sugar buy 11.9862 was submitted at 07:09:21Z into a closed session, came back
      // `ambiguous`, was queued by the venue and FILLED at the session open. The venue held 15 contracts.
      // 15 against 11.9862 is 25% — no match — so this branch adopted the desk's OWN fill as a stranger
      // (#1111: no stop, no decisionId, origin 'venue'), and at 07:40:36 the desk expired #1110 as FAILED.
      // One position, two records, and the risk went out with the record that was discarded. Arabica Coffee
      // repeated it at 08:15:54Z — that instrument's session open — as #1114 and #1115.
      //
      // This deliberately does NOT change ownership. Claiming the position would write our stopPrice and
      // decisionId onto something that might be a manual trade the owner placed in the same instrument, and
      // attaching our stop to somebody else's exposure is a worse error than the one being fixed. What it
      // changes is that the ambiguity becomes DURABLE: the adoption now names the submit it probably belongs
      // to, the two sizes, and the gap between them, so the assumption is auditable instead of invisible.
      const suspect = suspectedOwn(unconfirmed, p);
      if (suspect) {
        await store.logEvent(userId, 'order_adopt_suspect', {
          symbol: p.name, direction: p.direction || null,
          venueSize: p.size ?? null, sentSize: suspect.row.size ?? null,
          deltaPct: suspect.deltaPct, ratio: suspect.ratio, beyondRatio: suspect.beyondRatio,
          unresolvedTradeId: suspect.row.id, unresolvedSince: suspect.row.openAt || null,
          positionId: p.positionId ?? null,
          note: 'a venue position in the same symbol and direction as an UNRESOLVED submit, but its size does not match — adopted as a stranger, so the desk records no stop for it (TRD-RSK-9)',
        }, { actor: 'system:executor', level: 'warn' });
      }
      await store.createTrade(userId, {
        symbol: p.name,
        direction: p.direction || 'buy',
        size: p.size || 0,
        units: p.units ?? null,
        openPrice: p.openingRate ?? null,
        status: 'open',
        plus500PositionId: p.positionId ?? null,
        note: 'mirrored from Plus500 (not agent-opened)',
        origin: 'venue',
        currentRate: p.currentRate ?? null,
        floatingPnl: p.pnl ?? null,
      });
      venueOnly.push({ symbol: p.name, direction: p.direction, size: p.size });
      await store.logEvent(userId, 'phantom_fill', { symbol: p.name, direction: 'venue_only' });
    }

    // TRD-52 last step: bound the state. Anything still unconfirmed after the TTL is concluded failed —
    // BUT ONLY when the venue read can be believed. `emptyTrusted` is asserted by the caller that
    // checked the empty read against the account strip (mirrorPoller.cycle); the bare /reconcile route
    // does not pass it, so an empty-but-untrusted read can never expire a row that the venue may in
    // fact be holding. Expiring on a flaky read would recreate the original defect in the other
    // direction, and it would do it silently — which is why the expiry is an event, not a status edit.
    const venueReadable = venueItems.length > 0 || emptyTrusted === true;
    if (venueReadable) {
      for (const u of expiredRows(unconfirmed, { ttlMin: UNCONFIRMED_TTL_MIN })) {
        await store.updateTrade(userId, u.id, {
          status: 'failed',
          note: `unconfirmed expired after ${UNCONFIRMED_TTL_MIN}m with no matching venue position`,
        });
        expired.push({ tradeId: u.id, symbol: u.symbol, direction: u.direction, size: u.size });
        await store.logEvent(userId, 'order_unconfirmed_expired', {
          tradeId: u.id, symbol: u.symbol, direction: u.direction, size: u.size,
          ttlMin: UNCONFIRMED_TTL_MIN, venuePositions: venueItems.length,
          note: 'no venue position matched it within the window — concluded failed, not rejected',
        }, { actor: 'system:executor' });
      }
    }

    return { matched, phantomed, venueOnly, alreadyRecorded, recovered, expired, unconfirmedOpen: unconfirmed.length - recovered.length - expired.length, venuePositions: venueItems.length, dbOpen: open.length };
  } catch (e) {
    if (e && e.demoGuard) return { matched: [], phantomed: [], venueOnly: [], alreadyRecorded: [], recovered: [], expired: [], reason: 'not_demo' };
    if (e && e.notCaptured) return { matched: [], phantomed: [], venueOnly: [], alreadyRecorded: [], recovered: [], expired: [], reason: 'positions_read_unverified' };
    return { matched: [], phantomed: [], venueOnly: [], alreadyRecorded: [], recovered: [], expired: [], reason: String(e.message || e).slice(0, 160) };
  }
}

// Disaster-floor monitor: reads live equity, auto-trips HARD when breached.
async function monitorFloor(userId, settings) {
  if (settings.kill?.tier === 'hard') return { tier: 'hard', reason: 'already_hard' };
  if (settings.kill?.disasterFloorPct == null) return { tier: settings.kill?.tier || 'off', reason: 'floor_disabled' };
  let equity;
  try {
    const acct = await getConnector(settings).getAccount(settings, { fresh: true });
    equity = acct.Equity?.value ?? acct.Available?.value ?? acct.equity ?? null;
  } catch (e) {
    return { tier: settings.kill?.tier || 'off', skipped: true, reason: String(e.message || e).slice(0, 120) };
  }
  if (!Number.isFinite(equity)) return { tier: settings.kill?.tier || 'off', skipped: true, reason: 'equity_unreadable' };
  if (killswitch.floorBreached(settings, equity)) {
    // 2026-09-11: report the SAME baseline floorBreached uses (kill first,
    // then legacy risk) — the message used to cite risk.initialEquity only,
    // which misstated the operative baseline during the demo/live incident.
    const floorBase = settings.kill?.initialEquity ?? settings.risk?.initialEquity;
    const next = await killswitch.setTier(userId, settings, 'hard', {
      reason: `disaster floor: equity ${equity} vs initial ${floorBase}`,
      alert: true,
      autoClose: true,
    });
    return { tier: 'hard', equity, reason: 'floor_breached', kill: next.kill };
  }
  return { tier: settings.kill?.tier || 'off', equity, reason: 'ok' };
}

// Hard-tier auto-close: close every open trade (entries already blocked).
async function closeAll(userId, settings) {
  const open = await store.getOpenTrades(userId);
  const results = [];
  // force:true — the disaster sweep must at least TRY even if the venue
  // reports a closed market (some venues accept queued close orders).
  for (const t of open) results.push(await closeTrade(userId, settings, t.id, { force: true, source: 'sweep:kill' }));
  return {
    attempted: open.length,
    closed: results.filter((r) => r.closed).length,
    pendingCapture: results.filter((r) => r.reason === 'ui_action_not_captured').length,
    results,
  };
}

// F19 (2026-09-18): THE HARD TIER'S PROMISE, KEPT.
//
// `killswitch.setTier` only FLAGS `autoClose` — it closes nothing. The one block that consumed the flag
// lived inside the wake's `floor` step, which sits AFTER the `session` step's `skipped: 'kill_switch_hard'`
// early return — so the flag's only reader was unreachable in exactly the state that sets it. Verified
// end-to-end on the live desk 2026-09-17: tier `hard` + `autoClose: true` recorded, `Trades #1046` still
// open, zero trade_closed / order_attempt / error events — while the dialog had just promised a market
// close. While hard, the position was protected only by its venue stop, which was 3.05% away (F20).
//
// This is now the ONE entry point for that promise: called by the wake guard (BEFORE the early return) and
// by `POST /kill`, and built to be called from both, repeatedly, and after a restart:
//   - it RE-READS the kill state instead of trusting the caller's snapshot. `monitorFloor` writes the hard
//     tier DURING a wake, and the wake's own `settings` object predates that write — so the old condition
//     `settings.kill?.autoClose` was evaluated against the value from BEFORE the breach that set it, and a
//     breach on a desk that was `off` skipped the very sweep it had just asked for.
//   - it never throws. One caller is a wake that must still record its own skip; the other is an HTTP
//     handler that must still return the tier it persisted.
//   - it ALWAYS traces, and an attempt that closed nothing is louder (`warn`) than one that did (`info`).
//     A hard tier whose book will not close is the worst state this desk has, so it must not be the
//     quietest.
async function autoCloseSweep(userId, { caller = 'wake_guard', correlationId = null, actor = 'system:kill' } = {}) {
  const log = require('./log');
  const ctx = { actor, correlationId: correlationId || log.corrId('kill') };
  try {
    const settings = await store.getSettings(userId);
    const open = await store.getOpenTrades(userId);
    const plan = killswitch.autoClosePlan(settings, open);
    if (!plan.go) return { attempted: false, reason: plan.reason };
    const res = await closeAll(userId, settings);
    const failures = res.results.filter((r) => !r.closed).map((r) => r.reason);
    await log.write(userId, 'kill_auto_close', {
      caller, attempted: res.attempted, closed: res.closed,
      pendingCapture: res.pendingCapture, tradeIds: plan.tradeIds, failures: failures.slice(0, 5),
    }, { ...ctx, level: res.closed === res.attempted ? 'info' : 'warn' });
    return { attempted: true, ...res };
  } catch (e) {
    try {
      await log.write(userId, 'kill_auto_close', {
        caller, attempted: true, closed: 0, error: String(e.message || e).slice(0, 200),
      }, { ...ctx, level: 'error' });
      await log.error(userId, 'auto_close_sweep', e, ctx);
    } catch { /* logging must never be the thing that fails the caller */ }
    return { attempted: true, closed: 0, error: String(e.message || e).slice(0, 160) };
  }
}

module.exports = { openTrade, closeTrade, closeAll, autoCloseSweep, reconcile, monitorFloor, maybeTripBreaker, fillAnchorPlan };
