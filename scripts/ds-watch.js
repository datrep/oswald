// scripts/ds-watch.js
// DS-WATCH — watchdog + optional circuit breaker for the DeepSeek prompt-cache blow-up.
//
// WHY: the Copilot BYOK extension (vizards.deepseek-v4-for-copilot) writes one line per
// request to its VS Code output log:
//     [main-agent] tokens: model=… prompt=N completion=N | cache: hit=N miss=N rate=P%
// A healthy request is rate 98-100 % (only the tail is uncached). When a break point sits
// mid-history, `hit` freezes at a fixed prefix and everything after it is re-bought at
// ~50x the hit price on EVERY turn — that is what turned one afternoon into ~¥94.
// Compacting / reverting / starting a new chat costs exactly ONE full-miss request and
// resets the ratio to ~100 %. This script makes that visible in seconds, and with
// --proxy makes it enforceable.
//
// USAGE
//   node scripts/ds-watch.js                 watchdog only (alerts + log + state file)
//   node scripts/ds-watch.js --verbose       print every request
//   node scripts/ds-watch.js --self-test     offline test of the parser + breaker logic
//   node scripts/ds-watch.js --proxy         also run the local breaker proxy on :8788
//   node scripts/ds-watch.js --proxy --capture <dir>   also tee each chat request body to <dir>
//   --max-cny N --max-miss-cny N             hard ¥ budgets (default 100 / 30, 'off' disables)
//
// HARD STOP (opt-in, one setting): point the extension at this proxy, then reload the
// window —  "deepseek-copilot.baseUrl": "http://127.0.0.1:8788"
// Two independent rails then refuse /chat/completions with HTTP 429 + a reason:
//   1. the CACHE breaker — warn the moment the rate leaves 95%, REFUSE the moment it reaches 85%
//   2. the ¥ BUDGET     — the day's estimated spend passed the cap. This one still works
//      when the detector is merely unlucky, and it needs nothing but this process.
// A 45 s probe still goes through, so compact -> retry always works. Recover by compacting
// (3 clean requests close it) or GET /reset. GET /reset?caps=off waives the budget for today.
//
// Read-only with respect to the logs; never talks to the API itself (the proxy only
// forwards requests the extension already made, with the extension's own headers).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
let WATCH_LOG = path.join(ROOT, 'logs', 'ds-watch.log');
let STATE_FILE = path.join(ROOT, 'temp', 'ds-watch-state.json');
const LOCK_FILE = path.join(ROOT, 'temp', 'ds-watch.pid');

// Single instance: DS-WATCH is a managed OSWALD service now (Server tray + autoStart),
// so the dashboard, start-ds-watch.ps1 and a stray terminal must not all watch at once.
// Returns the pid of a live instance holding the lock, or 0 after taking it.
function acquireLock() {
  try {
    const old = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    if (old && old !== process.pid) {
      try {
        process.kill(old, 0);
        return old; // still alive
      } catch {
        /* stale pid - take it over */
      }
    }
  } catch {
    /* no lock file yet */
  }
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch {
    /* non-fatal: worst case two watchers */
  }
  return 0;
}

