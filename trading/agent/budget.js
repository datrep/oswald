// trading/agent/budget.js — TRD-12 Phase 2: granular LLM token budget.
// Per-consumer daily caps + one total daily cap + a boost-until toggle (3x).
// Usage is metered per call (event kind 'llm_usage'); gates SOFT-stop consumers
// (skip LLM calls when over — never hard-kill the desk). Loud Telegram alert
// once/day at 80% of the total cap.
'use strict';

const store = require('../store');
const { telegramAlert } = require('../lib/http');

// 'binding' added 2026-09-15 (TRD-75): the binding reviewer's calls were being recorded under a
// consumer name that is not on this list, and record() RETURNS EARLY for an unknown consumer - so its
// usage was never metered at all, while the report claimed it was "metered to its own budget consumer".
// A consumer absent from this list is invisible to the budget in BOTH directions.
//
// 'news' added 2026-10-03 (news S1 build, open-work 4.19): S1/S2 spend ZERO tokens, but the name must
// be METERABLE before it is ever spendable - the classification step (its own pre-registration, cap
// 60,000/day decided 2026-10-03) is the first caller, and `allow()` fails closed on unknown_consumer.
const CONSUMERS = ['chair', 'central', 'review', 'pulse', 'digest', 'whitepaper', 'ask', 'autopsy', 'strategy_tune', 'shadow', 'binding', 'news', 'analyses-vision'];

function budgetSettings(settings) {
  const b = settings.budget || {};
  return {
    totalDaily: Number(b.totalDaily ?? 150000),
    perConsumer: { ...(b.perConsumer || {}) },
    boostUntil: b.boostUntil || null,
    warnPct: Number(b.warnPct ?? 80),
    pricing: b.pricing || null,
  };
}

// ★★ TRD-LLM-1: LLM SPEND IS NOT DERIVABLE FROM THE LEDGER BECAUSE NO PRICE IS IN IT.
//
// The meter records TOKENS and has done since TRD-107; `equityCurve` is pure trading equity. So the
// question "do the LLMs pay for themselves" had no answer from the record, only from a per-report
// conversion — which means the answer changed with whoever did the converting.
//
// THE PRICE IS A SETTINGS VALUE, and it is THREE rates rather than one because the meter already
// records the three quantities that need them: `promptCacheHitTokens`, `promptCacheMissTokens` and
// `completionTokens` (TRD-107 kept the cache split for exactly this reason). A single blended $/M would
// discard the split the desk went to the trouble of preserving.
//
// ⚠ ABSENT IS NOT ZERO. If no price is configured, `costOf` returns null and NO cost field is written —
// it does not write 0. `Number(null) === 0` rendering "unpriced" as "free" is the TRD-96 defect class
// (a missing cap drawn as the safest row in the table), and it would be worse here: a free LLM is a
// conclusion, and "nobody has told me the price" is not.
function pricingOf(settings) {
  const p = (settings && settings.budget && settings.budget.pricing) || null;
  if (!p) return null;
  // ⚠⚠ CAUGHT BY THIS MODULE'S OWN TEST, AND IT IS THE DEFECT CLASS THIS ROW EXISTS TO FIX.
  //
  // The first version was `const hit = Number(p.inputHitPerM); if (!ok(hit) ...) return null;` with
  // `ok = (v) => Number.isFinite(v) && v >= 0`. **`Number(null) === 0`**, so a rate of `null` passed the
  // guard as **0** — and a 0 rate is not "missing", it is "this bucket is FREE". A settings row with
  // `inputHitPerM: null` would therefore have priced every cache HIT at zero and reported the desk's
  // cheapest tokens as costing nothing, which is the same shape as `Number(null) === 0` rendering an
  // absent cap as "0% used" (TRD-96) and an absent fill as a zero-price geometry (exitLevels.js).
  //
  // The precedent is explicit: `exitLevels.num()` rejects null/'' BEFORE coercing, because "a missing
  // value silently computes from zero" is a recurring trap here. Same treatment, same reason.
  // Booleans are refused too: `Number(true) === 1` would price a bucket at $1/M.
  const raw = (v) => {
    if (v == null || v === '' || typeof v === 'boolean' || typeof v === 'object') return NaN;
    return Number(v);
  };
  const hit = raw(p.inputHitPerM);
  const miss = raw(p.inputMissPerM);
  const out = raw(p.outputPerM);
  const ok = (v) => Number.isFinite(v) && v >= 0;
  if (!ok(hit) || !ok(miss) || !ok(out)) return null;
  return { inputHitPerM: hit, inputMissPerM: miss, outputPerM: out };
}

