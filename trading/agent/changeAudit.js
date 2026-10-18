// trading/agent/changeAudit.js — ★★ THE GUARD `epoch.js` CLAIMS TO HAVE AND DOES NOT.
//
// WHY THIS EXISTS. `epoch.js`'s own header states: "`assertRegistryCoverage` (see `test/epoch-registry.test.js`)
// fails when a task row that CLOSED carries a landing date newer than the newest entry." **That function does not
// exist, and the test it names cannot fail on a missing boundary because it never looks for one.** It is a comment.
//
// The cost was measured on 2026-10-02: the registry had not been touched since 2026-09-27 while SIX behaviour
// changes landed after it — including `size-contract-scale`, which changed the definition of the risk unit itself.
// A study scoped by that file pooled four sizing rules and reported one number. **A documented safeguard that was
// never built is worse than an absent one: it is the reason nobody looked.**
//
// ── WHAT THE GUARD CAN AND CANNOT USE ────────────────────────────────────────────────────────────────────────
// ⚠⚠ NOT `Tasks.completedAt`. Measured: **218 trading task rows share 2026-09-30** because the whole historical
// backlog was bulk-closed in one batch. `completedAt` is a BOARD ACTION, not a landing date — `epoch.js` says the
// same thing in prose ("the date the behaviour changed, not the date the row was filed"), and a check built on it
// would fire 218 times and be switched off within a day. It is accepted as EVIDENCE, reported as advisory.
//
// So the guard reasons from two things that ARE datable:
//   · `settings_write` rows that touch a POLICY key — a definite behaviour change, precisely timestamped;
//   · `trading/**` file mtimes — a proxy, and the ONLY signal that catches a code-only boundary like EXE-19
//     (which shipped with no task row and no settings write).
// Neither is sufficient alone; together they cannot be crossed silently.
//
// ⚠ SEVERITY IS THE DESIGN. A `settings_write` on a policy key after the newest entry is a BOUNDARY the registry
// does not know about ⇒ the registry is stale ⇒ not ok. Code changes are ADVISORY, because a comment or a test
// edits `trading/**` without changing behaviour, and a guard that cries on those is a guard nobody keeps.
'use strict';

// Keys that move by themselves and are not policy. Excluding them is not tidiness: `kill.initialEquity` is
// rewritten several times an hour by the disaster-floor rebase, so including it would make the check permanently
// red and therefore ignored — the same failure as a floor that no observation can ever satisfy.
const BOOKKEEPING_KEYS = new Set(['kill.initialEquity']);

// A policy key is one a reader of a STUDY would have to know about.
const DEFAULT_POLICY = /^(risk|strategies|deliberation|watch|paper|pulse|kill)\./;

const day = (d) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);

