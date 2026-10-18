'use strict';
// trading/plus500/bridgeStateGraph.js — THE BRIDGE STATE MACHINE AS DATA (TRD-BRG-1 #1511, 2026-10-05).
//
// WHY THIS FILE EXISTS. A state-machine PICTURE drawn by hand (or by an LLM) drifts from the machine the
// code actually runs, and its lines go wherever the author's pen went. This module is the picture as DATA:
// states, transitions, causes and the windows are declared ONCE, next to the reducer, and:
//   · the observer exports it verbatim to `bridge-state-graph.json` (the UI draws FROM it — no redrawing);
//   · `test/bridge-state-graph.test.js` drives `deriveBridgeState` with a fixture per transition and
//     asserts the reducer lands exactly on the declared `to` state with the declared `cause` — so an
//     arrow that lies about where it goes FAILS THE SUITE.
//
// ⚠ THE REDUCER (bridgeState.js) REMAINS THE SOURCE OF TRUTH; this file must FOLLOW it. The pins are what
// keep the two in step. `cause` is the exact string `deriveBridgeState` reports for that transition.
//
// ⚠ `from` is the NARRATIVE origin, used for drawing. The reducer is stateless: `cdp-unattached` can fire
// from any attached state, and is drawn from RESTING because that is where it is normally seen.

const {
  LAUNCH_PATIENCE_MS, SETTLE_WINDOW_MS, CAPTURE_WEDGE_FRESH_MS, LOGIN_VERDICT_FRESH_MS, MECHANICAL,
} = require('./bridgeState');

// ── states (nodes) ───────────────────────────────────────────────────────────────────────────────────
const STATES = [
  { id: 'OFF', title: 'OFF', sub: 'no chrome', tint: 'dead',
    blurb: 'Chrome is not running (TCP 9224 refused). The desk relaunches it automatically on the next capture need.' },
  { id: 'LAUNCHING', title: 'LAUNCHING', sub: 'launch intent ≤ 75 s', tint: 'degraded',
    blurb: 'A launch just happened; the bridge is waiting to attach. Up to 75 s of patience — a cold Chrome with a heavy profile takes ~30-60 s to open its debugging port.' },
  { id: 'RESTING', title: 'RESTING', sub: 'attached · settled', tint: 'operational',
    blurb: 'Attached over CDP, no navigation in flight, no fresh failure evidence. This is the normal "everything works" state.' },
  { id: 'NAVIGATING', title: 'NAVIGATING', sub: 'nav in flight ≤ 12 s', tint: 'operational',
    blurb: 'A main-frame navigation was just observed. Within 12 s this is simply the page loading — not an error.' },
  { id: 'BLANK_RENDER', title: 'BLANK_RENDER', sub: 'shell up, not settled', tint: 'degraded',
    blurb: 'A navigation 12–120 s old with NO login verdict and the feed unbound — the shell is up but nothing has settled. This is the exact condition behind the false login-death readings; it is shown instead of a verdict.' },
  { id: 'WEDGED', title: 'WEDGED', sub: 'attach_timeout · cdp · capture', tint: 'dead',
    blurb: 'The bridge cannot do its job: attach timed out, CDP dropped while Chrome lives, or a capture wedged. DEAD unless a recovery is in flight (then DEGRADED).' },
  { id: 'LOGGED_OUT', title: 'LOGGED_OUT', sub: 'login verdict false ≤ 15 m', tint: 'dead',
    blurb: 'The watchdog saw the venue login form. Needs the operator to re-login; a reload cannot restore a dead session.' },
];