function releaseLock() {
  try {
    if (Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------- config

const CFG = {
  verbose: false,
  json: false,
  selfTest: false,
  proxy: false,
  port: 8788,
  pollMs: 2000,
  summaryMs: 30000,
  minMiss: 20000, // a request only matters if it re-bought at least this many tokens (~¥0.02-0.04).
  //                 2026-09-24 02:24 is why: a 6.0k miss on a 39.3k fresh chat (rate 85%) tripped
  //                 the breaker and locked the chat for a rounding error. Never again.
  tripMinPrompt: 60000, // a prompt this small cannot carry a meaningful burn - warn, never trip
  warnRate: 95, // below this = WARN (a healthy turn hits >= 95%)
  tripRate: 85, // at/below this the rate has left 95% by 10 points - TRIP, compact by hand
  rewriteRate: 25, // a request this bad (or with almost no hit) looks like a compact, not a break
  rewriteHit: 30000,
  rewriteAllowance: 2, // consecutive refill-looking requests that are the compact's own cost, not a burn
  bigPrompt: 400000, // above this the session is big enough that VS Code prunes it every turn
  tripStreak: 1, // trip-grade requests in a row -> TRIP (1 = the ratio alone decides)
  tripBadInN: 3, // …or this many trip-grade requests inside the last…
  tripBadInM: 6, // …M requests. main-agent / background / terminal-steering interleave in one
  //                 log, so a single clean request from another agent must not shield a burn
  //                 (that is exactly how 2026-09-16 never tripped: it hovered at streak 2).
  tripWindowMiss: 400000, // …or this much miss in the last 10 requests
  recoverStreak: 3, // clean requests needed to close the circuit
  probeMs: 45000, // while OPEN, let one request through this often
  advisoryAfterTrips: 3, // this many trips inside…
  advisoryWindowMs: 20 * 60 * 1000, // …this window open advisory mode…
  advisoryMs: 15 * 60 * 1000, // …for this long (refusals pause, the ¥ rails do not)
  maxCny: 100, // HARD daily budget in CNY: refuse /chat/completions once today's spend passes it
  maxMissCny: 60, // HARD daily cap for MISS-BILLED spend (the 50x zone). Infinity = off.
  //                 2026-10-01: raised 30 -> 60 by request (a heavy writing day). At the observed
  //                 ~49% miss share this makes the 100 total the binding rail instead of ~61.
  //                 Waive for a single day without touching config: GET /reset?caps=off
  captureKeep: 20, // --capture: keep only the newest N request bodies on disk
};

/** 0 / missing / garbage keeps the built-in default; the literal 'off' disables the cap */
const numOrOff = (v, dflt) => {
  if (v == null) return dflt;
  if (String(v).toLowerCase() === 'off') return Infinity;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--verbose' || a === '-v') CFG.verbose = true;
  else if (a === '--json') CFG.json = true;
  else if (a === '--self-test') CFG.selfTest = true;
  else if (a === '--proxy') CFG.proxy = true;
  else if (a === '--port') CFG.port = Number(argv[++i]) || CFG.port;
  else if (a === '--min-miss') CFG.minMiss = Number(argv[++i]) || CFG.minMiss;
  else if (a === '--warn-rate') CFG.warnRate = Number(argv[++i]) || CFG.warnRate;
  else if (a === '--trip-streak') CFG.tripStreak = Number(argv[++i]) || CFG.tripStreak;
  else if (a === '--trip-rate') CFG.tripRate = Number(argv[++i]) || CFG.tripRate;
  else if (a === '--max-cny') CFG.maxCny = numOrOff(argv[++i], CFG.maxCny);
  else if (a === '--max-miss-cny') CFG.maxMissCny = numOrOff(argv[++i], CFG.maxMissCny);
  else if (a === '--log-root') (CFG.logRoots = CFG.logRoots || []).push(argv[++i]);
  else if (a === '--state') STATE_FILE = path.resolve(argv[++i] || STATE_FILE);
  else if (a === '--log-file') WATCH_LOG = path.resolve(argv[++i] || WATCH_LOG);
  else if (a === '--capture') CFG.captureDir = argv[++i];
  else if (a === '--capture-keep') CFG.captureKeep = Number(argv[++i]) || CFG.captureKeep;
  else if (a === '--multi') CFG.multi = true;
  else if (a === '--help' || a === '-h') {
    // print the header comment block, whatever it grows to (do not hard-code a line number)
    const src = fs.readFileSync(__filename, 'utf8').split('\n');
    const end = src.findIndex((l) => l.startsWith("'use strict'"));
    console.log(src.slice(1, end < 0 ? src.length : end).join('\n').replace(/^\/\/ ?/gm, ''));
    process.exit(0);
  }
}

// ---------------------------------------------------------------- price model
// CNY per 1M tokens, measured from the DeepSeek platform export on 2026-09-15
// (the export's `price` column). Peak is exactly 2x off-peak.
// Peak, local time: 09:00-11:59 and 14:00-17:59 Mon-Fri (= 01:00-04:00 / 06:00-10:00 UTC).

const PRICES = {
  'deepseek-flash': { hit: 0.02, miss: 1.0, out: 4.0 },
  'deepseek-v4-flash': { hit: 0.02, miss: 1.0, out: 4.0 },
  'deepseek-v4-pro': { hit: 0.15, miss: 4.72, out: 14.16 },
};

function isPeak(d) {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const h = d.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

function priceOf(model, when) {
  const known = Object.prototype.hasOwnProperty.call(PRICES, model);
  const p = known ? PRICES[model] : PRICES['deepseek-flash'];
  const k = isPeak(when) ? 2 : 1;
  return { hit: p.hit * k, miss: p.miss * k, out: p.out * k, known };
}

function cnyOf(r) {
  const p = priceOf(r.model, new Date(r.t));
  return (r.hit * p.hit + r.miss * p.miss + r.completion * p.out) / 1e6;
}

/** the miss-billing part of the bill: this is the 50x zone the budget actually caps */
function missCnyOf(r) {
  const p = priceOf(r.model, new Date(r.t));
  return (r.miss * p.miss) / 1e6;
}

// ---------------------------------------------------------------- helpers

const fmtM = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
const fmtY = (n) => '¥' + (n >= 10 ? n.toFixed(2) : n.toFixed(3));
const fmtCap = (n) => (Number.isFinite(n) ? fmtY(n) : 'off');

function stamp() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1, 2)}-${p(d.getDate(), 2)} ${p(d.getHours(), 2)}:${p(d.getMinutes(), 2)}:${p(d.getSeconds(), 2)}`;
}

function say(msg) {
  if (CFG.json) return;
  console.log(msg);
}

function note(msg) {
  say(msg);
  try {
    fs.mkdirSync(path.dirname(WATCH_LOG), { recursive: true });
    fs.appendFileSync(WATCH_LOG, `${stamp()}  ${msg}\n`);
  } catch {
    /* logging must never take the watchdog down */
  }
}

// ---------------------------------------------------------------- parsing

const RE_TOKENS =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})\.\d+ \[(\w+)\] \[([^\]]+)\] tokens: model=(\S+) prompt=(\d+) completion=(\d+) \| cache: hit=(\d+) miss=(\d+) rate=(\d+)%/;
const RE_ERROR = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})\.\d+ \[error\] DeepSeek request failed: kind=(\S+) code=(\S+)/;

function parseLine(line) {
  let m = RE_TOKENS.exec(line);
  if (m) {
    return {
      kind: 'request',
      t: `${m[1]} ${m[2]}:${m[3]}:${m[4]}`,
      day: m[1],
      level: m[5],
      agent: m[6],
      model: m[7],
      prompt: Number(m[8]),
      completion: Number(m[9]),
      hit: Number(m[10]),
      miss: Number(m[11]),
      rate: Number(m[12]),
    };
  }
  m = RE_ERROR.exec(line);
  if (m) {
    return { kind: 'error', t: `${m[1]} ${m[2]}:${m[3]}:${m[4]}`, day: m[1], agent: `network ${m[5]}/${m[6]}` };
  }
  return null;
}

// ---------------------------------------------------------------- detector

class Detector {
  constructor(cfg) {
    this.cfg = cfg;
    this.win = [];
    this.streak = 0;
    this.good = 0;
    this.tripped = false;
    this.trippedAt = null;
    this.trippedAtMs = null; // when the circuit opened - the probe window starts here, not at boot
    this.tripCount = 0;
    this.lastTrip = null;
    this.rewriteRun = 0; // consecutive refill-looking requests (the compact's own cost, not a burn)
    this.totals = { n: 0, hit: 0, miss: 0, out: 0, cny: 0, cnyMiss: 0, badN: 0, badCny: 0 };
  }

  /** bad enough to WARN about: the hit rate slipped under the bar and real money was re-bought */
  isBad(r) {
    return r.rate < this.cfg.warnRate && r.miss >= this.cfg.minMiss;
  }

  /** bad enough to TRIP on. The RATIO is the rail the user cares about (85%), but a trip also has
   *  to be worth stopping for: a small prompt or a trivial miss is a warning, not an emergency. */
  isTrip(r) {
    return r.rate <= this.cfg.tripRate && r.miss >= this.cfg.minMiss && r.prompt >= this.cfg.tripMinPrompt;
  }

  /** a request whose reusable prefix is essentially gone: exactly what a compact / revert / new
   *  chat / cold start looks like, and NOT a sign that the cache is broken. */
  isRewrite(r) {
    return r.rate < this.cfg.rewriteRate || r.hit < this.cfg.rewriteHit;
  }

  /** trip-grade requests already in the recent window (the current one is not in it yet) */
  badInWindow() {
    let n = 0;
    for (const r of this.win) if (this.isTrip(r)) n++;
    return n;
  }

  /** midnight: today's counters, streak and circuit start clean. tripCount/lastTrip are history. */
  resetDay() {
    this.win = [];
    this.streak = 0;
    this.good = 0;
    this.tripped = false;
    this.trippedAt = null;
    this.trippedAtMs = null;
    this.rewriteRun = 0;
    this.totals = { n: 0, hit: 0, miss: 0, out: 0, cny: 0, cnyMiss: 0, badN: 0, badCny: 0 };
  }

  windowMiss() {
    let m = 0;
    for (const r of this.win) m += r.miss;
    return m;
  }

  /** feed a request; returns { events, bad, cost } */
  add(r, opts = {}) {
    const events = [];
    const cost = cnyOf(r);
    const bad = this.isBad(r);
    const t = this.totals;
    t.n++;
    t.hit += r.hit;
    t.miss += r.miss;
    t.out += r.completion;
    t.cny += cost;
    t.cnyMiss += missCnyOf(r);
    if (bad) {
      t.badN++;
      t.badCny += cost;
    }
    if (opts.history) return { events, bad, cost };

    if (opts.probe) {
      // One request was let through while the circuit was OPEN - judge it from its result:
      //   a rewrite          -> the compact / revert / new chat IS the fix, release the lock
      //   above the trip bar -> the ratio is acceptable again, release the lock there and then
      //   still trip-grade   -> the break is still there: stay OPEN, do not spend another probe yet
      // The middle case is what removes the need for a manual /reset: a session sitting at 86-94%
      // can never reach the 95% warn bar, so waiting for "clean" requests is what used to latch it.
      this.good = 0;
      if (this.isRewrite(r) || !this.isTrip(r)) {
        this.tripped = false;
        this.trippedAt = null;
        this.trippedAtMs = null;
        this.streak = 0;
        events.push('probe', 'recover');
      } else {
        this.streak++;
        events.push('probe', 'warn');
      }
      this.rewriteRun = 0;
      this.win.push(r);
      if (this.win.length > 10) this.win.shift();
      return { events, bad, cost };
    }
    // Recovery is symmetric with the trip rule: the emergency is over once the ratio is back ABOVE
    // the trip bar (not only when it reaches the 95% warn bar). A warn-grade request (86-94%) therefore
    // counts as progress - that is what lets the lock clear itself instead of needing /reset.
    const tripGrade = this.isTrip(r);
    if (tripGrade) {
      this.good = 0;
    } else {
      this.good++;
      if (this.tripped && this.good >= this.cfg.recoverStreak) {
        this.tripped = false;
        this.trippedAt = null;
        this.trippedAtMs = null;
        events.push('recover');
      }
    }
    if (bad) events.push('warn');
    // Only a genuinely broken request can trip, and any ONE of three independent triggers is enough:
    //   N in a row, N inside the last M requests (so an interleaved clean request from another
    //   agent cannot shield an ongoing burn), or a large mass of miss tokens in the recent window.
    // A refill-looking request is the FIX being applied, not a failure: a compact / revert / new
    // chat costs exactly one full miss, and the refill can legitimately take two (the summarizer
    // run, then the first turn at the new size) - both were seen on 2026-09-24 and both were
    // falsely tripping. A run BEYOND rewriteAllowance is not a refill: it is the short-prefix burn
    // (hit pinned near 20k while the prompt kept growing) that hit 2026-09-16, and it must trip.
    if (tripGrade) {
      const rewrite = this.isRewrite(r);
      this.rewriteRun = rewrite ? this.rewriteRun + 1 : 0;
      const masked = rewrite && this.rewriteRun <= this.cfg.rewriteAllowance;
      if (!masked) this.streak++;
      const windowHit = this.windowMiss() >= this.cfg.tripWindowMiss;
      const badInM = this.badInWindow() + 1;
      if (!this.tripped && !masked && (this.streak >= this.cfg.tripStreak || badInM >= this.cfg.tripBadInN || windowHit)) {
        this.tripped = true;
        this.trippedAt = r.t;
        this.trippedAtMs = Date.now();
        this.tripCount++;
        this.lastTrip = { t: r.t, rate: r.rate, hit: r.hit, miss: r.miss, prompt: r.prompt, streak: this.streak, badInM, windowHit, refill: false };
        events.push('trip');
      } else if (masked) {
        events.push('refill');
      }
    } else {
      this.rewriteRun = 0;
      this.streak = 0;
    }
    this.win.push(r);
    if (this.win.length > 10) this.win.shift();
    return { events, bad, cost };
  }
}

const detector = new Detector(CFG);

// ---------------------------------------------------------------- hard budget
// Everything above is a cache-HEALTH heuristic, and a heuristic can only ever be a proxy for
// money. On 2026-09-16 it sat one bad request short of a trip all day while ¥23 burned. These
// two caps are the literal answer to "cap out": once the day's estimated spend passes them,
// /chat/completions is refused no matter what the hit rate happens to look like.

let capsWaivedFor = null; // day for which the human deliberately waived the budget

// Repeated trips are a signal in themselves: if the breaker has fired several times in a short
// window, refusing is not fixing anything (the break is somewhere compacting does not reach), it
// has only become a wall the user cannot get past. After advisoryAfterTrips trips inside
// advisoryWindowMs, refusals pause for advisoryMs. The ¥ rails are NOT affected - the money
// backstop stays armed, so this relaxes friction, not protection.
class Advisory {
  constructor(cfg) {
    this.cfg = cfg;
    this.times = [];
    this.until = 0;
  }

  /** record a trip; true when this trip is the one that opens advisory mode */
  register(now = Date.now()) {
    this.times = this.times.filter((t) => now - t < this.cfg.advisoryWindowMs);
    this.times.push(now);
    if (this.times.length < this.cfg.advisoryAfterTrips) return false;
    const entering = now >= this.until;
    this.until = now + this.cfg.advisoryMs;
    return entering;
  }

  active(now = Date.now()) {
    return now < this.until;
  }

  get recentCount() {
    return this.times.length;
  }
}

const advisory = new Advisory(CFG);

function budgetOf(t = detector.totals, cfg = CFG, day = stamp().slice(0, 10)) {
  const waived = capsWaivedFor === day;
  const overTotal = Number.isFinite(cfg.maxCny) && (t.cny || 0) >= cfg.maxCny;
  const overMiss = Number.isFinite(cfg.maxMissCny) && (t.cnyMiss || 0) >= cfg.maxMissCny;
  const out = {
    maxCny: Number.isFinite(cfg.maxCny) ? cfg.maxCny : null,
    maxMissCny: Number.isFinite(cfg.maxMissCny) ? cfg.maxMissCny : null,
    spent: t.cny || 0,
    missSpent: t.cnyMiss || 0,
    over: !waived && (overTotal || overMiss),
    waived,
  };
  if (out.over) {
    out.why =
      overTotal && overMiss
        ? `daily budget reached: ${fmtY(t.cny)} spent (cap ${fmtCap(cfg.maxCny)}) and ${fmtY(t.cnyMiss)} of it is miss billing (cap ${fmtCap(cfg.maxMissCny)})`
        : overTotal
          ? `daily budget reached: ${fmtY(t.cny)} spent (cap ${fmtCap(cfg.maxCny)})`
          : `${fmtY(t.cnyMiss)} of today's ${fmtY(t.cny)} is miss billing (cap ${fmtCap(cfg.maxMissCny)}) - the 50x zone`;
  }
  return out;
}

