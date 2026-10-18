// trading/scripts/supervise.js — OUT-OF-PROCESS supervisor (TRD-40 / implied goal F).
//
// Run every few minutes by Windows Task Scheduler:
//   powershell -ExecutionPolicy Bypass -File trading\scripts\install-supervisor-task.ps1
//
// WHY OUT OF PROCESS. `trading/agent/watchdog.js` already checks Plus500 login-death and
// waker-staleness — but every one of its checks needs the process alive (it calls
// `browser.chromeAlive()` and `waker.status()`). When the process dies, the watchdog dies
// with it and nobody is told. That is exactly what happened twice:
//   2026-09-12T16:51:54Z  and  2026-09-12T18:11:54Z, both silent, both found by hand.
// A watchdog that shares fate with the thing it watches is not a watchdog.
//
// WHAT IT REPORTS, and it REPORTS ONLY:
//   SERVICE DOWN        — nothing answering on the healthz port, with the reason from
//                         crash/exit.json and the last line of trading/server.log
//   ALIVE BUT HUNG      — port answers (or not) while the heartbeat has stopped: the event
//                         loop is blocked, which a port probe alone cannot see
//   ALIVE, NOT TRADING  — process healthy but the desk has no recent wake or event, with the
//                         desk's own state (kill tier, open positions, last activity)
//   RECOVERED           — once, then it goes quiet again
//
// WHY NO AUTO-RESTART **BY DEFAULT**. Restarting a trading process unattended can double-run the
// executor against a live book, and the supervisor cannot know whether the dead instance left
// a position unmanaged. Reporting is safe; restarting is a policy choice. Pass --restart to
// opt in, understanding that trade-off.
//
// ★★ AMENDED 2026-10-06 — THE OPT-IN IS NOW ENFORCED, AND NARROWED. Two findings, one morning:
//   (1) `--restart` USED TO CHANGE ONLY THE ALERT TEXT. `restartTrading()` was defined and NEVER CALLED.
//       An inert control that reports itself ENABLED — the exact defect class of the silent desk death
//       (2026-10-05 13:08Z: process vanished, this supervisor PAGED on time, nothing restarted, 37 min
//       down) that motivated looking. Now the policy is real: `supervise-policy.js`, pinned by
//       test/supervise-policy.test.js.
//   (2) THE POLICY IS ASYMMETRIC ON PURPOSE. The restart is safe ONLY when the desk is PROVABLY GONE
//       (down + heartbeat pid dead). A desk that is DOWN-BUT-ALIVE (wedged) or HUNG is NEVER killed
//       automatically — an in-flight order could be interrupted mid-submit and strand a position; those
//       stay report-only and wait for the operator. One auto-restart per 10 minutes, max.
// The SCHEDULED TASK (install-supervisor-task.ps1 → supervise-task.ps1) passes --restart since this date.
//
// ★ AMENDED 2026-10-07 (owner item "b") — STALE-HEARTBEAT ESCALATION LANE. The hung DETECTION has existed
// since TRD-40; what never existed was an escalation path. Now: pass `--restart-hung` (the scheduled task
// does not, by default) and a hung desk IS restarted once the heartbeat has been stale for >= 10 minutes
// with a live pid, under the same 10-minute backoff. The default stays report-only deliberately: killing a
// live desk can interrupt an in-flight order — that asymmetry is a policy choice, now explicit and pinned
// in supervise-policy.js (decideHungRestart) + test/supervise-policy.test.js.
//
// Usage:
//   node trading/scripts/supervise.js              # check, alert on change
//   node trading/scripts/supervise.js --dry        # print, send nothing
//   node trading/scripts/supervise.js --quiet      # silent unless alerting (for the task)
//   node trading/scripts/supervise.js --restart    # opt in to restarting when down'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const { paths: CRASH } = require('../lib/crash');
const { decideAutoRestart, decideHungRestart } = require('./supervise-policy');

const ARGS = new Set(process.argv.slice(2));
const DRY = ARGS.has('--dry');
const QUIET = ARGS.has('--quiet');
const RESTART = ARGS.has('--restart');
const RESTART_HUNG = ARGS.has('--restart-hung');   // 2026-10-07, item b: opt-in stale-heartbeat escalation

const ROOT = path.join(__dirname, '..', '..');
const TRADING = path.join(ROOT, 'trading');
const LOG_FILE = path.join(TRADING, 'server.log');
const ERR_FILE = path.join(TRADING, 'server.err.log');
const STATE_FILE = path.join(CRASH.DIR, 'supervisor-state.json');
const HEALTH_URL = process.env.TRADING_HEALTH_URL || 'http://127.0.0.1:8115/healthz';