// ── transitions (edges) ──────────────────────────────────────────────────────────────────────────────
// label: short arrow text · guard: what must be true · evidence: what you would observe in logs
const TRANSITIONS = [
  { id: 'launch-intent', from: 'OFF', to: 'LAUNCHING', cause: 'launch_intent',
    label: 'launch intent', guard: 'not attached, and a launch was requested within the last 75 s',
    evidence: 'browser log "launched Chrome"; TCP 9224 coming up' },
  { id: 'attach-ok', from: 'LAUNCHING', to: 'RESTING', cause: 'attached',
    label: 'attached', guard: 'the CDP attach succeeded',
    evidence: 'server.err.log "attached to existing Chrome on :9224"' },
  { id: 'attach-timeout', from: 'LAUNCHING', to: 'WEDGED', cause: 'attach_timeout',
    label: 'attach timeout (75 s)', guard: 'not attached, and the launch intent is older than 75 s',
    evidence: 'TCP open but CDP never attached — Chrome up, bridge blind' },
  { id: 'cdp-unattached', from: 'RESTING', to: 'WEDGED', cause: 'cdp_unattached',
    label: 'cdp_unattached', guard: 'Chrome is alive on :9224 but the desk is not attached',
    evidence: 'TCP up, bridge CDP down (host restarted Chrome out from under the desk?)' },
  { id: 'chrome-gone', from: 'WEDGED', to: 'OFF', cause: 'no_chrome',
    label: 'chrome gone', guard: 'TCP 9224 refuses connections',
    evidence: 'no Chrome process at all' },
  { id: 'capture-wedge', from: 'RESTING', to: 'WEDGED', cause: 'capture_timeout',
    label: 'capture_timeout ≤ 5 m', guard: 'a capture error newer than 5 min while no page lock is held',
    evidence: 'capture_timeout event; reads stop advancing' },
  { id: 'reads-resume', from: 'WEDGED', to: 'RESTING', cause: 'attached',
    label: 'reads resume', guard: 'attached again, and the capture error aged out (or recovery finished)',
    evidence: 'next capture succeeds; telemetry advances again' },
  { id: 'login-death', from: 'RESTING', to: 'LOGGED_OUT', cause: 'login_check',
    label: 'login verdict false', guard: 'a watchdog login check failed within the last 15 min',
    evidence: 'watchdog_login_death event' },
  { id: 'login-ok', from: 'LOGGED_OUT', to: 'RESTING', cause: 'attached',
    label: 'login ok', guard: 'no fresh failed login check (recovered, or the verdict aged out)',
    evidence: 'watchdog_login_recovered; operator re-login' },
  { id: 'nav-start', from: 'RESTING', to: 'NAVIGATING', cause: 'nav_in_flight',
    label: 'nav in flight', guard: 'a main-frame navigation within the last 12 s',
    evidence: 'framenavigated on the bridge page' },
  { id: 'nav-settle', from: 'NAVIGATING', to: 'RESTING', cause: 'attached',
    label: 'settled ≤ 12 s', guard: 'navigation older than 12 s, and not still in the shell-not-settled window',
    evidence: 'NAV ages out of the settle window with a verdict or a bound feed' },
  { id: 'nav-blank', from: 'NAVIGATING', to: 'BLANK_RENDER', cause: 'shell_not_settled',
    label: '12–120 s · no verdict · feed unbound', guard: 'navigation 12–120 s old, no login verdict, feed unbound',
    evidence: 'shell up but silent — the false login-death trap' },
  { id: 'blank-settle', from: 'BLANK_RENDER', to: 'RESTING', cause: 'attached',
    label: 'settled / feed bound', guard: 'navigation aged past 120 s, or a login verdict arrived, or the feed bound',
    evidence: 'page settles or the read path re-binds' },
];

// ── orthogonal modifiers (display metadata; behaviour lives in the reducer) ─────────────────────────
const MODIFIERS = [
  { id: 'isParked', label: 'parked', effect: 'QUIET — wins over everything else by design' },
  { id: 'healthPaused', label: 'health paused', effect: 'forces DEGRADED' },
  { id: 'isRecovering', label: 'recovering', effect: 'WEDGED reads DEGRADED while a repair is in flight' },
  { id: 'feedSilentForMs', label: 'feed silence', effect: 'display only — context for a reader' },
  { id: 'pageLockHeldBy', label: 'page lock', effect: 'display only — who holds the bridge page' },
];

const CATEGORIES = [
  { id: 'OPERATIONAL', emoji: '🟢', rule: 'RESTING · NAVIGATING — nothing parked / paused / recovering' },
  { id: 'QUIET', emoji: '⚪', rule: 'parked (deliberate rest) — wins over every other category' },
  { id: 'DEGRADED', emoji: '🟡', rule: 'LAUNCHING · BLANK_RENDER · WEDGED (recovering) · healthPaused · recovery in flight' },
  { id: 'DEAD', emoji: '🔴', rule: 'OFF · LOGGED_OUT · WEDGED (not recovering) — needs the operator' },
];

const CONSTANTS = { LAUNCH_PATIENCE_MS, SETTLE_WINDOW_MS, CAPTURE_WEDGE_FRESH_MS, LOGIN_VERDICT_FRESH_MS };

module.exports = { STATES, TRANSITIONS, MODIFIERS, CATEGORIES, CONSTANTS, MECHANICAL };
