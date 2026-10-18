// trading/agent/selfHealth.js — Phase 1 of the implied goal: the desk checking
// whether its OWN reading of the world is still accurate, and whether its
// decisions actually landed. This catches the silent failure class the
// 2026-09-10 Oil incident exposed: approved decisions that never filled,
// rejections, stale ticks, dead bridge, stalled wake loop, budget exhaustion.
//
// Runs on a 15-min cadence (settings.selfHealth.intervalMinutes, self-throttled
// via the latest self_health event). Every run logs a `self_health` event and
// keeps the newest snapshot in memory for GET /api/trading/self-health.
// On a status transition to warn/bad a Telegram alert fires ONCE per change.
// Read-only: it NEVER navigates the bridge and NEVER mutates settings.
'use strict';

const store = require('../store');
// TRD-116: the resolution + applicability rule, imported rather than restated. This check used to re-implement
// it, and got it wrong in three ways (see the verdict below and trading/scopeResolution.js).
const scopeResolution = require('../scopeResolution');
// TRD-52: the same TTL the resolver uses, imported rather than restated so the check and the expiry
// cannot disagree about when "still waiting" becomes "gave up".
const { UNCONFIRMED_TTL_MIN } = require('./unconfirmed');

const live = { last: null, running: false };

const TICK_SLA_MIN = 15;      // must match wakePipeline.TICK_SLA_MS semantics
const REJECT_WINDOW_MIN = 360;

// ★ TRD-F20-EPOCH (2026-09-28): `standing` — THE THIRD THING A NON-OK CHECK CAN MEAN, WHICH HAD NO NAME.
//
// Two checks were reporting a condition that NO ACTION COULD CLEAR: `stops` counted six desk-opened rows
// that predate the ability to record levels and six mirrored positions the desk never placed (both
// irreversible), and `field_risk_unit` fired whenever the notional cap bound — i.e. whenever a deliberate
// safety limit did its job. Because `overall` was `bad ? 'bad' : warn ? 'warn' : 'ok'`, that made the DESK
// DEGRADED banner PERMANENTLY ON. The desk's own note on the checks above says why that matters: "a known,
// unresolved label mismatch should keep the desk amber until someone fixes or ACKNOWLEDGES it" — and this
// file had no way to acknowledge anything. A banner that cannot go out is not a warning; it is furniture,
// and it devalues the one case that IS new. (It is also the same latch TRD-65 had to remove from the ALERT
// for the very same `#1046` row, one layer down.)
//
// So a check may declare that its non-ok status is STANDING: documented, irreversible or by design, and
// clearable by no action. A standing row stays in `checks` (the card renders it, the logged snapshot keeps
// its full text) but it does not set `overall` and it does not page. `bad` stays `bad`.
function check(id, label, status, detail, standing) {
  return { id, label, status, detail, ...(standing ? { standing: true } : {}) };
}

// TRD-94 (2026-09-21): THE VERDICT FOR PROVIDER ERRORS, as a pure function.
//
// Pure so the table below can be PINNED by a test rather than inferred from a live incident. The distinction
// it encodes is the one the incident needed: a `payment` error (402/401) cannot fix itself, retries are
// wasted, and the desk degrades on EVERY subsequent call until someone tops the account up — so it is `bad`
// even at n=1. A transport blip or a 5xx is `warn` and self-heals, so a single one must not page anyone.
function providerErrorVerdict(rows) {
  // ⚠ 2026-09-21: THE FIRST VERSION OF THIS CHECK COULD NOT SEE ITS OWN ROWS, TWICE OVER.
  // (a) `store.queryEvents` returns `{items, total, hasMore, nextCursor}`, not an array, and the guard below
  //     silently coerced it to [] — so the check answered "no provider errors in 24h" whatever the events said.
  // (b) it asked for `stream: 'state'`, and `log.streamFor` maps an UNLISTED kind to `'app'` — so
  //     `llm_provider_error` was never in the stream being filtered for.
  // Both are the same defect: a check that cannot see its input reports a clean bill of health. It now reads by
  // the KIND COLUMN (via `store.listEvents`), which is exact, and a non-array is an explicit WARN.
  if (!Array.isArray(rows)) {
    return { status: 'warn', detail: 'the event reader did not return an array — this check cannot see its input, so its silence is NOT a clean bill of health' };
  }
  const list = rows;
  if (!list.length) return { status: 'ok', detail: 'no provider errors in 24h' };
  const payment = list.filter((e) => e && e.errorKind === 'payment');
  const labels = [...new Set(list.map((e) => (e && e.label) || '?'))];
  const when = list[list.length - 1] && list[list.length - 1].createdAt
    ? new Date(list[list.length - 1].createdAt).toISOString().slice(11, 19) + 'Z' : '?';
  if (payment.length) {
    const statuses = [...new Set(payment.map((e) => e.status))].join('/');
    return {
      status: 'bad',
      detail: `${payment.length} PAYMENT error(s) (HTTP ${statuses}) in 24h — the provider REFUSED those calls, so those seats `
        + `ABSTAINED rather than disagreed (affects ${labels.join(', ')}). Last at ${when}. `
        // ⚠ 2026-09-21: this text first said "the account is out of credit", which ASSERTS A CAUSE THE EVIDENCE
        // DOES NOT ESTABLISH. Measured the same day: the key answers HTTP 200, and a 402 landed in the SAME
        // SECOND as a chair call that succeeded — so a depleted balance is one candidate, not the finding.
        // A check that names the wrong cause is the defect this desk writes rows about.
        + 'CAUSE NOT ESTABLISHED: candidates are a depleted upstream balance, or a thin balance refusing '
        + 'individual concurrent requests. NOTE the desk calls api.deepseek.com DIRECTLY and bypasses the '
        + 'local ds-watch breaker, so this spend is outside that budget and this is the only signal it produces.',
    };
  }
  const kinds = [...new Set(list.map((e) => (e && e.errorKind) || 'unknown'))].join('/');
  return {
    status: 'warn',
    detail: `${list.length} provider error(s) in 24h (${kinds}, affects ${labels.join(', ')}), latest at ${when} — `
      + 'retryable and self-healing, but each one removes a seat from that deliberation.',
  };
}

// `listEvents` nests the envelope under `payload`; the verdicts read the envelope fields directly, so the two
// shapes are reconciled HERE rather than in each verdict. A non-array passes through untouched so it stays loud.
function flat(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((e) => ({ ...(e && e.payload ? e.payload : {}), createdAt: e && e.createdAt }));
}

