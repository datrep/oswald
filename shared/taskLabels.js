// shared/taskLabels.js — the task LABEL contract, in one place.
//
// WHY THIS IS A MODULE AND NOT A REGEX COPY. A task label (`TRD-118`, `TRD-SHW-4`, `TRD-LRN-1`) is the ONLY
// citation handle this repo uses — docs, pre-registrations, code comments and task bodies all cite `TRD-n`.
// `Tasks.name` carries no uniqueness constraint (only `id` does), so when two rows share a label the citation
// becomes unresolvable at exactly the moment someone tries to act on it. That has happened four times
// (TRD-36, TRD-EVD-1, TRD-118, TRD-119), so the rule has to be enforced in more than one place:
//
//   · `models/taskModel.createTask` WARNS on a repeat, naming the existing row  (prevention, at the write)
//   · `scripts/task-label-hygiene.js` REPORTS repeats across the whole register (detection, on demand)
//
// Two copies of a label regex in those two places would drift, and a drifted label regex is precisely the
// failure it exists to prevent — the same reasoning as `shadowScore.barOpen`'s "the contract has exactly one
// home". So the parse lives here and both callers import it.
//
// ★ WHAT A REPEAT IS *NOT*. A repeated prefix is not automatically a defect: `TRD-12` appears 11 times
// (ids 200-210, Learning / Analytics / Risk / Backtest / Orders / Data / Connector / Budget / Strategy / Nav)
// and that is the house convention for a numbered SET split by domain — the convention says a function name of
// 4+ letters belongs in the DOMAIN rather than as its own segment. So **a unique index would fail the existing
// register**, and no constraint can express intent. `repeats()` therefore REPORTS; the decision to allow a
// repeat belongs to an explicit, documented allowlist (`scripts/task-label-hygiene.js`), never to this module.
'use strict';

// A label is `<POLICY>-<n>` or `<POLICY>-<FUNCTION>-<n>`, immediately followed by the `:` separator — the
// convention documented in the task-naming rules: `(policy short name)-(function name, <=3 chars*)-(numbered
// set*): <domain> — <description>`.
//
// ★ IT IS DELIBERATELY NOT `TRD-`-ONLY, AND THAT WAS A REAL GAP. The first version of this module (and of
// scripts/task-label-hygiene.js) matched `TRD-` alone, because that is the family the four collisions happened
// in. But the register carries OTHER live families — `LST-1..LST-8` in edict 51 (Listing Workbench), plus
// `MOD-`, `FS-`, `SYNC-`, `NAV-`, `UAC-`, `SCH-`, `CLN-` — so an `LST-118`-style collision would have been
// invisible to a guard that only looked at `TRD-`. Found 2026-09-24 while building the fixture for this
// module's own test: the query was `LIKE 'TRD-%'` and the fixture emitter printed the LST rows right beside it.
//
// Anchored at the start, and the `\s*:` is load-bearing: it is what stops a PROSE mention of `TRD-36` inside a
// task name from being read as that row's label.
const LABEL_RE = /^([A-Z]{2,5}(?:-[A-Z]{1,4})?-\d+)\s*:/;

// The label of a task name, or null when the name carries none.
function labelOf(name) {
  const m = LABEL_RE.exec(String(name == null ? '' : name));
  return m ? m[1] : null;
}

// Group rows (anything with `name`, optionally `id`) by label, keeping only labels used more than once.
// Insertion order of the input is preserved within each group, so a caller can say "the newcomer yields"
// (the TRD-EVD-1 -> TRD-EVD-2 precedent: the row that arrived second is the one renamed).
function repeats(rows) {
  const byLabel = new Map();
  for (const row of rows || []) {
    const label = labelOf(row && row.name);
    if (!label) continue;
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(row);
  }
  return [...byLabel.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([label, group]) => ({ label, rows: group }));
}

module.exports = { labelOf, repeats, LABEL_RE };
