// trading/agent/bindingProposer.js — an INDEPENDENT reviewer that proposes the instrument binding (TRD-75).
//
// OWNER REQUEST (2026-09-15): "the instrument <-> (strategy, params) binding should be AI-selected per
// instrument... (a separate AI?)". The axis and the validators exist (agent/binding.js); this is the
// proposer. It PROPOSES and RECORDS. It never writes settings, and it never trades.
//
// WHAT "A SEPARATE AI" HAS TO MEAN, beyond a separate HTTP call. A reviewer that is handed the desk's
// own position, its current signal and its pending decision is not reviewing - it is agreeing. So the
// input is built by WHITELIST, not by subtraction (the same discipline as shadow.stripContext): the
// input object has exactly the keys in INPUT_KEYS and NOTHING ELSE can get in. There is no spread of
// the desk's state anywhere in this file, and a test asserts the key set is exactly that list, because
// "we remembered not to pass positions" is not a guarantee.
//
// WHAT IT IS ALLOWED TO SEE: the instruments, which strategies are permitted where, the CURRENT binding
// with the provenance of every value, the lab evidence per pair, the declared physical-telemetry
// catalogue (including what is MISSING), and - since TRD-76 - the MEASURED VALUES from the sources that
// are actually wired, each with its own as-of and age. That is enough to judge fitness and not enough to
// copy a trade. Availability and value are separate keys on purpose: a source that exists is not
// evidence about the instrument.
//
// THE PROPOSAL MUST SURVIVE THE GUARDS, and it reuses the real ones rather than restating them:
//   * binding.validate() - unknown symbol/strategy, frozen (silent no-op), track-bound mismatch,
//     out-of-range or unknown params;
//   * the live-eligibility gate (agent/lab/gate.js + eligibility.js) - a pair whose lab verdict does not
//     permit it must be declared an OVERRIDE REQUEST with a reason, not quietly proposed.
// A rejected proposal is still RECORDED, with its problems: "the AI wanted X and it was refused because
// Y" is the audit trail that makes the next decision easier.
'use strict';

const crypto = require('crypto');

const PROMPT_VERSION = 'binding-v3';
// ★ THE CAP IS NOW MEASURED, NOT ESTIMATED (2026-09-15, RAISED 6000 -> 20000).
//
// The old comment on this constant was right about the mechanism and wrong about the size: a too-low cap
// does not truncate this reviewer's answer, it consumes the whole budget on reasoning and returns an
// EMPTY reply. What changed is how much reasoning it needs. The hypotheses channel (v3) asks for a
// falsifiable claim, its falsifier and its data per instrument, and the measured requirement moved well
// past the old ceiling: a forced call on the live settings needed **14,984 completion tokens** and
// **68 seconds** to emit `finish_reason: 'stop'`.
//
// At 6000/12000 the reviewer could not answer AT ALL — both attempts came back empty, so a v3 proposal
// produced nothing but `reviewer returned nothing: the 12000-token cap was consumed entirely by
// reasoning`. That is a silent, total failure of the feature, and the only reason it was caught is that
// the owner asked for a forced run. 20000 leaves ~5k of headroom over the measurement.
const MAX_TOKENS = 20000;
// The escalation rung, at twice the base. 40000 is not a guess either: it is the budget the diagnostic
// run actually completed on, so a future escalation is known to be serviceable.
const MAX_TOKENS_RETRY = 40000;
// ★ THE REVIEWER NEEDS ITS OWN TIMEOUT (2026-09-15). It inherited `settings.llm.timeoutMs` (60000), and a
// full call plus its escalation is ~30s + ~60s = ~90s, so the shipped budget aborted mid-escalation with
// `This operation was aborted` — a second, independent way to produce nothing. Other consumers keep the
// global value; only this one is raised, because only this one thinks about twelve instruments at once.
const DEFAULT_TIMEOUT_MS = 240000;
// A week. Chosen against the EVIDENCE cadence, not the clock: the lab verdicts move on weeks, the
// physical sources are weekly-to-monthly, and a reviewer asked more often than its evidence changes
// does not learn anything new - it just finds something to say. 168h also makes the ceiling the actual
// backstop for the change-trigger, which is what it is for.
const DEFAULT_MAX_STALE_H = 168;

// THE WHITELIST. This list is the contract the test enforces.
const INPUT_KEYS = ['promptVersion', 'instruments', 'scope', 'candidates', 'currentBinding', 'evidence', 'physicalTelemetry', 'physicalValues', 'rules'];

