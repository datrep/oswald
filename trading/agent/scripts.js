// trading/agent/scripts.js — TRD-12: background-script inventory.
// Every autonomous loop/poller/navigator in the trading service, in one
// registry, so the dashboard can show WHAT is running, at what cadence, and
// whether it moves the browser tab (the "script navigation" the owner sees).
'use strict';

const store = require('../store');

// id, name, cadence, navigates (browser tab moves), via, desc, evidenceKind.
const SCRIPT_DEFS = [
  { id: 'waker', name: 'Waker (schedule)', cadence: 'fires every interval (default 10m ± jitter)', navigates: false, via: 'DB + LLM', desc: 'The main loop: capture, quant scout, deliberation, execution, position review.', evidence: 'wake' },
  { id: 'capture', name: 'Plus500 price capture', cadence: 'on every wake', navigates: true, via: 'bridge', desc: 'Navigates to each watchlist instrument page and captures live bid/ask ticks.', evidence: 'telemetry.plus500_frontend' },
  { id: 'account_poller', name: 'Account mirror', cadence: '1s', navigates: false, via: 'bridge (evaluate-only)', desc: 'Reads the account strip + open positions from the parked tab.', evidence: 'account' },
  { id: 'mirror_cycle', name: 'Positions + alerts mirror', cadence: '60s', navigates: true, via: 'bridge', desc: 'Reconciles venue positions into Trades, mirrors Plus500 alerts, then parks the tab on /open-positions.', silentWhy: 'logs only when it SKIPS or fails — a healthy mirror and a dead one look identical in the event log, so liveness is judged by the position/alert rows it writes' },
  { id: 'alert_watch', name: 'Alert watch', cadence: '15s', navigates: false, via: 'DB', desc: 'Checks local alerts; a crossing wakes the desk (or logs alert_crossed while paused).', silentWhy: 'logs only when an alert actually crosses — silence is this process working correctly' },
  { id: 'position_review', name: 'Position exit review', cadence: 'on wake · 1 position/wake round-robin', navigates: false, via: 'LLM', desc: 'One-by-one hold/close review of open positions (advisory for your mirrored trades).', evidence: 'position_review' },
  { id: 'executor', name: 'Executor', cadence: 'on approved decision', navigates: true, via: 'bridge', desc: 'Places/closes orders on the Plus500 demo (asserts demo mode first).', evidence: 'trade_opened' },
  { id: 'watchdog', name: 'Watchdog', cadence: '5m', navigates: true, via: 'bridge', desc: 'Login-death check on /trade + stale-waker Telegram paging.', silentWhy: 'logs only a login death, a recovery, or a stale waker — a healthy watchdog logs nothing' },
  { id: 'concierge', name: 'Telegram concierge', cadence: '3s poll', navigates: false, via: 'Telegram', desc: 'Owner-only commands: /status /wake /pause /resume /kill /positions /help.', silentWhy: 'a poll, not a job: it writes nothing unless the owner sends a command' },
  { id: 'providers', name: 'Provider snapshot', cadence: 'on wake (60s gate)', navigates: false, via: 'REST', desc: 'Binance / OKX / Yahoo quotes into PriceTicks.', evidence: 'telemetry.provider_snapshot' },
  { id: 'bars', name: 'Bars build + retention', cadence: 'on wake (15m gate)', navigates: false, via: 'DB', desc: 'Aggregates ticks into 1h/1d bars, deletes stale ticks.', evidence: 'bars_built' },
  { id: 'meta', name: 'Meta regime (shadow)', cadence: 'on wake', navigates: false, via: 'DB', desc: 'Regime / trend / confidence / scale shadow verdict.', evidence: 'meta' },
  { id: 'multi', name: 'Multi-factor rank', cadence: '6h gate', cadenceMinutes: 360, navigates: false, via: 'Yahoo REST', desc: 'Equities momentum/trend/volatility ranking (shadow, never trades).', evidence: 'multi_signal' },
  { id: 'congress', name: 'Congress pull', cadence: '12h gate', cadenceMinutes: 720, navigates: false, via: 'Quiver REST', desc: 'Congress disclosures + flow ranking (shadow, never trades).', evidence: 'congress_signal' },
  { id: 'pulse', name: 'Market pulse', cadence: '4h gate', cadenceMinutes: 240, navigates: false, via: 'LLM', desc: 'Long-form "why the market is moving" narrative for the chair bundles.', evidence: 'pulse' },
  { id: 'digest', name: 'Midnight digest', cadence: 'daily', cadenceMinutes: 1440, navigates: false, via: 'LLM', desc: 'Compressed daily summary kept in the chair context window.', evidence: 'digest' },
  { id: 'discover', name: 'Instrument discover', cadence: 'on demand (spawned)', navigates: true, via: 'spawned script', desc: 'Search-selects each watchlist instrument to capture its Plus500 ID.', evidence: 'telemetry.watchlist_discover' },
  { id: 'discover_ai', name: 'AI watchlist discoverer', cadence: '12h gate (30m checker)', cadenceMinutes: 720, navigates: true, via: 'bridge (search probe)', desc: 'Finds interesting tickers from congress/multi/pulse feeds, probes Plus500, auto-adds matches to the watchlist (capped, ai-tagged).', evidence: 'discover_signal' },
];