// TRD-116 (2026-09-21, CORRECTED 2026-09-25): SCOPE AND `enabled` CAN DISAGREE SUCH THAT A SETTING IS DEAD.
//
// ★ THIS VERDICT WAS WRONG, IN THE SAME DIRECTION, THREE TIMES, AND IT WAS MEASURED RATHER THAN SUSPECTED.
// Run against the resolver the desk actually trades on (`quant.scopedStrategyIds`, via
// temp/scope-resolver-probe.js, 2026-09-25) it reported as unreachable:
//
//   B. enabled=['survgold'], symbolScope={}            → resolver: reachable on Gold. An ABSENT key falls back
//                                                       to the global list; an EMPTY MAP is not an empty scope.
//   C. enabled=['survgold'], scope={Silver:['turtle']} → resolver: reachable on Gold. Enumerating OTHER
//                                                       symbols says nothing about a symbol that is absent.
//   F. scope={Bitcoin:['rsi2']}, rsi2 NOT enabled      → resolver: rsi2 IS live on Bitcoin, because an
//                                                       explicit entry REPLACES the global list. That is the
//                                                       deliberate override TRD-91 exists to protect, and it is
//                                                       the direction THIS ROW'S OWN ROW corrected on 2026-09-24.
//
// Two of the three were pinned by a test asserting `warn`, so "the test agrees" was never evidence. A check
// whose output is not its subject's actual state is TRD-114's class one level up, and this one is worse than
// the defect it was written to catch: it fires on configurations that work, which is how a guard becomes
// noise and then gets ignored.
//
// ★ AND IT NEEDS A UNIVERSE. "Can this strategy run anywhere" is unanswerable without the symbols that can
// trade, and it needs the applicability filter too — `survoil` is enabled AND named by the global list, but
// `survoil.symbols = ['Oil']` track-binds it away from everything else, so a two-list reading calls it
// reachable on SX5E while the desk cannot open it there. Both come from `scopeResolution`.
function scopeEnabledVerdict(enabledList, symbolScope, symbols, registry) {
  if (!Array.isArray(enabledList) || symbolScope == null || typeof symbolScope !== 'object') {
    return { status: 'warn', detail: 'scope/enabled could not be read — this check cannot see its input, so its silence is NOT a clean bill of health' };
  }
  // The same discipline as every other check here: a reader that cannot see its input is LOUD. An empty
  // watchlist means reachability is UNMEASURED, and silently returning `ok` would state a clean result the
  // check never computed — which is exactly how this check went wrong the first time.
  const universe = Array.isArray(symbols) ? [...new Set(symbols.filter(Boolean))] : [];
  if (!universe.length) {
    return { status: 'warn', detail: 'the watchlist could not be read, so strategy REACHABILITY IS UNMEASURED — a strategy enabled but unable to run on any symbol is invisible to this check, and its silence is NOT a clean bill of health' };
  }
  const problems = scopeResolution.unreachableEnabled(enabledList, symbolScope, universe, registry);
  if (!problems.length) {
    return {
      status: 'ok',
      detail: `${enabledList.length} enabled strateg${enabledList.length === 1 ? 'y' : 'ies'}, every one of them can run on at least one of the ${universe.length} watchlist symbol(s)`,
    };
  }
  return {
    status: 'warn',
    detail: `${problems.length} unreachable configuration(s) — ${problems.map((p) => `"${p.id}" is ENABLED but ${p.why}`).join('; ')}. `
      + 'The two fields are each well-formed; it is the DISAGREEMENT that is dead, and it reads as live on every surface that shows '
      + '`enabled` without the scope. NOTE the opposite direction is NOT reported here and is not a defect: a scope entry naming a '
      + 'strategy absent from `enabled` is LIVE (an explicit entry replaces the global list — TRD-91).',
  };
}

// The tuner rows, from the reader's `items`. Kept separate so the reader's SHAPE is checked in one place: the
// first version of this check filtered a non-array and reported OK, which is how a check lies. Synchronous — it
// does no I/O, and an async version would hand its caller a Promise that the shape test could not read.
function tunerSkipRows(items) {
  if (!Array.isArray(items)) return items; // pass the non-array through so the verdict can be loud about it
  return items.filter((e) => e && e.kind === 'tune_skipped');
}

// TRD-112 (2026-09-21): IS THE TUNER ALIVE, AND IF SO, WHICH GATE IS HOLDING IT?
//
// Pure, so the table is pinned rather than inferred. The row's defect was NOT that the tuner was refused —
// being refused on a non-parity-validated live desk is the DESIGN. It was that `tuner.enabled: true` produced
// no evidence of any kind, so "the tuner has never run" and "the tuner runs every 6h and declines" were
// indistinguishable from the outside. Now that every gate decision is recorded, "no record in 24h" is once
// again a real alarm rather than the normal state.
function tunerGateVerdict(rows, lastTuneAt = null) {
  // Same rule as providerErrorVerdict above: a non-array is a BROKEN READER, not an empty result.
  if (!Array.isArray(rows)) {
    return { status: 'warn', detail: 'the event reader did not return an array — the tuner check cannot see its input' };
  }
  const list = rows;
  const tuned = lastTuneAt ? `last ACTUAL tune: ${new Date(lastTuneAt).toISOString().slice(0, 19)}Z` : 'it has never actually tuned';
  if (!list.length) {
    return {
      status: 'warn',
      detail: `no tuner decision recorded in 24h (${tuned}) — the scheduler is a 6h interval, so this means either `
        + 'the service has not run or the gate path went quiet again, which is the silence TRD-112 was written for',
    };
  }
  const latest = list[0] || {};
  const p = latest.payload || {};
  const gate = p.gate || '?';
  const n = list.length;
  const tail = ` (${n} run(s) in 24h; ${tuned})`;
  if (gate === 'parity_not_validated') {
    return {
      status: 'ok',
      detail: `held at the PARITY gate — the live desk needs learning.parityValidated, the sim desk is always allowed${tail}. `
        + 'The tuner is alive and deliberately held, which is now stated rather than assumed.',
    };
  }
  if (gate === 'disabled') return { status: 'ok', detail: `tuner.enabled is false — recorded as deliberately off${tail}` };
  if (gate === 'interval') return { status: 'ok', detail: `inside the ${p.intervalHours || ''}h throttle${tail}` };
  if (gate === 'kill_switch_hard') return { status: 'ok', detail: `skipped on a HARD kill${tail}` };
  if (gate === 'budget') return { status: 'warn', detail: `starved of budget — the 'strategy_tune' sub-cap refused it${tail}` };
  return { status: 'warn', detail: `unrecognised gate "${gate}"${tail}` };
}

