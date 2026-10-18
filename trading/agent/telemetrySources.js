// trading/agent/telemetrySources.js — the PHYSICAL / STRUCTURAL telemetry the desk does not yet read.
//
// THE GAP (owner, 2026-09-15): "Pulse gives a general analysis of current, but for commodities we have
// things like petroleum reserve... no implementation on that yet. We have to string up the decisions
// instruments." Every piece of telemetry the desk has is PRICE-DERIVED - bars, ticks, indicators, all
// of it is the same number seen through a different window. For a commodity, the thing that actually
// moves the curve is physical: inventories, production, positioning. The desk cannot weigh what it
// cannot ask for, so a DECLARED catalogue is the prerequisite for any per-instrument judgement - and
// the binding proposer consumes this so it can say "I would want X here, and X is not wired".
//
// WHY DECLARED AND NOT FETCHED EAGERLY: they each need an ADAPTER, and some need a credential too - but
// the credential is the smaller half and, for most of this catalogue, not required at all. Corrected
// 2026-09-15 after testing instead of assuming: FRED serves every series as a keyless CSV, and the weather
// source only ever needed a GLOBAL provider. Declaring them means the
// gap is VISIBLE (the proposer can name it, the dashboard can show it) instead of being invisible
// because nothing tried. A source that is declared-but-unconfigured is a to-do; a source nobody
// declared is a blind spot.
//
// PURE except for the optional fetch, which takes an injected `fetchImpl` so tests never touch the
// network. `env` is a parameter (defaults to process.env) so availability is testable and never
// depends on the machine the test runs on.
'use strict';

const KIND = { PHYSICAL: 'physical', POSITIONING: 'positioning', MACRO: 'macro', SEASONAL: 'seasonal' };