// Price ONE call's tokens. Pure, so it can be reconciled against a stored row later.
// Returns null when there is no price — never a zero-cost object.
function costOf(tokens, pricing) {
  const p = pricing || null;
  if (!p) return null;
  const completion = Number(tokens && tokens.completion) || 0;
  const hit = Number(tokens && tokens.hit) || 0;
  const miss = Number(tokens && tokens.miss) || 0;
  const usd = (hit / 1e6) * p.inputHitPerM + (miss / 1e6) * p.inputMissPerM + (completion / 1e6) * p.outputPerM;
  return {
    costUsd: Math.round(usd * 1e6) / 1e6,
    tokens: { hit, miss, completion },
    pricingUsed: p,
  };
}

function dayStartUtc() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

// TRD-77: the token COUNTS written before this instant were destroyed at write time (the redaction
// sweep struck completionTokens/promptTokens in 945 of 1002 llm_usage rows). They are NOT zero, they
// are NOT MEASURABLE, and no analysis can recover them. Published here so a spend report cannot
// silently render the blank era as a quiet one.
const METER_TRUSTED_FROM = '2026-09-14T17:51:00Z';

// Today's usage per consumer from the meter events.
//
// TRD-77: this read reports its own shape. `fetched` is what the page cap actually allowed,
// `requestedLimit` is what was asked for, and `calls` is how many rows were counted — because a
// caller that cannot tell a TOTAL from a FLOOR will report the floor as a total with full
// confidence, which is precisely how this meter was blind for four days.
//
// The limit is the page cap rather than a larger number on purpose: asking for 2000 while the store
// clamps to 500 makes the code state an intent it cannot honour. The cap is the honest request, and
// saturation is detected rather than hidden (`agent/meterIntegrity.js`).
//
// ★★ 2026-09-30 — SATURATION WAS DETECTED AND STILL LOST. Detecting a full page is not the same as
// READING PAST IT, and the detector firing every day is not a substitute for the meter being right.
// The three parities above all held while this still summed one page: measured 2026-09-29, 549 calls
// for the day and 500 read — 71,086 tokens (5.3%) invisible, per-consumer, so `shadow` stood at
// 270,022 (90.0% of its 300,000 cap) and was published as 243,093 (81.0%), and `digest`'s only call
// was invisible at 0. The gate reads THIS number to decide `allowed`, so the missing 9 points of
// shadow's headroom were 9 points of cap the gate could spend past.
//
// So the read now WALKS the day (`store.listEventsAll`, keyset on `id`) instead of taking its newest
// page. The JS arithmetic below is deliberately unchanged — `Number(...) || 0` over the meter's own
// field names — because `agent/meterIntegrity.js` exists to compare this path against a SQL sum that
// shares none of it. Making this read SQL-powered would have made the detector compare SQL to SQL and
// silently retire the one control that caught this. What changed is only the ROW SET: all of today,
// not the newest 500 of it.
async function todayUsage(userId) {
  const requestedLimit = store.EVENT_QUERY_CAP || 500;
  const since = dayStartUtc();
  // The window and the sum must cover the same population — today, in full. `truncated` is the one
  // way this can still be a floor, and when it is true the detail below says so out loud rather than
  // letting a bounded walk pass for a total.
  const { rows: events, pages, truncated } = await store.listEventsAll(userId, { kind: 'llm_usage', since, pageSize: requestedLimit });
  const from = since.getTime();
  const usage = { total: 0, by: {} };
  let calls = 0;
  for (const e of events) {
    if (new Date(e.createdAt).getTime() < from) continue;
    calls += 1;
    const p = e.payload || {};
    const tok = (Number(p.completionTokens) || 0) + (Number(p.promptTokens) || 0);
    usage.total += tok;
    usage.by[p.consumer] = (usage.by[p.consumer] || 0) + tok;
  }
  usage.calls = calls;
  usage.fetched = events.length;
  usage.pages = pages;
  usage.truncated = !!truncated;
  usage.cap = store.EVENT_QUERY_CAP || null;
  usage.requestedLimit = requestedLimit;
  return usage;
}