const SYSTEM = [
  'You are an independent reviewer for a small systematic trading desk. You do NOT trade, you do not',
  'see the desk positions, and you are not told what it currently wants to do. Your job is to propose',
  'which strategy should run on which instrument, and with which parameters, from the evidence given.',
  '',
  'Rules you must respect:',
  '1. A strategy marked "frozen" has immutable parameters. NEVER propose parameters for it - the',
  '   proposal will be rejected, because its code spreads its own constants and any edit does nothing.',
  '2. A strategy marked trackBound may only be proposed for the instruments it declares.',
  '3. A pair whose lab evidence is not "pass" needs an explicit override with a REASON. Propose it as',
  '   overrideReason, not as a normal binding. Do not hide it.',
  '4. Parameters must be inside the declared min/max, and only from the declared parameter list.',
  '5. Be willing to propose NOTHING for an instrument. "no binding, because the evidence is absent and',
  '   the physical telemetry is unwired" is a better answer than a plausible-looking guess, and it will',
  '   be recorded as such.',
  '5b. SCOPE IS YOURS TO DECIDE, NOT A CONSTRAINT ON YOU. `scope` reports what each instrument is',
  '   permitted to run TODAY. A binding you propose for a pair that is NOT on that permitted list is a',
  '   SCOPE ADDITION - the desk will START TRADING that instrument, and your proposal is recorded as the',
  '   decision that did it. So "scope permits no strategy" is NOT a reason to propose nothing: it is a',
  '   description of the current state that you are being asked to change. If you believe a pair belongs',
  '   in scope, propose it and give the evidence. Equally, do not propose a pairing you cannot justify -',
  '   every addition is attributed to you by name in the record.',
  '5c. `candidates` says what is POSSIBLE on each instrument: `inScope` is what already runs there,',
  '   `noLabCase` are strategies that COULD run there and for which no lab case exists at all, and',
  '   `withCase` are the rest with the verdict the gate gives them. An instrument with an empty `inScope`',
  '   is one nobody has decided about yet - that IS the question, and `applicableCount` is how many',
  '   strategies there are to answer it with. Read `noLabCase` as ONE fact about the whole list, not one',
  '   per strategy: no case of its own is not evidence against a pairing, and it is not a pass either.',
  '5d. You may also propose TESTS, in `hypotheses`. A hypothesis says what you believe about an',
  '   instrument and WHAT WOULD PROVE YOU WRONG: a claim a backtest could contradict. "Sugar mean-reverts',
  '   because managed money is at a record crowded long" is a hypothesis. "Sugar will rise" is a',
  '   prediction, "meanrev should run on Sugar" is a binding, and neither is accepted here.',
  '   * Every hypothesis MUST carry `falsifiableBy`: EITHER `strategy` = the id of an EXISTING strategy',
  '     that would test it, OR `{"needsAuthoring": true, "sketch": "..."}` saying plainly that new code',
  '     has to be written. A claim with no falsifier is REFUSED and recorded as refused.',
  '   * `requiredData` names the telemetry source ids the test needs, taken from the catalogue you were',
  '     shown. A hypothesis needing a source the catalogue CANNOT fetch is refused AT THE DOOR, so read',
  '     the catalogue rather than wishing. Asking for something undeclared is also refused.',
  '   * A hypothesis is NOT a binding. It grants nothing, it starts nothing, and it will NOT put an',
  '     instrument in scope. If you want scope, propose a binding (5b). If you have nothing',
  '     falsifiable to say about an instrument, propose NOTHING for it - an empty list is a real answer.',
  '6. If you want telemetry that is listed as missing, say so in wantsPhysical. That is how the gap gets',
  '   funded instead of forgotten.',
  '7. physicalValues holds MEASURED figures from sources that are actually wired, each with its own',
  '   asOf date, cadence and ageDays. Two duties: CITE it when you use it, and WEIGH ITS AGE. A weekly',
  '   report 7 days old is current; the same figure 40 days old is not, and fresh:false means the feed',
  '   has stopped advancing, not that the position has been maintained. Never describe an ageing figure',
  '   as the current one, and prefer "no evidence" to a stale number presented as live.',
  '8. A percentile is quoted WITH its window (percentileWindowWeeks). "86th percentile" alone is not a',
  '   statement; "86th of 30 weeks" is. Do not infer a trend from fewer weeks than you were given.',
  '9. rules.mode says what the desk is for. In "demo" the venue is a simulated account and the POINT of a',
  '   pairing may be to COLLECT LIVE EVIDENCE rather than to claim a validated edge. Proposing that is',
  '   correct and useful - but the RATIONALE MUST SAY SO, for example "demo: no lab case exists; proposed',
  '   to generate live evidence". What is not acceptable is presenting a data-collection pairing as a',
  '   validation it does not have. The owner reads these rationales to decide, so a true one beats a',
  '   persuasive one.',
  '',
  'Reply with JSON only, exactly this shape:',
  '{"bindings":[{"symbol":"...","strategy":"...","params":{"key":number},"rationale":"one sentence",',
  '"evidence":["..."],"overrideReason":"only if the lab evidence is not pass"}],',
  '"unbound":[{"symbol":"...","reason":"one sentence"}],"wantsPhysical":[{"symbol":"...","sourceId":"..."}],',
  '"hypotheses":[{"symbol":"...","statement":"a claim a backtest could contradict",',
  '"falsifiableBy":{"strategy":"existing-strategy-id"},"requiredData":["catalogue-source-id"]}],',
  '"notes":"anything the owner should read"}',
].join('\n');

// ★ THE DEFECT THIS REPLACES (found 2026-09-15 by the first forced proposal since 09-14):
//      const lastSig = last && last.payload ? (JSON.parse(last.payload).inputSig || null) : null;
// `store.listEvents` ALREADY parses the payload (safeJson), so `last.payload` is an OBJECT here and
// `JSON.parse` receives "[object Object]" and throws `SyntaxError: "[object Object]" is not valid JSON`.
// It never fired on the FIRST proposal (there was no prior event), so it survived review and testing:
// **the reviewer could propose exactly once and never again**, and the wake hook's bare `catch` made
// every subsequent failure silent. The redaction bug that turned this field into "[REDACTED]" had been
// found by reading a live row; this one was hiding in the same two lines.
//
// The read is a helper rather than an inline expression because the shapes are THREE, not one:
// safeJson yields an object, or the RAW STRING when the JSON is invalid, or null when empty. A guard
// that assumes the object shape is the bug above; a guard that assumes the string shape is the same
// bug inverted. Pure, exported, and pinned by tests.
function eventPayload(ev) {
  if (!ev || ev.payload == null) return null;
  if (typeof ev.payload === 'string') { try { return JSON.parse(ev.payload); } catch { return null; } }
  return typeof ev.payload === 'object' ? ev.payload : null;
}

// ---------------------------------------------------------------------------
// THE CANDIDATE SET (TRD-85, 2026-09-15) - what the reviewer could CONSIDER.
// ---------------------------------------------------------------------------
//
// ★ THE BLIND SPOT THIS REMOVES. `evidence` is built from bindingTable().symbols[].strategies, which is
// the IN-SCOPE list. For a symbol with nothing in scope that list is empty, so the reviewer received
// `scope: {permitted: []}`, `evidence: []` and - for anything the physical catalogue does not cover -
// `physicalTelemetry: {declared: 0}`. It was handed NOTHING about the symbol and then asked whether a pair
// belonged in scope. It answered correctly for its input ("zero declared telemetry, zero sources and no
// lab evidence") and refused all four instruments the discoverer had added. That is the same circularity
// that was fixed for `scope` itself, one channel over: the reviewer was shown only what was already true.
//
// The fix is to state what is POSSIBLE, not only what is CURRENT.
//
// WHY IT IS GROUPED AND NOT ONE ROW PER PAIR. A row-per-pair version is ~100 rows on this watchlist and
// almost every one would say the same sentence: "no lab candidate for X". Emptiness is ONE fact about a
// set, so it is stated once, as a list. The reviewer is a reasoning model billed per token; what it needs
// is "8 strategies are available here and none has a case", not eight restatements of that.
//
// `unmapped` is kept SEPARATE from `noLabCase` deliberately. An exemption is a policy outcome (no case of
// its own); an unmapped strategy is a DEFECT - a strategy nobody classified in lab/gate.js - and letting
// the two share a list is exactly the conflation gate.js warns about.
const CANDIDATES_NOTE = [
  'Per symbol: `inScope` = what may run there today; `noLabCase` = strategies that COULD run there with NO',
  'lab case of their own (one fact about the list, not one per strategy); `withCase` = the rest, with the',
  'gate verdict; `unmapped` = a strategy nobody has classified, which is a defect rather than an exemption.',
  'An empty `inScope` means nobody has decided about this instrument yet - that is the question being asked,',
  'and `applicableCount` is how many strategies are available to answer it with.',
].join(' ');