// `why` is not decoration - it is the sentence that justifies the source to the model and to the owner,
// and it is what stops the catalogue growing into a list of things that are merely available.
//
// `implemented` is a SEPARATE FACT FROM `requiresKey`, and conflating them was a bug I found by writing
// the tests: cftc_cot_positioning needs no key and has a URL, so the first version of availability()
// called it READY - while nothing in the repo fetches it. A catalogue that marks a declaration as wired
// is worse than no catalogue, because the proposer would then reason as if the data were in hand.
// Default is false: a source is implemented when an adapter exists, and only then.
const SOURCES = [
  {
    id: 'eia_crude_stocks',
    label: 'US crude oil inventories (EIA weekly)',
    kind: KIND.PHYSICAL,
    instruments: ['Oil', 'Brent Oil'],
    provider: 'EIA', route: '/v2/petroleum/stoc/wstk',
    requiresKey: 'EIA_API_KEY', cadence: 'weekly', implemented: false,
    why: 'weekly crude and product stocks are the primary physical driver of the front of the curve; a surprise build/draw is the single most-traded commodity event',
  },
  {
    id: 'eia_crude_production',
    label: 'US crude production + rig count context (EIA)',
    kind: KIND.PHYSICAL,
    instruments: ['Oil', 'Brent Oil'],
    provider: 'EIA', route: '/v2/petroleum/prod/sum',
    requiresKey: 'EIA_API_KEY', cadence: 'weekly', implemented: false,
    why: 'supply-side confirmation: stocks alone move on imports, production moves the curve structurally',
  },
  {
    id: 'fred_real_yield_10y',
    label: 'US 10-year real yield (FRED DFII10)',
    kind: KIND.MACRO,
    instruments: ['Gold', 'Silver'],
    provider: 'FRED',
    // ★ NO KEY IS NEEDED, AND THE OLD DECLARATION WAS WRONG (corrected 2026-09-15). FRED serves any series
    // as a keyless CSV - verified live: HTTP 200, 98,875 bytes, latest row `2026-09-11, 2.60`. The catalogue
    // said `requiresKey: 'FRED_API_KEY'`, so the binding reviewer dutifully asked the owner for a credential
    // the feed does not want, and a signup that was never the blocker looked like the thing to go and do.
    route: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10',
    requiresKey: null, cadence: 'daily', implemented: false,
    why: 'the opportunity cost of holding a non-yielding asset - the standard first-order driver of Gold, and the desk currently has no macro input at all',
  },
  {
    id: 'fred_cb_gold_holdings',
    label: 'Central bank / official gold holdings context (FRED or WGC)',
    kind: KIND.PHYSICAL,
    instruments: ['Gold'],
    provider: 'FRED',
    // The same keyless CSV mechanism as DFII10 works for any FRED series - but no SERIES is chosen, so
    // nothing is fetchable yet. That is a series decision, not a credential, and it reports `no_route`.
    route: null,
    caveat: 'the keyless CSV route works for any FRED series, but no series is chosen yet - that is a series decision, not a key',
    requiresKey: null, cadence: 'monthly', implemented: false,
    why: 'official-sector buying has been the dominant slow bid; it is invisible to price-derived telemetry by construction',
  },
  {
    id: 'cftc_cot_positioning',
    label: 'CFTC Commitments of Traders, managed money net',
    kind: KIND.POSITIONING,
    instruments: ['Gold', 'Silver', 'Oil', 'Brent Oil', 'Sugar', 'Arabica Coffee'],
    provider: 'CFTC', route: 'https://publicreporting.cftc.gov/resource/72hh-3qpy.json',
    requiresKey: null, cadence: 'weekly', implemented: true, implementedBy: 'adapter',
    why: 'positioning extremes mark crowded trades - a mean-reversion signal the desk cannot see in bars alone. PUBLIC, no key.',
  },
  {
    id: 'opec_production',
    label: 'OPEC+ production vs quota',
    kind: KIND.PHYSICAL,
    instruments: ['Oil', 'Brent Oil'],
    provider: 'OPEC/IEA', route: null,
    // ★ THE KEY WAS NEVER THE BLOCKER (corrected 2026-09-15): there is no endpoint to spend one on. OPEC
    // publishes reports and PDFs, not a queryable feed, so this source needs a PROVIDER DECISION before a
    // credential means anything. Declaring OPEC_API_KEY sent the owner looking for an API that may not exist.
    caveat: 'OPEC publishes reports, not a queryable feed - a provider has to be chosen before a credential means anything',
    requiresKey: null, cadence: 'monthly', implemented: false,
    why: 'the cartel is the supply-side actor; quota compliance is the mechanism, not the price outcome',
  },
  {
    id: 'weather_brazil_frost',
    label: 'Brazil frost / growing-region weather (Arabica)',
    kind: KIND.SEASONAL,
    instruments: ['Arabica Coffee'],
    // ★ THE PROVIDER WAS WRONG, NOT THE KEY (corrected 2026-09-15). api.weather.gov is keyless, but it
    // covers the US ONLY - verified 200 for Denver, and useless for the Brazilian coffee belt that this
    // source exists for. A keyless GLOBAL provider was verified live instead: Open-Meteo returned daily
    // minimum temperature for Franca SP (-20.49, -47.40), HTTP 200.
    provider: 'Open-Meteo',
    route: 'https://api.open-meteo.com/v1/forecast?latitude=-20.54&longitude=-47.40&daily=temperature_2m_min&timezone=America/Sao_Paulo',
    requiresKey: null, cadence: 'daily', implemented: false,
    // Having the weather is NOT having a frost signal, and confusing the two is how a data source gets
    // mistaken for a strategy input.
    caveat: 'the data is keyless; what is NOT yet decided is what counts as a frost event (threshold, station set, forecast vs observed)',
    why: 'a frost event is the classic Arabica tail risk; it is a physical event with no price precursor',
  },
  {
    id: 'venue_funding_basis',
    label: 'Perpetual funding / basis (already partly wired)',
    kind: KIND.POSITIONING,
    instruments: ['Bitcoin'],
    provider: 'internal', route: null,
    requiresKey: null, cadence: 'continuous', implemented: true, implementedBy: 'internal',
    why: 'the desk already stores venue funding clocks (TRD-50) - declared here so the catalogue is honest about what EXISTS as well as what is missing',
  },
];

