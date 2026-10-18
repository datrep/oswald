// trading/agent/killswitch.js — two-tier kill switch (TRD-3).
// tier: off | soft | hard
//   off   = normal operation
//   soft  = NO new entries (existing positions keep running their exits)
//   hard  = no new entries AND close everything (autoClose)
// Triggers: manual API, disaster floor (equity drawdown >= disasterFloorPct vs
// initialEquity), circuit breaker (repeated order rejections).
'use strict';

const store = require('../store');
const { sendKillAlert } = require('./alerts');

const TIERS = ['off', 'soft', 'hard'];

// A number, or null when the value is absent/unreadable. Deliberately NOT `Number(v)`, which turns null
// and '' into 0 — in this file every caller is asking "is this usable", and 0 is not.
function finite(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// IS THE EQUITY BELOW THE DISASTER FLOOR — AND CAN THE QUESTION BE ANSWERED AT ALL? (TRD-109, 2026-09-20)
//
// The old body was fail-OPEN: it returned `false` — the same answer as "not breached" — whenever it could
// not compute, so a missing baseline was indistinguishable from a safe one. Measured on the live settings:
// with `kill.initialEquity` absent the chain falls back to `risk.initialEquity`, a stale hardcoded 2,685.76
// against an equity near 4,000. A −8% floor would then not fire until roughly −38%, and the desk would
// report itself armed the whole way down. The third state is the fix: 'unusable' is a different statement
// from 'ok', and only 'breached' is allowed to evacuate a book.
function floorState(settings, equity) {
  const floorPct = finite(settings?.kill?.disasterFloorPct);
  if (floorPct == null) return { status: 'unusable', reason: 'disasterFloorPct is not a number', source: null };
  const eq = finite(equity);
  if (eq == null) return { status: 'unusable', reason: 'equity is unavailable', source: null, floorPct };
  // TRD-11: the baseline lives in kill.initialEquity (legacy fallback: risk) — and WHICH one was used is part
  // of the answer, because a fallback baseline is not a baseline anyone can size against.
  const killBase = finite(settings?.kill?.initialEquity);
  const riskBase = finite(settings?.risk?.initialEquity);
  const usableKill = killBase != null && killBase > 0;
  const usableRisk = riskBase != null && riskBase > 0;
  if (!usableKill && !usableRisk) {
    return {
      status: 'unusable', floorPct, source: null,
      reason: 'no baseline: kill.initialEquity and risk.initialEquity are both missing or non-positive',
    };
  }
  const initial = usableKill ? killBase : riskBase;
  const pct = +(((eq - initial) / initial) * 100).toFixed(4);
  return {
    status: pct <= floorPct ? 'breached' : 'ok',
    pct, initial, floorPct,
    source: usableKill ? 'kill' : 'risk_legacy',
    reason: usableKill ? null : 'kill.initialEquity is unusable — the legacy risk.initialEquity was used instead',
  };
}

// Equity is below the disaster floor? (e.g. -8% vs initial equity)
//
// UNCHANGED SEMANTICS, and deliberately so: 'unusable' is NOT a breach. The single caller is the
// disaster-floor hard kill (`executor.monitorFloor`), and evacuating a book is irreversible while refusing
// an entry is not — so a floor that cannot be evaluated must not close anything. The entry side of the same
// question is answered fail-CLOSED in `risk.evaluate`, which is where being wrong is reversible.
function floorBreached(settings, equity) {
  return floorState(settings, equity).status === 'breached';
}

function blockedForEntry(settings) {
  return settings.kill?.tier !== 'off';
}

// WHAT AN OMITTED `autoClose` MEANS ON A HARD KILL (TRD-111, 2026-09-20).
//
// The old expression was `autoClose !== null ? !!autoClose : true`, so the default `true` applied ONLY when
// the key was ABSENT from the options object. `undefined` — which is what a caller gets by leaving the field
// out of a REQUEST BODY — is `!== null`, so it evaluated `!!undefined` = false. `routes.js` passes
// `autoClose: b.autoClose` unconditionally, so a body of `{"tier":"hard"}` stored `autoClose: false`, the
// route computed `sweeping = false`, and NOTHING closed: the book stayed open behind its venue stops, which
// is the 2026-09-17 outcome reached by a different route. Every in-repo caller passed an explicit boolean,
// so the failing case was exactly the improvised one — curl, a script, or an operator during an incident.
//
// The rule now: on a HARD tier, only an explicit boolean `false` turns the sweep off. Omitted, null, a
// string or a number all mean "you did not say", and "you did not say" must never mean "do not close".
// The destructor is chosen by an explicit opt-out, never by an omission.
function resolveAutoClose(tier, autoClose) {
  if (tier !== 'hard') return false;
  return typeof autoClose === 'boolean' ? autoClose : true;
}

// ⚠⚠ TRD-OPS-2 (2026-10-01): THE ALERT NOW USES THE SAME RULE `resolveAutoClose` ALREADY ESTABLISHED.
//
// That function's closing line is "the destructor is chosen by an explicit opt-out, never by an omission". The
// alert had the OPPOSITE rule — `alert = false` by default — so OMITTING the flag meant SILENCE. Measured
// 2026-10-01: two automatic stops inherited exactly that silence. `sim_disaster_floor` is a HARD kill (blocks
// entries AND closes the book), and the UI Fallback Pause had no alert path at all and LATCHES.
//
// ★ SO ALERTING IS NOW THE DEFAULT WHEN THE DESK BECOMES MORE RESTRICTIVE THAN IT WAS. Only an explicit
// `alert: false` turns it off. `off -> soft|hard` is the transition that matters, because that is the desk
// stopping; `soft -> hard` matters too, because the book is now being closed. Going the other way — to `off`, a
// resume — is something a human just did, and alerting on it is noise.
//
// ⚠ WHY NOT SIMPLY `alert = true`. That would fire on every resume and on the smoke test, and an alert that cries
// on routine events is one that stops being read — which returns the original silence by a different route. The
// rule is deliberately about the TRANSITION, for the same reason the UI Fallback Pause alerts on the transition
// only. ⚠ And the default is `null`, NOT `false`: an omitted flag and an explicit `false` have to stay
// distinguishable, or the opt-out becomes indistinguishable from the omission it is meant to replace.
const TIER_RANK = { off: 0, soft: 1, hard: 2 };

// ★★ TRD-OPS-3 (2026-10-02) — THE CIRCUIT BREAKER'S POLICY, AND WHY IT MEASURES BREADTH.
//
// THE DEFECT. The breaker counted RAW `order_rejected` events in a rolling window, with no de-duplication.
// Measured 2026-10-01: Natural Gas failed five order attempts inside 30 minutes — three `order ticket did not
// open` (26.6-27.2 s each) and two `#trade-button` timeouts — and the breaker soft-killed the desk for 62
// minutes. ONE unreachable instrument, reported as a systemic fault, and the instrument was not even the one
// the desk was worried about.
//
// ⚠ WHAT THE BREAKER IS FOR. It exists to catch the failures no per-instrument guard can see: the venue
// logged us out, the bridge died, the session feed went blind. Every one of those breaks MANY symbols at
// once. A broken instrument breaks ONE symbol repeatedly — and the desk already has the right response to
// that, which is to scope the symbol out. Tripping the desk is the wrong instrument at the wrong scale.
//
// ★ SO THE TRIGGER IS THE NUMBER OF DISTINCT SYMBOLS, NOT THE NUMBER OF EVENTS. Five rejections from one
// symbol no longer trip it; five symbols each rejecting once does. `raw` is carried so the alert can name
// BOTH numbers — a breaker that cannot explain itself is the defect class this workstream keeps re-finding.
const CB_WINDOW_MIN = 30;
const CB_MAX_REJECTS = 5;

// PURE. The policy, separated from the read so it is testable without a database — the same split
// `instruments.floorVerdict` and `exitPolicy.gateNearStopCut` use, and the reason this one moved out of
// `executor.js`, where it could only be exercised against SQL.
function breakerDecision({ raw = 0, symbols = 0, currentTier = 'off', windowMin = CB_WINDOW_MIN, maxSymbols = CB_MAX_REJECTS } = {}) {
  const nRaw = Number(raw) || 0;
  const nSym = Number(symbols) || 0;
  // Only a desk that is RUNNING can be tripped. A desk already soft-killed must not have its tier rewritten by
  // a later sweep, and `off` is the only tier from which "stop" is a change worth making.
  const tripped = nSym >= maxSymbols && currentTier === 'off';
  return {
    tripped, raw: nRaw, symbols: nSym,
    reason: tripped
      ? `circuit breaker: ${nSym} different symbols rejected orders in ${windowMin}min (${nRaw} order(s) in total)`
      : null,
  };
}
function resolveAlert(tier, currentTier, alert) {
  if (typeof alert === 'boolean') return alert;
  return (TIER_RANK[tier] || 0) > (TIER_RANK[currentTier] || 0);
}

// Manual trigger / auto trigger. Hard tier also flags autoClose.
async function setTier(userId, settings, tier, { reason = 'manual', autoClose = null, alert = null, actor = null } = {}) {
  if (!TIERS.includes(tier)) throw new Error(`invalid tier ${tier}`);
  const nextAutoClose = resolveAutoClose(tier, autoClose);
  const shouldAlert = resolveAlert(tier, settings.kill && settings.kill.tier, alert);
  await store.saveSettings(userId, {
    kill: { tier, autoClose: nextAutoClose, pausedAt: tier === 'off' ? null : (settings.kill?.pausedAt || new Date().toISOString()) },
  });
  // DESIGN BIBLE v1: kill changes are sec-stream, attributed to the caller.
  await require('./log').write(userId, 'kill', { tier, reason, autoClose: nextAutoClose }, { actor: actor || 'system', correlationId: require('./log').corrId('kill') });
  if (shouldAlert) {
    try {
      await sendKillAlert(tier, reason);
    } catch { /* telegram optional */ }
  }
  return store.getSettings(userId);
}

// WHEN THE HARD TIER'S CLOSE APPLIES (F19, 2026-09-18).
//
// `setTier` above only FLAGS `autoClose`; it closes nothing, and the single block that consumed the flag
// lived in a wake step a hard tier never reaches. The promise the dashboard dialog makes ("closes N open
// position(s) at market") is now consumed through ONE rule in ONE place — beside the flag it reads — so a
// second reader cannot re-derive it differently. PURE: no store, no venue, no connector, which is what
// makes the rule itself testable without a desk attached.
//
// Note what is deliberately NOT here: no "already swept" latch. The flag describes a STATE ("while hard,
// the book should be flat"), not a one-shot order, so every wake re-checks it and a close that failed
// because the bridge was busy is retried on the next wake instead of being forgotten. "Nothing open" is
// the idempotence: once the book is flat the plan is `go: false` forever, at the cost of zero venue calls.
function autoClosePlan(settings, openTrades) {
  if (settings?.kill?.tier !== 'hard') return { go: false, reason: 'tier_not_hard' };
  if (!settings.kill.autoClose) return { go: false, reason: 'auto_close_off' };
  const open = Array.isArray(openTrades) ? openTrades : [];
  if (!open.length) return { go: false, reason: 'nothing_open' };
  return { go: true, reason: 'hard_tier_auto_close', tradeIds: open.map((t) => t.id) };
}

async function release(userId, reason = 'manual') {
  return setTier(userId, { kill: { tier: 'off' } }, 'off', { reason });
}

module.exports = { TIERS, CB_WINDOW_MIN, CB_MAX_REJECTS, breakerDecision, floorState, floorBreached, resolveAutoClose, resolveAlert, blockedForEntry, autoClosePlan, setTier, release };
