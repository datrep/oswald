'use strict';
// trading/agent/constraints.js — the RESOLVER for the external constraint ledger (migration 052).
//
// ★ WHAT THIS ANSWERS, AND THE ONLY THING IT ANSWERS: given the stored versions of a constraint and a moment in time,
// which version applied — and was it something we knew about then, or something we learned afterwards?
//
// THREE OUTCOMES, AND THE THIRD IS THE POINT. `satisfied` | `breached` | `unassessable`. Missing, undatable or
// unrecoverable evidence must land in `unassessable`, never in `satisfied` — a clean pass from absent history is the
// exact failure this ledger exists to prevent, and it is the one a report is most likely to produce by accident.
//
// ★★ TWO CLOCKS, AND THEY ARE NOT INTERCHANGEABLE.
//   `effectiveFrom`/`effectiveTo`  — when the WORLD changed. Answers "did we honour what applied?"
//   `recordedAt`                   — when the DESK learned. Answers "why did it behave that way?"
// A venue changes a margin on the 1st and we capture it on the 5th. A trade on the 3rd has one answer under each
// question, and collapsing them rewrites history whenever a fact arrives late. So:
//   inForce(.., at)  uses the WINDOW      — the default for an audit
//   knownAt(.., at)  uses `recordedAt`    — a separately named view, never a default
// and a version whose window covers `at` but whose `recordedAt` is AFTER `at` is reported as `lateDiscovery`.
//
// ⚠ `effectiveFrom IS NULL` MEANS UNKNOWN, AND AN UNKNOWN IS NEVER IN FORCE. A row captured from a venue page today
// carries no effective date, so it is a CANDIDATE: it is excluded from every as-of answer, and its mere existence on
// a subject makes that subject's assessment UNASSESSABLE. Backfilling a guessed date would invent history; omitting
// the row would silently produce a pass. This is the C5 decision, and it is the one most likely to be "fixed" by a
// future reader into exactly the bug it prevents.
//
// ⚠ HALF-OPEN WINDOWS: `effectiveFrom <= t < effectiveTo`, matching `FeatureEpochs`, so two adjacent versions can
// share a boundary instant without both applying. An open `effectiveTo` is unbounded.
//
// PURE: no DB, no clock, no settings. Callers pass rows and an instant; callers store the outcome.

const SATISFIED = 'satisfied';
const BREACHED = 'breached';
const UNASSESSABLE = 'unassessable';

const IN_FORCE = 'in_force';
const CANDIDATE = 'candidate';
const NOT_IN_FORCE = 'not_in_force';
// A BOUNDED START (migration 053): the true start is somewhere inside [NotBefore, NotAfter]. Outside that interval the
// answer is DETERMINISTIC; inside it we genuinely do not know, and saying "in force" or "not in force" would both be
// inventions. This is why a fourth state exists rather than a flag on the third.
const UNCERTAIN = 'uncertain';

const ts = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());
const valid = (v) => v != null && Number.isFinite(ts(v));

// One row's relationship to an instant, on the WORLD clock.
//
// ⚠⚠ THE BOUNDED BRANCH IS THE ONE THAT EARNS ITS KEEP. Without it, an observation-derived bound is worth nothing:
// the row would sit as an eternal candidate and every future audit would be unassessable forever. With it, the
// uncertainty is confined to the interval the evidence actually leaves open:
//     at <  NotBefore            -> the version cannot have started yet            => NOT_IN_FORCE
//     at >= NotAfter (> = To)    -> it had certainly started, and has not ended   => IN_FORCE
//     otherwise                  -> genuinely unknown                              => UNCERTAIN
function stateAt(row, at) {
  if (!row) return NOT_IN_FORCE;
  const t = ts(at);

  if (valid(row.effectiveFrom)) {
    const from = ts(row.effectiveFrom);
    const to = valid(row.effectiveTo) ? ts(row.effectiveTo) : Infinity;
    return (from <= t && t < to) ? IN_FORCE : NOT_IN_FORCE;
  }

  const notBefore = valid(row.effectiveFromNotBefore) ? ts(row.effectiveFromNotBefore) : null;
  const notAfter = valid(row.effectiveFromNotAfter) ? ts(row.effectiveFromNotAfter) : null;
  if (notBefore == null && notAfter == null) return CANDIDATE;   // unknown start, as in 052

  const to = valid(row.effectiveTo) ? ts(row.effectiveTo) : Infinity;
  if (t >= to) return NOT_IN_FORCE;                              // the version had already ended
  if (notBefore != null && t < notBefore) return NOT_IN_FORCE;   // it cannot have started
  if (notAfter != null && t >= notAfter) return IN_FORCE;        // it had certainly started
  return UNCERTAIN;
}