// Which TradingEvent kinds feed the "last run" evidence for each script.
//
// ⚠ THESE STRINGS ARE A CONTRACT WITH THE EMITTERS, AND FOUR OF THEM USED TO BE WRONG (F32, 2026-09-18).
//
// `telemetry.capture`, `telemetry.mirror` and `telemetry.discover` named sources that no code emits — the
// capture writes `plus500_frontend`, the separate discover job writes `watchlist_discover`, and the mirror
// writes only `mirror_*` SKIP/FAILURE rows. The lookup then compared the newest telemetry event's source
// against these strings, did not match, and left the field blank — so the card rendered `—` for exactly
// the five processes whose liveness the 2026-09-17 audit needed most, including both sides of the
// bridge-contention outage. `bars` pointed at `telemetry.tick_retention`, which is written only when ticks
// are DELETED, so the column showed a timestamp only on the days retention actually removed something.
//
// The lesson is the one the audit kept re-learning: a label that is never checked against its producer
// reads as coverage while measuring nothing. `test/data-plane.test.js` now asserts every `evidence` string
// here names a kind + source that some file in `trading/` really emits.
//
// `silentWhy` is for the processes that CANNOT be judged from the event log (they log on failure or on a
// crossing only). The card prints that sentence instead of a bare dash, because an unqualified `—` is
// indistinguishable from a process that has stopped — the audit's complaint about the `Congress pull` row.

function splitEvidence(id) {
  const [kind, source] = (id || '').split('.');
  return { kind, source: source || null };
}

// One line, in the card's own words, for what this process's liveness IS — never a bare dash (F32).
// Three states, and they mean different things:
//   - timed:    the producer wrote its evidence at `lastAt`
//   - neverButExpected: the evidence kind exists in code and has NEVER been logged (`Congress pull` while
//     its strategy is off). The audit called this "correct but unqualified"; now the card says so.
//   - silentWhy: the process cannot be judged from the event log at all, and says why.
function livenessOf(d) {
  if (d.lastMs == null && d.silentWhy) return { kind: 'silent', text: d.silentWhy };
  if (d.lastMs == null) return { kind: 'never', text: `never recorded — no ${d.evidence} event exists on this desk` };
  return { kind: 'timed', text: null };
}

