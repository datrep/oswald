'use strict';
// trading/agent/constraintAudit.js — ask the ledger the question it exists for: what applied at this trade, and was
// it honoured?
//
// ★★ WHY THIS EXISTS. Every other piece of the constraint programme records or compares. Nothing CONSUMED it:
// `resolveSubject`/`assessSubject` had zero callers, so the ledger was a library with no caller. This is the caller.
//
// ⚠⚠ WHY IT RUNS AFTER THE FACT RATHER THAN AT CLOSE, AND THIS IS THE WHOLE DESIGN.
// There is NO choke point for trade closure. `closeTrade` is defined twice (`agent/executor.js:870` for the live
// path, `agent/paper.js:104` for paper) and is called from ten sites across five files; the only shared write,
// `store.updateTrade`, is used 8 times by executor and ZERO times by paper. So a close-time hook would have had to
// be duplicated, or hung off `updateTrade` — where it would have SILENTLY SKIPPED EVERY PAPER CLOSE, producing no
// assessment for them, which is indistinguishable from "no breach". That is the exact failure this register exists
// to prevent, in the feature built to prevent it.
//
// A read-only pass has none of that: it cannot delay or fail a close, it covers paper trades, and it can assess
// history. ⚠ THE COST IS NAMED RATHER THAN HIDDEN: this can REPORT a breach, never prevent one. Prevention needs a
// real choke point on the close path, which does not exist today.
//
// ⚠ AND ONLY ONE CONSTRAINT IS CHECKABLE PER TRADE. `minimum_trade_size` has its observation on the trade row
// (`size`). Margin, funding and the one-tab rule are not per-trade facts — they are recorded as `informational` by
// the resolver rather than faked into a verdict, which is exactly what `checks` was added for.

const crypto = require('node:crypto');
const c = require('./constraints');
const assessability = require('./assessability');

const KIND = 'constraint_assessment';
const VENUE = 'plus500';

// ★★ THE RULES VERSION, AND WHY IT IS IN THE DEDUPE KEY.
// 1 = judged at `closeAt` with a whole-subject verdict (2026-10-27, 200 rows written before it was corrected).
// 2 = judged at ENTRY time with a scoped verdict.
// ⚠ Those 200 rows are WRONG under the corrected instant, and `TradingEvents` is append-only (AGENTS.md §4) so they
// cannot be deleted. Keying the dedupe on this version means a re-run APPENDS corrected assessments instead of
// skipping trades it believes it has already judged. Without it the wrong answers would be permanent AND look
// authoritative — the failure mode this file's own header warns about.
const RULES_VERSION = 2;

// What the verdict is ABOUT. A scoped verdict must never be readable as "this trade was clean".
const SCOPE = 'minimum trade size';

// THE AUTHORED MAP: which constraint can be judged from a trade, and in which direction.
// ⚠ It cites a FIELD, not a key — the key is per-instrument — and it states the direction because the ledger
// stores a value and a unit and deliberately does not encode intent (a floor and a requirement look identical).
const CHECKS = {
  minimum_trade_size: { direction: 'min', observation: (trade) => (trade.size == null ? null : Number(trade.size)) },
};

const fieldOfKey = (key) => assessability.fieldOf(key);

// One trade, one assessment. PURE: the caller supplies the versions, the instrument id and the floors.
// Returns a NAMED record in every branch — an assessment that cannot be made is reported as `unassessable` with
// its reason, never as an absent field.
// WHICH INSTRUMENT IS A TRADE JUDGED AGAINST? Recorded first, symbol map second.
//
// ⚠⚠ THE ORDER IS THE POINT. `runOnce` used to resolve the id ONLY from the symbol map (`:182`), which is a lookup
// against the registry AS IT IS NOW — so the fact was reconstructed at audit time rather than recorded at entry, and
// a symbol renamed between the two, or an option contract whose composite name can never match `Instruments.symbol`,
// left the trade unjoinable. Migration 055 puts the id on the row; the map stays for the 316 rows that predate it.
//
// ⚠ AN EMPTY STRING IS ABSENT, NOT PRESENT. `'' != null` is TRUE, and this repo has already paid for that comparison
// once (`sizeReconcile`#s empty `positionId` counting as "a venue position the desk has no row for"). A recorded `''`
// must fall through to the map rather than become an id nothing can match.
//
// PURE, so both directions are testable without a database.
function tradeInstrumentId(trade, idBySymbol) {
  const recorded = trade && trade.venueInstrumentId;
  if (recorded != null && recorded !== '') return String(recorded);
  const symbol = trade && trade.symbol;
  if (symbol == null || !idBySymbol || typeof idBySymbol.get !== 'function') return null;
  const mapped = idBySymbol.get(String(symbol));
  return mapped == null || mapped === '' ? null : String(mapped);
}