const HEARTBEAT_STALE_MS = 150000;   // heartbeat is every 30s; 2.5min means the loop is stuck
const DOWN_REALERT_MS = 30 * 60000;  // while down, re-page at most every 30min
const IDLE_ALERT_MS = 75 * 60000;    // process fine but nothing has happened for 75min

const say = (s) => { if (!QUIET) console.log(s); };

// Market state WITHOUT the trading process: sessions.calendarState() is pure and synchronous,
// so the supervisor can tell "the desk is idle" from "the desk is idle BECAUSE the market is
// closed". Without this the pager would fire every 30 minutes all weekend, and a pager that
// is wrong becomes a pager that is ignored — which is worse than no pager.
function marketState() {
  try {
    const { calendarState } = require('../agent/sessions');
    return calendarState(new Date());
  } catch (e) {
    return `unknown (${String(e.message || e).slice(0, 60)})`;
  }
}
// Next time the calendar says OPEN (entries allowed), to the minute. A 15-minute grid
// reported 20:43 UTC as "next open" when the open is 21:00 — it had found the start of the
// 30-minute OBSERVATION window, which is "not closed" but is not the open either. Plausible-
// looking and wrong is the failure mode this whole workstream exists to eliminate, so the
// grid is 1 minute and the target state is 'open' specifically.
function nextOpenText(from = new Date()) {
  try {
    const { calendarState } = require('../agent/sessions');
    const base = new Date(Math.floor(from.getTime() / 60000) * 60000);
    for (let i = 1; i <= 8 * 24 * 60; i++) {
      const t = new Date(base.getTime() + i * 60000);
      if (calendarState(t) === 'open') return `${t.toISOString()} (in ${ageStr(i * 60000)})`;
    }
  } catch { /* fall through */ }
  return 'unknown';
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch { /* best effort */ }
}
function tail(file, n = 1) {
  try {
    const txt = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/);
    return txt.slice(-n).join(' | ').slice(0, 300);
  } catch { return null; }
}
// The last time we have EVIDENCE the service was alive. A dead process cannot tell us when
// it died, so the log's mtime is the best available proxy — and far better than "now",
// which would understate every outage as 0s.
function logMtimeIso() {
  try { return fs.statSync(LOG_FILE).mtime.toISOString(); } catch { return null; }
}
function ageStr(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
const isoAge = (iso) => (iso ? ageStr(Date.now() - new Date(iso).getTime()) : null);

async function probeHealth() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(HEALTH_URL, { signal: ctrl.signal });
    return { ok: r.ok, status: r.status, body: (await r.text()).slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 120) };
  } finally { clearTimeout(t); }
}

// The desk's OWN view of whether it is trading. Best-effort: if SQL is unreachable that is
// itself reportable, but it must not stop the supervisor from reporting a dead process.
async function deskState() {
  try {
    const { getPool } = require('../../shared/db');
    const db = await getPool();
    const r = (await db.request().query(
      `SELECT
         (SELECT COUNT(*) FROM Trades WHERE status = 'open') AS openPositions,
         (SELECT TOP 1 createdAt FROM TradingEvents ORDER BY id DESC) AS lastEventAt,
         (SELECT TOP 1 createdAt FROM TradingEvents WHERE kind = 'wake' ORDER BY id DESC) AS lastWakeAt,
         (SELECT TOP 1 createdAt FROM TradingEvents WHERE kind = 'self_health' ORDER BY id DESC) AS lastSelfHealthAt,
         (SELECT TOP 1 JSON_VALUE(settings,'$.kill.tier') FROM TradingSettings) AS killTier`,
    )).recordset[0];
    return {
      ok: true,
      openPositions: r.openPositions,
      lastEventAt: r.lastEventAt,
      lastWakeAt: r.lastWakeAt,
      lastSelfHealthAt: r.lastSelfHealthAt,
      killTier: r.killTier,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 140) };
  }
}

function restartTrading() {
  // Only ever called with --restart. Mirrors scripts/restart-trading.ps1 (WMI spawn, so the
  // service is not a child of this supervisor and cannot be killed with it).
  const { spawnSync } = require('child_process');
  const ps = path.join(TRADING, 'scripts', 'restart-trading.ps1');
  if (!fs.existsSync(ps)) return { ok: false, error: `missing ${ps}` };
  const r = spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', ps], { encoding: 'utf8' });
  return { ok: r.status === 0, out: String(r.stdout || '').slice(0, 400), err: String(r.stderr || '').slice(0, 200) };
}