// A cadence fault is only a fault for a process that is SUPPOSED to run. Each rule below mirrors the gate
// in the module that owns it one-for-one, and `test/data-plane.test.js` asserts those gate expressions are
// still present in those files — so the registry cannot drift into describing a desk that no longer exists.
//
// F31's ROOT CAUSE lives here (18/09). `Multi-factor rank` had been silent for 7.5 days, and the audit
// read that as "a ranking process silently stopped". It had not stopped: the wake only reaches the 6h gate
// when `strategies.enabled` contains `multi`, and the live setting is `["survgold","survoil"]`. So the
// factor was switched off by CONFIGURATION, no error was ever logged (nothing failed — nothing ran), and
// the one surface that showed the silence could not say which kind of silence it was. That is the same
// defect class as F19: a real state that no label names.
function enabledNow(d, settings) {
  const s = settings || {};
  switch (d.id) {
    // wakePipeline `telemetry` step: `((settings.strategies || {}).enabled || ['turtle']).includes(<id>)`
    case 'multi':
    case 'congress': return ((s.strategies || {}).enabled || ['turtle']).includes(d.id);
    // wakePipeline `telemetry` step: `(settings.pulse || {}).enabled !== false`
    case 'pulse': return (s.pulse || {}).enabled !== false;
    // discoverer.runDiscovery: `if (!force && dc.enabled !== true) return { skipped: 'disabled' }`
    case 'discover_ai': return (s.discover || {}).enabled === true;
    default: return true;
  }
}

// Two of these gates are settings-driven, so the declared cadence is the DEFAULT, not the live value:
// reading `pulse.intervalHours` off the registry would report an owner who set 24h as permanently broken.
function effectiveCadenceMin(d, settings) {
  const s = settings || {};
  if (d.id === 'pulse') return Math.max(15, (Number(s.pulse && s.pulse.intervalHours) || 4) * 60);
  if (d.id === 'discover_ai') return Math.max(30, (Number(s.discover && s.discover.intervalHours) || 12) * 60);
  return Number(d.cadenceMinutes) > 0 ? Number(d.cadenceMinutes) : null;
}

// How much lateness before silence is a FAULT. 2× rather than 3× because these are gates, not
// event-driven: `Multi-factor rank` declares a 6h gate, and the audit found it silent for ~7 days — 28
// missed cycles, at which point the factor is simply absent from the desk with nothing to say so.
const CADENCE_SLACK = 2;

async function inventory(userId, settings = null) {
  const defs = SCRIPT_DEFS.map((d) => ({ ...d }));
  // One query per def, filtered in SQL by kind AND source — so a source mismatch can no longer silently
  // produce a blank cell, which is how four of these read `—` for months while the process ran every wake.
  for (const d of defs) {
    if (!d.evidence) continue;
    const { kind, source } = splitEvidence(d.evidence);
    const ev = await store.latestEvent(userId, kind, { source });
    if (!ev || !ev.payload) continue;
    const pl = ev.payload || {};
    d.lastAt = ev.createdAt;
    d.lastMs = new Date(ev.createdAt).getTime();
    d.lastSummary = String(
      pl.captured != null ? `${pl.captured} ticks` :
      pl.action != null ? `${pl.action} ${pl.reason || ''}` :
      pl.regime != null ? `regime ${pl.regime}` :
      pl.evaluated != null ? `${pl.evaluated} ranked` :
      pl.symbols != null ? `${pl.symbols} symbols` :
      pl.headline ? String(pl.headline).slice(0, 40) :
      pl.items != null ? `${pl.items.length} positions` :
      (source || kind)
    ).slice(0, 60);
  }
  for (const d of defs) {
    d.liveness = livenessOf(d);
    d.enabled = enabledNow(d, settings);
    const cadenceMin = effectiveCadenceMin(d, settings);
    d.cadenceMin = cadenceMin;
    d.maxSilenceMin = cadenceMin == null ? null : cadenceMin * CADENCE_SLACK;
    if (d.lastMs != null) d.ageMin = (Date.now() - d.lastMs) / 60000;
    // `overdue` is the ONE place "this process has stopped" is decided, so the card and the header cannot
    // disagree about it. Unknown, disabled and silent-by-design are all NOT overdue — deliberately, and
    // each for a different reason stated above.
    d.overdue = !!(d.enabled && d.maxSilenceMin != null && d.lastMs != null && d.ageMin > d.maxSilenceMin);
  }
  return defs;
}

module.exports = { inventory, SCRIPT_DEFS, splitEvidence, livenessOf, enabledNow, effectiveCadenceMin, CADENCE_SLACK };