// Did the desk know this row at `at`? Uses `recordedAt` only. A row with no `recordedAt` cannot be placed in the
// belief timeline at all, so it is excluded rather than assumed.
function knownAtInstant(row, at) {
  if (!row || !valid(row.recordedAt)) return false;
  return ts(row.recordedAt) <= ts(at);
}

const byStartDesc = (a, b) => (valid(b.effectiveFrom) ? ts(b.effectiveFrom) : -Infinity)
  - (valid(a.effectiveFrom) ? ts(a.effectiveFrom) : -Infinity);

// ── IN FORCE — the audit default ───────────────────────────────────────────────────────────────────────────────
// Returns at most one row. The write path forbids overlapping versions of one key (migration 052,
// `vw_ConstraintOverlaps`), so more than one match is a data error that must be visible rather than silently
// resolved by a tie-break: `overlapping` is reported and the newest start wins ONLY so the caller has something to
// show next to the contradiction.
function inForce(versions, { key = null, at } = {}) {
  const rows = (Array.isArray(versions) ? versions : [])
    .filter((r) => r && (key == null || r.constraintKey === key));
  const match = rows.filter((r) => stateAt(r, at) === IN_FORCE).sort(byStartDesc);
  if (!match.length) return { row: null, status: NOT_IN_FORCE, overlapping: 0 };
  return { row: match[0], status: IN_FORCE, overlapping: match.length - 1 };
}

// ── KNOWN AT — the belief view, always named explicitly ────────────────────────────────────────────────────────
// "What did the desk believe at `at`" is a different question from "what applied at `at`", and it is the answer that
// explains behaviour. Newest belief wins; ties broken by the later window start so a same-instant correction
// supersedes the row it corrects.
function knownAt(versions, { key = null, at } = {}) {
  const rows = (Array.isArray(versions) ? versions : [])
    .filter((r) => r && (key == null || r.constraintKey === key) && knownAtInstant(r, at))
    .sort((a, b) => ts(b.recordedAt) - ts(a.recordedAt));
  return { row: rows[0] || null, count: rows.length };
}

// ── SUPERSESSION ─────────────────────────────────────────────────────────────────────────────────────────────
// ⚠⚠ A SUPERSEDED ROW IS RETIRED, NOT MERELY OLDER, AND THE DIFFERENCE IS THE WHOLE POINT.
//
// The schema draws a distinction the resolver has to honour:
//   · `supersedesId`  — "the row I point at was WRONG". A correction. It never applied anywhere, at any instant.
//   · `effectiveTo`   — "this period ENDED". The row was true while it lasted and simply stops applying.
//
// Measured 2026-10-26: `resolveSubject` read every row and retired neither. The consequence is silent and specific.
// A bootstrapped row is UNDATED, so it is a `candidate`; append a correction that supersedes it and the correction
// is ALSO a candidate, because it too has no date yet. Two candidates, one of which is known-wrong. And a single
// candidate is enough to make every affected assessment UNASSESSABLE. So the correction would look like it worked —
// the new value is present, the overlap guard is quiet — while the ledger went on refusing to answer for ever, and
// that refusal reads as caution rather than as a bug.
//
// The set is computed from the FULL input, not from the subject-filtered rows: a row that says "I supersede X" is
// evidence about X regardless of which subject window is being read.
function supersededIds(versions) {
  const out = new Set();
  for (const r of Array.isArray(versions) ? versions : []) {
    if (!r) continue;
    const target = r.supersedesId;
    if (target == null || target === '') continue;
    out.add(String(target));
  }
  return out;
}