function candidateSets({ symbols = [], settings = null, registry = null, gate = null } = {}) {
  const binding = require('./binding');
  const labGate = require('./lab/gate');
  const bySymbol = [];
  for (const symbol of symbols) {
    const applicable = binding.applicableIds(symbol, registry);
    const inScope = binding.inScopeIds(settings || {}, symbol, registry).ids;
    const noLabCase = [];
    const unmapped = [];
    const withCase = [];
    for (const id of applicable.filter((x) => !inScope.includes(x))) {
      const d = gate ? labGate.observe(gate, { strategyId: id, symbol }) : null;
      if (!d || d.action === 'exempt') noLabCase.push(id);
      else if (d.action === 'unmapped') unmapped.push(id);
      else withCase.push({ strategy: id, outcome: d.outcome, eligible: d.action === 'allow' });
    }
    bySymbol.push({ symbol, applicableCount: applicable.length, inScope, noLabCase, unmapped, withCase });
  }
  return { note: CANDIDATES_NOTE, bySymbol };
}

// ---------------------------------------------------------------------------
// Input construction - WHITELIST ONLY.
// ---------------------------------------------------------------------------
function buildReviewInput({ instruments = [], scope = {}, bindingTable = null, evidence = [], coverage = {}, physicalValues = {}, candidates = null, rules = null } = {}) {
  return {
    promptVersion: PROMPT_VERSION,
    instruments: instruments.map((i) => ({ symbol: i.symbol, venue: i.venue || null })),
    scope,
    // Always present, so the key set stays exactly INPUT_KEYS whatever the caller passes; the caller is
    // the one that decides what to enumerate (see candidateSets).
    candidates: candidates || { note: CANDIDATES_NOTE, bySymbol: [] },
    currentBinding: (bindingTable && bindingTable.symbols) ? bindingTable.symbols.map((row) => ({
      symbol: row.symbol,
      scopeSource: row.scopeSource,
      strategies: row.strategies.map((b) => ({
        strategy: b.strategy,
        tunable: b.tunable,
        trackBound: b.trackBound,
        params: b.tuned,
        paramSources: Object.fromEntries(Object.entries(b.params).map(([k, v]) => [k, v.source])),
      })),
    })) : [],
    evidence,
    physicalTelemetry: coverage,
    // TRD-76: what the wired sources actually SAY, with the report's own date and age. Availability
    // and value must not arrive looking alike - "a source exists" is not evidence about the instrument.
    physicalValues,
    rules: rules || {
      frozen: 'parameters proposed for a frozen strategy will be rejected',
      override: 'lab evidence other than pass requires overrideReason',
      unboundIsAllowed: true,
      // Present in the DEFAULT as well as in the rules `propose()` builds: a caller that omits `rules`
      // must not silently receive a reviewer that believes scope is closed. That belief is exactly what
      // produced "scope explicitly permits no strategy" for every symbol but Gold and Oil.
      scopeMayBeExtended: true,
      scopeNote: 'scope reports the CURRENT state; a binding for a pair that is not permitted is a SCOPE ADDITION, not an invalid proposal',
    },
  };
}