// ★ 2026-10-06: is the pid in the crash-guard heartbeat still ALIVE? Signal 0 = existence check.
// EPERM means "alive but not ours" — still alive, which is the safe direction for this decision.
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

function composeDown(downSince, sinceSource, exitRec, hb, health, desk) {
  const hbAge = hb ? Date.now() - new Date(hb.at).getTime() : null;
  // crash/exit.json is a SINGLE file, so any process that loads the crash guard overwrites it
  // - including a `npm run test:unit`/smoke run. An exit record OLDER than the last heartbeat
  // therefore belongs to a PREVIOUS process, and quoting it as this outage's cause would be
  // exactly the plausible-looking-and-wrong failure this workstream exists to remove.
  const hbMs = hb && hb.at ? new Date(hb.at).getTime() : null;
  const exMs = exitRec && exitRec.at ? new Date(exitRec.at).getTime() : null;
  const staleExit = exMs != null && hbMs != null && exMs < hbMs;
  let reason;
  if (!staleExit && exitRec && exitRec.event !== 'heartbeat' && exitRec.event !== 'start') {
    const codeTxt = exitRec.code != null ? ` code ${exitRec.code}` : '';
    const why = exitRec.message || exitRec.reason || exitRec.signal || '';
    reason = `process ${exitRec.event}${codeTxt} at ${exitRec.at}${why ? ` — ${why}` : ''}`;
  } else if (hbAge != null && hbAge > HEARTBEAT_STALE_MS) {
    reason = `no exit record for THIS process; last heartbeat ${ageStr(hbAge)} ago — killed abruptly (SIGKILL / OOM / parent teardown)`;
    if (staleExit) reason += `\n  (an older exit record exists from pid ${exitRec.pid} at ${exitRec.at} — a different process)`;
  } else if (!hb) {
    reason = 'no crash files at all — this process was started before the crash guard existed';
  } else {
    reason = 'no exit record and the heartbeat is fresh — process may be starting up';
  }
  const lines = [
    `OSWALD trading: SERVICE DOWN for ${ageStr(Date.now() - new Date(downSince).getTime())}`,
    `reason: ${reason}`,
    health.error ? `healthz: ${health.error}` : `healthz: HTTP ${health.status}`,
    `down since: ${downSince} (${sinceSource})`,
  ];
  const lastLog = tail(LOG_FILE);
  if (lastLog) lines.push(`last log: ${lastLog}`);
  const lastErr = tail(ERR_FILE, 2);
  if (lastErr) lines.push(`last error log: ${lastErr}`);
  const mkt = marketState();
  lines.push(mkt === 'closed'
    ? `market: CLOSED (next open ${nextOpenText()}) — the death cost no trading time, but the desk must be up before then`
    : `market: ${mkt}`);
  if (desk && desk.ok) {
    lines.push(`desk: ${desk.openPositions} open position(s), kill=${desk.killTier || 'off'}, last event ${isoAge(desk.lastEventAt) || 'never'} ago`);
  } else if (desk) {
    lines.push(`desk state unavailable: ${desk.error}`);
  }
  lines.push(RESTART
    ? 'auto-restart policy: ONLY when the process is provably gone (down + pid dead); hung desks stay operator-decided'
    : 'no auto-restart (report-only). Start: powershell -File trading\\scripts\\restart-trading.ps1');
  return lines.join('\n');
}

// Returns the delivery result. A supervisor that cannot tell whether it paged is not doing its
// job: lib/http.js now RECORDS failures, and we also surface them in the exit code, because
// Task Scheduler's "Last Run Result" is inspectable without Telegram being alive.
async function alert(text) {
  say(text);
  if (DRY) { say('(dry run - nothing sent)'); return { ok: true, dry: true }; }
  try {
    const { telegramAlert } = require('../lib/http');
    const r = await telegramAlert(text);
    if (!r || !r.ok) {
      console.error(`[supervise] ALERT DELIVERY FAILED: ${(r && (r.description || r.error)) || 'unknown'} - the message above was NOT sent anywhere`);
    }
    return r || { ok: false, error: 'no result' };
  } catch (e) {
    console.error(`[supervise] ALERT THREW: ${String(e.message || e).slice(0, 120)}`);
    return { ok: false, error: String(e.message || e) };
  }
}