// ---------------------------------------------------------------- reporting

function banner(r, cost) {
  const p = priceOf(r.model, new Date(r.t));
  const wouldBe = (r.miss * p.hit + r.hit * p.hit + r.completion * p.out) / 1e6;
  const refill = detector.isRewrite(r);
  const big = r.prompt >= CFG.bigPrompt;
  const advice = refill
    ? [
        '  CACHE REFILL - this is the one-off full miss a compact / revert / new chat costs.',
        '  Nothing to fix: the next request should hit ~100%.',
      ]
    : big
      ? [
          `  This session is ${Math.round(r.prompt / 1000)}k tokens, so VS Code is already pruning it every turn.`,
          '  COMPACTING WILL NOT HOLD at that size - compact, or better start a NEW CHAT.',
        ]
      : [
          '  You are paying 50x the hit price on everything after the break point, EVERY TURN.',
          '  FIX: Compact conversation  (or revert / start a new chat).',
          '       It costs ONE full-miss request (~¥0.5) and the next request hits ~100%.',
        ];
  const lines = [
    '',
    '='.repeat(78),
    `  ${refill ? 'CACHE REFILL' : 'CACHE-MISS BLOW-UP'}   rate=${r.rate}%  prompt=${r.prompt.toLocaleString()}  miss=${r.miss.toLocaleString()}`,
    `  cached prefix (hit plateau) = ${r.hit.toLocaleString()} tokens`,
    `  model=${r.model}  ${p.known ? '' : '(unknown model - priced as flash) '}this request ~${fmtY(cost)} (vs ~${fmtY(wouldBe)} if cached)`,
    ...advice,
    '='.repeat(78),
    '',
  ];
  note(lines.join('\n'));
}