// Stable signature for change detection, so a re-decision happens when the INPUT MOVES (a verdict
// changes, a binding changes, a source becomes available) rather than on a blind timer.
function signature(input) {
  const relevant = {
    // ★ THE PROMPT VERSION IS PART OF THE INPUT (2026-09-15). A prompt change can change the answer, so a
    // previous decision must not be treated as current just because the desk data looks identical.
    // Without this, bumping PROMPT_VERSION would leave the old proposal standing until the 168h ceiling.
    v: input.promptVersion,
    i: (input.instruments || []).map((x) => x.symbol).sort(),
    s: input.scope,
    // TRD-85: what is POSSIBLE is part of the decision. A new strategy becoming applicable, or a lab case
    // appearing for a candidate, is new information even when nothing in scope moved.
    c: ((input.candidates && input.candidates.bySymbol) || []).map((r) => [r.symbol, r.inScope, r.noLabCase, (r.withCase || []).map((w) => [w.strategy, w.outcome])]),
    b: (input.currentBinding || []).map((r) => [r.symbol, (r.strategies || []).map((x) => [x.strategy, x.params])]),
    e: (input.evidence || []).map((e) => [e.symbol, e.strategy, e.outcome, e.eligible]),
    p: Object.fromEntries(Object.entries(input.physicalTelemetry || {}).map(([s, c]) => [s, [c.ready, c.declared]])),
    // TRD-76: a NEW report is new evidence and should make the reviewer reconsider; re-reading the
    // same report should not. So the signature carries each source's AS-OF, not its numbers.
    pv: Object.fromEntries(Object.entries(input.physicalValues || {}).map(([s, rows]) => [s, (rows || []).map((r) => r.asOf || null)])),
  };
  return crypto.createHash('sha1').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// The STRANDED proposal.
// ---------------------------------------------------------------------------
// `applied` is hard-coded false and the apply runs in the same wake that PROPOSED, so a proposal recorded
// while no writer was armed used to stay unapplied FOREVER: arming autoTighten or autoScope would then do
// nothing until the reviewer INPUT moved again, which can be days. The reviewer would look like it had
// decided and the desk would never act - the same "recorded and read by nothing" shape the binding work
// exists to remove, one layer down.
//
// ONLY THE NEWEST proposal qualifies. An older one may have been superseded by evidence the reviewer has
// since weighed, and resurrecting it would apply a decision taken against a world that has moved.
// `inputSig` already records which proposal a `binding_scoped` event came from, so the marker needs no
// new state: an apply that names the signature retires it.
async function strandedProposal(userId) {
  const store = require('../store');
  const [props, applied] = await Promise.all([
    store.listEvents(userId, { kind: 'binding_proposal', limit: 1 }).catch(() => []),
    store.listEvents(userId, { kind: 'binding_scoped', limit: 20 }).catch(() => []),
  ]);
  const p = eventPayload((props || [])[0]) || {};
  if (p.accepted !== true) return null;
  if (p.inputSig && new Set((applied || []).map((e) => (eventPayload(e) || {}).inputSig).filter(Boolean)).has(p.inputSig)) return null;
  if (!Array.isArray(p.bindings) || !p.bindings.length) return null;
  return p;
}

// TRD-105 (2026-09-19): THE NET-EDGE SCREEN ON WIDENING.
//
// A pair being ADDED to scope is the one case where the desk starts trading something it never traded, and
// the reviewer does it repeatedly: with rsi2 retired, the very next forced proposal was
// {"Bitcoin":["meanrev"]}. The eligibility gate cannot stop that — meanrev is declared UNCOVERED and
// therefore EXEMPT by an explicit owner decision — and the win-rate parity check cannot either. What CAN
// is the price path: a pair whose own closed trades show MFE below |MAE| + round trip has an entry premise
// that cannot pay, whatever its win rate.
//
// ⚠ DELIBERATELY ASYMMETRIC — this refuses ADDING a pair, never one already in scope. A live
// forward-validation track is not torn down on a small sample (12 trades is too few to conclude a
// trend-follower has no edge, which is exactly why TRD-100 is still open rather than actioned). Opening a
// NEW pairing on measured-negative evidence is the case with no defence.
//
// ⚠ COVERAGE, STATED HONESTLY: this catches a pair with a MEASURED negative record. It does NOT stop a
// pair with no record at all — meanrev/Bitcoin reads `no_record`, is recorded as such, and is NOT refused,
// because "refuse anything unproven" would forbid the desk from ever trying a new pairing. That half
// belongs to the gate's enforce decision or to a shadow-first requirement, and is not claimed here.
async function scopeEdgeScreen(userId, scopeAdd) {
  const pairs = Object.entries(scopeAdd || {})
    .flatMap(([symbol, ids]) => (Array.isArray(ids) ? ids : []).map((id) => ({ symbol, strategy: id, key: `${id}:${symbol}` })));
  if (!pairs.length) return null;
  const rows = await require('./analytics').netEdge(userId, {}).catch(() => null);
  // A screen that could not run must not read as a screen that passed.
  if (!rows) return { checked: pairs.map((p) => `${p.key}=UNSCREENED`), refusal: null };
  const byKey = new Map(rows.map((r) => [`${r.strategy}:${r.symbol}`, r]));
  const checked = pairs.map((p) => { const r = byKey.get(p.key); return `${p.key}=${r ? r.verdict : 'no_record'}`; });
  // TRD-106 (2026-09-19): `unmeasurable` refuses a widening too. It is a different statement from
  // `negative` — the path could not be measured rather than measured badly — but the refusal is the same,
  // because an excursion that cannot be measured at the available tick cadence is a trade that never left
  // the spread, and that is evidence about the pair rather than an absence of it. `insufficient` (not
  // enough history) and `no_record` still do NOT refuse: refusing anything unproven would forbid the desk
  // from ever trying a new pairing.
  const bad = pairs.map((p) => byKey.get(p.key)).filter((r) => r && (r.verdict === 'negative' || r.verdict === 'unmeasurable'));
  if (!bad.length) return { checked, refusal: null };
  return {
    checked,
    refusal: {
      level: 'error',
      reason: `NET EDGE ON A PAIR THIS WOULD ADD TO SCOPE IS ${bad.some((b) => b.verdict === 'unmeasurable') ? 'UNMEASURABLE AND/OR NEGATIVE' : 'NEGATIVE'}: ${bad.map((b) => `${b.strategy}/${b.symbol} ${b.verdict} (${b.why})`).join('; ')} — a pairing is not widened onto evidence that is negative, or that cannot be measured at all (TRD-105/TRD-106)`,
    },
  };
}

// Propose when the input changed, or when nothing has been proposed for maxStaleH.
// minIntervalH is a FLOOR (a busy day must not become a proposal per wake); maxStaleH is a CEILING.
//
// ★ THE CEILING IS NOT REDUNDANT, and it is the half a pure change-trigger gets wrong: if the desk's
// own inputs never move, a change-trigger NEVER reconsiders - and "nothing changed" is precisely what
// a stale world looks like from the inside. The ceiling forces a re-decision anyway, so the binding
// gets re-examined on a cadence even when every input the reviewer can see is identical.
// maxStaleH = 0 disables the ceiling (and then the change trigger is the only trigger, as before).
function shouldPropose({ sig, lastSig = null, lastAt = null, now = Date.now(), minIntervalH = 12, maxStaleH = 168 } = {}) {
  if (!lastSig) return { propose: true, why: 'no prior proposal' };
  const ageH = lastAt ? (now - new Date(lastAt).getTime()) / 3600000 : Infinity;
  const unusable = !Number.isFinite(ageH) || ageH < 0;
  if (maxStaleH > 0 && (unusable || ageH >= maxStaleH)) {
    return { propose: true, why: `stale: no re-decision in ${unusable ? 'an unknown period' : `${ageH.toFixed(1)}h`} (ceiling ${maxStaleH}h)` };
  }
  if (sig === lastSig) return { propose: false, why: 'input unchanged, and within the staleness ceiling' };
  if (unusable) return { propose: true, why: 'no usable prior timestamp' };
  if (ageH < minIntervalH) return { propose: false, why: `input moved but only ${ageH.toFixed(1)}h since the last proposal (floor ${minIntervalH}h)` };
  return { propose: true, why: 'input changed' };
}

// ---------------------------------------------------------------------------
// Parsing + validation
// ---------------------------------------------------------------------------
// ★ TRAILING CONTENT IS NOT A REASON TO THROW AWAY A WHOLE DECISION (2026-09-15).
//
// The prompt asks for "JSON only", and JSON.parse(whole reply) demands it exactly. A reasoning model that
// appends ONE sentence after a perfectly valid object therefore fails the entire proposal - after spending
// the whole token budget producing it. Measured live on a forced proposal whose reply was valid JSON plus a
// note: "Unexpected non-whitespace character after JSON at position 7288 (line 2 column 1)". The reviewer
// looked like it had nothing to say and had actually said everything.
//
// So the reply is read as "one JSON object, somewhere", which is what the desk means. The object is found
// by BRACE MATCHING rather than by "first { to last }", because a trailing sentence containing a brace
// would otherwise corrupt a good reply, and string/escape state is tracked so a brace inside a rationale
// cannot close the object early.
// ★ A REPLY CAN CONTAIN MORE THAN ONE OBJECT, AND THAT IS NOW VISIBLE (2026-09-15).
//
// A forced call returned TWO complete top-level JSON objects: the answer, then the model's own prose
// ("Wait — that last one: the response must be JSON only... Note the trailing text after the JSON in my
// draft; I must not include it... Let me finalize."), then a second, corrected copy. `firstJsonObject`
// takes the FIRST, so the desk parsed the draft the model had just disowned.
//
// The two happened to agree on every count here, so nothing was materially wrong — but the MECHANISM is
// unsafe, and "it agreed this time" is not a guarantee. This does NOT yet change which object is used:
// choosing the last is right for a self-correction and catastrophic for a stray `{}` in prose, and that
// trade needs evidence about how often each happens. So the count is RECORDED, the trail shows it, and
// the decision can be made against data rather than a guess. `jsonObjects > 1` is a protocol violation
// worth counting.
function topLevelJsonObjects(text) {
  const out = [];
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf('{', from);
    if (start < 0) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) break;
    out.push(text.slice(start, end + 1));
    from = end + 1;
  }
  return out;
}

function firstJsonObject(text) {
  return topLevelJsonObjects(text)[0] || null;
}