// TRD-96 (2026-09-18): the OLD version did `Number(bs.perConsumer[consumer])`, which is NaN for a
// consumer with no configured sub-cap — and NaN is not finite, so `per` became null, `allow()` read
// null as "there is no sub-cap to check" and SKIPPED the check, and `summary()` rendered `cap ?? 0`
// → "cap 0 / 0% used". So the two consumers that could spend WITHOUT any sub-cap (shadow, binding)
// were drawn as the safest rows in the table. Today: shadow 104,398 tokens / 78 calls and binding
// 47,674 / 2 calls, both invisible.
//
// The fix is NOT to invent numbers — it is to stop representing "no cap configured" as zero. A
// missing / empty / non-numeric cap is now reported as `uncapped: true`, and the caller can see it.
// Only a real number is a cap. (An explicit `null` also means uncapped here: "no cap" is what a null
// key says, and reading it as `Number(null) === 0` would silently refuse every call.)
function capFor(bs, consumer, _usageTotal) {
  const boost = bs.boostUntil && Date.now() < new Date(bs.boostUntil).getTime() ? 3 : 1;
  const raw = bs.perConsumer[consumer];
  const configured = raw != null && raw !== '' && Number.isFinite(Number(raw));
  return { per: configured ? Number(raw) * boost : null, uncapped: !configured, total: bs.totalDaily * boost };
}

// Record one LLM call's usage (metering; failures never break the caller).
//
// TRD-104 (2026-09-19): `meta.forced` marks a call made by a FORCED diagnostic run rather than by the
// desk's own cadence. It is still billed to the same consumer and the same daily cap — deliberately,
// because the tokens were really spent and a meter that hides them is the TRD-77 failure — but WITHOUT
// the flag the record cannot tell the two apart, and a debug session reads exactly like the desk burning
// its own budget. Measured 2026-09-15: 216,775 tokens on 'binding', 26.6% of that day, dominated by
// clusters of forced runs minutes apart — which is how a later reading of the meter concluded the
// proposer was out of control when the cadence gate was in fact working.
//
// The precedent is `wakePipeline`'s provider snapshot, which already records `forced: !!force` for the
// same reason: two behaviours a reader must not have to guess between.
async function record(userId, consumer, usage, meta = null) {
  if (!usage || !CONSUMERS.includes(consumer)) return;
  const completion = Number(usage.completionTokens) || 0;
  const hit = Number(usage.promptCacheHitTokens) || 0;
  const miss = Number(usage.promptCacheMissTokens) || 0;
  const prompt = hit + miss;
  if (completion + prompt <= 0) return;
  // TRD-107 (2026-09-19): KEEP THE CACHE SPLIT. `promptTokens` stays the SUM, because the TRD-77 meter and
  // its integrity check both depend on that meaning — but the split is what says whether prompt caching is
  // working, and it was being thrown away here. The provider returns cacheHit/cacheMiss on EVERY call and
  // the only record of it went to `services/pricing.js`'s in-memory `stats`, which is process-local and
  // wiped by a restart, so the one number that determines cost-per-call was unmeasurable from the desk's
  // own event store. Without it, every prompt-size change is a guess in the dark.
  //
  // Both key names end in "Tokens", which matches log.js DENYLIST_KEY; they survive because they also match
  // COUNT_KEY and hold numbers, which is exactly the TRD-77 exception. Do not rename them.
  const payload = {
    consumer, completionTokens: completion, promptTokens: prompt,
    promptCacheHitTokens: hit, promptCacheMissTokens: miss,
  };
  if (meta && meta.forced === true) payload.forced = true;
  // ★★ TRD-LLM-1: PRICE THE CALL AT WRITE TIME, AND RECORD THE RATE THAT PRICED IT.
  //
  // The cost is written INTO the row rather than recomputed on read, deliberately: a later rate change
  // must not rewrite what an earlier call cost. Including `pricingUsed` is what makes the stored number
  // re-derivable instead of merely asserted — a reader can multiply the row's own tokens by the row's own
  // rate and must get the row's own cost back. That is the same "recorded value, not reconstructed
  // value" discipline the epoch work uses.
  //
  // When no price is configured the fields are ABSENT (see `pricingOf`) — not zero.
  const cost = costOf({ completion, hit, miss }, pricingOf(meta && meta.settings));
  if (cost) {
    payload.costUsd = cost.costUsd;
    payload.pricingUsed = cost.pricingUsed;
  } else {
    payload.unpriced = true; // explicit, so "no price configured" is readable and never renders as free
  }
  try { await store.logEvent(userId, 'llm_usage', payload); } catch { /* best-effort */ }
}