function summarize(reason) {
  const t = detector.totals;
  const inp = t.hit + t.miss;
  const missPct = inp ? ((t.miss / inp) * 100).toFixed(1) : '0.0';
  const b = budgetOf();
  const g = gateStatus();
  say(
    `[${stamp()}] ${reason} | requests=${t.n} hit=${fmtM(t.hit)} miss=${fmtM(t.miss)} (${missPct}% of prompt)` +
      ` | est. today ${fmtY(t.cny)} of which miss-heavy ${t.badN} req = ${fmtY(t.badCny)}` +
      ` | budget ${fmtY(t.cny)}/${fmtCap(CFG.maxCny)} miss ${fmtY(t.cnyMiss)}/${fmtCap(CFG.maxMissCny)}` +
      (b.over ? ' SPENT-OUT' : b.waived ? ' (caps waived)' : '') +
      ` | gate=${g.ok ? 'ON' : 'OFF'}` +
      ` | circuit=${detector.tripped ? 'OPEN' : 'closed'}`
  );
}

function writeState(extra = {}) {
  const t = detector.totals;
  const inp = t.hit + t.miss;
  const state = {
    updated: stamp(),
    tripped: detector.tripped,
    trippedAt: detector.trippedAt,
    tripCount: detector.tripCount,
    advisory: advisory.active(),
    advisoryTripsInWindow: advisory.recentCount,
    lastTrip: detector.lastTrip,
    badStreak: detector.streak,
    recent: detector.win.slice(-10),
    budget: budgetOf(),
    gate: gateStatus(),
    totals: { ...t, missPct: inp ? +(t.miss / inp * 100).toFixed(2) : 0 },
    ...extra,
  };
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    /* non-fatal */
  }
}

function handleRequest(r, opts) {
  const { events, bad, cost } = detector.add(r, opts);
  if (CFG.json) {
    console.log(JSON.stringify({ t: r.t, agent: r.agent, model: r.model, prompt: r.prompt, hit: r.hit, miss: r.miss, rate: r.rate, cny: +cost.toFixed(4), state: detector.tripped ? 'OPEN' : 'closed' }));
  } else if (CFG.verbose || events.length) {
    const tag = events.length ? events.join(',').toUpperCase() : 'ok';
    say(
      `${r.t.slice(11)}  ${r.agent.padEnd(17)} rate=${String(r.rate).padStart(3)}%  prompt=${String(r.prompt).padStart(7)}  miss=${String(r.miss).padStart(7)}  ${fmtY(cost).padStart(8)}  ${tag}`
    );
  }
  if (events.includes('warn') && !events.includes('trip')) banner(r, cost);
  if (events.includes('refill')) {
    banner(r, cost);
    note(`CACHE REFILL (rate ${r.rate}%, hit ${fmtM(r.hit)} of ${fmtM(r.prompt)}) - the compact's own one-off cost, not a burn.`);
  }
  if (events.includes('trip')) {
    banner(r, cost);
    const structural = r.prompt >= CFG.bigPrompt && r.hit >= 100000; // the pruning signature, not merely a big prefix
    note(
      `*** TRIP #${detector.tripCount}: rate ${r.rate}% with a ${fmtM(r.hit)}-token cached prefix ` +
        `(prompt ${fmtM(r.prompt)})${structural ? ' - the break is ABOVE the message history, so compacting alone will not hold' : ''}. ` +
        (CFG.proxy ? 'Proxy circuit is OPEN - /chat/completions will be refused (429).' : 'Alert only - enable --proxy for a hard stop.')
    );
    const enteredAdvisory = advisory.register();
    if (enteredAdvisory) {
      note(
        `ADVISORY MODE for ${Math.round(CFG.advisoryMs / 60000)} min: ${advisory.recentCount} trips in the last ` +
          `${Math.round(CFG.advisoryWindowMs / 60000)} min. Refusing now cannot fix a break that compacting does not ` +
          'move, so refusals are suspended while the ¥ budget rails STAY armed.'
      );
    }
    writeState();
  }
  if (events.includes('recover'))
    note(`RECOVERED: cache-hit rate back above the ${CFG.tripRate}% trip bar - circuit closed by itself, nothing to reset.`);
  if (events.includes('probe')) {
    note(
      `PROBE (rate ${r.rate}%, hit ${fmtM(r.hit)}) - ` +
        (events.includes('warn')
          ? 'still broken: circuit stays OPEN, next request is refused again.'
          : events.includes('recover')
            ? 'history rewrite seen: circuit closed - the next turns should hit ~100%.'
            : 'clean: recovery in progress.')
    );
  }
  if (bad) writeState();
  return { events, bad, cost };
}

// ---------------------------------------------------------------- log tailing