function parseProposal(text) {
  if (!text || typeof text !== 'string') return { error: 'empty reply' };
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const attempt = (s) => { try { return { obj: JSON.parse(s) }; } catch (e) { return { err: `not JSON: ${String(e.message || e).slice(0, 120)}` }; } };

  const objects = topLevelJsonObjects(trimmed);
  let r = attempt(trimmed);
  let salvaged = false;
  if (r.err) {
    const first = objects[0] || null;
    if (first && first !== trimmed) {
      const retry = attempt(first);
      if (!retry.err) { r = retry; salvaged = true; }
    }
  }
  if (r.err) return { error: r.err, jsonObjects: objects.length };
  const obj = r.obj;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'not an object', jsonObjects: objects.length };
  return {
    salvaged,
    jsonObjects: objects.length,
    proposal: {
      bindings: Array.isArray(obj.bindings) ? obj.bindings : [],
      unbound: Array.isArray(obj.unbound) ? obj.unbound : [],
      wantsPhysical: Array.isArray(obj.wantsPhysical) ? obj.wantsPhysical : [],
      hypotheses: Array.isArray(obj.hypotheses) ? obj.hypotheses : [],
      notes: obj.notes || null,
    },
  };
}

// ---------------------------------------------------------------------------
// THE HYPOTHESIS CHANNEL (TRD-86, 2026-09-15).
// ---------------------------------------------------------------------------
//
// WHY IT EXISTS. The reviewer kept refusing instruments with "the evidence is absent" — correctly, but
// uselessly. There was no channel in which it could say the useful thing instead: *here is what I
// believe, here is what would prove me wrong, and here is the data the test needs*. `wantsPhysical`
// existed and nothing consumed it; this is the same channel with the claim attached.
//
// A HYPOTHESIS IS NOT A BINDING, AND THAT IS ENFORCED STRUCTURALLY, NOT PROMISED. A binding says "run
// this"; a hypothesis says "here is a claim and its falsifier". Only the lab decides whether a claim is
// true. So a hypothesis must never be able to widen scope — and the guarantee is that `validateProposal`
// builds `patch` and `scopeAdd` from `bindings` ALONE. A test asserts that a hypotheses-only reply
// produces an empty scopeAdd, because a rule that lives only in a comment is not a rule.
//
// ★ REFUSALS ARE PER-HYPOTHESIS, NOT PER-REPLY. This is the same defect class as the empty-params bug
// found earlier today: one bad item must not make an entire reply inert, or a malformed hypothesis about
// Gold would silently kill the scope decision about Sugar in the same response. A refused hypothesis is
// DROPPED and RECORDED, the bindings beside it still land, and the reply-level reasons get a `warn` at
// most — never an `error`, which would flip `accepted` to false and take the whole proposal with it.

// `requiredData` accepts either `["id"]` or `[{sourceId:"id"}]`: the model produced both shapes, and
// refusing one of them would be pedantry, not validation.
function normaliseRequiredData(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const id = typeof item === 'string' ? item : (item && (item.sourceId || item.id));
    if (id != null && String(id).trim()) out.push(String(id).trim());
  }
  return [...new Set(out)];
}

function validateHypotheses(list, { symbols = [], registry = null } = {}) {
  const binding = require('./binding');
  const telemetry = require('./telemetrySources');
  const known = new Set(symbols);
  const rows = [];
  for (const h of Array.isArray(list) ? list : []) {
    const reasons = [];
    const row = {
      symbol: (h && h.symbol) || null,
      statement: String((h && h.statement) || '').trim(),
      falsifiableBy: (h && h.falsifiableBy) || null,
      requiredData: normaliseRequiredData(h && h.requiredData),
    };
    if (!h || typeof h !== 'object' || Array.isArray(h)) {
      reasons.push({ level: 'error', reason: 'a hypothesis must be an object' });
    } else {
      if (!row.symbol) reasons.push({ level: 'error', reason: 'a hypothesis must name a symbol' });
      else if (!known.has(row.symbol)) reasons.push({ level: 'error', reason: `"${row.symbol}" is not on the watchlist` });
      if (!row.statement) reasons.push({ level: 'error', reason: 'a hypothesis must state a claim - an empty statement is not falsifiable' });

      // 2. THE FALSIFIER. "An AI cannot invent an edge", so the only safe form of an AI-authored claim
      // is one something can contradict. A claim with no named falsifier is refused at the door.
      const fb = (row.falsifiableBy && typeof row.falsifiableBy === 'object' && !Array.isArray(row.falsifiableBy)) ? row.falsifiableBy : {};
      const byStrategy = String(fb.strategy || '').trim();
      const needsAuthoring = fb.needsAuthoring === true;
      if (byStrategy && needsAuthoring) {
        reasons.push({ level: 'error', reason: 'falsifiableBy names BOTH an existing strategy and needsAuthoring - exactly one must be true' });
      } else if (!byStrategy && !needsAuthoring) {
        reasons.push({ level: 'error', reason: 'no falsifier: name an existing strategy that would test this, or declare {"needsAuthoring":true,"sketch":"..."}' });
      } else if (needsAuthoring && !String(fb.sketch || '').trim()) {
        reasons.push({ level: 'error', reason: 'needsAuthoring:true with no sketch - a claim whose test cannot even be sketched is not a hypothesis' });
      } else if (byStrategy) {
        const strat = registry && typeof registry.get === 'function' ? registry.get(byStrategy) : null;
        if (!strat) reasons.push({ level: 'error', reason: `falsifiableBy names unknown strategy "${byStrategy}"` });
        else if (row.symbol && !binding.eligibleOn(byStrategy, row.symbol, registry)) {
          reasons.push({
            level: 'error',
            reason: `"${byStrategy}" can never run on ${row.symbol}${Array.isArray(strat.symbols) && strat.symbols.length ? ` (track-bound to ${JSON.stringify(strat.symbols)})` : ''}, so it cannot be the test`,
          });
        }
      }

      // 3. THE DATA. A test for data that does not exist is not a plan, so an unfetchable source is an
      // ERROR, answered in the catalogue's own words. A missing adapter or credential is a to-do, and is
      // recorded as a warn: the gap stays funded instead of forgotten.
      for (const id of row.requiredData) {
        const req = telemetry.resolveRequirement(id);
        if (!req.testable) {
          reasons.push({ level: 'error', reason: `requiredData "${id}" cannot be fetched: ${req.refuseReason}` });
          continue;
        }
        if (req.state !== 'ready') reasons.push({ level: 'warn', reason: `requiredData "${id}" is ${req.state}: ${req.reason}` });
        if (row.symbol && Array.isArray(req.instruments) && req.instruments.length && !req.instruments.includes(row.symbol)) {
          reasons.push({ level: 'warn', reason: `the catalogue declares "${id}" for ${JSON.stringify(req.instruments)}, not ${row.symbol}` });
        }
      }
    }
    row.status = reasons.some((r) => r.level === 'error') ? 'refused' : 'accepted';
    row.reasons = reasons;
    rows.push(row);
  }
  return { rows, accepted: rows.filter((r) => r.status === 'accepted'), refused: rows.filter((r) => r.status === 'refused') };
}