// Soft gate: is this consumer allowed to call the LLM right now?
async function allow(userId, settings, consumer) {
  // TRD-96 (2026-09-18): an UNKNOWN consumer name used to return `allowed: true` forever — there is no
  // sub-cap to read and no usage row to count, so the gate had nothing to compare and waved it through.
  // That is the gate-side mirror of TRD-75's record-side defect: `record()` returns early for a name
  // not on CONSUMERS, so such a caller's spend is invisible in BOTH directions while the desk believes
  // it is capped. Verified before the fix: `allow('nosuchconsumer')` → `{allowed:true, cap:null}`.
  // A name the budget cannot meter must not be a name the budget cannot refuse, so this fails CLOSED.
  // (A typo in a consumer name is a bug, not a licence to spend.)
  if (!CONSUMERS.includes(consumer)) {
    return { allowed: false, reason: 'unknown_consumer', consumer, cap: null, uncapped: false };
  }
  const bs = budgetSettings(settings);
  const usage = await todayUsage(userId);
  const { per, total } = capFor(bs, consumer, usage.total);
  if (per != null && (usage.by[consumer] || 0) >= per) {
    // v1.2 (2026-09-12 audit): sub-cap exhaustion pages the owner once a day
    // per consumer (fire-and-forget; the gate itself stays instant).
    maybeWarnConsumer(userId, settings, consumer).catch(() => {});
    return { allowed: false, reason: 'consumer_cap', used: usage.by[consumer] || 0, cap: per, uncapped: false };
  }
  if (usage.total >= total) return { allowed: false, reason: 'total_cap', used: usage.total, cap: total, uncapped: false };
  // `uncapped: true` on an ALLOWED call is the honest answer, not an error: this consumer has no
  // sub-cap, so the only limit on it today is the total. It is surfaced here so a caller (or the
  // self-health report) can say so out loud instead of inferring "0% used" from a null cap.
  return { allowed: true, used: usage.by[consumer] || 0, cap: per, uncapped: per == null, totalUsed: usage.total, totalCap: total };
}

// v1.2 (2026-09-12 audit): per-consumer sub-cap exhaustion pages the owner
// (once per consumer per day). Chair sub-cap exhaustion used to be silent —
// exactly the case that degrades entries to quant-only (the degraded-entry
// path exists because of it).
async function maybeWarnConsumer(userId, settings, consumer) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const recent = await store.listEvents(userId, { kind: 'budget_warn', limit: 30 });
    if (recent.some((e) => e.payload && e.payload.date === today && e.payload.consumer === consumer)) return;
    const bs = budgetSettings(settings);
    const usage = await todayUsage(userId);
    const cap = Number(bs.perConsumer[consumer]);
    await store.logEvent(userId, 'budget_warn', { date: today, consumer, used: usage.by[consumer] || 0, cap: Number.isFinite(cap) ? cap : null });
    await telegramAlert(`OSWALD LLM budget: '${consumer}' exhausted its daily sub-cap (${usage.by[consumer] || 0} tokens${Number.isFinite(cap) ? ` / ${cap}` : ''}) — that consumer is soft-stopped until the daily reset.`).catch(() => {});
  } catch { /* non-fatal */ }
}

// Once-per-day loud Telegram warning when the total cap crosses warnPct.
async function maybeWarn(userId, settings) {
  try {
    const bs = budgetSettings(settings);
    const usage = await todayUsage(userId);
    if (!bs.totalDaily || usage.total < bs.totalDaily * (bs.warnPct / 100)) return;
    const today = new Date().toISOString().slice(0, 10);
    // v1.2: match a TOTAL warn only (payload.consumer undefined) — consumer
    // sub-cap warns share the kind and must not mask the total-cap warn.
    const recent = await store.listEvents(userId, { kind: 'budget_warn', limit: 30 });
    if (recent.some((e) => e.payload && e.payload.date === today && !e.payload.consumer)) return;
    await store.logEvent(userId, 'budget_warn', { date: today, used: usage.total, cap: bs.totalDaily });
    await telegramAlert(`OSWALD LLM budget at ${Math.round(usage.total / bs.totalDaily * 100)}% of today's cap (${usage.total}/${bs.totalDaily} tokens).`).catch(() => {});
  } catch { /* non-fatal */ }
}