// TRD-65 (2026-09-19): WHICH checks are offending, as a comparable set.
//
// The alert below used to fire on the change of the coarse `overall` status alone. That is a latch too:
// the moment ONE check is permanently red, `overall` is red forever and `prevStatus !== overall` is false
// forever, so no later defect can ever page — not a latched UI Fallback Pause, not a dead feed. A health
// board whose alarm can be permanently disabled by one stuck row is the same failure it exists to catch.
// Keyed on the set of offending checks, a NEW offender pages while an old one stays red.
//
// ⚠ AND THE KEY CARRIES THE GRADE, NOT JUST THE ID — TRD-67's last surviving form (fixed 2026-09-21).
//
// Ids alone closed the latch above but left one silent case, and it is the one that matters most: `ticks`
// is ALREADY in the set as `warn` whenever some symbols are merely stale or their session is unknown, so
// the moment one symbol goes genuinely DEAD — `warn` to `bad` on the SAME id — the key did not change and
// NOTHING PAGED. That is the original TRD-67 complaint ("a dead feed never pages") surviving in its last
// form, and it is precisely the transition the desk will meet first: a feed that dies while a neighbour is
// merely quiet.
//
// The cost is bounded and was already paid: the key changes on a RECOVERY too — an id leaving the offender
// set changed the id-only key as well — so this adds no new class of alert, only the escalation that was
// missing. A grade change on an existing offender is exactly what "tell me when things get worse" means.
function offenderKey(checks) {
  return (checks || [])
    // ⚠ `!c.standing`: a standing row is EXCLUDED here for the same reason it is excluded from `overall` —
    // it is not an offender, it is a known condition, and letting it into the key would let a frozen row
    // occupy the key permanently (re-creating, in the key, the latch TRD-65 removed from the comparison).
    .filter((c) => c && c.status && c.status !== 'ok' && !c.standing)
    .map((c) => `${c.id}:${c.status}`)
    .sort()
    .join(',');
}

// How long a latch has been held, in the terms a reader acts on. An absent or unparseable stamp says so
// rather than defaulting to "0m": "we do not know when this started" is itself the information, and a
// zero would be a claim we cannot make.
function pauseAgeLabel(pausedAt, nowMs = Date.now()) {
  if (!pausedAt) return ' (since unknown)';
  const t = new Date(pausedAt).getTime();
  if (!Number.isFinite(t)) return ' (since unknown)';
  const mins = Math.max(0, Math.round((nowMs - t) / 60000));
  if (mins < 60) return ` for ${mins}m`;
  return ` for ${Math.floor(mins / 60)}h${mins % 60}m`;
}

// TRD-67 (2026-09-19): STALENESS AND DEATH ARE NOT THE SAME GRADE, AND A CLOSED VENUE IS NEITHER.
//
// The row: "tick staleness is graded warn, so a 2h26m dead feed never paged". Confirmed live on 19/09 —
// every market feed was **702 minutes** dead and the board still said `warn` ("stale 10/11"). A `warn`
// is a look-at-this-later; no ticks while the venue's own calendar says the venue is TRADING is a fault,
// and the desk already has the line for it: `quant.TICK_SLA_MS` (15 min, "a series older than this is
// NOT TRADABLE").
//
// Why the grade could not simply be raised: silence is CORRECT when the venue is shut, and this desk reads
// its own calendar — grading staleness on age alone would page every weekend. So the verdict is decided
// per symbol against the session feed, and an UNKNOWN session (no fresh session entry) is deliberately
// NOT called dead. "We cannot tell" and "it is broken" are different facts and only one of them should
// page at 3am; the unknown case is reported so it is not silent either.
function deadFeedVerdict({ mins, open, slaMin = TICK_SLA_MIN, deadMultiple = 3 } = {}) {
  if (mins == null || !Number.isFinite(Number(mins))) return 'never_captured';
  const m = Number(mins);
  if (m <= slaMin) return 'fresh';
  if (open === false) return 'venue_closed';      // silent because the venue is shut — expected
  const dead = m >= slaMin * deadMultiple;        // 3x the not-tradable line
  if (open === true) return dead ? 'dead' : 'stale';
  return dead ? 'stale_unknown_session' : 'stale';
}

// Only 'dead' is a fault. Everything else stale-ish stays visible as a warn rather than being promoted
// by arithmetic.
function tickSeverity(verdicts) {
  const v = verdicts || [];
  if (v.includes('dead')) return 'bad';
  if (v.some((x) => x !== 'fresh' && x !== 'venue_closed')) return 'warn';
  return 'ok';
}

function ageMin(ev) {
  if (!ev || !ev.createdAt) return null;
  return (Date.now() - new Date(ev.createdAt).getTime()) / 60000;
}

// F16/F22 (2026-09-18): the tick-freshness line, in the shape the incident actually had.
//
// The old line was `stale: ${stale.slice(0, 5).join(', ')}` over the 12 watchlist symbols, and both halves
// of it pointed the wrong way:
//   - `slice(0, 5)` named the first five in WATCHLIST order, so after the 16-hour outage the banner named
//     whichever symbols happened to be listed first rather than the ones that had been dead longest (F16).
//     The label also said "(12 symbols)" while naming 5, and the database held stale venue ticks for ≥17
//     symbols — ages 964m to 8182m — because the freshness check only ever looked at the watchlist (F16).
//   - one flat list cannot express the SHAPE. Recovery re-captures symbol by symbol, so the ages came out as
//     a staircase: 11 symbols at ~10m, 6 at 1041m, one at 8259m (F22). That distribution is the difference
//     between "a symbol is quiet" and "this desk is half-starved", and a single number cannot say it.
//
// Pure and exported so the summary itself is pinned without a database.
function tickAgeSummary(rows, slaMin = TICK_SLA_MIN) {
  const withAge = rows.filter((r) => Number.isFinite(r.mins));
  const missing = rows.length - withAge.length;
  const stale = withAge.filter((r) => r.mins > slaMin).sort((a, b) => b.mins - a.mins);
  const worst = stale.slice(0, 3).map((r) => `${r.symbol} ${Math.round(r.mins)}m`);
  const bucketOf = (x) => (x <= slaMin ? `≤${slaMin}m` : x <= 60 ? '≤1h' : x <= 360 ? '≤6h' : x <= 1440 ? '≤1d' : '>1d');
  const counts = new Map();
  for (const r of withAge) counts.set(bucketOf(r.mins), (counts.get(bucketOf(r.mins)) || 0) + 1);
  const shape = [`≤${slaMin}m`, '≤1h', '≤6h', '≤1d', '>1d']
    .filter((k) => counts.has(k))
    .map((k) => `${counts.get(k)} ${k}`)
    .join(' · ');
  return { checked: rows.length, stale: stale.length, missing, worst, shape };
}

