'use strict';
// trading/store/ownership.js — WHO OWNS EACH SETTINGS KEY, AND WHEN A WRITE CROSSES THAT LINE.
//
// ★ WHY THIS EXISTS. `AGENTS.md` §2 states the rule — operator-owned (`risk.*`, `watchlist.symbols`,
// `deliberation.*`) are never written by the machine; machine-owned (`bridge.*` runtime, `kill.initialEquity`,
// `watchlist.universe`, `watchlist.candidates`) are never edited by hand — and ADR-0001 records the reasoning.
// Until now the rule existed only as prose, so it could not be checked. Measured 2026-10-27 over the settings
// journal: `bridge.consecutiveFails` was written **22 times in 4 days** against 2 actual changes of the pause, and
// `watchlist.universe` shrank from 4,172 to 3,678 characters across 3 writes. None of that was visible as a
// CATEGORY of event; it was only recoverable by reading 27 individual diffs.
//
// ⚠ WHAT THIS MODULE DOES NOT DO: it does not refuse writes. A refusal on the write path would fail a live save
// over a classification question — the same trade `reportDeadScopeWrite` already declined (see store.js): the
// state is reportable and adjustable, and a hard failure here would take the desk down to protect a convention.
// `violations()` is what a caller REPORTS; making it throw is a separate, later decision that needs the owner.
//
// ⚠ AND THE RATCHET IS HONEST ABOUT WHAT IT FINDS: `trading/agent/discoverer.js` writes `watchlist.symbols`, which
// is OPERATOR-owned, from an automated loop. That is a real violation and it is listed as a known entry rather than
// silently allowlisted — the same shape as `INVARIANT_A_KNOWN` in test/architecture-conformance.test.js.
//
// PURE: no DB, no clock, no logging.

const OPERATOR = 'operator';
const MACHINE = 'machine';
const SHARED = 'shared';

// Longest-prefix wins, so `watchlist.symbols` (operator) and `watchlist.universe` (machine) can sit under the same
// parent without either swallowing the other. Order is irrelevant; the matcher sorts by specificity.
const RULES = [
  { path: 'risk', owner: OPERATOR },
  { path: 'deliberation', owner: OPERATOR },
  // ★ ADDED 2026-10-27, CLOSING A GAP THE ADR HAD RECORDED RATHER THAN FIXED. ADR-0001 classifies `budget.*` as
  // operator-owned and `discovery.*` as machine-owned, and `RULES` contained neither — so a machine write to either
  // was classified `shared` and raised nothing. The registry was NARROWER than the decision it exists to enforce,
  // which is the quiet direction to be wrong in: every crossing still looked accounted for.
  // ⚠ Adding them here FORCED `AGENTS.md` §2 to name them too, because `test/ownership-doc-sync.test.js` checks
  // both directions. That coupling is the reason the gap was recorded instead of silently patched.
  { path: 'budget', owner: OPERATOR },
  { path: 'discovery', owner: MACHINE },
  // ★ CO-OWNED, and the first version of this file got it wrong by declaring the whole key OPERATOR.
  //
  // `watchlist.symbols` is ONE array carrying TWO kinds of entry, discriminated by `source`: the operator's manual
  // picks (`source: 'manual'`, or absent) and the discoverer's autonomous picks (`source: 'ai'`).
  // `agent/discoverer.js` rewrites the array on every discovery run but preserves every manual entry verbatim
  // (`manual = symbols.filter(s => (s.source || 'manual') !== 'ai')`). So the machine is not trespassing on the
  // operator's key — it is editing ITS OWN ENTRIES inside a shared container, which a path-level classifier cannot
  // express. Declaring the key OPERATOR-owned would have flagged a legitimate, behaviour-preserving write every
  // cycle: a violation count that cries wolf is worse than no count, because a reader learns to skip it.
  //
  // The ownership therefore moves to the ENTRY, and `symbolsViolation` enforces it below.
  { path: 'watchlist.symbols', owner: SHARED, coOwned: 'ai_entries_only' },
  { path: 'bridge', owner: MACHINE },
  { path: 'kill.initialEquity', owner: MACHINE },
  { path: 'watchlist.universe', owner: MACHINE },
  { path: 'watchlist.candidates', owner: MACHINE },
];

const matches = (path, prefix) => path === prefix || path.startsWith(`${prefix}.`);

// The owner of a dotted settings path. Anything unmatched is SHARED — deliberately the permissive default, because
// a wrong OPERATOR label would flag legitimate machine writes and a wrong MACHINE label would flag the operator.
function ownerOf(path) {
  const p = String(path || '');
  if (!p) return SHARED;
  let best = null;
  for (const r of RULES) {
    if (matches(p, r.path) && (!best || r.path.length > best.path.length)) best = r;
  }
  return best ? best.owner : SHARED;
}