// A row is retired when another row names it AND it carries an id to be named by. A row with no id cannot be
// superseded (there is nothing to point at), so it is never retired by accident.
function isRetired(row, retired) {
  if (!row || row.constraintVersionId == null) return false;
  return retired.has(String(row.constraintVersionId));
}

// ── SUBJECT RESOLUTION ────────────────────────────────────────────────────────────────────────────────────────
// Everything that binds one subject at one instant. `venueInstrumentId: null` on a row means a VENUE-WIDE
// constraint, which applies to every instrument at that venue — the one-tab prohibition is exactly that shape.
function resolveSubject(versions, { venue = null, venueInstrumentId = null, at } = {}) {
  const retired = supersededIds(versions);
  const rows = (Array.isArray(versions) ? versions : []).filter((r) => {
    if (!r) return false;
    if (isRetired(r, retired)) return false;   // a correction retires what it corrects — see above
    if (venue != null && r.venue != null && String(r.venue) !== String(venue)) return false;
    if (venueInstrumentId != null) {
      // venue-wide (null) OR this specific instrument
      if (r.venueInstrumentId != null && String(r.venueInstrumentId) !== String(venueInstrumentId)) return false;
    }
    return true;
  });
  const inForceRows = [];
  const candidates = [];
  const uncertain = [];
  const lateDiscovery = [];
  for (const r of rows) {
    const st = stateAt(r, at);
    if (st === IN_FORCE) {
      inForceRows.push(r);
      // In force at `at` but LEARNED after it: the desk was operating under an older belief. This does not by itself
      // make the assessment unassessable — retained evidence may still pin the effective date — but it must be
      // reported, because it is the difference between "we broke a rule" and "the rule reached us late".
      if (!knownAtInstant(r, at)) lateDiscovery.push(r);
    } else if (st === CANDIDATE) {
      candidates.push(r);
    } else if (st === UNCERTAIN) {
      // ⚠ IT MIGHT HAVE APPLIED, AND WE CANNOT SAY. Reported separately from a candidate because the two mean
      // different things to a reader: a candidate has NO date, an uncertain row has a date RANGE and the instant
      // falls inside it.
      uncertain.push(r);
    }
  }
  inForceRows.sort(byStartDesc);
  return { inForce: inForceRows, candidates, uncertain, lateDiscovery };
}

// ── COMPARISON ───────────────────────────────────────────────────────────────────────────────────────────────
// ONE CONSTRAINT AGAINST ONE OBSERVED FACT. `direction` is the caller's statement of what the limit means, because
// the ledger stores a value and a unit and deliberately does not encode intent: `minimum_trade_size` is a floor and
// `initial_margin_pct` is a requirement, and the row cannot tell you which. Intent is behaviour, so it lives in code.
//
// ⚠ AN OBSERVED FACT THAT IS ABSENT IS NOT A PASS. `null` -> unassessable.
function assessOne({ constraint, observed, direction = null } = {}) {
  if (!constraint) return { verdict: UNASSESSABLE, reason: 'no_constraint' };
  if (constraint.verificationState === 'unrecoverable') {
    return { verdict: UNASSESSABLE, reason: 'evidence_unrecoverable' };
  }
  if (constraint.verificationState === 'disputed') {
    return { verdict: UNASSESSABLE, reason: 'evidence_disputed' };
  }
  const type = constraint.constraintType;

  if (type === 'prohibition') {
    // A prohibition is honoured when the thing did not happen. The caller states what happened.
    if (observed == null) return { verdict: UNASSESSABLE, reason: 'no_observation' };
    return observed === true
      ? { verdict: BREACHED, reason: 'prohibited_action_occurred' }
      : { verdict: SATISFIED, reason: 'prohibition_respected' };
  }

  if (type === 'enum') {
    if (observed == null) return { verdict: UNASSESSABLE, reason: 'no_observation' };
    return String(observed) === String(constraint.valueEnum)
      ? { verdict: SATISFIED, reason: 'matches' }
      : { verdict: BREACHED, reason: `observed ${observed} != declared ${constraint.valueEnum}` };
  }

  if (type === 'time_of_day') {
    if (observed == null) return { verdict: UNASSESSABLE, reason: 'no_observation' };
    const a = Number(observed);
    const b = Number(constraint.valueMinutesUtc);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { verdict: UNASSESSABLE, reason: 'not_numeric' };
    return a === b ? { verdict: SATISFIED, reason: 'matches' } : { verdict: BREACHED, reason: `observed ${a} != declared ${b}` };
  }

  if (type === 'numeric_limit') {
    const limit = Number(constraint.valueNumeric);
    const value = Number(observed);
    if (observed == null || !Number.isFinite(value) || !Number.isFinite(limit)) {
      return { verdict: UNASSESSABLE, reason: 'not_numeric' };
    }
    if (direction === 'min') {
      return value >= limit ? { verdict: SATISFIED, reason: `${value} >= ${limit}` } : { verdict: BREACHED, reason: `${value} < ${limit}` };
    }
    if (direction === 'max') {
      return value <= limit ? { verdict: SATISFIED, reason: `${value} <= ${limit}` } : { verdict: BREACHED, reason: `${value} > ${limit}` };
    }
    // ⚠ WITHOUT A DIRECTION THE COMPARISON IS UNDEFINED, and guessing one would turn an ambiguous constraint into a
    // verdict. This is the failure mode the `unassessable` state exists for.
    return { verdict: UNASSESSABLE, reason: 'direction_not_stated' };
  }

  return { verdict: UNASSESSABLE, reason: `unknown_type:${type}` };
}