// `persist: false` runs the checks and returns the snapshot WITHOUT logging a self_health
// event or alerting. Needed because the checks read in-process state (the waker's running flag,
// the bridge probe, the budget counter): run from a diagnostic script they describe the SCRIPT,
// not the desk, and writing that verdict into the desk's health log records a falsehood.
// (2026-09-13: exactly that happened once, and the false 'bad' had to be explained.)
async function run(userId, settings, { force = false, persist = true } = {}) {
  const cfg = settings.selfHealth || {};
  if (cfg.enabled === false && !force) return { skipped: 'disabled' };
  if (live.running) return { skipped: 'already_running' };
  live.running = true;
  try {
    const lastEvent = await store.latestEvent(userId, 'self_health');
    const intervalMin = Math.max(5, Number(cfg.intervalMinutes) || 15);
    if (!force && ageMin(lastEvent) != null && ageMin(lastEvent) < intervalMin) {
      return { skipped: 'interval', latest: lastEvent.payload };
    }

    const checks = [];

    // 1. Decision-vs-execution drift — approved entries that never filled.
    {
      const wakes = await store.listEvents(userId, { kind: 'wake', limit: 12 });
      const miss = [];
      for (const w of wakes) {
        const p = w.payload || {};
        for (const e of (p.executions || [])) {
          // F17 (2026-09-18): `blocked` marks a POLICY refusal — the desk declined to open on a stale feed
          // before it ever reached the venue. Counting that as drift would report a working gate as a broken
          // one, which is the same asymmetry TRD-43 drew between `order_blocked` and `order_rejected`.
          if (e.action === 'entry' && e.placed === false && !e.blocked) {
            miss.push({ symbol: e.symbol, reason: e.reason || 'unknown', at: w.createdAt });
          }
        }
      }
      checks.push(miss.length
        ? check('drift', 'Decisions vs fills', 'bad',
          `${miss.length} approved entr${miss.length === 1 ? 'y' : 'ies'} never filled in last ${wakes.length} wakes: ${miss.slice(0, 3).map((m) => `${m.symbol} (${m.reason})`).join(' · ')}`)
        : check('drift', 'Decisions vs fills', 'ok', `no unfilled approved entries in last ${wakes.length} wakes`));
    }

    // 2. Order rejections in the last 6h (connector/cap failures).
    {
      const rejects = await store.countEventsSince(userId, 'order_rejected', REJECT_WINDOW_MIN);
      const last = await store.latestEvent(userId, 'order_rejected');
      const mins = ageMin(last);
      checks.push(rejects
        ? check('rejections', `Order rejections (${REJECT_WINDOW_MIN / 60}h)`, 'warn',
          `${rejects} rejected order(s) — last ${mins != null ? Math.round(mins) : '?'}m ago`)
        : check('rejections', `Order rejections (${REJECT_WINDOW_MIN / 60}h)`, 'ok', 'none in window'));
    }

    // 2b. Unconfirmed order submits (TRD-52). A row here means the desk SENT an order and does not know
    // whether the venue took it — the one state that can hide an unmanaged position, and until now it
    // was recorded as a rejection and averaged away with genuine refusals. `bad` (which pages, when
    // alertOnBad is on) is reserved for a submit older than the TTL, because that is a submit the
    // resolver should have settled and did not.
    {
      const rows = await store.getUnconfirmedTrades(userId, 20);
      const oldest = rows.length ? rows[0] : null;
      const mins = oldest ? ageMin({ createdAt: oldest.openAt }) : null;
      checks.push(rows.length
        ? check('unconfirmed', 'Unconfirmed orders', mins != null && mins > UNCONFIRMED_TTL_MIN ? 'bad' : 'warn',
          `${rows.length} submit(s) with an unknown outcome — oldest #${oldest.id} ${oldest.symbol} ${oldest.direction} ${mins != null ? Math.round(mins) + 'm' : '?'} ago (TTL ${UNCONFIRMED_TTL_MIN}m)`)
        : check('unconfirmed', 'Unconfirmed orders', 'ok', 'no submits awaiting venue confirmation'));
    }

    // 3. Tick freshness per watchlist symbol.
    {
      const ticksRepo = require('../store/ticks');
      const sessionFeed = require('../plus500/sessionFeed');
      const syms = (settings.watchlist && settings.watchlist.symbols) || [];
      const rows = [];
      for (const s of syms) {
        const t = await ticksRepo.latestTick(userId, s.symbol, s.venue || 'plus500').catch(() => null);
        // `no ticks yet` is its own fact and must not be averaged into an age (a symbol that has never been
        // captured is not "0 minutes old").
        // TRD-67: the venue's own open/closed state travels with the age, because silence means opposite
        // things either side of it. `null` is "no fresh session entry" — not "closed".
        let open = null;
        try { open = sessionFeed.isOpen(s.symbol); } catch { open = null; }
        rows.push(t
          ? { symbol: s.symbol, mins: (Date.now() - new Date(t.capturedAt || t.createdAt).getTime()) / 60000, open }
          : { symbol: s.symbol, mins: null, open });
      }
      const tickSum = tickAgeSummary(rows);
      const verdicts = rows.map((r) => deadFeedVerdict(r));
      const sev = tickSeverity(verdicts);
      const closed = verdicts.filter((v) => v === 'venue_closed').length;
      const unknown = verdicts.filter((v) => v === 'stale_unknown_session').length;
      const worstLive = rows
        .filter((r, i) => verdicts[i] === 'dead' || verdicts[i] === 'stale')
        .sort((a, b) => Number(b.mins) - Number(a.mins))
        .slice(0, 3).map((r) => `${r.symbol} ${Math.round(Number(r.mins))}m`);
      const dead = verdicts.filter((v) => v === 'dead').length;
      const label = `Tick freshness (${tickSum.checked} symbols)`;
      if (sev === 'ok') {
        checks.push(check('ticks', label, 'ok',
          closed ? `all fresh or venue closed (${closed} closed)` : `all ≤${TICK_SLA_MIN}m`));
      } else {
        checks.push(check('ticks', label, sev,
          (dead ? `DEAD ${dead}/${tickSum.checked} while the venue is TRADING — worst ${worstLive.join(', ') || 'n/a'}`
            : `stale ${tickSum.stale}/${tickSum.checked}${worstLive.length ? ` — worst by age: ${worstLive.join(', ')}` : ''}`)
          + (tickSum.missing ? `, ${tickSum.missing} never captured` : '')
          + (closed ? ` — ${closed} venue-closed (silence expected)` : '')
          + (unknown ? ` — ${unknown} session unknown` : '')
          + ` — ages: ${tickSum.shape}`));
      }
    }

    // 3b. SIGNAL-SERIES freshness per watchlist symbol (TRD-68 direction (c), 2026-09-22).
    //
    // A SECOND FEED, and the tick check above is structurally blind to it: that check reads
    // `ticksRepo.latestTick`, so a symbol whose ticks arrive perfectly while its CHART BARS have stopped is
    // graded `fresh`. That was China Shenhua exactly - 3 ticks per sweep, `captured:36, missing:[]`, and a 1h
    // signal series 456 minutes old. quant returns no signal and renders no price for a stale series, so the
    // symbol is silently excluded from evaluation forever while still costing a scout slot and riding in every
    // chair bundle, and the only visible artefact was a bare `stale` with no explanation anywhere.
    //
    // THE GRADING IS TRD-67's, deliberately NOT a second implementation: same `deadFeedVerdict`, same
    // venue-open rule (silence is correct when the venue is shut), same "only dead is a fault". What differs
    // is the SLA, because the CADENCE differs - a 1h series held to the 15-minute tick SLA would report every
    // healthy symbol as stale. And the SLA is TAKEN FROM quant, not restated: `quant.BAR_FRESH_MS` is the
    // desk's own line for "this series is not tradable", so this check cannot drift from what it checks. Same
    // for the venue order: `IND_VENUE_PREF` is quant's preference list, imported rather than copied, so the
    // check measures the series quant would actually READ rather than one nobody trades.
    {
      const barsRepo = require('../store/bars');
      const quant = require('./quant');
      const sessionFeed = require('../plus500/sessionFeed');
      const syms = (settings.watchlist && settings.watchlist.symbols) || [];
      const barSlaMin = quant.BAR_FRESH_MS / 60000; // 240 min (4h), quant's not-tradable line
      const rows = [];
      for (const s of syms) {
        let chosen = null;
        for (const v of quant.IND_VENUE_PREF) {
          const b = await barsRepo.listBars(userId, { timeframe: '1h', symbol: s.symbol, venue: v, limit: quant.MIN_BARS * 2 }).catch(() => null);
          if (b && b.length >= quant.MIN_BARS) { chosen = { venue: v, last: b[b.length - 1] }; break; }
        }
        if (!chosen) {
          const b = await barsRepo.listBars(userId, { timeframe: '1h', symbol: s.symbol, venue: s.venue, limit: 1 }).catch(() => null);
          if (b && b.length) chosen = { venue: s.venue, last: b[b.length - 1] };
        }
        let open = null;
        try { open = sessionFeed.isOpen(s.symbol); } catch { open = null; }
        rows.push(chosen
          ? { symbol: s.symbol, venue: chosen.venue, mins: (Date.now() - new Date(chosen.last.barStart).getTime()) / 60000, open }
          : { symbol: s.symbol, venue: null, mins: null, open });
      }
      const verdicts = rows.map((r) => deadFeedVerdict({ ...r, slaMin: barSlaMin }));
      const sev = tickSeverity(verdicts);
      const dead = verdicts.filter((v) => v === 'dead').length;
      const stale = verdicts.filter((v) => v === 'stale' || v === 'stale_unknown_session').length;
      const noSeries = verdicts.filter((v) => v === 'never_captured').length;
      const closed = verdicts.filter((v) => v === 'venue_closed').length;
      const worst = rows
        .filter((r, i) => verdicts[i] === 'dead' || verdicts[i] === 'stale' || verdicts[i] === 'stale_unknown_session')
        .sort((a, b) => Number(b.mins) - Number(a.mins))
        .slice(0, 3)
        // MISSED CADENCES, not just an age: a 1h series 456 minutes old has missed 7 hourly bars, and that is
        // the number that makes the condition legible. The GRADE stays TRD-67's - this only says how far past.
        .map((r) => `${r.symbol} ${Math.round(Number(r.mins))}m (${r.venue || 'no venue'}, ~${Math.max(0, Math.floor(Number(r.mins) / 60) - 4)} missed hourly bar(s))`);
      const label = `Signal series (${rows.length} symbols)`;
      if (sev === 'ok') {
        checks.push(check('signal_series', label, 'ok',
          closed ? `all within ${barSlaMin}m or venue closed (${closed} closed)` : `all ≤${barSlaMin}m`));
      } else {
        checks.push(check('signal_series', label, sev,
          (dead ? `DEAD ${dead}/${rows.length} while the venue is TRADING — worst ${worst.join('; ') || 'n/a'}`
            : `stale ${stale}/${rows.length}${worst.length ? ` — worst by age: ${worst.join('; ')}` : ''}`)
          + (noSeries ? `, ${noSeries} with NO usable series at all` : '')
          + (closed ? ` — ${closed} venue-closed (silence expected)` : '')
          + ` — SLA ${barSlaMin}m (quant.BAR_FRESH_MS)`));
      }
    }

    // 4. Provider snapshot health (binance/okx/yahoo capture pipeline).
    {
      const snap = await store.latestEvent(userId, 'provider_snapshot');
      const mins = ageMin(snap);
      if (!snap) {
        checks.push(check('providers', 'Provider feeds', 'warn', 'no provider snapshot yet'));
      } else {
        const p = snap.payload || {};
        const fails = [];
        for (const [name, r] of Object.entries(p.results || {})) {
          if (r && Array.isArray(r.failures) && r.failures.length) fails.push(name);
        }
        if (mins != null && mins > 30) checks.push(check('providers', 'Provider feeds', 'warn', `last snapshot ${Math.round(mins)}m ago`));
        else if (fails.length) checks.push(check('providers', 'Provider feeds', 'warn', `recent failures: ${fails.join(', ')}`));
        else checks.push(check('providers', 'Provider feeds', 'ok', `${p.ticks ?? '?'} ticks · binance/okx/yahoo ok`));
      }
    }

    // 5. Bridge + watchdog login state.
    {
      const b = settings.bridge || {};
      const wd = require('./watchdog').status();
      const loginAlive = wd.login && wd.login.alive;
      if (b.paused) {
        // TRD-65 (2026-09-19): report the pause's AGE, not only its fail count. The latch survives
        // recovery BY DESIGN — the 2026-09-11 patch exists because a passing health check must not
        // silently clear an active pause — so `consecutiveFails` is back to 0 in exactly the state a
        // reader most needs to act on. `consecutiveFails || '?'` rendered that as "(? consecutive fails)":
        // it named the one number that cannot be nonzero, and said nothing about how long entries have
        // been blocked. The fail counter is now printed honestly as 0 and the duration carries the weight.
        checks.push(check('bridge', 'Plus500 bridge', 'bad',
          `UI fallback PAUSE active${pauseAgeLabel(b.pausedAt)} (${Number(b.consecutiveFails) || 0} consecutive fails; the resume button clears it)`));
      } else if (loginAlive === false) checks.push(check('bridge', 'Plus500 bridge', 'bad', 'watchdog sees Plus500 SIGNED OUT'));
      else if (Number(b.consecutiveFails) > 0) checks.push(check('bridge', 'Plus500 bridge', 'warn', `${b.consecutiveFails} consecutive selector failure(s)`));
      else checks.push(check('bridge', 'Plus500 bridge', 'ok', loginAlive === true ? 'logged in · selectors healthy' : 'no login probe yet'));
    }

    // 5b. Venue session feed freshness (2026-09-15).
    //
    // ★ WHY THIS CHECK EXISTS. The desk's own answer to "is this instrument tradeable" ages out
    // SILENTLY: a symbol's entry is only trusted for STALE_MS, after which `get()` returns null — and
    // every consumer reads a missing entry as "unknown, carry on". So a feed that has stopped updating
    // is not visibly missing. It looks exactly like a quiet market, which is why the desk spent a
    // trading day with no venue session data and no complaint from anything.
    //
    // `warn`, not `bad`, deliberately: silence is now much less dangerous than it was (the fallback can
    // only produce a real halt or a macro lock), and a pager that fires when the venue happens to be
    // idle at a weekend is a pager that gets ignored — the reasoning the supervisor's marketState()
    // already records.
    {
      const feed = require('../plus500/sessionFeed');
      const s = feed.status();
      const mins = Math.round((s.silentForMs || 0) / 60000);
      if (!s.tracking) checks.push(check('sessions', 'Venue session feed', 'warn', 'listener never started'));
      else if (s.silent) checks.push(check('sessions', 'Venue session feed', 'warn', `no venue payload for ${mins}m — session state is UNKNOWN and every consumer is on its fallback (${s.tracked} symbol(s) cached, ${s.attachments} attach(es))`));
      else checks.push(check('sessions', 'Venue session feed', 'ok', `${s.tracked} symbol(s) · last payload ${mins}m ago · ${s.attachments} attach(es)`));
    }

    // 5c. Did the desk actually DO anything, or only record that it tried? (2026-09-15)
    //
    // ★ THE BLIND SPOT THIS CLOSES. Check 6 below asks "is the wake loop alive", and it answered YES all
    // day on 2026-09-15 while 19 consecutive wakes skipped the entire pipeline. A skip IS a wake event,
    // so liveness was never in question and nothing measured progress. The desk was recording activity
    // and doing nothing, which is the failure the owner's own dashboard could not show him.
    //
    // Gated on the pure calendar so it cannot fire on a weekend, where skipping every wake is correct.
    // Scoped to `market_closed` because the other skip reason (kill_switch_hard) is a deliberate state
    // with its own check, and paging twice for one decision is how alerts get muted.
    {
      const cal = require('./sessions').calendarState(new Date());
      const wakes = await store.listEvents(userId, { kind: 'wake', limit: 40 });
      const skippedReasons = wakes.map((w) => (w.payload || {}).skipped).filter(Boolean);
      const allSessionSkipped = wakes.length > 0 && skippedReasons.length === wakes.length && skippedReasons.every((r) => r === 'market_closed');
      if (allSessionSkipped && cal === 'open') {
        checks.push(check('progress', 'Wake progress', 'bad',
          `the last ${wakes.length} wake events ALL skipped with market_closed while the calendar says the market is open — the desk is running and doing nothing. Check the venue session feed and any CorporateEvents halt rows for today.`));
      } else if (allSessionSkipped) {
        checks.push(check('progress', 'Wake progress', 'ok', `all of the last ${wakes.length} wakes skipped market_closed (calendar: ${cal}) — expected while the venue is shut`));
      } else {
        checks.push(check('progress', 'Wake progress', 'ok', `${wakes.length - skippedReasons.length} of the last ${wakes.length} wake events reached the pipeline`));
      }
    }

    // 5d. What is SCHEDULED today? (2026-09-15)
    //
    // ★ REVISED. This started as an "Entry lock" check, written when a scheduled macro event barred new
    // entries for a whole day. The owner asked the right question — why should an FOMC meeting day bar
    // entries at all? — and the answer was that nobody had decided it, and that the lock suppressed the
    // deliberation it should have informed. So a `macro` event no longer locks anything.
    //
    // The check stays because the INFORMATION is worth a line: on a day the desk trades normally it is
    // useful to see why the chairs are being told about an FOMC statement. A `macro` day is now `ok`, not
    // `warn` — nothing is wrong. A `halt` still pages, because that one really does shut the venue.
    {
      const { getPool, sql } = require('../db');
      const now = new Date();
      try {
        const pool = await getPool();
        const r = await pool.request()
          .input('userId', sql.Int, userId)
          .input('today', sql.Date, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())))
          .query(`SELECT symbol, eventType, note FROM CorporateEvents
                  WHERE userId = @userId AND eventDate = @today AND eventType IN ('halt','macro')`);
        const macro = r.recordset.filter((e) => e.eventType === 'macro');
        const halt = r.recordset.filter((e) => e.eventType === 'halt');
        const names = (rows) => [...new Set(rows.map((e) => e.note || e.eventType))].join(' · ');
        if (halt.length) checks.push(check('schedule', 'Scheduled events', 'bad', `a venue HALT is in force today: ${names(halt)} — the desk is skipping wakes`));
        else if (macro.length) checks.push(check('schedule', 'Scheduled events', 'ok', `today: ${names(macro)}. Context only — the chairs are told and entries are NOT blocked.`));
        else checks.push(check('schedule', 'Scheduled events', 'ok', 'nothing scheduled today'));
      } catch (e) {
        checks.push(check('schedule', 'Scheduled events', 'warn', `could not read today's events: ${String(e.message || e).slice(0, 80)}`));
      }
    }

    // 6. Wake-loop cadence (stalled waker = the desk went blind).
    {
      const waker = require('./waker').status();
      const lastWake = await store.latestEvent(userId, 'wake');
      const mins = ageMin(lastWake);
      const intervalMin = Math.max(1, Number((settings.wake || {}).intervalMinutes) || 10);
      if (!waker || !waker.running) {
        checks.push(check('waker', 'Wake loop', 'bad', 'loop NOT running'));
      } else if (mins != null && mins > Math.max(3, intervalMin)) {
        checks.push(check('waker', 'Wake loop', 'warn', `last wake ${Math.round(mins)}m ago — overdue (interval ${intervalMin}m)`));
      } else {
        checks.push(check('waker', 'Wake loop', 'ok', `last wake ${mins != null ? Math.round(mins) : '?'}m ago (interval ${intervalMin}m)`));
      }
    }

    // 7. LLM budget headroom (chairs silently abstain when exhausted) + UNCAPPED consumers.
    {
      const bs = await require('./budget').summary(userId, settings);
      const total = Number(bs.usage && bs.usage.total) || 0;
      const cap = Number(bs.settings && bs.settings.totalDaily) || 0;
      const pct = cap ? Math.round(total / cap * 100) : 0;
      const headroom = cap ? `${total.toLocaleString()} / ${cap.toLocaleString()} tokens today (${pct}%)` : 'no daily cap set';
      // TRD-96: a consumer with NO sub-cap is bounded only by the total, and it used to render as
      // "cap 0 / 0% used" — indistinguishable from a consumer that never runs. Naming them here means
      // "the budget looks quiet" can never be the same statement as "two consumers have no ceiling".
      const uncapped = (bs.consumers || []).filter((c) => c.uncapped);
      const note = uncapped.length
        ? ` · UNCAPPED (total-cap only): ${uncapped.map((c) => `${c.consumer} ${Number(c.used).toLocaleString()}`).join(', ')}`
        : '';
      // TRD-94: the chair is the most expensive consumer per call (~9,528 tokens measured 2026-09-18),
      // so a churn regime spends the very sub-cap that exists to gate it — and the desk then keeps
      // ENTERING, quant-only and at a reduced size, with nothing on the dashboard saying those entries
      // were never deliberated. That is the difference between "the book is quiet" and "the book is not
      // being judged", so it is named here rather than left to be inferred from an empty wake log.
      const chair = (bs.consumers || []).find((c) => c.consumer === 'chair');
      const chairOff = chair && chair.cap != null && Number(chair.used) >= Number(chair.cap);
      const chairNote = chairOff
        ? ` · CHAIR SOFT-STOPPED (${Number(chair.used).toLocaleString()}/${Number(chair.cap).toLocaleString()}) — degraded entries are quant-only and size-reduced until the daily reset (TRD-94)`
        : '';
      const status = pct >= 90 || chairOff ? 'bad' : (pct >= 70 || uncapped.length) ? 'warn' : 'ok';
      checks.push(check('budget', 'LLM budget', status, headroom + note + chairNote));
    }

    // 8. Kill switch state (soft/hard changes what the desk is allowed to do).
    {
      const k = settings.kill || {};
      checks.push(check('kill', 'Kill switch', k.tier === 'off' ? 'ok' : 'warn',
        `tier: ${k.tier || 'off'}${k.autoClose ? ' · auto-close ON' : ''}`));
    }

    // 9. LLM served-model assertion (2026-09-10): the API can silently alias
    // the requested model (deepseek-chat/reasoner -> flash) and the alias can
    // change with any server-side deploy — never trust the pin alone.
    {
      const mm = await store.latestEvent(userId, 'llm_model_mismatch');
      const mins = ageMin(mm);
      if (mm && mins != null && mins < 24 * 60) {
        const p = mm.payload || {};
        checks.push(check('model', 'LLM served model', 'warn',
          `mismatch ${Math.round(mins)}m ago: requested ${p.requested || '?'} → served ${p.served || '?'}`));
      } else {
        checks.push(check('model', 'LLM served model', 'ok', 'no served-model mismatch in last 24h'));
      }
    }

    // 10. Field contracts (2026-09-13) — does each field still mean what its LABEL says?
    // Check 9 above is the same instinct applied to one field ("never trust the pin alone").
    // This generalises it to the fields that have actually lied: chgPct (a 120-bar lookback
    // presented as a 5m move), the trailing anchor (seeded from pre-entry bars), mfePct/maePct
    // (favourable/adverse swapped), holdingMinutes, the backtest win rate (a "win rate" from a
    // 0- or 1-trade run) and riskPerTradePct (inert while the notional cap binds).
    // Each contract is pushed as its own row so it is individually visible and individually
    // actionable. Contract warnings DO count toward the overall status on purpose: a known,
    // unresolved label mismatch should keep the desk amber until someone fixes or acknowledges
    // it, rather than being buried in a footnote nobody reads.
    {
      try {
        // F20: the settings ride along so the venue-levels contract can apply the owner's realised-R:R floor
        // (`risk.minRealisedRrPct`). Without them the contract falls back to the same 50% default, which is
        // the right answer for a caller that has no settings — but not for the desk's own health run.
        const fc = await require('./fieldContracts').runAll(userId, { settings });
        for (const c of fc.checks) checks.push(c);
      } catch (e) {
        checks.push(check('field_contracts', 'Field contracts', 'warn', `contracts threw: ${String(e.message || e).slice(0, 140)}`));
      }
    }

    // 11. Stop coverage (TRD-43) — is every DESK-OPENED position risk-measurable?
    // This is the same instinct as check 10 pointed at the one field whose absence is silent:
    // `rMultiple` returns null rather than throwing, so a position with no stop simply drops out
    // of every R-based metric while the metrics keep reporting a sample size. 11 of 25 closed
    // trades were in that state, and a single "11 excluded" count could not say whether the desk
    // had failed to record a risk or had merely adopted somebody else's position.
    //
    // The recent window decides the STATUS; the all-time residue is context. Judging the residue
    // would leave this amber forever over rows that cannot be fixed, which is how a real alert
    // gets tuned out — see the F work: the failure to be audible is worse than the defect.
    {
      try {
        const cov = await require('./stopCoverage').report(userId, { days: 90, recentDays: 7 });
        checks.push(check('stops', 'Stop coverage (risk measurable)', cov.verdict.status, cov.verdict.detail, cov.verdict.standing));
      } catch (e) {
        checks.push(check('stops', 'Stop coverage (risk measurable)', 'warn', `coverage check threw: ${String(e.message || e).slice(0, 140)}`));
      }
    }

    // 12. Meter integrity (TRD-77) — can the LLM budget still SEE what it measures?
    // Check 7 above asks whether the budget has headroom; this one asks whether the number it reads is
    // a measurement at all. The difference matters because the failure mode was not "the cap is too
    // high" but "there is no cap, and the system reports that there is": the denylist struck the token
    // counters, so every usage figure read zero while the desk spent, for four days, and the budget API
    // rendered a full, confident, wrong table.
    //
    // The detector is deliberately independent of the meter: the call count and the token sum come from
    // SQL in one statement (no pagination, no `Number(x) || 0` coercion, no reliance on the meter's
    // field names), and they are compared against what the meter reports. A meter that reports 0 is
    // indistinguishable from a desk that is idle, so "is this plausible" cannot work — the check has
    // to read the same population through different code.
    {
      try {
        const mi = await require('./meterIntegrity').inspect(userId);
        checks.push(check('meter', 'LLM meter integrity', mi.status, mi.detail));
      } catch (e) {
        checks.push(check('meter', 'LLM meter integrity', 'warn', `meter check threw: ${String(e.message || e).slice(0, 140)}`));
      }
    }

    // 13. LLM provider errors (TRD-94, 2026-09-21) — "this seat could not speak" vs "this seat said nothing".
    //
    // Check 7 asks whether the budget has headroom and check 12 whether the meter can see; this one asks
    // whether the CHAIR COULD ANSWER AT ALL. Measured 2026-09-21: `DeepSeek HTTP 402 Insufficient Balance` has
    // recurred since 2026-09-10 (18 prompts carrying it, 2 that morning) and was written ONLY to a prompt-error
    // row (a table nothing reads) and a vote reason — so a seat abstaining on CREDIT rendered exactly like a
    // seat with nothing to say. An abstention is a legitimate answer; a payment failure is not, and it cannot
    // fix itself. That is why it gets its own check rather than a longer note on check 7.
    {
      try {
        const since = new Date(Date.now() - 24 * 3600000).toISOString();
        // By KIND COLUMN, not by stream: `log.streamFor` maps an unlisted kind to 'app', so a stream filter
        // silently excluded this check's own events (see providerErrorVerdict).
        const rows = await store.listEvents(userId, { kind: 'llm_provider_error', since, limit: 200 }).catch(() => null);
        const v = providerErrorVerdict(flat(rows));
        checks.push(check('provider', 'LLM provider errors', v.status, v.detail));
      } catch (e) {
        checks.push(check('provider', 'LLM provider errors', 'warn', `provider check threw: ${String(e.message || e).slice(0, 140)}`));
      }
    }

    // 14. Tuner liveness (TRD-112, 2026-09-21) — an enabled dial that has never done anything.
    // `tuner.enabled: true` and `learning.parityValidated: false` on the live desk, so every 6h run was refused
    // at the parity gate and returned into a caller that discards it: no event, no record, nothing to count. The
    // row said "the tuner has never run"; the measurement was worse — it had run every 6 hours for eleven days.
    // Check 7 watches the budget and check 13 the provider; this one watches a control's OWN decisions.
    {
      try {
        const since = new Date(Date.now() - 24 * 3600000).toISOString();
        const res = await store.listEvents(userId, { kind: 'tune_skipped', since, limit: 200 }).catch(() => null);
        const rows = tunerSkipRows(res);
        const lastTune = await store.latestEvent(userId, 'tune').catch(() => null);
        const v = tunerGateVerdict(rows, lastTune && lastTune.createdAt);
        checks.push(check('tuner', 'Tuner liveness', v.status, v.detail));
      } catch (e) {
        checks.push(check('tuner', 'Tuner liveness', 'warn', `tuner check threw: ${String(e.message || e).slice(0, 140)}`));
      }
    }

    // 15. Scope vs enabled (TRD-116, 2026-09-21; rule corrected 2026-09-25) — a setting that does nothing.
    // Reads the SETTINGS BLOB and the WATCHLIST, not the event stream, so there is no reader to get wrong.
    {
      const v = scopeEnabledVerdict(
        settings.strategies && settings.strategies.enabled,
        settings.strategies && settings.strategies.symbolScope,
        scopeResolution.watchlistSymbols(settings.watchlist),
      );
      checks.push(check('scope', 'Strategy scope vs enabled', v.status, v.detail));
    }

    // ★ TRD-F20-EPOCH: THE STATUS IS DECIDED BY THE CHECKS THAT DESCRIBE AN ACTIONABLE, CURRENT FAULT.
    // A standing row is counted and reported separately rather than folded into `warn`, so `bad`/`warn`
    // keep meaning what a reader assumes they mean: something is wrong NOW and someone can do something.
    const active = checks.filter((c) => !c.standing);
    const standing = checks.length - active.length;
    const bad = active.filter((c) => c.status === 'bad').length;
    const warn = active.filter((c) => c.status === 'warn').length;
    const overall = bad ? 'bad' : warn ? 'warn' : 'ok';
    const snapshot = { at: new Date().toISOString(), status: overall, bad, warn, standing, checks };
    live.last = snapshot;
    if (!persist) return snapshot;
    await store.logEvent(userId, 'self_health', snapshot);

    // Transition alert (once per status change, not per run).
    //
    // TRD-65 (2026-09-19): A TRANSITION ON THE OVERALL STATUS ALONE IS A LATCH OF ITS OWN.
    // `field_levels` is permanently bad on one historical trade (`#1046`), so `overall` is 'bad' on every
    // run and `prevStatus !== overall` is false on every run — which silently mutes the paging for EVERY
    // later defect, including a UI Fallback Pause that latches entries off and a feed that dies. One stuck
    // check turns the whole alarm off, and it does so invisibly: the panel looks like it is working.
    // The alert is now keyed on the SET of offending check ids, so a NEW offender pages even while an old
    // one stays red, while "once per change, never once per run" is preserved exactly.
    const prevStatus = lastEvent && lastEvent.payload && lastEvent.payload.status;
    const prevKey = lastEvent && lastEvent.payload ? offenderKey(lastEvent.payload.checks) : null;
    if (cfg.alertOnBad !== false && overall !== 'ok' && (prevStatus !== overall || prevKey !== offenderKey(checks))) {
      const offenders = checks.filter((c) => c.status !== 'ok' && !c.standing).map((c) => `${c.label}: ${c.detail}`).join('\n');
      const standingLine = standing ? `\n+${standing} standing row(s): documented, and no action clears them (see the self-health card)` : '';
      await require('../lib/http').telegramAlert(
        `OSWALD self-health: ${overall.toUpperCase()} (${bad} bad / ${warn} warn)\n${offenders.slice(0, 600)}${standingLine}`
      ).catch(() => {});
    }

    return snapshot;
  } finally {
    live.running = false;
  }
}

function latest() {
  return live.last;
}

module.exports = { run, latest, tickAgeSummary, TICK_SLA_MIN, pauseAgeLabel, offenderKey, deadFeedVerdict, tickSeverity, providerErrorVerdict, tunerGateVerdict, tunerSkipRows, scopeEnabledVerdict };
