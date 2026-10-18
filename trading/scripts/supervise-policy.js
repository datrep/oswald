'use strict';
// trading/scripts/supervise-policy.js — WHEN MAY THE OUT-OF-PROCESS SUPERVISOR AUTO-RESTART THE DESK?
//
// ★ WHY THIS FILE EXISTS (2026-10-06). `supervise.js --restart` used to change only the ALERT TEXT
// ("auto-restart: ENABLED") — `restartTrading()` was defined and NEVER CALLED. An inert control that
// reports itself enabled is the exact defect class this workstream exists to remove, and it was found
// while chasing the 2026-10-05 silent desk death (13:08→13:45Z: process vanished, supervisor paged,
// nothing restarted, 37 minutes of downtime until an unrelated deploy restart).
//
// THE POLICY, and the asymmetry that motivates it:
//   · DOWN + the crash-guard heartbeat's pid NOT ALIVE  -> restart is SAFE (nothing is running; the desk
//     is provably gone — the silent-death case this exists for).
//   · DOWN + pid ALIVE (port dead but process wedged)   -> HOLD. Killing a live desk can interrupt an
//     in-flight order and strand a position; that is an operator decision.
//   · HUNG (port answers, heartbeat stale)              -> HOLD, same reason: the process is alive.
//   · UP                                                -> nothing to do.
//   · `--restart` absent                                -> report-only, always (the historical default).
// A 10-minute backoff prevents a restart loop when the desk cannot stay up.
//
// Pure — no I/O, no clock — so the decision is pinned by test/supervise-policy.test.js rather than
// discovered in production.
function decideAutoRestart({ restartFlag, state, pidAlive, recentAutoRestart = false } = {}) {
  if (!restartFlag) return { act: false, reason: 'report-only (no --restart)' };
  if (state === 'up') return { act: false, reason: 'desk is up' };
  if (state === 'down') {
    if (pidAlive) return { act: false, reason: 'port down but the heartbeat pid is ALIVE (wedged) — killing a live desk can strand an order; operator decision' };
    if (recentAutoRestart) return { act: false, reason: 'a restart was attempted within the last 10 minutes — backing off' };
    return { act: true, reason: 'down with no live process — restart is safe' };
  }
  if (state === 'hung') return { act: false, reason: 'hung (process alive) — killing a live desk can strand an order; operator decision' };
  return { act: false, reason: `unknown state '${state}'` };
}

// Stale-heartbeat escalation lane (added 2026-10-07, owner-approved item "b").
// The hung DETECTION has existed since TRD-40; what never existed is an escalation path. This lane is
// OPT-IN (default OFF) because the asymmetry above still holds: killing a live desk can interrupt an
// in-flight order. When opted in (--restart-hung), a hung desk is restarted after the heartbeat has been
// stale for `thresholdMs` (default 10 min) with a live pid and the same 10-minute restart backoff.
function decideHungRestart({ restartHungFlag, hbAgeMs, pidAlive, recentAutoRestart = false, thresholdMs = 10 * 60000 } = {}) {
  if (!restartHungFlag) return { act: false, reason: 'stale-heartbeat restart lane is OFF — hung desks stay operator-decided (enable with --restart-hung)' };
  if (!(hbAgeMs >= thresholdMs)) return { act: false, reason: `heartbeat stale ${Math.round((hbAgeMs || 0) / 1000)}s — below the ${Math.round(thresholdMs / 60000)}-minute hung-restart threshold` };
  if (!pidAlive) return { act: false, reason: 'hung reading but the pid is NOT alive — the down lane owns this case' };
  if (recentAutoRestart) return { act: false, reason: 'a restart was attempted within the last 10 minutes — backing off' };
  return { act: true, reason: `heartbeat stale ${Math.round(hbAgeMs / 60000)} min with a live pid — restarting via the opted-in stale-heartbeat lane` };
}

module.exports = { decideAutoRestart, decideHungRestart };