// ── WHOLE-SUBJECT ASSESSMENT ─────────────────────────────────────────────────────────────────────────────────
// `observations` maps a constraintKey to the fact observed for this trade. Returns the worst outcome, in the order
// breached > unassessable > satisfied? NO — unassessable outranks satisfied, and a breach outranks everything
// because it is a finding. Precedence: breached, then unassessable, then satisfied.
//
// ⚠ A CANDIDATE ANYWHERE ON THE SUBJECT FORCES THE WHOLE ASSESSMENT TO UNASSESSABLE. That is C5 taken literally: an
// undatable constraint might have applied, so no clean pass is available. It is deliberately conservative, and the
// reason names the candidate so a reader can see which row blocked it rather than a bare "unassessable".
// `checks` names the keys THIS audit can actually evaluate. Anything else in force is reported as `informational`:
// recorded, visible, and excluded from the verdict.
//
// ⚠ WHY THIS EXISTS. Without it, every constraint lacking an observation forces `unassessable`, so recording a
// margin rate or a funding rate — neither of which a trade carries — would make EVERY trade permanently unassessable.
// That is not conservatism, it is a register nobody can read. The distinction is honest either way as long as it is
// STATED: `informational` means "in force, not judged here", and it is listed rather than dropped.
//
// ★★ `floors` — WHEN THE DESK COULD NOT YET OBSERVE THE CONSTRAINT (agent/assessability.js).
// A constraint can be IN FORCE and still be impossible to assess, because the desk could not honour or check it yet:
// `minimum_trade_size` before `size-contract-scale` (2026-10-02) is refused by the desk's own arithmetic error, and
// an audit dating it earlier measures that error, not the venue. `floors` maps a constraintKey to the instant from
// which it became measurable, and anything before that is `unassessable` with its OWN reason — never a pass, never a
// breach. ⚠ THE FLOOR IS NOT `effectiveFrom`: one is the world's history, the other is the desk's. A constraint in
// force since 2025 is still unassessable for a trade placed while the desk could not size correctly.
function assessSubject({ subject, observations = {}, directions = {}, checks = null, at, floors = {} } = {}) {
  const resolved = subject || { inForce: [], candidates: [], uncertain: [], lateDiscovery: [] };
  const evaluated = Array.isArray(checks) ? new Set(checks) : null;
  const results = [];
  const informational = [];
  const beforeFloorKeys = [];
  for (const constraint of resolved.inForce) {
    const key = constraint.constraintKey;
    if (evaluated && !evaluated.has(key)) {
      informational.push({ constraintKey: key, type: constraint.constraintType });
      continue;
    }
    // ⚠ CHECKED BEFORE THE COMPARISON, NOT AFTER. Running the comparison and then discarding it would still compute a
    // BREACHED that a careless caller could surface; the point is that no verdict about the venue is available.
    const floor = floors && Object.prototype.hasOwnProperty.call(floors, key) ? floors[key] : null;
    if (floor && at != null && new Date(at).getTime() < new Date(floor).getTime()) {
      beforeFloorKeys.push(key);
      results.push({ constraintKey: key, verdict: UNASSESSABLE, reason: 'before_assessability_floor', floor });
      continue;
    }
    const obs = Object.prototype.hasOwnProperty.call(observations, key) ? observations[key] : null;
    const r = assessOne({ constraint, observed: obs, direction: directions[key] || null });
    results.push({ constraintKey: key, ...r });
  }
  const breached = results.filter((r) => r.verdict === BREACHED);
  const unassessable = results.filter((r) => r.verdict === UNASSESSABLE);
  // Both buckets block a clean pass: a candidate has no date at all, an uncertain row has a range the instant falls
  // inside. Either could have applied, and neither can be asserted into "satisfied".
  //
  // ⚠⚠ 2026-10-27 — `checks` DOES **NOT** SCOPE THESE, AND I TRIED TO MAKE IT AND WAS WRONG.
  // The temptation was real: `constraintAudit` checks only `minimum_trade_size`, and `plus500.single_tab` — undated
  // on purpose, a venue-wide PROHIBITION no trade audit can evaluate — made all 411 closed trades `unassessable`.
  // Filtering out-of-scope blockers would have turned that into a clean `satisfied`.
  //
  // `test/constraints.test.js:177` pins the opposite, and it is right: the verdict returned here is PER SUBJECT, so
  // `satisfied` reads as "this trade honoured the constraints that applied" — a claim about the margin too. An
  // audit that cannot judge one constraint cannot report the trade as clean by narrowing what it looked at. That is
  // the same defect as an absent measurement reading as a clean result, one level up.
  //
  // So the honest answer when a blocker exists is `unassessable` NAMING IT, which is exactly what the consumer now
  // reports. Making that go away is a job for the LEDGER (date the row), not for the verdict.
  const blockingCandidates = (resolved.candidates || []).map((c) => c.constraintKey);
  const uncertainKeys = (resolved.uncertain || []).map((c) => c.constraintKey);

  let verdict = SATISFIED;
  if (breached.length) verdict = BREACHED;
  else if (unassessable.length || blockingCandidates.length || uncertainKeys.length) verdict = UNASSESSABLE;

  return {
    verdict,
    results,
    informational,
    blockingCandidates,
    uncertain: uncertainKeys,
    lateDiscovery: resolved.lateDiscovery.map((r) => r.constraintKey),
    // ⚠ LISTED, NOT FOLDED INTO `unassessable`. "Too early to judge" and "we could not read the fact" send a reader
    // to different fixes — the first to the row's floor, the second to the observation — and a bare unassessable
    // count cannot tell them apart.
    beforeFloor: beforeFloorKeys,
    // ⚠ A SUBJECT WITH NOTHING IN FORCE IS `unassessable`, NOT `satisfied`. "We hold no constraints for this
    // instrument" is missing coverage, and E7 makes missing coverage the primary failure this register guards against.
    // ⚠ AND THE TWO REASONS MUST STAY DISTINCT: `no_applicable_constraints` means the ledger holds nothing for this
    // subject, while `nothing_evaluated` means it holds something the caller did not ask to check. The first is a
    // coverage gap in the DATA; the second is a gap in the AUDIT. Collapsing them sends a reader to the wrong fix —
    // the first version of this line reported the data gap whenever `results` was empty, including when informational
    // rows existed, and a test caught it.
    ...((results.length === 0 && blockingCandidates.length === 0)
      ? {
        verdict: UNASSESSABLE,
        reason: informational.length === 0 ? 'no_applicable_constraints' : 'nothing_evaluated',
      }
      : {}),
    at: at ? new Date(ts(at)).toISOString() : null,
  };
}