function logRoots() {
  if (CFG.logRoots && CFG.logRoots.length) return CFG.logRoots.filter((d) => fs.existsSync(d));
  const roots = [];
  const bases = [process.env.APPDATA, path.join(os.homedir(), 'AppData', 'Roaming'), path.join(os.homedir(), '.config')].filter(Boolean);
  for (const base of bases) {
    for (const app of ['Code', 'Code - Insiders', 'Code - OSS']) {
      const d = path.join(base, app, 'logs');
      if (!roots.includes(d) && fs.existsSync(d)) roots.push(d);
    }
  }
  return roots;
}

function findLogs() {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a log dir can vanish mid-scan
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'DeepSeek.log') out.push(p);
    }
  };
  for (const r of logRoots()) walk(r, 0);
  return out;
}

const tail = new Map(); // file -> { off, buf }

function pollFiles(onLine) {
  for (const f of findLogs()) {
    let st = tail.get(f);
    const fresh = !st;
    if (fresh) {
      st = { off: 0, buf: '' };
      tail.set(f, st);
    }
    let fd = null;
    try {
      fd = fs.openSync(f, 'r');
      const size = fs.fstatSync(fd).size;
      if (size < st.off) st.off = 0; // truncated
      if (size > st.off) {
        const len = size - st.off;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.off);
        st.off = size;
        st.buf += buf.toString('utf8');
        let idx;
        while ((idx = st.buf.indexOf('\n')) >= 0) {
          const line = st.buf.slice(0, idx).replace(/\r$/, '');
          st.buf = st.buf.slice(idx + 1);
          if (line) onLine(line, fresh);
        }
      }
    } catch {
      /* file rotated or locked; next poll retries */
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
}

// ---------------------------------------------------------------- breaker proxy

function upstreamHeaders(headers) {
  const h = { ...headers, host: 'api.deepseek.com' };
  delete h['accept-encoding']; // keep the body readable for usage extraction
  delete h.connection;
  return h;
}

function extractUsage(text) {
  const last = (re) => {
    let m;
    let v = null;
    while ((m = re.exec(text))) v = Number(m[1]);
    return v;
  };
  const hit = last(/"prompt_cache_hit_tokens":\s*(\d+)/g);
  const miss = last(/"prompt_cache_miss_tokens":\s*(\d+)/g);
  const out = last(/"completion_tokens":\s*(\d+)/g);
  if (hit === null && miss === null) return null;
  const model = (text.match(/"model":\s*"([^"]+)"/) || [])[1] || 'deepseek-flash';
  return { hit: hit || 0, miss: miss || 0, completion: out || 0, model };
}

let lastProbe = 0;

// The extension logs the very same request the proxy just forwarded (identical hit/miss/completion)
// and the log tailer reads that line too. Without this the request is counted twice - which would
// halve the effective trip streak and make the ¥ caps fire at half the intended spend.
const echoed = new Map(); // fingerprint -> ms
const fpOf = (r) => `${r.hit}/${r.miss}/${r.completion}`;
function markEchoed(r) {
  const now = Date.now();
  for (const [k, ts] of echoed) if (now - ts > 20000) echoed.delete(k);
  echoed.set(fpOf(r), now);
}
function isEcho(r) {
  const k = fpOf(r);
  const ts = echoed.get(k);
  if (!ts || Date.now() - ts > 20000) return false;
  echoed.delete(k); // one-shot: only the first matching log line is the echo
  return true;
}

// ---- capture (diagnostic): tee each chat request body to disk so that two consecutive prompts
// can be diffed to find the exact first difference - i.e. what is breaking the cache prefix.
// Bounded: keeps only the newest captureKeep bodies, and refuses anything over 8 MB.
const capture = { dir: null, n: 0 };

function pruneCaptures() {
  if (!capture.dir) return;
  try {
    const files = fs
      .readdirSync(capture.dir)
      .filter((f) => f.endsWith('.req.json'))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - CFG.captureKeep))) fs.unlinkSync(path.join(capture.dir, f));
  } catch {
    /* pruning is best-effort */
  }
}

function initCapture(dir) {
  if (!dir) return;
  capture.dir = path.resolve(dir);
  try {
    fs.mkdirSync(capture.dir, { recursive: true });
  } catch {
    /* non-fatal */
  }
  pruneCaptures();
}

function saveCapture(body) {
  if (!capture.dir || !body || !body.length || body.length > 8 * 1024 * 1024) return;
  try {
    const name = `${stamp().replace(/[: ]/g, '-')}-${String(++capture.n).padStart(3, '0')}.req.json`;
    fs.writeFileSync(path.join(capture.dir, name), body);
    pruneCaptures();
  } catch {
    /* capture must never take the proxy down */
  }
}

// ---- gate check: is chat traffic actually routed through this proxy?
// Guard against the 2026-09-30 failure: `deepseek-copilot.baseUrl` lost its http:// scheme (every
// request died with ERR_INVALID_URL) and was then removed entirely, so chat bypassed the proxy
// and the watchdog saw nothing while the bill kept running. Now the gate is checked out loud.
function settingsPath() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'Code', 'User', 'settings.json');
}

function gateStatus() {
  const want = `http://127.0.0.1:${CFG.port}`;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(settingsPath(), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  } catch (e) {
    return { ok: false, baseUrl: null, want, why: `cannot read settings.json (${e.message})` };
  }
  const baseUrl = cfg['deepseek-copilot.baseUrl'];
  if (!baseUrl) {
    return { ok: false, baseUrl: null, want, why: `deepseek-copilot.baseUrl is NOT SET - chat goes straight to DeepSeek, nothing is monitored. Set it to "${want}"` };
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, baseUrl, want, why: `baseUrl "${baseUrl}" has no http:// scheme - the extension dies with ERR_INVALID_URL. Use "${want}"` };
  }
  const ok = baseUrl.replace(/\/+$/, '') === want;
  return { ok, baseUrl, want, why: ok ? 'ok' : `baseUrl "${baseUrl}" is not this proxy (${want}) - traffic is NOT monitored` };
}

function refuse(res, message) {
  res.writeHead(429, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'ds_watch_breaker', error: { message, type: 'ds_watch_breaker', code: 'ds_watch_breaker' } }));
}

