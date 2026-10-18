// trading/agent/telemetry/index.js — the adapter registry (TRD-76).
//
// THE REGISTRY IS THE SOURCE OF TRUTH FOR "IMPLEMENTED", NOT A LITERAL IN THE CATALOGUE.
// `telemetrySources.js` carries a hand-written `implemented` flag, and the catalogue header records
// the exact bug that flag caused: cftc_cot_positioning needed no key and had a URL, so the first
// version of availability() called it READY while nothing in the repo fetched it, and the proposer
// would have reasoned as if the data were in hand. A hand-written flag can drift from reality the
// moment somebody edits it in hope.
//
// So `implemented` is DERIVED from this registry - a source is wired when an adapter OBJECT exists
// for it - and the catalogue's literal is kept only as a declaration to be compared against. When the
// two disagree, `availability()` says so instead of picking a winner.
'use strict';

const cftcCot = require('./cftcCot');

const ADAPTERS = {
  [cftcCot.ID]: cftcCot,
};

const ids = () => Object.keys(ADAPTERS);
const has = (id) => Object.prototype.hasOwnProperty.call(ADAPTERS, id);
const get = (id) => ADAPTERS[id] || null;

// THE ADAPTER CONTRACT, in one place. Each adapter names its constants in its own convention (CFTC uses
// STALE_AFTER_DAYS), and a reader reaching in for `adapter.staleAfterDays` silently got `undefined` —
// which made every value read as freshness UNKNOWN and, at the other end, dropped the cadence from the
// journalled event. Normalising here means an adapter cannot half-satisfy the interface: it is either
// registered with metadata or the registry says so.
function meta(id) {
  const a = ADAPTERS[id];
  if (!a) return null;
  return {
    id,
    provider: a.PROVIDER || null,
    cadence: a.CADENCE || null,
    staleAfterDays: a.STALE_AFTER_DAYS != null ? a.STALE_AFTER_DAYS : null,
  };
}

// Fetch every wired source that covers at least one of these symbols. Sources are independent: one
// failing must not remove another's observation, and a source that covers nothing here is skipped
// rather than reported as a failure.
//
// Returns `{ results, observations, anyOk }` - `observations` flattened so a caller can record them
// without walking the per-source shape.
async function collect({ ids: only = null, symbols = [], now = new Date(), fetchImpl = fetch } = {}) {
  const wanted = (only && only.length ? only : ids()).filter((id) => has(id));
  const results = [];
  for (const id of wanted) {
    const adapter = ADAPTERS[id];
    const covered = symbols.filter((s) => adapter.marketNamesFor([s]).length > 0);
    if (!covered.length) { results.push({ id, ok: false, skipped: 'no watched symbol is covered', observations: [] }); continue; }
    try {
      results.push(await adapter.fetchLatest({ symbols: covered, now, fetchImpl }));
    } catch (e) {
      results.push({ id, ok: false, reason: `adapter threw: ${String(e.message || e).slice(0, 140)}`, observations: [] });
    }
  }
  const observations = results.flatMap((r) => r.observations || []);
  return { results, observations, anyOk: results.some((r) => r.ok) };
}

module.exports = { ADAPTERS, ids, has, get, meta, collect };