// ── SCOPED ASSESSMENT — a NARROWER CLAIM, WITH ITS OWN NAME ──────────────────────────────────────────────────
// ★★ WHY A SECOND FUNCTION RATHER THAN A FLAG ON `assessSubject`. The whole-subject verdict answers "did this
// subject honour what applied?" — so `satisfied` there is a claim about EVERY applicable constraint, and an unknown
// one must block it. That contract is pinned by `test/constraints.test.js:177` and is not negotiable.
//
// A trade audit cannot make that claim: it has an observation for `minimum_trade_size` and nothing to say about a
// venue-wide prohibition, which is violated by an ACTION (a second tab) that no trade row records. Asked the
// subject question it must answer `unassessable` for ever — correctly, and uselessly.
//
// So this answers a smaller question and SAYS SO:
//   · a verdict for each REQUESTED key it can actually judge,
//   · every other applicable key in `notJudged` with its reasons,
//   · and a requested key that is itself undated or uncertain comes back `unassessable` — NEVER `notJudged`.
//     That last rule is the one that keeps this honest: moving an unjudgeable REQUESTED key into `notJudged` would
//     let a scoped check look clean by quietly reclassifying the thing it was asked about.
//
// ⚠ `scope` is the caller's name for what it judged ("minimum trade size"), because a verdict without a stated
// scope is the defect this function exists to avoid. It is echoed, never invented here.
// ⚠ THE COMPARISON IS DELEGATED TO `assessOne` — only the bucketing is new, so the two functions cannot disagree
// about arithmetic (asserted by test/assess-scoped.test.js).
function assessScoped({ subject, checks, observations = {}, directions = {}, at, floors = {}, scope = null } = {}) {
  const resolved = subject || { inForce: [], candidates: [], uncertain: [], lateDiscovery: [] };
  const requested = Array.isArray(checks) ? checks.filter((k) => typeof k === 'string' && k) : [];
  if (!requested.length) {
    return { ok: false, reason: 'nothing_requested', scope, verdict: UNASSESSABLE, results: [], notJudged: [] };
  }

  const inForceByKey = new Map();
  for (const r of resolved.inForce || []) if (!inForceByKey.has(r.constraintKey)) inForceByKey.set(r.constraintKey, r);
  const candKeys = new Set((resolved.candidates || []).map((r) => r.constraintKey));
  const uncKeys = new Set((resolved.uncertain || []).map((r) => r.constraintKey));

  const results = [];
  for (const key of requested) {
    const constraint = inForceByKey.get(key);
    if (!constraint) {
      // A REQUESTED key with no version in force is a failure of the check, never a silent pass. The three reasons
      // are kept apart because they send a reader to different places: the row is undated, the window is open, or
      // the ledger simply holds nothing for this subject.
      const reason = candKeys.has(key) ? 'effective_date_unknown'
        : uncKeys.has(key) ? 'effective_date_uncertain'
          : 'no_version_in_force';
      results.push({ constraintKey: key, verdict: UNASSESSABLE, reason });
      continue;
    }
    const floor = floors && Object.prototype.hasOwnProperty.call(floors, key) ? floors[key] : null;
    if (floor && at != null && new Date(at).getTime() < new Date(floor).getTime()) {
      results.push({ constraintKey: key, verdict: UNASSESSABLE, reason: 'before_assessability_floor', floor });
      continue;
    }
    const obs = Object.prototype.hasOwnProperty.call(observations, key) ? observations[key] : null;
    results.push({ constraintKey: key, ...assessOne({ constraint, observed: obs, direction: directions[key] || null }) });
  }

  // Everything that applies but was not asked about. Listed, never dropped — and never allowed to change the verdict,
  // because the verdict is explicitly about the requested keys only.
  const requestedSet = new Set(requested);
  const applicable = new Map();
  for (const r of [...(resolved.inForce || []), ...(resolved.candidates || []), ...(resolved.uncertain || [])]) {
    if (r && r.constraintKey && !applicable.has(r.constraintKey)) applicable.set(r.constraintKey, r);
  }
  const notJudged = [];
  for (const [key, row] of applicable) {
    if (requestedSet.has(key)) continue;
    const reasons = ['not_requested'];
    if (candKeys.has(key)) reasons.push('effective_date_unknown');
    else if (uncKeys.has(key)) reasons.push('effective_date_uncertain');
    if (row.constraintType === 'prohibition') reasons.push('prohibition_needs_an_event_observation');
    notJudged.push({ constraintKey: key, type: row.constraintType || null, reasons });
  }

  const breached = results.filter((r) => r.verdict === BREACHED).length;
  const unassessable = results.filter((r) => r.verdict === UNASSESSABLE).length;
  // Precedence unchanged from the whole-subject form: a breach is a finding and outranks everything.
  const verdict = breached ? BREACHED : (unassessable ? UNASSESSABLE : SATISFIED);
  return { ok: true, scope, verdict, results, notJudged, at: at ? new Date(ts(at)).toISOString() : null };
}