function startProxy() {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/status')) {
      const s = {
        tripped: detector.tripped,
        trips: detector.tripCount,
        gate: gateStatus(),
        badStreak: detector.streak,
        totals: detector.totals,
        budget: budgetOf(),
        advisory: { active: advisory.active(), tripsInWindow: advisory.recentCount },
        lastTrip: detector.lastTrip,
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(s, null, 2));
      return;
    }
    if (url.startsWith('/reset')) {
      detector.tripped = false;
      detector.trippedAt = null;
      detector.trippedAtMs = null;
      detector.streak = 0;
      if (url.includes('caps=off')) {
        capsWaivedFor = stamp().slice(0, 10);
        note(`CAPS WAIVED for ${capsWaivedFor} via /reset?caps=off - the ¥ budget will not refuse anything again today.`);
      } else {
        note('RESET via /reset - circuit closed.');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    const isChat = url.includes('/chat/completions');
    let probeServed = false;
    if (isChat) {
      const b = budgetOf();
      if (b.over) {
        note(`BUDGET STOP: refused a /chat/completions request - ${b.why}`);
        refuse(
          res,
          `ds-watch BUDGET STOP: ${b.why}. The chat is not allowed to spend more today. ` +
            `Raise the cap (start-ds-watch.ps1 -MaxCny N) or deliberately GET http://127.0.0.1:${CFG.port}/reset?caps=off`
        );
        return;
      }
    }
    if (detector.tripped && isChat && !advisory.active()) {
      const now = Date.now();
      const ref = Math.max(detector.trippedAtMs || 0, lastProbe);
      if (now - ref < CFG.probeMs) {
        const lt = detector.lastTrip;
        const structural = !!(lt && lt.prompt >= CFG.bigPrompt && lt.hit >= 100000);
        refuse(
          res,
          `ds-watch breaker OPEN: the cache-hit rate fell to ${lt ? lt.rate : '?'}% (miss billing is 50x). ` +
            (structural
              ? `This session is ${fmtM(lt.prompt)} tokens, so it is being pruned every turn - compacting will not hold it, start a NEW CHAT. `
              : 'Compact the conversation (or revert / start a new chat). ') +
            `It releases by itself as soon as one request comes back above ${CFG.tripRate}% - a probe is let through ` +
            `every ${Math.round(CFG.probeMs / 1000)}s, so simply retrying is enough.`
        );
        note(`REFUSED a /chat/completions request (circuit OPEN, ${advisory.recentCount} trips in ${Math.round(CFG.advisoryWindowMs / 60000)} min).`);
        return;
      }
      lastProbe = now;
      probeServed = true;
    }
    const up = https.request(
      { host: 'api.deepseek.com', port: 443, method: req.method, path: url, headers: upstreamHeaders(req.headers) },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        let acc = '';
        upRes.on('data', (chunk) => {
          res.write(chunk);
          if (isChat) {
            acc += chunk.toString('utf8');
            if (acc.length > 600000) acc = acc.slice(-300000);
          }
        });
        upRes.on('end', () => {
          res.end();
          if (!isChat) return;
          const u = extractUsage(acc);
          if (!u) return;
          const r = { t: stamp(), day: stamp().slice(0, 10), agent: 'proxy', ...u, prompt: u.hit + u.miss, rate: u.hit + u.miss ? Math.round((u.hit / (u.hit + u.miss)) * 100) : 0 };
          markEchoed(r); // the extension logs this same request; the tailer must not count it twice
          handleRequest(r, { probe: probeServed });
        });
      }
    );
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `ds-watch proxy error: ${e.message}` } }));
    });
    // Tee the body instead of a bare req.pipe(up): identical forwarding, plus an optional capture.
    const chunks = [];
    let size = 0;
    let waiting = false;
    req.on('data', (c) => {
      size += c.length;
      if (size <= 8 * 1024 * 1024) chunks.push(c);
      if (!up.write(c) && !waiting) {
        waiting = true;
        req.pause();
        up.once('drain', () => {
          waiting = false;
          req.resume();
        });
      }
    });
    req.on('end', () => {
      up.end();
      if (isChat) saveCapture(Buffer.concat(chunks));
    });
    req.on('error', () => up.destroy());
  });
  server.on('error', (e) => {
    note(`PROXY FAILED to listen on ${CFG.port} (${e.code || e.message}) - continuing in ALERT-ONLY mode.`);
    if (e.code === 'EADDRINUSE') {
      note(`  free the port or re-run with --port <n>; do NOT leave "deepseek-copilot.baseUrl" pointing at a dead proxy.`);
    }
  });
  server.listen(CFG.port, '127.0.0.1', () => {
    note(`PROXY LISTENING on http://127.0.0.1:${CFG.port} - set "deepseek-copilot.baseUrl" to it and reload the window for the hard stop.`);
    note(`  /status = circuit state   /reset = close the circuit`);
  });
  return server;
}

// ---------------------------------------------------------------- self-test