const applicable = (symbol) => SOURCES.filter((s) => (s.instruments || []).includes(symbol));

const isConfigured = (source, env = process.env) => !source.requiresKey || !!(env && env[source.requiresKey]);

// TRD-76: the registry decides what is WIRED, not the literal above. Read lazily and defensively so a
// catalogue read never breaks because an adapter module failed to load - an unloadable adapter is an
// unimplemented source, which is the safe direction.
function registry() {
  try { return require('./telemetry'); } catch { return null; }
}
const isImplemented = (source) => {
  const reg = registry();
  return !!(reg && reg.has(source.id));
};

// Availability for one source, with the reason stated. A source is never "available" by omission, and
// DECLARED is never reported as WIRED - those are different claims and only one of them is true today.
//
// ★ TRD-76: "WIRED" HAS MORE THAN ONE MECHANISM, and deriving it from the adapter registry alone got
// this wrong. `venue_funding_basis` IS genuinely wired - by INTERNAL storage (TRD-50 funding clocks baked
// into the instrument registry and the Trades ledger), not by fetching anything - so a registry-only rule
// demoted a real source to needs_adapter. The flag therefore carries its MECHANISM:
//
//   implementedBy: 'adapter'   a network adapter must exist in the registry, or the claim is a lie
//   implementedBy: 'internal'  wired by desk machinery; the declaration stands, nothing to validate
//   implementedBy: null        with implemented:true this is an UNBACKED CLAIM and is reported as one
//
// The guard still sits exactly where the original bug was - a source with a URL and no key requirement
// declared available while nothing fetched it - without mislabelling an internal mechanism as missing.
function availability(source, env = process.env) {
  const configured = isConfigured(source, env);
  const by = source.implementedBy || null;
  const declaredImplemented = source.implemented === true;
  let implemented = false;
  let mismatch = null;
  if (by === 'adapter') {
    implemented = isImplemented(source);
    if (declaredImplemented && !implemented) mismatch = 'declares implementedBy:adapter but NO adapter is registered';
    if (!declaredImplemented && implemented) mismatch = 'declares implemented:false but an adapter IS registered';
  } else if (by === 'internal') {
    implemented = declaredImplemented;
    if (!declaredImplemented) mismatch = 'declares implementedBy:internal without implemented:true';
  } else if (declaredImplemented) {
    mismatch = 'declares implemented:true with no implementedBy - an unbacked claim, so it is NOT counted as wired';
  }
  const base = { id: source.id, configured, implemented, implementedBy: by, declaredImplemented, mismatch, caveat: source.caveat || null };
  if (implemented && configured) return { ...base, state: 'ready', reason: mismatch || 'wired, and credentials available' };
  // ★ NO ROUTE IS A DIFFERENT GAP FROM NO KEY (2026-09-15). Two sources declared a credential AND had no
  // endpoint, so the catalogue told the reviewer to ask the owner for OPEC_API_KEY and NOAA_API_KEY -
  // credentials that were never the blocker, one of which has no feed to spend it on. This check sits
  // BEFORE needs_key deliberately: answering "go and get a key" for a source with nowhere to send it sends
  // the owner to solve the wrong problem, which is worse than saying nothing. It sits AFTER the `ready`
  // return so an INTERNAL mechanism with no network route (venue_funding_basis) is not mislabelled here.
  if (!source.route) {
    return { ...base, state: 'no_route', reason: source.caveat || 'no fetchable endpoint or series is declared - this needs a PROVIDER DECISION, not a credential' };
  }
  if (!configured) return { ...base, state: 'needs_key', reason: `${source.requiresKey} is not set - declared and visible, not yet wired` };
  return { ...base, state: 'needs_adapter', reason: `${mismatch || 'credentials are not the blocker - NO ADAPTER IS WRITTEN yet, so this is a declaration only'}${source.caveat ? ` · ${source.caveat}` : ''}` };
}