// ── OVERLAP — the write-path guard, expressed as a PURE PREDICATE so it can be tested without a database ─────
// Two versions of ONE key may not describe the same instant. A period with two answers is a mistake, not a fact,
// and the resolver is deliberately given no tie-break, so the refusal has to happen where the mistake is made.
//
// ⚠ A ROW WITH AN UNKNOWN START CANNOT OVERLAP ANYTHING. It is a candidate rather than a period (C5), so two
// undatable captures of the same fact are allowed to coexist — which is exactly what happens when the venue page is
// captured twice before anyone can establish when the term took effect.
function overlaps(a, b) {
  const startOf = (r) => (valid(r && r.effectiveFrom) ? ts(r.effectiveFrom)
    : valid(r && r.effectiveFromNotBefore) ? ts(r.effectiveFromNotBefore) : null);
  const aFrom = startOf(a);
  const bFrom = startOf(b);
  // ⚠ UNKNOWN STARTS STILL CANNOT OVERLAP (C5): an undatable row is a candidate, not a period.
  // A BOUNDED start, however, is treated as its EARLIEST POSSIBLE instant — which makes a collision more likely rather
  // than less. The guard errs toward refusing; admitting uncertainty must never make it more permissive.
  if (aFrom == null || bFrom == null) return false;
  const aTo = valid(a.effectiveTo) ? ts(a.effectiveTo) : Infinity;
  const bTo = valid(b.effectiveTo) ? ts(b.effectiveTo) : Infinity;
  return aFrom < bTo && bFrom < aTo;
}