// The PURE core. The caller gathers evidence; this decides what is unaccounted for. Pure so it can be driven in
// both directions offline — an allow case AND a violation case — rather than proved by reading the source.
//
//   newestLandedAt  the newest `landedAt` in the registry (the boundary beyond which nothing is registered)
//   settingsWrites  [{ id, at, keys: [...] }]
//   codeChanges     [{ file, at }]
//   closedTasks     [{ id, name, at }]   advisory only — see the header on bulk closures
//   freeze          { at, note } | null  a declared POLICY FREEZE: after `at`, ANY change is a finding
function unaccounted({
  newestLandedAt,
  settingsWrites = [],
  codeChanges = [],
  closedTasks = [],
  policy = DEFAULT_POLICY,
  bookkeeping = BOOKKEEPING_KEYS,
  freeze = null,
  now = Date.now(),
} = {}) {
  const boundary = freeze ? freeze.at : newestLandedAt;
  if (!boundary) return { ok: false, pending: false, findings: [], why: 'no boundary to audit against — refusing to report a clean bill of health' };
  // ⚠⚠ A FREEZE THAT HAS NOT STARTED IS NOT A PASS, AND THE FIRST RUN OF THIS GUARD PROVED IT. With a window
  // opening at 2026-10-02T03:00:00Z and the clock at 02:54Z the audit found nothing, printed "nothing unaccounted
  // for", and exited 0 — which is TRUE and reads as "everything is accounted for". It is the same defect as a
  // scope that never changes its answer: a green tick over an empty window. The window is now a THIRD state, and
  // `pending` exists so a caller cannot render it as a pass.
  if (freeze && new Date(freeze.at).getTime() > now) {
    const mins = Math.ceil((new Date(freeze.at).getTime() - now) / 60000);
    return {
      ok: true, pending: true, boundary: freeze.at, findings: [], blocking: 0,
      why: `the freeze window has NOT STARTED — it opens ${freeze.at} (${mins} min away), so nothing has been audited yet`,
    };
  }
  const after = (at) => new Date(at).getTime() > new Date(boundary).getTime();
  const findings = [];

  // 1. POLICY SETTINGS WRITES — a definite, dated behaviour change the registry does not cover.
  for (const w of settingsWrites) {
    if (!after(w.at)) continue;
    const keys = (w.keys || []).filter((k) => policy.test(k) && !bookkeeping.has(k));
    if (!keys.length) continue;
    findings.push({
      severity: freeze ? 'freeze_breach' : 'unregistered_boundary',
      at: new Date(w.at).toISOString(),
      what: `settings_write #${w.id} changed ${keys.join(', ')}`,
      // The repair is the same in both modes, so it is stated once, here, rather than left to the reader.
      fix: freeze ? 'the freeze is broken: either register the change and restart the window, or revert it' : 'register this as a boundary in epoch.js FEATURES',
    });
  }

  // 2. CODE CHANGES under trading/** — advisory, and the ONLY signal that catches a code-only boundary.
  const files = [...new Set(codeChanges.filter((c) => after(c.at)).map((c) => c.file))];
  if (files.length) {
    findings.push({
      severity: freeze ? 'freeze_breach' : 'advisory',
      at: new Date(Math.max(...codeChanges.filter((c) => after(c.at)).map((c) => new Date(c.at).getTime()))).toISOString(),
      what: `${files.length} file(s) under trading/ changed after ${boundary}`,
      files: files.slice(0, 8),
      fix: 'if any of these changed BEHAVIOUR, register a boundary — a code-only change ships with no task row and no settings write (EXE-19, 2026-10-02)',
    });
  }

  // 3. CLOSED TASKS — advisory ONLY, and the report says why rather than presenting them as boundaries.
  const tasks = closedTasks.filter((t) => after(t.at));
  if (tasks.length) {
    const days = [...new Set(tasks.map((t) => day(t.at)))].sort();
    findings.push({
      severity: 'advisory',
      at: new Date(tasks[0].at).toISOString(),
      what: `${tasks.length} trading task row(s) closed after ${boundary}, on ${days.length} date(s)`,
      // ⚠ THE CAVEAT TRAVELS WITH THE NUMBER. 218 rows sharing one date is a bulk closure, not a boundary, and a
      // reader who does not know that will read "218 changes" out of a board tidy-up.
      note: days.length === 1 && tasks.length > 10
        ? `${new Date(tasks[0].at).toISOString().slice(0, 10)} closed ${tasks.length} rows at once — a BULK BOARD CLOSURE, not ${tasks.length} behaviour changes`
        : 'completedAt is a BOARD action, not a landing date',
      fix: 'do not read this as a boundary count — see the note',
    });
  }

  const blocking = findings.filter((f) => f.severity === 'unregistered_boundary' || f.severity === 'freeze_breach');
  return { ok: blocking.length === 0, pending: false, boundary, findings, blocking: blocking.length };
}

// The one-line form, so a caller that renders only a summary still states the window it judged.
function summaryLine(r) {
  if (!r || !r.findings) return 'change audit: no result';
  // ⚠⚠ A REFUSAL MUST NOT RENDER AS "0 findings", AND THE FIRST VERSION OF THIS FUNCTION DID EXACTLY THAT. The
  // refusal carries `findings: []`; an empty ARRAY is TRUTHY, so the guard above fell straight through and printed
  // "0 finding(s) after undefined" — a refusal that reads as a clean report. That is the defect this module exists
  // to stop, reproduced in the one line a caller renders. `boundary` is the discriminator: a real audit always has one.
  if (!r.boundary) return `change audit: REFUSED — ${r.why || 'no boundary to audit against'}`;
  // ⚠ PENDING IS STATED BEFORE OK, because "nothing unaccounted for" over an unopened window is the vacuous pass.
  if (r.pending) return `change audit: window NOT STARTED (opens ${r.boundary}) — nothing audited yet`;
  if (r.ok && !r.findings.length) return `change audit: nothing unaccounted for after ${r.boundary}`;
  const blocking = r.blocking ? ` ⚠ ${r.blocking} BLOCKING` : '';
  return `change audit: ${r.findings.length} finding(s) after ${r.boundary}${blocking}`;
}

module.exports = { unaccounted, summaryLine, BOOKKEEPING_KEYS, DEFAULT_POLICY };