function assessmentFor({ trade, versions = [], venueInstrumentId = null, floors = {}, at = null } = {}) {
  // ⚠ ENTRY TIME, NOT CLOSE. The constraint that governs a trade's SIZE is the one in force when the order was
  // sized; judging at `closeAt` could compare a September entry against an October minimum and call it a breach or
  // a pass. `filledAt` is the actual fill; `openAt` is the fallback for the 14 closed rows that have no fill time
  // (measured 2026-10-27: 317 of 331 populated), and the fallback is explicit rather than silent.
  // ⚠ `closeAt` is deliberately NOT a candidate. My first version used it, which is what RULES_VERSION 1 records.
  const instant = at || trade.filledAt || trade.openAt || null;
  if (!instant) {
    // ⚠ THE SCOPE IS CARRIED EVEN WHEN NOTHING WAS ATTEMPTED. A record with a verdict and no scope is the exact
    // defect this file exists to avoid; "we could not assess" is still an assessment OF something.
    return { verdict: c.UNASSESSABLE, reason: 'no_instant', scope: SCOPE, checked: null };
  }
  if (venueInstrumentId == null) {
    // The instrument registry did not resolve this symbol. Naming it matters: an empty constraint set would
    // otherwise read as `no_applicable_constraints`, which blames the ledger for a gap in the instrument map.
    // ⚠ Measured 2026-10-27: the three rows this hits are OPTION contracts (`Oil | Call 97 | Oct W3`), whose venue
    // names never appear in `Instruments`. That is a gap in the instrument map, not in the ledger.
    return { verdict: c.UNASSESSABLE, reason: 'instrument_unknown', scope: SCOPE, checked: null };
  }

  const subject = c.resolveSubject(versions, { venue: VENUE, venueInstrumentId: String(venueInstrumentId), at: instant });
  const observations = {};
  const directions = {};
  const checks = [];
  const keyFloors = {};
  for (const [field, spec] of Object.entries(CHECKS)) {
    const key = `${VENUE}.${venueInstrumentId}.${field}`;
    checks.push(key);
    directions[key] = spec.direction;
    observations[key] = spec.observation(trade);
    if (floors[field]) keyFloors[key] = floors[field];
  }

  // ★ SCOPED, not whole-subject: this audit can judge ONE key and must not answer for the others. `notJudged`
  // carries everything else that applies, with its reasons, so the narrower claim is visible rather than implied.
  const a = c.assessScoped({
    subject, observations, directions, checks, at: instant, floors: keyFloors, scope: SCOPE,
  });
  return {
    verdict: a.verdict,
    reason: a.reason || null,
    scope: a.scope,
    checked: checks,
    results: a.results,
    notJudged: a.notJudged,
    at: instant ? new Date(instant).toISOString() : null,
  };
}

// A deterministic identity for one assessment, so a re-run cannot double-count it.
function assessmentHash(tradeId, record) {
  return crypto.createHash('sha256')
    .update(`${tradeId}|${(record.checked || []).join(',')}|${record.verdict}|${record.reason || ''}`)
    .digest('hex');
}

// ★★ THE POPULATION IS THE WINDOW, NOT A ROW COUNT.
//
// The first version fetched `TOP (@n) ... ORDER BY closeAt DESC` with n = 200 and called that the window. Measured
// 2026-10-27: 247 trades had closed in 30 days, so 47 of them were NEVER ASSESSED and nothing in the output said so.
// That is the same defect `store.EVENT_QUERY_CAP` documents — "a caller asking for more silently received less and
// could not tell a TOTAL from a FLOOR" — rebuilt one file over.
//
// A row cap is now only a runaway guard, and it STATES what it withholds: `truncated` plus `remaining`. PURE, so the
// arithmetic is testable without a database.
function windowPlan({ total = 0, maxTrades = 5000 } = {}) {
  const t = Math.max(0, Number(total) || 0);
  const cap = Math.max(1, Number(maxTrades) || 1);
  if (t <= cap) return { take: t, truncated: false, remaining: 0, total: t };
  return { take: cap, truncated: true, remaining: t - cap, total: t };
}