function selfTest() {
  let fails = 0;
  const check = (name, cond, got) => {
    if (cond) console.log(`  PASS  ${name}`);
    else {
      console.log(`  FAIL  ${name}  -> got ${JSON.stringify(got)}`);
      fails++;
    }
  };

  const l1 =
    '2026-09-15 18:57:59.123 [info] [main-agent] tokens: model=deepseek-flash prompt=161899 completion=42 | cache: hit=161664 miss=235 rate=100% | chars/tok=3.5';
  const r1 = parseLine(l1);
  check('parse healthy request', r1 && r1.kind === 'request' && r1.hit === 161664 && r1.rate === 100, r1);
  const r2 = parseLine(
    '2026-09-15 16:41:32.1 [info] [main-agent] tokens: model=deepseek-flash prompt=395337 completion=200 | cache: hit=186752 miss=208585 rate=47% | chars/tok=3.6'
  );
  check('parse broken request', r2 && r2.rate === 47 && r2.miss === 208585, r2);
  check('parse error line', (parseLine('2026-09-15 16:44:34.9 [error] DeepSeek request failed: kind=network code=ECONNRESET baseUrl="x"') || {}).kind === 'error', null);
  check('ignores unrelated lines', parseLine('2026-09-15 15:59:19.762 [info] Extension activated version=0.9.2') === null, null);

  const peak = isPeak(new Date('2026-09-15T16:00:00'));
  check('16:00 local is peak', peak === true, peak);
  check('20:00 local is off-peak', isPeak(new Date('2026-09-15T20:00:00')) === false, null);

  const d = new Detector({ ...CFG, tripStreak: 3, recoverStreak: 3, probeMs: 1 });
  const bad = { t: '2026-09-15 16:41:32', model: 'deepseek-flash', prompt: 395337, hit: 186752, miss: 208585, completion: 200, rate: 47 };
  const good = { t: '2026-09-15 18:57:59', model: 'deepseek-flash', prompt: 161899, hit: 161664, miss: 235, completion: 42, rate: 100 };
  d.add(bad);
  d.add(bad);
  const third = d.add(bad);
  check('trips on 3rd consecutive bad request', third.events.includes('trip'), third.events);
  const rec = [d.add(good), d.add(good), d.add(good)];
  check('recovers after 3 clean requests', rec[2].events.includes('recover'), rec.map((x) => x.events));
  d.add(bad);
  d.add(bad);
  const probe = d.add({ ...bad, t: '2026-09-15 19:10:00', rate: 3, hit: 20000, miss: 400000 }, { probe: true });
  check('probe does not trip', probe.events.includes('probe') && !probe.events.includes('trip'), probe.events);
  const tiny = d.add({ ...bad, rate: 80, miss: 1200, prompt: 30000 });
  check('small miss is not "bad"', tiny.bad === false, tiny.bad);
  check('history lines are scored but not counted as a streak', d.add(bad, { history: true }).events.length === 0, null);

  const usage = extractUsage(
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_cache_hit_tokens":186752,"prompt_cache_miss_tokens":208585,"completion_tokens":200},"model":"deepseek-flash"}\n\ndata: [DONE]\n\n'
  );
  check('SSE usage extraction', usage && usage.hit === 186752 && usage.miss === 208585 && usage.model === 'deepseek-flash', usage);

  const d2 = new Detector({ ...CFG, tripStreak: 2, recoverStreak: 2 });
  d2.add(bad);
  const t2 = d2.add(bad);
  check('sandbox breaker trips', t2.events.includes('trip') && d2.tripped === true, t2.events);
  const stillBad = d2.add(bad, { probe: true });
  check('a still-broken probe keeps the circuit OPEN', stillBad.events.includes('probe') && d2.tripped === true, { events: stillBad.events, tripped: d2.tripped });
  const rewrite = d2.add({ ...bad, rate: 3, hit: 20480, miss: 500000, prompt: 520480 }, { probe: true });
  check('a rewrite probe closes the circuit (compact worked)', rewrite.events.includes('recover') && d2.tripped === false, { events: rewrite.events, tripped: d2.tripped });
  const clean1 = d2.add(good);
  check('clean requests are not probes', clean1.events.length === 0, clean1.events);

  // --- 2026-09-16: the hit rate sagged to 47-53%, but the bad requests were interleaved with
  //     clean ones from other agents, so a strict "N in a row" streak never fired (it hit 2). ---
  const soft = { ...bad, rate: 92, hit: 414000, miss: 36000, prompt: 450000 };
  const d4 = new Detector({ ...CFG, tripWindowMiss: Infinity });
  const w1 = d4.add(soft);
  check('a 92% request warns but is not trip-grade', w1.bad === true && w1.events.includes('warn') && !w1.events.includes('trip'), w1.events);
  const w2 = d4.add(soft);
  check('two 92% requests do not trip (a slip is not a break)', d4.tripped === false && w2.events.includes('warn'), w2.events);

  const d3 = new Detector({ ...CFG, tripStreak: 99, recoverStreak: 3, tripWindowMiss: Infinity });
  d3.add(bad);
  d3.add(good); // another agent's clean request - this is what reset the streak on 09-16
  d3.add(bad);
  const t3 = d3.add(bad);
  check('3 bad within 6 trips even with a clean request interleaved', t3.events.includes('trip') && d3.streak === 2, { events: t3.events, streak: d3.streak });

  // --- the user's bar: warn the moment the rate leaves 95%, TRIP the moment it reaches 85% ---
  const d6 = new Detector({ ...CFG, tripWindowMiss: Infinity });
  const away = { ...bad, rate: 84, hit: 420000, miss: 80000, prompt: 500000 };
  const a1 = d6.add(away);
  check('a single 84% request trips at the 85% bar', a1.events.includes('trip'), a1.events);
  const d8 = new Detector({ ...CFG, tripWindowMiss: Infinity });
  check('a single 86% request only warns', d8.add({ ...away, rate: 86, hit: 430000, miss: 70000 }).events.join() === 'warn', d8.tripped);

  // ...and the FIX must not re-trip itself: a compact is exactly one full-miss request
  const d7 = new Detector({ ...CFG, tripWindowMiss: Infinity });
  d7.add(good);
  const c1 = d7.add({ ...bad, rate: 3, hit: 20000, miss: 600000, prompt: 620000 });
  const c2 = d7.add({ ...bad, rate: 12, hit: 21000, miss: 150000, prompt: 171000 });
  check('the compact refill (1 full miss) does not trip', !c1.events.includes('trip') && c1.events.includes('refill'), c1.events);
  check('a 2-request refill (summarizer, then first turn) does not trip', !c2.events.includes('trip') && d7.tripped === false, c2.events);
  const c3 = d7.add({ ...bad, rate: 8, hit: 21400, miss: 160000, prompt: 181000 });
  check('a THIRD consecutive short-prefix request does trip (the real 09-16 burn)', c3.events.includes('trip'), c3.events);

  // --- advisory: repeated trips must not wall the user in ---
  const adv = new Advisory({ advisoryAfterTrips: 3, advisoryWindowMs: 60000, advisoryMs: 30000 });
  const t0 = 1000000;
  adv.register(t0);
  adv.register(t0 + 1000);
  check('advisory stays off below the trip count', adv.active(t0 + 2000) === false, null);
  const entered = adv.register(t0 + 2000);
  check('3 trips in the window opens advisory', entered === true && adv.active(t0 + 3000) === true, null);
  check('advisory expires on its own', adv.active(t0 + 2000 + 30001) === false, null);
  const adv2 = new Advisory({ advisoryAfterTrips: 2, advisoryWindowMs: 60000, advisoryMs: 30000 });
  adv2.register(t0);
  const again2 = adv2.register(t0 + 200000); // outside the window: the old trip has aged out
  check('advisory does not open on trips spaced beyond the window', again2 === false, null);

  // --- the hard budget: the literal "cap out" ---
  const burn = { ...bad, t: '2026-09-16 20:00:00', hit: 20000, miss: 600000, prompt: 620000, rate: 3 };
  const money = new Detector({ ...CFG, maxCny: 1, maxMissCny: 0.5 });
  money.add(burn, { probe: true });
  const bb = budgetOf(money.totals, { maxCny: 1, maxMissCny: 0.5 });
  check('budget: one 600k-miss request passes the ¥0.5 miss cap', bb.over === true && bb.missSpent > 0.5, bb);
  check('budget: a healthy day is not over the cap', budgetOf({ n: 1, cny: 0.02, cnyMiss: 0.01 }, { maxCny: 20, maxMissCny: 8 }).over === false, null);
  check('budget: "off" really disables the cap', budgetOf({ n: 1, cny: 999, cnyMiss: 999 }, { maxCny: Infinity, maxMissCny: Infinity }).over === false, null);

  // --- the cap must not survive midnight ---
  const d5 = new Detector({ ...CFG, maxCny: 1 });
  d5.add(bad, { probe: true });
  d5.tripped = true;
  d5.resetDay();
  check('day rollover clears the counters, streak and circuit', d5.totals.cny === 0 && d5.totals.cnyMiss === 0 && d5.streak === 0 && d5.win.length === 0 && d5.tripped === false, d5.totals);
  check('day rollover makes the budget usable again', budgetOf(d5.totals, { maxCny: 1, maxMissCny: 0.5 }).over === false, null);

  // --- a trivial miss must never lock the chat (2026-09-24 02:24: 85% on a 39.3k fresh chat) ---
  const tinyTx = new Detector({ ...CFG });
  const freshChat = { t: '2026-09-24 02:24:52', model: 'deepseek-flash', prompt: 39300, hit: 33300, miss: 6000, completion: 400, rate: 85 };
  check('an 85% request with a 6.0k miss does NOT trip', tinyTx.add(freshChat).events.includes('trip') === false, tinyTx.tripped);
  const bigSession = { ...bad, rate: 85, prompt: 285600, hit: 33300, miss: 252300 };
  check('the same 85% on a 285k session still trips', new Detector({ ...CFG }).add(bigSession).events.includes('trip'), null);

  // --- the lock must release itself: a probe above the trip bar frees it, no manual /reset ---
  const rel = new Detector({ ...CFG, tripStreak: 1, recoverStreak: 3 });
  check('it tripped to start with', rel.add(bad).events.includes('trip') === true, null);
  const probeOk = rel.add({ ...bad, rate: 90, hit: 400000, miss: 40000, prompt: 440000 }, { probe: true });
  check('a probe above the trip bar releases the lock (no manual reset)', probeOk.events.includes('recover') && rel.tripped === false, probeOk.events);
  const rec2 = new Detector({ ...CFG, tripStreak: 1, recoverStreak: 2 });
  rec2.add(bad);
  rec2.add({ ...bad, rate: 90, hit: 400000, miss: 40000, prompt: 440000 });
  const rec3 = rec2.add({ ...bad, rate: 91, hit: 400000, miss: 39000, prompt: 439000 });
  check('two warn-grade requests above the bar also release it', rec3.events.includes('recover') && rec2.tripped === false, rec3.events);

  check('capture is a no-op when unconfigured', saveCapture(Buffer.from('{}')) === undefined, null);
  const g = gateStatus();
  check('gate check reports a usable result', typeof g.ok === 'boolean' && typeof g.why === 'string', g);

  console.log(fails ? `\n${fails} FAILED` : '\nall self-tests passed');
  process.exit(fails ? 1 : 0);
}