async function summary(userId, settings) {
  const bs = budgetSettings(settings);
  const usage = await todayUsage(userId);
  return {
    settings: bs,
    usage,
    // TRD-77: an accumulator whose history is partly destroyed must SAY SO where it is read.
    history: {
      meterTrustedFrom: METER_TRUSTED_FROM,
      note: 'Token counts written before this instant were destroyed at write time (TRD-77). Spend over an earlier period is NOT MEASURABLE — read it as blank, never as zero.',
    },
    consumers: CONSUMERS.map((c) => {
      const { per, uncapped } = capFor(bs, c, usage.total);
      const used = usage.by[c] || 0;
      // TRD-96: `cap: per ?? 0` + `pct: cap ? … : 0` made an UNCAPPED consumer print as "cap 0, 0%
      // used" — the same output a dormant consumer produces. An uncapped consumer is not at 0% of
      // anything; it has no denominator, so `pct` is null and `uncapped` says why. Consumers that are
      // simply unused keep `used: 0` with a real cap, so the two cases stay distinguishable.
      return { consumer: c, used, cap: per, uncapped, pct: per ? Math.round(used / per * 100) : null };
    }),
  };
}

// ★★ TRD-LLM-1: THE SPEND READER — the number that turns the token ledger into a money ledger.
//
// This is the half that was missing: `summary()` answers "how many tokens" and nothing answered "what did
// they cost", so every cost statement was a per-report conversion. This totals the cost the ROWS THEMSELVES
// recorded at write time, so the answer no longer depends on the rate in force when it is asked.
//
// ⚠ IT REPORTS ITS OWN COVERAGE, and that is not decoration. Three populations can be present and only one
// of them is a cost:
//   * rows with `costUsd`   -> priced, summed;
//   * rows with `unpriced`  -> written while no rate was configured. NOT zero. Counted separately.
//   * rows written BEFORE this field existed -> have neither key. Also NOT zero. Counted separately.
// Summing all three into one "spend" would report an unpriced era as a cheap one, which is the exact shape
// of the TRD-77 defect (a blank era rendered as a quiet one).
async function spend(userId, { since = null, limit = null } = {}) {
  const cap = limit || store.EVENT_QUERY_CAP || 500;
  const events = await store.listEvents(userId, { kind: 'llm_usage', limit: cap, ...(since ? { since } : {}) });
  const fetched = events.length;
  const out = {
    calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    costUsd: 0, pricedCalls: 0, unpricedCalls: 0, preCostEraCalls: 0,
    by: {},
    fetched, cap, truncated: fetched >= cap,
  };
  for (const e of events) {
    const p = e.payload || {};
    const completion = Number(p.completionTokens) || 0;
    const hit = Number(p.promptCacheHitTokens) || 0;
    const miss = Number(p.promptCacheMissTokens) || 0;
    const prompt = Number(p.promptTokens) || (hit + miss);
    out.calls += 1;
    out.promptTokens += prompt;
    out.completionTokens += completion;
    out.totalTokens += prompt + completion;
    const c = Number(p.costUsd);
    if (Number.isFinite(c)) { out.costUsd += c; out.pricedCalls += 1; }
    else if (p.unpriced === true) out.unpricedCalls += 1;
    else out.preCostEraCalls += 1;
    const k = p.consumer || '(none)';
    out.by[k] = out.by[k] || { calls: 0, tokens: 0, costUsd: 0 };
    out.by[k].calls += 1;
    out.by[k].tokens += prompt + completion;
    if (Number.isFinite(c)) out.by[k].costUsd += c;
  }
  out.costUsd = Math.round(out.costUsd * 1e6) / 1e6;
  out.coverage = {
    pricedCalls: out.pricedCalls,
    unpricedCalls: out.unpricedCalls,
    preCostEraCalls: out.preCostEraCalls,
    note: 'Only `pricedCalls` contribute to costUsd. `unpricedCalls` (no rate configured) and '
      + '`preCostEraCalls` (written before cost recording existed) are NOT zero and are counted separately.',
  };
  return out;
}

// The desk-owned answer to "do the LLMs pay for themselves", stated as a RATE rather than as a verdict,
// because a rate is what the record can actually support. Above this $/M the LLM spend would cancel the
// whole gain; below it, it cannot. Stated per-million-tokens so it is comparable to a published price.
function breakevenRatePerM({ gainUsd, tokens }) {
  const g = Number(gainUsd);
  const t = Number(tokens);
  if (!Number.isFinite(g) || !Number.isFinite(t) || t <= 0 || g <= 0) return null;
  return { perMillionTokens: (g / (t / 1e6)), gainUsd: g, tokens: t };
}

// `dayStartUtc` and `METER_TRUSTED_FROM` are exported so the detector and the meter cannot drift on
// where "today" begins or on when the record became readable (the TRD-52 rule: import the boundary
// the check depends on rather than restating it).
module.exports = {
  CONSUMERS, record, allow, maybeWarn, maybeWarnConsumer, summary, todayUsage, dayStartUtc, METER_TRUSTED_FROM,
  pricingOf, costOf, spend, breakevenRatePerM,
};