// A backlog means earlier pages were dropped AND nothing has been delivered since. If this one
// lands, the operator needs to know what they missed; if it also fails, the exit code and the
// failure log still record it.
function failureBacklog() {
  try {
    const { alertFailures, lastAlertOkAt } = require('../lib/http');
    const since = lastAlertOkAt();          // undefined => no success on record at all
    const undelivered = alertFailures(since ? { since } : {});
    if (!undelivered.length) return null;
    const last = undelivered[undelivered.length - 1];
    return `${undelivered.length} alert(s) failed to deliver since the last success${since ? ` (${since})` : ' (no success on record)'}; most recent ${last.at} — ${last.error}`;
  } catch { return null; }
}

(async () => {
  const state = readJson(STATE_FILE) || {};
  const exitRec = readJson(CRASH.EXIT_FILE);
  const hb = readJson(CRASH.HEARTBEAT_FILE);
  const health = await probeHealth();
  const desk = await deskState();
  const now = Date.now();

  const hbAge = hb ? now - new Date(hb.at).getTime() : null;
  const hung = !!(hb && hbAge > HEARTBEAT_STALE_MS);
  const down = !health.ok;

  const previous = state.lastState || 'unknown';
  let current;
  let message = null;

  if (down) {
    current = 'down';
    // Prefer a previously recorded downSince (the true start of the outage), else the last
    // evidence of liveness: heartbeat, then the log's mtime, then the desk's last event.
    let downSince = state.downSince;
    let sinceSource = 'recorded at the previous check';
    if (!downSince) {
      if (hb && hb.at) { downSince = hb.at; sinceSource = 'last heartbeat'; }
      else if (logMtimeIso()) { downSince = logMtimeIso(); sinceSource = 'last line written to server.log'; }
      else if (desk.ok && desk.lastEventAt) { downSince = desk.lastEventAt; sinceSource = 'last desk event'; }
      else { downSince = new Date(now).toISOString(); sinceSource = 'first check — no evidence available'; }
    }
    const due = !state.lastAlertAt || now - new Date(state.lastAlertAt).getTime() > DOWN_REALERT_MS;
    if (previous !== 'down' || due) message = composeDown(downSince, sinceSource, exitRec, hb, health, desk);
    state.downSince = downSince;
  } else if (hung) {
    current = 'hung';
    const due = !state.lastAlertAt || now - new Date(state.lastAlertAt).getTime() > DOWN_REALERT_MS;
    if (previous !== 'hung' || due) {
      message = [
        'OSWALD trading: ALIVE BUT HUNG',
        `reason: the health port answers but the heartbeat stopped ${ageStr(hbAge)} ago`,
        `the event loop is blocked — a port check alone would call this healthy`,
        exitRec ? `last crash record: ${exitRec.event} at ${exitRec.at}` : 'no crash record',
      ].join('\n');
    }
  } else {
    current = 'up';
    const mkt = marketState();
    const tradingWindow = mkt === 'open' || mkt === 'observation';
    const wakeAge = desk.ok && desk.lastWakeAt ? now - new Date(desk.lastWakeAt).getTime() : null;
    const idle = desk.ok && wakeAge != null && wakeAge > IDLE_ALERT_MS;
    if (idle && tradingWindow) {
      const due = !state.lastAlertAt || now - new Date(state.lastAlertAt).getTime() > DOWN_REALERT_MS;
      if (due) {
        message = [
          `OSWALD trading: ALIVE BUT NOT TRADING (${ageStr(wakeAge)} since the last wake)`,
          `market: ${mkt} — the desk SHOULD be trading`,
          `desk: ${desk.openPositions} open position(s), kill=${desk.killTier || 'off'}`,
          `last event ${isoAge(desk.lastEventAt) || 'never'} ago, self-health ${isoAge(desk.lastSelfHealthAt) || 'never'} ago`,
        ].join('\n');
      }
    } else if (idle) {
      // The whole point of the market check: silence here is CORRECT, and saying so out loud
      // is what keeps the real alert trustworthy.
      say(`[supervise] idle ${ageStr(wakeAge)} but the market is ${mkt} — not alerting (next open ${nextOpenText()})`);
    }
    if (previous === 'down') {
      message = `${message ? `${message}\n\n` : ''}OSWALD trading: RECOVERED — service is answering again (was down since ${state.downSince || 'unknown'})`;
    }
    state.downSince = null;
  }

  let delivered = true;

  // ★ 2026-10-06: THE POLICY, now actually ENFORCED (before this, --restart changed only the alert text —
  // restartTrading() was never called; see supervise-policy.js for the why and the asymmetry). Runs on the
  // DENIED path too, so a held restart is stated rather than silent.
  const recentAuto = state.lastAutoRestartAt && (now - new Date(state.lastAutoRestartAt).getTime() < 10 * 60000);
  const policy = decideAutoRestart({
    restartFlag: RESTART, state: current,
    pidAlive: hb && hb.pid ? pidAlive(hb.pid) : false,
    recentAutoRestart: !!recentAuto,
  });
  let restartNote = null;
  if (policy.act) {
    const r = restartTrading();
    if (r.ok) {
      restartNote = `auto-restart: EXECUTED — ${policy.reason}`;
      state.downSince = null;
      state.lastAutoRestartAt = new Date(now).toISOString();
    } else {
      restartNote = `auto-restart: ATTEMPTED AND FAILED — ${policy.reason} — ${String(r.error || r.err || '').slice(0, 160)}`;
      state.lastAutoRestartAt = new Date(now).toISOString();
    }
  } else if (RESTART && current !== 'up') {
    restartNote = `auto-restart: held — ${policy.reason}`;
  }
  if (restartNote) {
    say(`[supervise] ${restartNote}`);
    if (message) message += `\n${restartNote}`;
  }

  // Stale-heartbeat escalation lane (2026-10-07, item "b"): OPT-IN via --restart-hung (default OFF —
  // the strand-an-order asymmetry is unchanged). The held/report-only decision is stated on every hung
  // alert so the control is never silent about itself (the 2026-10-06 inert-control lesson).
  if (current === 'hung') {
    const hp = decideHungRestart({
      restartHungFlag: RESTART_HUNG,
      hbAgeMs: hbAge,
      pidAlive: hb && hb.pid ? pidAlive(hb.pid) : false,
      recentAutoRestart: !!recentAuto,
    });
    let hungNote;
    if (hp.act) {
      const r = restartTrading();
      hungNote = r.ok
        ? `hung-restart: EXECUTED — ${hp.reason}`
        : `hung-restart: ATTEMPTED AND FAILED — ${hp.reason} — ${String((r && (r.error || r.err)) || '').slice(0, 140)}`;
      if (r.ok) state.downSince = null;
      state.lastAutoRestartAt = new Date(now).toISOString();
    } else {
      hungNote = `hung-restart: held — ${hp.reason}`;
    }
    say(`[supervise] ${hungNote}`);
    if (message) message += `\n${hungNote}`;
  }

  if (message) {
    const backlog = failureBacklog();
    if (backlog) message += `\n\nNOTE: ${backlog} — the alert channel itself may be unreliable, so check the dashboard directly.`;
    const r = await alert(message);
    delivered = !!(r && r.ok);
    if (delivered) state.lastAlertAt = new Date(now).toISOString();
  } else {
    // Nothing to report about the desk — but a dropped page is itself a finding, and it is the
    // one finding that cannot be delivered through the channel that is broken. So it is printed
    // and it sets a nonzero exit code, which survives as "Last Run Result" in Task Scheduler.
    const backlog = failureBacklog();
    if (backlog) {
      console.error(`[supervise] UNDELIVERED ALERTS: ${backlog}`);
      console.error('[supervise] exit 4 — the desk is up, but the alert channel has dropped messages');
      writeJson(STATE_FILE, { ...state, lastState: current, lastRunAt: new Date(now).toISOString() });
      process.exit(4);
    }
    say(`[supervise] ok — state=${current}; healthz up; heartbeat ${hbAge != null ? `${ageStr(hbAge)} old` : 'absent'}; market ${marketState()}; last wake ${isoAge(desk.ok ? desk.lastWakeAt : null) || 'n/a'}`);
  }

  state.lastState = current;
  state.lastRunAt = new Date(now).toISOString();
  writeJson(STATE_FILE, state);

  // Exit codes are the ONLY signal that survives a broken alert channel: Task Scheduler
  // records them as "Last Run Result", readable via install-supervisor-task.ps1 -Status.
  //   0 = desk up   2 = down/hung   3 = supervisor broken   4 = alerted but COULD NOT DELIVER
  if (!delivered) {
    console.error('[supervise] exit 4 — the desk state was detected but the page did not go out');
    process.exit(4);
  }
  process.exit(current === 'up' ? 0 : 2);
})().catch((e) => {
  console.error(`[supervise] failed: ${String(e.stack || e.message || e)}`);
  process.exit(3);
});