// The first existing version the candidate would collide with, or null. Same key only — different keys may overlap
// freely, because they are different facts.
function findOverlap(candidate, existing) {
  const key = candidate && candidate.constraintKey;
  if (!key) return null;
  for (const row of Array.isArray(existing) ? existing : []) {
    if (!row || row.constraintKey !== key) continue;
    if (overlaps(candidate, row)) return row;
  }
  return null;
}

// ── WRITE-TIME VALIDATION (pure) ────────────────────────────────────────────────────────────────────────────
// Mirrors the `CK_ConstraintVersions_payload` CHECK so a bad patch fails with a readable message BEFORE it reaches
// SQL, and adds the rules a CHECK cannot express.
const TYPES = ['numeric_limit', 'enum', 'prohibition', 'time_of_day'];
const SUBJECTS = ['instrument', 'venue', 'account'];
const STATES = ['asserted', 'observed', 'confirmed', 'disputed', 'expired', 'unrecoverable'];
const KEY_RE = /^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9_]*)+$/;

function validateVersion(patch = {}) {
  const errors = [];
  const p = patch || {};

  if (!p.constraintKey || !KEY_RE.test(String(p.constraintKey))) {
    errors.push('constraintKey must be a dotted lowercase key such as `venue.minimum_trade_size`');
  }
  if (!SUBJECTS.includes(p.subjectKind)) errors.push(`subjectKind must be one of ${SUBJECTS.join(', ')}`);
  if (!TYPES.includes(p.constraintType)) errors.push(`constraintType must be one of ${TYPES.join(', ')}`);
  if (!STATES.includes(p.verificationState)) errors.push(`verificationState must be one of ${STATES.join(', ')}`);
  if (!p.recordedBy) errors.push('recordedBy is required: a row with no recorder cannot be attributed');

  // The payload pairing — the same rule the CHECK enforces, stated earlier so the message is usable.
  const hasNum = p.valueNumeric != null;
  const hasUnit = p.valueUnit != null;
  const hasEnum = p.valueEnum != null;
  const hasMin = p.valueMinutesUtc != null;
  const type = p.constraintType;
  if (type === 'numeric_limit' && !(hasNum && hasUnit)) errors.push('numeric_limit requires valueNumeric AND valueUnit');
  if (type === 'enum' && !hasEnum) errors.push('enum requires valueEnum');
  if (type === 'prohibition' && (hasNum || hasUnit || hasEnum || hasMin)) errors.push('prohibition carries no payload');
  if (type === 'time_of_day' && !(hasMin && Number.isInteger(p.valueMinutesUtc) && p.valueMinutesUtc >= 0 && p.valueMinutesUtc <= 1439)) {
    errors.push('time_of_day requires valueMinutesUtc as an integer 0..1439');
  }
  if (type === 'numeric_limit' && hasEnum) errors.push('numeric_limit must not carry valueEnum');
  if (type === 'enum' && (hasNum || hasUnit || hasMin)) errors.push('enum must carry valueEnum only');
  if (type === 'time_of_day' && (hasNum || hasUnit || hasEnum)) errors.push('time_of_day must carry valueMinutesUtc only');

  if (valid(p.effectiveFrom) && valid(p.effectiveTo) && ts(p.effectiveTo) <= ts(p.effectiveFrom)) {
    errors.push('effectiveTo must be after effectiveFrom (the window is half-open)');
  }

  // ── BOUNDED START (migration 053) ───────────────────────────────────────────────────────────────────────────
  const hasExact = p.effectiveFrom != null;
  const hasBefore = p.effectiveFromNotBefore != null;
  const hasAfter = p.effectiveFromNotAfter != null;
  // ⚠ EXACT AND BOUNDED ARE MUTUALLY EXCLUSIVE. Both is not more information, it is two answers to one question, and a
  // reader would have to know which wins — so the row is refused rather than resolved.
  if (hasExact && (hasBefore || hasAfter)) {
    errors.push('effectiveFrom is exact; effectiveFromNotBefore/NotAfter must be absent (two answers to one question)');
  }
  if (hasBefore && !valid(p.effectiveFromNotBefore)) errors.push('effectiveFromNotBefore is not a usable date');
  if (hasAfter && !valid(p.effectiveFromNotAfter)) errors.push('effectiveFromNotAfter is not a usable date');
  if (valid(p.effectiveFromNotBefore) && valid(p.effectiveFromNotAfter)
      && ts(p.effectiveFromNotAfter) < ts(p.effectiveFromNotBefore)) {
    errors.push('effectiveFromNotAfter must not precede effectiveFromNotBefore');
  }
  // A bounded row whose interval starts after the version already ended describes nothing.
  if (valid(p.effectiveFromNotBefore) && valid(p.effectiveTo) && ts(p.effectiveFromNotBefore) >= ts(p.effectiveTo)) {
    errors.push('the bounded start lies at or after effectiveTo — the version would never apply');
  }

  // ★ A `confirmed` ROW MUST NAME ITS ARTEFACT. D2/D5: the digest is an integrity check, not evidence, and a
  // confirmed constraint without a retained artefact cannot support a satisfied verdict — so it must not be able to
  // EXIST as `confirmed` in the first place. `observed` and `asserted` are allowed to lack one; they are not yet
  // claims anyone is relying on.
  if (p.verificationState === 'confirmed' && !p.evidenceArtifactRef) {
    errors.push('verificationState `confirmed` requires evidenceArtifactRef — a confirmed constraint with no retained artefact cannot support a verdict');
  }
  if (p.evidenceArtifactRef && !p.evidenceDigest) {
    errors.push('evidenceArtifactRef requires evidenceDigest, so the artefact can be shown to be the one that was read');
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  SATISFIED, BREACHED, UNASSESSABLE, IN_FORCE, CANDIDATE, UNCERTAIN, NOT_IN_FORCE,
  TYPES, SUBJECTS, STATES, KEY_RE,
  stateAt, knownAtInstant, inForce, knownAt, resolveSubject, assessOne, assessSubject, assessScoped,
  supersededIds, isRetired,
  overlaps, findOverlap, validateVersion,
};