// ---------------------------------------------------------------- main

function main() {
  if (CFG.selfTest) return selfTest();

  // --log-root (sandbox / alternate log dir) and --multi are exempt: they are test modes.
  const skipLock = CFG.multi || (CFG.logRoots && CFG.logRoots.length > 0);
  if (!skipLock) {
    const holder = acquireLock();
    if (holder) {
      say(`DS-WATCH is already running (pid ${holder}) - exiting so we do not watch twice.`);
      say(`  stop it first:  Stop-Process -Id ${holder} -Force`);
      process.exit(0);
    }
    process.on('exit', releaseLock);
  }

  say('DS-WATCH — DeepSeek prompt-cache watchdog');
  say('  healthy = rate 98-100% (only the tail is uncached). Leave 95% and it warns; reach 85% and it stops you.');
  say(
    `  warn: <${CFG.warnRate}% && miss >=${fmtM(CFG.minMiss)} | trip: <=${CFG.tripRate}% on ${CFG.tripStreak} request(s), ` +
      `${CFG.tripBadInN} within ${CFG.tripBadInM}, or ${fmtM(CFG.tripWindowMiss)} miss in 10 | recover after ${CFG.recoverStreak} above the bar`
  );
  say(`  budget: ${fmtCap(CFG.maxCny)}/day total, ${fmtCap(CFG.maxMissCny)}/day miss-billed (--max-cny / --max-miss-cny, 'off' disables)`);
  say(`  advisory: ${CFG.advisoryAfterTrips} trips in ${Math.round(CFG.advisoryWindowMs / 60000)} min pauses refusals for ${Math.round(CFG.advisoryMs / 60000)} min (¥ rails stay armed)`);
  say(`  log: ${path.relative(ROOT, WATCH_LOG)}   state: ${path.relative(ROOT, STATE_FILE)}`);

  // seed from existing logs so the day total is right from the first second
  let histN = 0;
  let today = stamp().slice(0, 10);
  // The budget is a DAILY rail, so it has to roll over on its own: without this the watcher would
  // keep yesterday's spend (and a permanently SPENT-OUT cap) until someone restarted it.
  const rollover = () => {
    const now = stamp().slice(0, 10);
    if (now === today) return;
    say(`--- ${today} -> ${now}: the day rolled over, resetting the counters and the budget ---`);
    detector.resetDay();
    capsWaivedFor = null;
    today = now;
  };
  const onLine = (line, isHistory) => {
    const parsed = parseLine(line);
    if (!parsed) return;
    if (parsed.kind === 'error') {
      if (!isHistory) note(`API FAILURE: ${parsed.t} ${parsed.agent} -> compact the chat (a failed stream poisons the prefix)`);
      return;
    }
    if (parsed.day !== today) return;
    if (isHistory) {
      histN++;
      detector.add(parsed, { history: true });
      return;
    }
    if (isEcho(parsed)) return; // the proxy already scored this one
    handleRequest(parsed, {});
  };

  pollFiles(onLine);
  writeState();
  summarize(`seeded from ${histN} requests logged today`);
  say('tab keeps watching (Ctrl+C to stop). Warnings and trips are appended to logs/ds-watch.log.');

  setInterval(() => pollFiles(onLine), CFG.pollMs);
  let gateWasOk = gateStatus().ok;
  if (!gateWasOk) note(`*** GATE OFF: ${gateStatus().why}`);
  setInterval(() => {
    rollover();
    const g = gateStatus();
    if (g.ok !== gateWasOk) {
      gateWasOk = g.ok;
      note(g.ok ? `GATE ON again: baseUrl = ${g.baseUrl}` : `*** GATE OFF: ${g.why}`);
    }
    summarize('status');
    writeState();
  }, CFG.summaryMs);

  if (CFG.proxy) startProxy();
  else say('hard stop is OFF (alert only). Re-run with --proxy to make the trip refuse requests.');
  if (CFG.captureDir) {
    initCapture(CFG.captureDir);
    say(`capture ON -> ${path.relative(ROOT, capture.dir)} (newest ${CFG.captureKeep} request bodies; DELETE THEM after analysis)`);
  }
}

main();