// Every LEAF path in a settings patch. An object that carries no scalar leaves contributes nothing on its own.
function leaves(obj, prefix = '', out = []) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    if (prefix) out.push(prefix);
    return out;
  }
  const keys = Object.keys(obj);
  // An EMPTY object writes nothing: `deepMerge` over `{}` is a no-op, so counting it would report a write that did
  // not happen — and a reported non-write is how a violation count becomes noise a reader learns to ignore.
  if (!keys.length) return out;
  for (const k of keys) leaves(obj[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}

// Which namespaces a patch touches. Arrays and scalars terminate a path; an empty object is dropped because it
// changes nothing.
function classifyPatch(patch) {
  const out = { [OPERATOR]: [], [MACHINE]: [], [SHARED]: [] };
  for (const p of leaves(patch && typeof patch === 'object' ? patch : {})) {
    // `risk.bySymbol` arrives as an object of objects; its leaves are the real paths and they inherit `risk`.
    out[ownerOf(p)].push(p);
  }
  return out;
}

// Writes that cross an ownership line. `by` is the WRITER's namespace; a SHARED path is never a violation, and an
// unknown writer is not judged — an unknown actor is an absence of evidence, not a finding.
const violations = (patch, { by = null } = {}) => {
  const writer = by === OPERATOR || by === MACHINE ? by : null;
  if (!writer) return [];
  const scopes = classifyPatch(patch);
  const opposing = writer === MACHINE ? OPERATOR : MACHINE;
  return scopes[opposing].map((path) => ({ path, owner: opposing, writer }));
};

// One line per write, for the journal payload. Absent when nothing owns anything in the patch.
function describe(patch) {
  const c = classifyPatch(patch);
  const parts = [];
  if (c[OPERATOR].length) parts.push(`${c[OPERATOR].length} operator`);
  if (c[MACHINE].length) parts.push(`${c[MACHINE].length} machine`);
  if (c[SHARED].length) parts.push(`${c[SHARED].length} shared`);
  return parts.length ? parts.join(' / ') : null;
}

// ── ENTRY-LEVEL OWNERSHIP INSIDE `watchlist.symbols` ────────────────────────────────────────────────────────
// A machine write may add, change or drop `source: 'ai'` entries. It may NOT remove or mutate a manual entry, which
// is the operator's.
//
// ⚠ ORDER IS NOT OWNERSHIP. `discoverer` rebuilds the array as `[...manual, ...ai]`, so every run reorders it; a
// guard that compared array indices would fire on every cycle without a single entry being lost. Comparison is by
// symbol NAME, and only presence and content count.
const isAi = (s) => String((s && s.source) || 'manual') === 'ai';
const nameOf = (s) => String((s && s.symbol) || '').toLowerCase();

function symbolsViolation(before, after) {
  const list = (v) => (Array.isArray(v) ? v.filter((s) => s && s.symbol) : []);
  const prev = list(before);
  const next = list(after);
  // No prior value means this is the first write — nothing can have been removed.
  if (!prev.length) return [];
  const afterByName = new Map(next.map((s) => [nameOf(s), s]));
  const out = [];
  for (const entry of prev) {
    if (isAi(entry)) continue;                       // the machine's own entries are its to change
    const now = afterByName.get(nameOf(entry));
    if (!now) {
      out.push({ path: 'watchlist.symbols', symbol: entry.symbol, reason: 'manual_entry_removed' });
    } else if (JSON.stringify(now) !== JSON.stringify(entry)) {
      out.push({ path: 'watchlist.symbols', symbol: entry.symbol, reason: 'manual_entry_modified' });
    }
  }
  return out;
}

// Everything a machine write did wrong, in one call: the path-level rule above plus the entry-level rule for the
// co-owned array. `before`/`after` are the settings objects; only `watchlist.symbols` is inspected for now, because
// it is the only co-owned key.
function machineWriteViolations({ before = null, patch = null, by = null } = {}) {
  if (by !== MACHINE) return [];
  const out = violations(patch, { by });
  const patched = patch && patch.watchlist ? patch.watchlist.symbols : undefined;
  // Only an ACTUAL array in the patch can have removed a manual entry; a write that omits the key left it alone.
  if (Array.isArray(patched)) {
    out.push(...symbolsViolation(((before || {}).watchlist || {}).symbols, patched));
  }
  return out;
}

module.exports = {
  OPERATOR, MACHINE, SHARED, RULES,
  ownerOf, leaves, classifyPatch, violations, describe,
  isAi, symbolsViolation, machineWriteViolations,
};