// Validate against the REAL guards. Returns the patch the proposal WOULD write, and every reason it was
// refused. `accepted` means "safe to hand to the owner", NOT "applied" - nothing here applies anything.
function validateProposal(proposal, { settings = null, symbols = [], registry, candidates = [], overrides = {}, gate = null } = {}) {
  const binding = require('./binding');
  const reasons = [];
  const bindings = (proposal && proposal.bindings) || [];
  const known = new Set(symbols);

  // ★ `patch` AND `scopeAdd` ARE BUILT FROM `bindings` ONLY. The hypothesis channel below cannot reach
  // either of them, which is what "an untested hypothesis grants no scope" means in practice.
  const patch = {};
  const scopeAdd = {};
  for (const b of bindings) {
    if (!b || !b.symbol || !b.strategy) { reasons.push({ level: 'error', reason: 'a binding is missing symbol or strategy' }); continue; }
    if (!known.has(b.symbol)) { reasons.push({ level: 'error', symbol: b.symbol, strategy: b.strategy, reason: `"${b.symbol}" is not on the watchlist` }); continue; }
    if (!String(b.rationale || '').trim()) { reasons.push({ level: 'error', symbol: b.symbol, strategy: b.strategy, reason: 'no rationale - a binding without a stated reason cannot be reviewed' }); continue; }
    // A binding with NO parameters carries no VALUES, so it must not create a symbolParams entry. An
    // empty object still lands in the config, and validate() then reports it as a RETUNE of a frozen
    // strategy - a false positive that made the whole proposal unacceptable. Found on a forced live
    // proposal: the reviewer emitted {Gold: {survgold: {}}} to say "keep this binding as it is", and the
    // guard read it as an attempt to retune the frozen survivor.
    if (Object.keys(b.params || {}).length) {
      patch[b.symbol] = patch[b.symbol] || {};
      patch[b.symbol][b.strategy] = { ...(b.params || {}) };
    }
    // ★ IS THIS PAIR PERMITTED TODAY? The same binding means two different things and only the settings
    // can say which: a VALUE CHANGE on a pair that already runs, or a SCOPE ADDITION on one that does
    // not. Reporting them as one thing is how a scope proposal became an inert param change.
    const current = binding.inScopeIds(settings || {}, b.symbol, registry).raw;
    if (!current.includes(b.strategy)) {
      scopeAdd[b.symbol] = [...(scopeAdd[b.symbol] || current), b.strategy];
    }
  }

  // 1. The existing config guards, REUSED rather than restated. The patch is merged over the REAL
  // settings so the guards see the true enabled list and symbolScope - validating against a stub would
  // invent warnings (e.g. "not in strategies.enabled") that the real config does not have. The SCOPE
  // additions go in too, so the track-bound and unknown-strategy checks see the intended end state
  // rather than the state before the proposal.
  const realStrategies = (settings && settings.strategies) || {};
  const merged = {
    strategies: {
      ...realStrategies,
      symbolParams: { ...(realStrategies.symbolParams || {}), ...patch },
      ...(Object.keys(scopeAdd).length ? { symbolScope: { ...(realStrategies.symbolScope || {}), ...scopeAdd } } : {}),
    },
  };
  for (const p of binding.validate(merged, { symbols, registry })) reasons.push({ ...p, source: 'binding.validate' });

  // 2. The live-eligibility gate: a pair the gate DECLINES must be declared as an override request.
  if (gate) {
    const labGate = require('./lab/gate');
    for (const b of bindings) {
      if (!b || !b.symbol || !b.strategy) continue;
      const cfg = { ...gate, overrides };
      const decision = labGate.observe(cfg, { strategyId: b.strategy, symbol: b.symbol });
      if (decision.action === 'allow') continue;

      // ★ AN EXEMPTION IS NOT A REFUSAL (corrected 2026-09-15). gate.apply() blocks on `would_refuse`
      // ONLY - an exemption is non-blocking BY CONSTRUCTION - and the owner's decision of 2026-09-15 was
      // explicitly "exempt but recorded", so that how much of the desk runs on an exemption is a visible
      // NUMBER rather than a hidden permission.
      //
      // This check used to require action === 'allow', which no exempt pair can ever produce. Every
      // strategy declared UNCOVERED (meanrev, macd, rsi2, multi, congress, survgold, survoil) and every
      // mapped strategy with no candidate for that symbol therefore made the proposal `accepted: false` -
      // and applyScope requires accepted. The capability existed and was UNREACHABLE: the reviewer could
      // propose a scope addition and it could never be applied. Found by forcing a real proposal, which
      // proposed exactly one addition and was refused for being exempt.
      if (decision.action === 'exempt') {
        reasons.push({
          level: 'warn', symbol: b.symbol, strategy: b.strategy, source: 'live-eligibility gate',
          reason: `EXEMPT, not validated: ${decision.reason}. Recorded rather than refused, so the exemption share stays a visible number.`,
        });
        continue;
      }

      // `would_refuse` and `unmapped` DO block. One is the gate declining a pair it has a case against;
      // the other is a strategy nobody has classified, which is a defect rather than a policy outcome.
      const requested = String(b.overrideReason || '').trim();
      const retry = requested
        ? labGate.observe({ ...cfg, overrides: { ...overrides, [`${b.strategy}:${b.symbol}`]: requested } }, { strategyId: b.strategy, symbol: b.symbol })
        : null;
      if (!(retry && retry.action === 'allow')) {
        reasons.push({
          level: 'error', symbol: b.symbol, strategy: b.strategy, source: 'live-eligibility gate',
          reason: `the gate would not permit this pair (${decision.outcome}) and ${requested ? 'the override reason still did not clear it' : 'no overrideReason was given'}`,
        });
      }
    }
    void candidates;
  }

  // 3. THE HYPOTHESIS CHANNEL. Validated for admissibility and RECORDED - and deliberately unable to
  // contribute to `patch` or `scopeAdd`. Refusals are per-hypothesis: they surface as a warn, so the
  // bindings in the same reply are unaffected.
  const hypotheses = validateHypotheses((proposal && proposal.hypotheses) || [], { symbols, registry });
  if (hypotheses.refused.length) {
    const first = (h) => `${h.statement || h.symbol || 'unnamed'} — ${(h.reasons.find((r) => r.level === 'error') || {}).reason || 'no reason given'}`;
    reasons.push({
      level: 'warn',
      reason: `${hypotheses.refused.length} hypothesis(es) REFUSED and recorded (the bindings in this reply are unaffected): ${hypotheses.refused.map(first).join(' | ')}`,
    });
  }

  const errors = reasons.filter((r) => r.level === 'error');
  return {
    accepted: errors.length === 0,
    reasons,
    patch,
    scopeAdd,
    hypotheses,
    overrideRequests: bindings.filter((b) => String((b && b.overrideReason) || '').trim()).map((b) => ({ symbol: b.symbol, strategy: b.strategy, reason: b.overrideReason })),
  };
}