// Read every closed trade in the window, assess the ones with no assessment yet, log one event each.
// NEVER throws: it rides a timer, and a reporting loop that can take the desk down is worse than no reporting.
async function runOnce(userId, { days = 30, maxTrades = 5000, now = new Date() } = {}) {
  const store = require('../store');
  const cstore = require('../store/constraints');
  const registry = require('../store/instruments');
  const epoch = require('./epoch');

  let trades = []; let versions = []; let instruments = []; let seen = new Set(); let error = null;
  let plan = { take: 0, truncated: false, remaining: 0, total: 0 };
  try {
    const { getPool, sql } = require('../db');
    const pool = await getPool();
    // ⚠ COUNT FIRST, so the cap is applied to a KNOWN population and any withholding can be stated.
    const counted = await pool.request()
      .input('u', sql.Int, userId)
      .input('d', sql.Int, days)
      .query(`SELECT COUNT(*) AS n FROM dbo.Trades
               WHERE userId = @u AND status = 'closed' AND closeAt >= DATEADD(day, -@d, GETUTCDATE())`);
    plan = windowPlan({ total: (counted.recordset[0] || {}).n, maxTrades });
    trades = plan.take === 0 ? [] : (await pool.request()
      .input('u', sql.Int, userId)
      .input('d', sql.Int, days)
      .input('n', sql.Int, plan.take)
      .query(`SELECT TOP (@n) id, symbol, direction, size, status, filledAt, openAt, closeAt
                FROM dbo.Trades
               WHERE userId = @u AND status = 'closed' AND closeAt >= DATEADD(day, -@d, GETUTCDATE())
               ORDER BY closeAt DESC`)).recordset;
    versions = await cstore.subjectVersions(userId, { venue: VENUE });
    instruments = await registry.listInstruments(userId, { venue: VENUE });
    // ⚠ ONLY assessments written under the CURRENT rules count as "already done". Keyed on the version so a
    // corrected instant or a corrected verdict supersedes the earlier rows instead of being skipped by them.
    const done = (await pool.request()
      .input('u', sql.Int, userId)
      .input('d', sql.Int, days)
      .input('v', sql.Int, RULES_VERSION)
      .query(`SELECT JSON_VALUE(payload, '$.tradeId') AS tid FROM TradingEvents
               WHERE userId = @u AND kind = '${KIND}'
                 AND JSON_VALUE(payload, '$.rulesVersion') = @v
                 AND createdAt >= DATEADD(day, -@d, GETUTCDATE())`)).recordset;
    seen = new Set(done.map((r) => String(r.tid)));
  } catch (e) {
    error = String((e && e.message) || e).slice(0, 200);
  }

  // ⚠ A FAILED READ IS NOT "NOTHING TO DO". Two different silences, and only one of them is good news.
  if (error) {
    const out = { ok: false, reason: 'read_failed', error };
    await store.logEvent(userId, KIND, out).catch(() => {});
    return out;
  }

  const { floors, missing } = assessability.resolveFloors({ epochs: epoch.FEATURES });
  const idBySymbol = new Map();
  for (const i of instruments || []) {
    if (i && i.symbol && i.venueInstrumentId != null) idBySymbol.set(String(i.symbol), String(i.venueInstrumentId));
  }

  const assessed = [];
  let skippedExisting = 0;
  for (const trade of trades) {
    if (seen.has(String(trade.id))) { skippedExisting += 1; continue; }
    const record = assessmentFor({
      trade,
      versions,
      venueInstrumentId: tradeInstrumentId(trade, idBySymbol),
      floors,
    });
    const payload = { tradeId: trade.id, symbol: trade.symbol, rulesVersion: RULES_VERSION, hash: assessmentHash(trade.id, record), ...record };
    await store.logEvent(userId, KIND, payload).catch(() => {});
    assessed.push({ tradeId: trade.id, symbol: trade.symbol, verdict: record.verdict, reason: record.reason });
  }

  return {
    ok: true,
    reason: assessed.length ? 'assessed' : 'nothing_new',
    rulesVersion: RULES_VERSION,
    scope: SCOPE,
    // ⚠ `truncated` and `remaining` are part of the result, not a footnote: a run that covered 200 of 247 must never
    // be readable as complete. The dedupe makes a truncated run recoverable — the remainder is picked up next time —
    // but only if somebody can SEE that it was truncated.
    window: { days, total: plan.total, processed: plan.take, truncated: plan.truncated, remaining: plan.remaining },
    assessed: assessed.length,
    skippedExisting,
    // Counts rather than a wall of rows, but the reasons survive so a reader can see WHY nothing was assessable.
    byVerdict: assessed.reduce((m, a) => { m[a.verdict] = (m[a.verdict] || 0) + 1; return m; }, {}),
    sample: assessed.slice(0, 10),
    floorsMissing: missing,
  };
}

module.exports = { KIND, CHECKS, VENUE, SCOPE, RULES_VERSION, fieldOfKey, tradeInstrumentId, assessmentFor, assessmentHash, windowPlan, runOnce };
