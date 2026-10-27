'use strict';
// trading/agent/assessability.js — ★★ WHEN COULD THE DESK OBSERVE A CONSTRAINT AT ALL?
//
// A constraint can be IN FORCE and still be impossible to assess, because the desk could not yet honour or check
// it. `size-contract-scale` (2026-10-02) is the clean case: before it, size derivation omitted the contract scale,
// so a cents-quoted instrument was sized ~77x too small, the venue minimum refused every entry, and the desk
// reported its own arithmetic error as a VENUE FACT — "the minimum is ~487% of equity". An audit of
// `minimum_trade_size` dated before that instant is not measuring the venue. It is measuring a bug.
//
// ⚠⚠ TWO DATES, AND CONFLATING THEM IS THE DEFECT THIS FILE EXISTS TO PREVENT.
//   · `effectiveFrom`   — when the WORLD changed. A venue term's own history.
//   · `assessableFrom`  — when the DESK became able to see it. An internal capability's history.
// A constraint in force since 2025 is still unassessable for a trade placed while the desk could not size
// correctly. Storing the second as though it were the first would put a desk defect into the venue's record.
//
// ⚠⚠ AND THE DATES ARE DERIVED, NEVER RESTATED. `FLOOR_EPOCHS` cites EPOCH IDS and nothing else; the date comes
// from `epoch.js` by lookup. Writing `2026-10-02` into a table here would be a second producer of a fact the
// registry already owns, and the two would drift the first time an entry was corrected. That is also why a new
// `assessableFrom` COLUMN was rejected: 50 constraint rows carrying one epoch's date is 50 copies of one fact.
//
// ⚠ A CITED ID THAT NO LONGER EXISTS IS REPORTED, NOT IGNORED. A floor whose epoch was renamed would silently
// become "no floor", which reads as "always assessable" — the permissive direction, the one nobody notices.

const { parseKey } = require('./constraintReconcile');

// Constraint FIELD -> the epoch that made it measurable. Fields are the last segment of a constraintKey.
const FLOOR_EPOCHS = {
  // Before this the desk's own missing factor caused the refusals it then attributed to the venue.
  minimum_trade_size: 'size-contract-scale',
};

// ⚠ NAMED ABSENCES. These fields have NO defensible floor, and saying so is the point: an omission that is not
// stated is indistinguishable from an oversight, and a reader would reasonably assume a floor of "always".
const NO_FLOOR = {
  initial_margin_pct:
    'the margin guard compared a USD notional against an SGD equity until the account-currency factor landed in '
    + 'risk.js (P2). That fix has NO registered epoch — measured 2026-10-26, no FEATURES entry mentions currency, '
    + 'fx, sgd or margin at all — so there is nothing to cite. Registering it is what would give this field a floor.',
  funding_buy_pct: 'measured against the venue\'s own charges (fundingSource=venue_actual), not against a desk calculation; no floor needed.',
  funding_sell_pct: 'measured against the venue\'s own charges (fundingSource=venue_actual), not against a desk calculation; no floor needed.',
  funding_time: 'the venue states it directly and `constraintReconcile` compares it in UTC minutes; no desk calculation sits between.',
  single_tab: 'an operational prohibition, not a measurable quantity.',
};

// `plus500.11.minimum_trade_size` -> `minimum_trade_size`. Returns null for an unparsable key rather than guessing
// a field, because a wrong field would silently apply the WRONG floor — worse than applying none.
function fieldOf(constraintKey) {
  const p = parseKey(constraintKey);
  return p ? p.field : null;
}

// Resolve every floor this module knows about against a registry. PURE: the caller supplies `epochs`
// (`epoch.FEATURES`), so nothing here reads a clock, a store or a network.
//
// Returns:
//   floors    { field: 'YYYY-MM-DD' }  — only the fields whose epoch was FOUND
//   missing   [{ field, epochId }]     — cited but absent from the registry; a real fault, and it blocks
//   unfound   []                       — nothing else
function resolveFloors({ epochs, map = FLOOR_EPOCHS } = {}) {
  const byId = new Map();
  for (const e of Array.isArray(epochs) ? epochs : []) {
    if (e && e.id && e.landedAt) byId.set(String(e.id), String(e.landedAt));
  }
  const floors = {};
  const missing = [];
  for (const [field, epochId] of Object.entries(map || {})) {
    if (byId.has(String(epochId))) floors[field] = byId.get(String(epochId));
    else missing.push({ field, epochId: String(epochId) });
  }
  return { floors, missing };
}

// The floor for one constraint key, or null when this field is not floored.
// ⚠ `landedAt` is used DIRECTLY as the instant the new behaviour begins, which is the registry's own convention
// (`epoch.ranges` treats `landedAt` as the start of the era). Inventing a different convention here — say, the end
// of that day — would make two readers of one date disagree.
function assessableFrom(constraintKey, { epochs, map = FLOOR_EPOCHS } = {}) {
  const field = fieldOf(constraintKey);
  if (!field) return { field: null, floor: null, why: 'unparsable_key' };
  if (!Object.prototype.hasOwnProperty.call(map || {}, field)) {
    return { field, floor: null, why: NO_FLOOR[field] ? 'no_floor_recorded' : 'not_a_floored_field' };
  }
  const { floors, missing } = resolveFloors({ epochs, map });
  const miss = missing.find((m) => m.field === field);
  if (miss) return { field, floor: null, why: 'epoch_not_in_registry', epochId: miss.epochId };
  return { field, floor: floors[field] || null, why: floors[field] ? 'floored' : 'unresolved' };
}

// A half-open test, matching every other window in this codebase: AT the floor is assessable.
function beforeFloor(at, floor) {
  if (!floor || at == null) return false;
  const a = new Date(at).getTime();
  const f = new Date(floor).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(f)) return false; // an unreadable date must not invent a block
  return a < f;
}

module.exports = { FLOOR_EPOCHS, NO_FLOOR, fieldOf, resolveFloors, assessableFrom, beforeFloor };