// ---------------------------------------------------------------------------
// The call. PROPOSES AND RECORDS. Writes no settings, places no order.
// ---------------------------------------------------------------------------
async function propose(userId, settings, { force = false, registry = null, now = new Date() } = {}) {
  const store = require('../store');
  const reg = registry || require('./strategies');
  const binding = require('./binding');
  const labGate = require('./lab/gate');
  const telemetry = require('./telemetrySources');

  const symbols = ((settings.watchlist || {}).symbols || []);
  const symbolNames = symbols.map((s) => s.symbol);
  const bpCfg = settings.bindingProposer || {};

  // Evidence per (symbol, strategy): what the lab actually said, and what the gate would do.
  const labRead = await labGate.loadCandidates(userId);
  const gateCfg = labGate.configFrom(settings, labRead.candidates);
  const table = binding.bindingTable(settings, { symbols: symbolNames, registry: reg });
  const evidence = [];
  for (const row of table.symbols) {
    for (const b of row.strategies) {
      const d = labGate.observe(gateCfg, { strategyId: b.strategy, symbol: row.symbol });
      evidence.push({ symbol: row.symbol, strategy: b.strategy, outcome: d.outcome, eligible: d.action === 'allow', candidates: (d.candidates || []).map((c) => ({ id: c.id, status: c.status, verdict: c.verdict })) });
    }
  }

  const coverage = telemetry.coverage(symbolNames);
  // TRD-76: the VALUES the wired sources actually returned, with their as-of dates. Read from what the
  // desk has RECORDED rather than fetched here, so a wake never borrows a third party's outage and the
  // proposal cannot cite an observation that moved underneath it mid-decision. A read failure degrades
  // to "no recorded values" and must not stop the review.
  let physicalValues = {};
  try {
    const tvalues = require('./telemetry/values');
    physicalValues = tvalues.render(await tvalues.latest(userId, { now }), symbolNames);
  } catch { physicalValues = {}; }
  const scope = {};
  for (const row of table.symbols) scope[row.symbol] = { permitted: row.strategies.map((b) => b.strategy), source: row.scopeSource };
  // TRD-85: the same gate config the evidence uses, so a candidate and an in-scope pair are judged by ONE
  // rule rather than two that could drift.
  const candidates = candidateSets({ symbols: symbolNames, settings, registry: reg, gate: { candidates: labRead.candidates, enforce: false, overrides: {} } });

  const input = buildReviewInput({
    instruments: symbols,
    scope,
    candidates,
    bindingTable: table,
    evidence,
    coverage,
    physicalValues,
    rules: {
      frozen: 'never propose params for a tunable:false strategy - it is rejected and does nothing',
      override: 'a pair whose lab evidence is not eligible requires overrideReason - and that includes a pair you are ADDING to scope, whose evidence is usually ABSENT rather than bad',
      unboundIsAllowed: true,
      // ★ THE SCOPE RULE HAS TO BE IN THE INPUT AS WELL AS THE SYSTEM PROMPT. The reviewer was asked to
      // propose bindings and then handed a `scope` map with empty `permitted` lists, which reads as a
      // closed door. It answered "scope explicitly permits no strategy" for every symbol but Gold and Oil,
      // so the desk could only ever trade the two that already had a frozen survivor - the exact outcome
      // the owner asked to fix. Adding the capability without saying so would have changed nothing.
      scopeMayBeExtended: true,
      scopeNote: 'scope reports the CURRENT state. It is not a limit on what you may propose: a binding for a pair that is not permitted is a SCOPE ADDITION that puts the pair in scope and starts the desk trading that instrument. Propose one if you can justify it.',
      // Demo means a simulated venue, so a pairing may legitimately exist to GENERATE evidence.
      mode: (settings.paper && settings.paper.enabled) ? 'sim' : 'demo',
      modeNote: 'in demo, proposing a pairing in order to COLLECT LIVE EVIDENCE is a valid answer - say exactly that in the rationale rather than dressing it up as validation.',
      tunableStrategies: Object.values(reg.REGISTRY).filter((s) => Array.isArray(s.params) && s.params.length).map((s) => ({ id: s.id, params: s.params })),
    },
  });
  const sig = signature(input);

  const recent = await store.listEvents(userId, { kind: 'binding_proposal', limit: 1 }).catch(() => []);
  const last = recent && recent[0];
  // ⚠ THE FIELD IS CALLED inputSig, NOT signature, AND THAT IS LOAD-BEARING.
  // trading/agent/log.js redacts any key matching /(password|...|signature|...)/i at the LOGGING
  // boundary, so a field named `signature` is stored as the literal string "[REDACTED]". Reading it
  // back would give a value that never matches, lastSig would be null on every run, and both the 12h
  // floor and the 168h ceiling would be silently bypassed - the cadence defeated by a field name, with
  // no error anywhere. Found 2026-09-15 by reading the live lab_gate row and noticing
  // "signature":"[REDACTED]" with redacted:["signature"].
  const lastSig = (eventPayload(last) || {}).inputSig || null;
  const lastAt = last ? last.createdAt : null;
  const gateDecision = shouldPropose({
    sig,
    lastSig,
    lastAt,
    now: now.getTime(),
    // Read the numbers EXPLICITLY rather than with `|| default`, so a deliberate 0 is not silently
    // turned back into the default. 0 is meaningful for both: floor 0 = no floor, ceiling 0 = off.
    minIntervalH: bpCfg.minIntervalH == null ? 12 : Number(bpCfg.minIntervalH),
    maxStaleH: bpCfg.maxStaleH == null ? DEFAULT_MAX_STALE_H : Number(bpCfg.maxStaleH),
  });
  if (!force && !gateDecision.propose) {
    // A writer that is armed must not have to wait for the reviewer's INPUT to move before it can act on
    // a decision the reviewer has ALREADY made and had accepted. See strandedProposal above.
    const stranded = (bpCfg.autoTighten === true || bpCfg.autoScope === true) ? await strandedProposal(userId) : null;
    if (stranded) {
      return {
        skipped: gateDecision.why, inputSig: sig, stranded: true,
        proposal: { bindings: stranded.bindings, unbound: stranded.unbound || [], hypotheses: stranded.hypotheses || [] },
        accepted: true,
        overrideRequests: stranded.overrideRequests || [],
      };
    }
    return { skipped: gateDecision.why, inputSig: sig };
  }

  const budget = require('./budget');
  const allowance = await budget.allow(userId, settings, 'binding');
  if (!allowance || !allowance.allowed) return { skipped: 'budget_cap', inputSig: sig };

  const deepseek = require('./deepseek');
  const llm = settings.llm || {};
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(input) }];
  const ask = (maxTokens) => deepseek.callChat(messages, {
    model: llm.model || undefined, temperature: 0.2, maxTokens,
    // The reviewer's own budget, not the global one: see DEFAULT_TIMEOUT_MS.
    timeoutMs: Number(bpCfg.timeoutMs) || DEFAULT_TIMEOUT_MS,
    // TRD-84 (2026-09-20): LABELLED, so its cost is finally attributable in the record. This call already
    // passed `userId`, but every `llm_usage` row read `unlabelled`, and this is the one caller whose cost
    // was argued about ("~14k tokens per proposal") without a per-call number behind it. The escalation to
    // MAX_TOKENS_RETRY is a second billed call with the same label, which is the honest picture.
    jsonMode: true, userId, label: 'binding',
  });

  let reply = null;
  let truncated = false;
  try {
    reply = await ask(MAX_TOKENS);
    if (deepseek.isTruncatedEmpty(reply, MAX_TOKENS)) {
      reply = await ask(MAX_TOKENS_RETRY);
      // Still nothing at the escalated cap = the reviewer cannot finish inside it. Say THAT, not "empty".
      truncated = deepseek.isTruncatedEmpty(reply, MAX_TOKENS_RETRY);
    }
  } catch (e) {
    await store.logEvent(userId, 'binding_proposal', { inputSig: sig, error: String(e.message || e).slice(0, 200), at: now.toISOString(), applied: false, forced: force || undefined });
    return { error: String(e.message || e).slice(0, 200), inputSig: sig };
  }

  if (reply && reply.usage) {
    // TRD-104: a forced run is billed (the tokens were spent) but MARKED, so the record and the meter can
    // separate a diagnostic session from the desk's own 12h cadence. Untagged, the two are identical, and
    // the 2026-09-15 debug cluster read as the proposer spending 26.6% of a day on its own.
    budget.record(userId, 'binding', reply.usage, { forced: force === true, settings }).catch(() => {});
    deepseek.meterUsage(reply.model, reply.usage).catch(() => {});
  }

  const parsed = parseProposal(reply && reply.text);
  const verdict = parsed.error
    ? {
      accepted: false,
      reasons: [{
        level: 'error',
        // A truncated reply and a malformed one need DIFFERENT fixes, so they must not produce the same
        // sentence. This one is a budget fact, and it names the number that was not enough.
        reason: truncated
          ? `reviewer returned nothing: the ${MAX_TOKENS_RETRY}-token cap was consumed entirely by reasoning (prompt ${((reply && reply.usage && reply.usage.promptTokens) || 0) + ((reply && reply.usage && reply.usage.promptCacheHitTokens) || 0) + ((reply && reply.usage && reply.usage.promptCacheMissTokens) || 0)} tokens in). Raise the cap or narrow the input.`
          : `unparseable reply: ${parsed.error}`,
      }],
      patch: {},
      scopeAdd: {},
      hypotheses: { rows: [], accepted: [], refused: [] },
      overrideRequests: [],
    }
    : validateProposal(parsed.proposal, {
      settings,
      symbols: symbolNames,
      registry: reg,
      overrides: {},
      gate: { candidates: labRead.candidates, enforce: false, overrides: {} },
    });

  // TRD-105: screen a WIDENING against the path itself, before it can be recorded as accepted. A refusal
  // here is final end-to-end, because applyScope requires accepted === true.
  const edgeScreen = await scopeEdgeScreen(userId, verdict.accepted ? (verdict.scopeAdd || {}) : {});
  if (edgeScreen && edgeScreen.refusal) {
    verdict.accepted = false;
    verdict.reasons = [...(verdict.reasons || []), edgeScreen.refusal];
  }

  // RECORDED whether or not it was accepted. A refused proposal is the useful one.
  await store.logEvent(userId, 'binding_proposal', {
    inputSig: sig, // NOT `signature` - see the redaction note above
    promptVersion: PROMPT_VERSION,
    model: (reply && reply.model) || null,
    applied: false,
    accepted: verdict.accepted,
    reasons: verdict.reasons,
    overrideRequests: verdict.overrideRequests,
    wouldWrite: verdict.patch,
    wouldAddScope: verdict.scopeAdd || {},
    // The bindings THEMSELVES, not only the patch they imply: a proposal accepted while no writer was
    // armed has to be re-offerable later, and the ops it implies cannot be rebuilt from `wouldWrite`
    // alone (wouldWrite holds values, not the decision to put a pair in scope).
    bindings: (parsed.proposal && parsed.proposal.bindings) || [],
    unbound: (parsed.proposal && parsed.proposal.unbound) || [],
    wantsPhysical: (parsed.proposal && parsed.proposal.wantsPhysical) || [],
    // TRD-86: the claims and what would falsify them. Recorded on the SAME event as the bindings, because
    // a hypothesis is part of the same decision and splitting it would let the two drift apart.
    hypotheses: (parsed.proposal && parsed.proposal.hypotheses) || [],
    hypothesesVerdict: verdict.hypotheses || null,
    notes: (parsed.proposal && parsed.proposal.notes) || null,
    parsed: !!parsed.proposal,
    // Recorded rather than silent: a salvaged reply means the model appended prose, and that is worth
    // seeing in the trail (the prompt may need tightening, or the behaviour may be drifting). A reply
    // with MORE THAN ONE top-level object is a protocol violation, and the desk currently parses the
    // FIRST of them — so the count is the evidence needed before deciding how to handle that.
    salvaged: parsed.salvaged || undefined,
    jsonObjects: parsed.jsonObjects > 1 ? parsed.jsonObjects : undefined,
    truncated: truncated || undefined,
    // TRD-104: whether this was the desk's cadence or a forced diagnostic run. `force` bypasses
    // shouldPropose BY DESIGN (that is what it is for), so a forced call is the one case where the
    // 12h floor / 168h ceiling does not explain the spend — and until now it was unrecorded, which made
    // a debug session indistinguishable from a cadence that had stopped throttling.
    // TRD-105: what the net-edge screen made of the pairs this proposal would add to scope. Recorded even
    // when it passes (or could not run), because "screened and clean" and "never screened" must not look
    // the same in the trail.
    netEdgeScreen: edgeScreen ? edgeScreen.checked : undefined,
    forced: force || undefined,
    at: now.toISOString(),
  }).catch(() => {});

  return {
    inputSig: sig, promptVersion: PROMPT_VERSION, accepted: verdict.accepted,
    reasons: verdict.reasons, overrideRequests: verdict.overrideRequests,
    wouldWrite: verdict.patch, wouldAddScope: verdict.scopeAdd || {},
    hypotheses: verdict.hypotheses || { rows: [], accepted: [], refused: [] },
    proposal: parsed.proposal || null, applied: false,
  };
}

module.exports = {
  PROMPT_VERSION, MAX_TOKENS, MAX_TOKENS_RETRY, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_STALE_H, INPUT_KEYS, SYSTEM,
  buildReviewInput, signature, shouldPropose, parseProposal, validateProposal, propose, eventPayload, strandedProposal, candidateSets, CANDIDATES_NOTE,
  validateHypotheses, normaliseRequiredData, topLevelJsonObjects, firstJsonObject,
  // Exported for the same reason `exitLevels.decideClose` and `wakePipeline.adverseStopCap` are: the screen
  // can then be driven over real pairs without spending a single token on an LLM call.
  scopeEdgeScreen,
};