// Per symbol: what physical telemetry exists, what is missing, and therefore what the desk is blind to.
// This is the object the binding proposer is handed, so it proposes from what CAN be known.
function coverage(symbols = [], env = process.env) {
  const out = {};
  for (const symbol of symbols) {
    const declared = applicable(symbol);
    const rows = declared.map((s) => ({ ...availability(s, env), label: s.label, kind: s.kind, cadence: s.cadence, why: s.why }));
    out[symbol] = {
      declared: rows.length,
      ready: rows.filter((r) => r.state === 'ready').length,
      needsKey: rows.filter((r) => r.state === 'needs_key').map((r) => r.id),
      needsRoute: rows.filter((r) => r.state === 'no_route').map((r) => r.id),
      needsAdapter: rows.filter((r) => r.state === 'needs_adapter').map((r) => r.id),
      sources: rows,
      // Stated in the negative on purpose: this is the sentence that must reach the proposer.
      blindTo: rows.filter((r) => r.state !== 'ready').map((r) => r.label),
    };
  }
  return out;
}

// One-line-per-symbol summary for a prompt or a dashboard.
function describe(symbols = [], env = process.env) {
  const cov = coverage(symbols, env);
  return Object.entries(cov).map(([symbol, c]) => {
    if (!c.declared) return `${symbol}: no physical/structural telemetry declared - price-derived only`;
    if (!c.blindTo.length) return `${symbol}: ${c.ready}/${c.declared} sources ready`;
    return `${symbol}: ${c.ready}/${c.declared} ready; BLIND to ${c.blindTo.join('; ')}`;
  });
}

// ---------------------------------------------------------------------------------------------------
// RESOLVING A REQUIREMENT (TRD-86, 2026-09-15).
// ---------------------------------------------------------------------------------------------------
//
// A hypothesis names the telemetry its test would need, by source id. That claim has to be checked
// against THIS catalogue before the test is queued, for two reasons that pull in the same direction:
//
//   1. A model asked to name data it wants will name data it IMAGINES. Without a lookup, "we need
//      EUA carbon futures" becomes a queued task for a source that was never declared and never will be.
//   2. The catalogue already knows WHY each source is not usable — `no_route` means there is nothing to
//      fetch and no credential would help. Queuing a test against it is not optimism, it is a plan that
//      cannot be executed, and the honest answer is to refuse it at the door in the catalogue's own words.
//
// There was no id lookup on this module before: `applicable(symbol)` answers "what is declared for this
// instrument", which is the other direction. So `byId` is new.
const byId = (id) => {
  const key = id == null ? '' : String(id);
  return SOURCES.find((s) => s.id === key) || null;
};

// The states in which a test CANNOT be run: no endpoint exists (`no_route`), or nothing is declared
// under that id at all (`unknown`). Every other state is a to-do — a missing adapter or a missing
// credential is work someone can do, and the catalogue says exactly which.
const UNTESTABLE_STATES = ['no_route', 'unknown'];

function resolveRequirement(id, env = process.env) {
  const key = id == null ? '' : String(id);
  const source = byId(key);
  if (!source) {
    const reason = `no source with id "${key}" is declared in the telemetry catalogue — a hypothesis cannot require data the desk has not declared`;
    return {
      id: key, known: false, state: 'unknown', testable: false, configured: false, implemented: false,
      reason,
      // ★ `refuseReason` IS NOT OPTIONAL HERE. Omitting it in this branch made every undeclared source
      // report "cannot be fetched: undefined" — the refusal lost the only useful part. Caught by the
      // test that asserts the sentence, which is exactly what a test asserting the MESSAGE rather than
      // the boolean is for.
      refuseReason: reason,
    };
  }
  const a = availability(source, env);
  const testable = !UNTESTABLE_STATES.includes(a.state);
  return {
    ...a,
    known: true,
    testable,
    label: source.label,
    kind: source.kind,
    instruments: source.instruments,
    why: source.why,
    // The reason to quote when refusing is availability()'s OWN sentence, so the doorstep answer and the
    // catalogue cannot drift apart. A refusal that re-words the cause is a second place to be wrong.
    refuseReason: testable ? null : a.reason,
  };
}

module.exports = { KIND, SOURCES, byId, applicable, isConfigured, isImplemented, availability, resolveRequirement, coverage, describe };
