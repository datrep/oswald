// trading/agent/review.js — TRD-12: one-by-one exit review of open positions.
// The chair deliberates each open position SEPARATELY (one LLM call per
// position, never bundled), round-robin across wakes so token cost stays
// FLAT (settings.deliberation.positionReview.maxPerWake, default 1) no matter
// how many positions are open. Fail-secure: unparseable verdict = hold.
'use strict';

const deepseek = require('./deepseek');
const quant = require('./quant');
const store = require('../store');
const ticks = require('../store/ticks');
// TRD-EXI-1 (#1490): the floor under a near-stop cut. Pure, so the arithmetic can be pinned by a test rather
// than argued about - which is what happened to this rule before the floor existed.
const { gateNearStopCut, DEFAULT_MIN_CUT_SAVING_R } = require('./exitPolicy');
// TRD-EXI-1b (#1490): where the refused cut is recorded and later counterfactualised. Safe to require from here
// (autopsy does not require review), and the only module that owns the diagnosis/tick-replay channel.
const autopsy = require('./autopsy');

const lastIndex = new Map(); // key `${scope}:${userId}` -> next review index

const prDefaults = () => ({ enabled: true, maxPerWake: 1, minConfidence: 0.7, closeMirrored: false, maxTokens: 250, minCutSavingR: DEFAULT_MIN_CUT_SAVING_R });

function pr(settings) {
  const p = (settings.deliberation && settings.deliberation.positionReview) || {};
  const d = prDefaults();
  return {
    enabled: p.enabled !== false,
    maxPerWake: Number(p.maxPerWake) >= 0 ? Number(p.maxPerWake) : d.maxPerWake,
    minConfidence: p.minConfidence != null ? Number(p.minConfidence) : d.minConfidence,
    closeMirrored: p.closeMirrored === true,
    maxTokens: Number(p.maxTokens) || d.maxTokens,
    reviewMinutes: Number(p.reviewMinutes) >= 0.5 ? Number(p.reviewMinutes) : 5,
    // 0 is an explicit OFF switch, so a zero must survive rather than fall back to the default
    minCutSavingR: Number(p.minCutSavingR) >= 0 ? Number(p.minCutSavingR) : d.minCutSavingR,
  };
}

function parseVerdict(text) {
  try {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (j && (j.action === 'hold' || j.action === 'close')) {
      const conf = Number(j.confidence);
      return {
        action: j.action,
        confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
        reason: String(j.reason || '').slice(0, 200),
      };
    }
    return null;
  } catch { return null; }
}

async function buildPositionContext(userId, t) {
  // TRD-12 Phase 1: unified context module (was hand-rolled here).
  const ind = await quant.indicatorSnapshot(userId, t.symbol).catch(() => null);
  const tick = await store.latestTick(userId, t.symbol, t.venue).catch(() => null);
  const base = await require('./context').positionSection(userId, t, { indicators: ind, tick });
  // TRD-12 Phase 2: grounded market baseline for the exit chair.
  const wp = await require('./whitepaper').bundleSections(userId).catch(() => null);
  const weekly = wp && wp.weekly ? `WHITE PAPER (weekly): ${String(wp.weekly.text).slice(0, 500)}` : null;
  // TRD-89 (2026-09-18): WHO OPENED THIS, AND HOW ITS THESIS ENDS. Without this the chair judged every
  // position as a trend trade, so a mean-reversion entry was closed the moment the trend reading
  // disagreed with it — which is the entry condition, not a break. Thirteen rsi2 positions died that
  // way in one session. The strategy declares its own exit thesis; the chair is told to use it.
  let thesis = null;
  if (t.strategyId) {
    try {
      const strat = require('./strategies').get(t.strategyId);
      if (strat) {
        thesis = strat.exitThesis
          ? `EXIT THESIS (${strat.id} — ${strat.name}): ${strat.exitThesis}`
          : `STRATEGY: ${strat.id} — ${strat.name}. ${strat.description || ''}`.trim();
      } else {
        thesis = `STRATEGY: ${t.strategyId}. No exit thesis is declared for this strategy; judge it on the stop and on whether its stated entry premise still holds.`;
      }
    } catch { thesis = null; }
  } else {
    thesis = 'STRATEGY: none recorded on this position (origin/legacy row). There is no declared entry premise, so judge only the stop distance and the profit you can see.';
  }
  return [base, thesis, weekly].filter(Boolean).join('\n');
}

// ONE chair call for ONE position. Returns the parsed verdict + cost info.
async function reviewOne(userId, settings, t) {
  const cfg = pr(settings);
  // TRD-12: the venue's own session state (passive feed, zero clicks). A
  // closed market means the position cannot be closed right now — skip the
  // LLM call entirely (no tokens, no doomed UI navigation) and hold.
  const venue = require('../plus500/sessionFeed').get(t.symbol);
  if (venue && venue.isTraded === false) {
    const nextOpen = venue.next && venue.next.from ? new Date(venue.next.from) : null;
    return {
      action: 'hold', confidence: 1,
      reason: nextOpen ? `market closed — next session ${nextOpen.toISOString()}` : 'market closed',
      skipped: 'market_closed', at: new Date().toISOString(),
    };
  }
  // TRD-12 Phase 2: token budget soft-gate — over cap, skip the review call.
  const budget = require('./budget');
  const gate = await budget.allow(userId, settings, 'review');
  if (!gate.allowed) {
    return { action: 'hold', confidence: 1, reason: 'budget cap — review skipped', skipped: 'budget_cap', at: new Date().toISOString() };
  }
  const ctx = await buildPositionContext(userId, t);
  const system = 'You are the exit-review chair of the OSWALD trading agent. You review ONE open position at a time, in isolation. Use the basic vocabulary: "hold" means CONTINUE the position, "close" means STOP it. Stop when: the stop level is about to be hit, the position THESIS is broken, or profit is worth taking. Discipline: a small loss alone is NOT a reason to close; a broken thesis or a stop about to be hit IS. THE THESIS BELONGS TO THE STRATEGY, NOT TO A GENERIC TREND READING: when the context states an EXIT THESIS, judge this position by THAT — a mean-reversion position is SUPPOSED to be on the other side of the recent move, so a trend indicator disagreeing with it is its entry condition, not a break. If no exit thesis is given, judge only the stop and the premise you can infer. Respond JSON ONLY: {"action":"hold"|"close","confidence":0.0-1.0,"reason":"short reason"}';
  // 2026-09-11: v4-pro thinking tokens bill INSIDE max_tokens — at the old
  // 250 cap EVERY review came back empty (finish=length) and read as
  // 'unparseable verdict'. Cap raised in settings AND retried here once with
  // headroom when the empty-truncation signature is detected. Genuine
  // gibberish still fails secure (hold).
  let r = null;
  let v = null;
  for (let i = 0; i < 2; i++) {
    const budget = i === 0 ? cfg.maxTokens : Math.max(cfg.maxTokens * 4, cfg.maxTokens + 1200);
    r = await deepseek.callChat(
      [
        { role: 'system', content: system },
        { role: 'user', content: ctx },
      ],
      { model: (settings.llm && settings.llm.model) || deepseek.DEFAULT_MODEL, temperature: 0.1, maxTokens: budget, jsonMode: true, timeoutMs: 60000, userId, label: 'review' }
    );
    deepseek.meterUsage(r.model, r.usage).catch(() => {});
    require('./budget').record(userId, 'review', r.usage, { settings }).catch(() => {});
    v = parseVerdict(r.text);
    if (v) break;
    // 2026-09-11: any EMPTY reply gets one retry with headroom — the residual
    // 'unparseable verdict' cases (Gold 18:49Z) came back empty BELOW the
    // cap-pinned truncation heuristic (network-shortened body). Non-empty
    // gibberish still fails secure immediately.
    const empty = !String(r.text || '').length;
    if (!empty && !deepseek.isTruncatedEmpty(r, budget)) break;
    if (!(await require('./budget').allow(userId, settings, 'review')).allowed) break; // no double-spend past the cap
  }
  require('./budget').maybeWarn(userId, settings).catch(() => {});
  const verdict = v || { action: 'hold', confidence: 0, reason: 'unparseable verdict — fail-secure hold' };
  return { ...verdict, model: r.model, tokens: (r.usage && r.usage.completionTokens) || 0, at: new Date().toISOString() };
}

// TRD-89 (2026-09-18): WHO MAY CLOSE A POSITION. The exit chair is a TREND reader. For a strategy whose
// thesis is a FADE, its central judgement — the move is running against the position — describes the
// entry condition, so its authority to stop the position was the defect, not its opinion. A strategy
// declaring reviewAuthority 'advisory' keeps the verdict (it is still recorded, still visible, still
// worth reading) and loses only the power to execute.
//
// A DECIDER is the default, so nothing changes for the trend survivors that rely on the chair as a
// safety net. The default is also RECORDED in the event (`authority` + `authoritySource`) rather than
// assumed, so an absent or unrecognised strategyId cannot quietly re-grant the authority this removes.
function reviewAuthorityFor(t) {
  const strategyId = t && t.strategyId;
  if (!strategyId) return { authority: 'decider', source: 'no_strategy_recorded' };
  try {
    const s = require('./strategies').get(strategyId);
    if (!s) return { authority: 'decider', source: `unknown_strategy:${strategyId}` };
    return s.reviewAuthority === 'advisory'
      ? { authority: 'advisory', source: `strategy:${strategyId}` }
      : { authority: 'decider', source: `strategy:${strategyId}` };
  } catch (e) {
    return { authority: 'decider', source: `lookup_failed:${String(e.message || e).slice(0, 40)}` };
  }
}

// TRD-89 (2026-09-18): THE CLOSE DECISION, PURE. Extracted so the authority rule can be driven through
// its whole truth table without a database or a live LLM verdict — the previous pins could only grep the
// wiring, which proves a line exists, not that the rule is right. The two ways a close can be suppressed
// are named separately ('strategy_policy' vs 'mirrored_position') because a bare `advisory: true` cannot
// tell them apart, and a suppression nobody can attribute is the defect this workstream keeps finding.
function decideClose({ verdict, mirrored, closeMirrored, minConfidence, authority, cutGate = null }) {
  const shouldClose = !!verdict && verdict.action === 'close'
    && Number(verdict.confidence) >= Number(minConfidence);
  const strategyOwnsExit = authority === 'advisory';
  const canClose = (!mirrored || !!closeMirrored) && !strategyOwnsExit;
  // ⚠ TRD-EXI-1 (#1490): A THIRD WAY A CLOSE CAN BE SUPPRESSED, AND IT IS NAMED SEPARATELY FOR THE SAME REASON
  // THE OTHER TWO ARE. A cut that banks almost nothing is refused: measured over 25 cuts the rule is right 14
  // times and wrong twice AND STILL LOSES, because a correct cut saves ~0.158R while a wrong one forfeits the
  // target (~2.70R) that the VENUE would really have booked. Break-even needs a 94% hit rate; it achieves 87.5%.
  // The floor converts that into a paying rule without pretending the review has no judgement, and `cutGate` is
  // returned WHOLE so the event carries the saving that caused the suppression - the number the floor is tuned by.
  const cutSuppressed = !!cutGate && cutGate.refuse === true;
  // ⚠ TRD-EXI-1b (#1490): `cutSuppressed` says the GATE refused. It does NOT say the gate is WHY the position is
  // still open: a mirrored position is suppressed by the mirror policy whatever the gate says, and a strategy
  // that owns its own exit is suppressed by that too. Counting either as a refused cut would credit the floor
  // with a decision it did not make and then measure the floor against it. `cutEnforced` is the population that
  // gets MEASURED - a cut the desk would otherwise have taken.
  const cutEnforced = cutSuppressed && canClose;
  return {
    shouldClose,
    canClose,
    close: shouldClose && canClose && !cutSuppressed,
    advisory: shouldClose && !canClose,
    strategyOwnsExit,
    cutGate: cutGate || null,
    cutSuppressed,
    cutEnforced,
    advisoryReason: !shouldClose ? null
      : strategyOwnsExit ? 'strategy_policy'
        : mirrored && !closeMirrored ? 'mirrored_position'
          : null,
  };
}

// Shared loop: pick positions round-robin, review one-by-one, act when the
// chair is confident. closeFn(t) executes the close; mirrored positions are
// advisory-only unless closeMirrored (the user's manual trades stay theirs).
async function reviewScope(scope, userId, settings, trades, { skipSymbols = [], closeFn, all = false } = {}) {
  const cfg = pr(settings);
  if (!cfg.enabled) return { reviewed: 0, reason: 'position_review_disabled' };
  // HARD kill = no exit execution (and no LLM spend): reviews stand down.
  // The auto-close sweep already handled the exits.
  if ((settings.kill || {}).tier === 'hard') return { reviewed: 0, reason: 'kill_switch_hard' };
  const candidates = (trades || []).filter((t) => t.status === 'open' && !skipSymbols.includes(t.symbol));
  if (!candidates.length) return { reviewed: 0, reason: 'no_open_positions' };

  const key = `${scope}:${userId}`;
  const start = (lastIndex.get(key) || 0) % candidates.length;
  const picked = [];
  // Manual review runs (dashboard button) review EVERY open position;
  // the background loop stays round-robin maxPerWake (default 1) so token
  // cost stays flat between manual checks.
  const maxN = all ? candidates.length : Math.min(Math.max(0, cfg.maxPerWake), candidates.length);
  for (let i = 0; i < maxN; i++) picked.push(candidates[(start + i) % candidates.length]);
  lastIndex.set(key, (start + picked.length) % candidates.length);

  const results = [];
  for (const t of picked) {
    try {
      const v = await reviewOne(userId, settings, t);
      const mirrored = String(t.note || '').includes('mirrored from Plus500');
      const { authority, source } = reviewAuthorityFor(t);
      // TRD-EXI-1 (#1490): what a market cut would bank, read from the TICK FEED rather than from the verdict's
      // prose. The model's own sentence ("3.0 pts away") is not an input the gate may depend on - it is the
      // thing being checked. Read BEFORE decideClose so the suppression is decided on the price, not on the text.
      let cutGate = null;
      let cutPrice = null;
      try {
        const tick = await store.latestTick(userId, t.symbol, t.venue);
        const mid = tick ? ticks.midOf(tick) : null;
        cutPrice = Number.isFinite(mid) && mid > 0 ? mid : null;
        cutGate = gateNearStopCut({
          entry: t.openPrice, stopPrice: t.stopPrice,
          price: cutPrice,
          minSavingR: cfg.minCutSavingR,
        });
      } catch (e) {
        cutGate = { refuse: false, savingR: null, minSavingR: cfg.minCutSavingR, reason: `unreadable:${String(e.message || e).slice(0, 40)}` };
      }
      const d = decideClose({
        verdict: v, mirrored, closeMirrored: cfg.closeMirrored, minConfidence: cfg.minConfidence, authority, cutGate,
      });
      // TRD-EXI-1b (#1490): A REFUSED CUT IS A DECISION AND IT USED TO LEAVE NOTHING BEHIND. That is the exact
      // reason the floor could only ever be justified by the cuts that were TAKEN - the ones it declined were
      // invisible, so no measurement could ever disagree with it. Recorded here with the levels and the price in
      // force at THIS instant, because those are the only terms the later counterfactual is allowed to use.
      // Own try/catch: telemetry about a decision may never change the outcome of the review that made it.
      const cutAt = new Date().toISOString();
      let cutRefusal = null;
      if (d.cutEnforced) {
        try {
          cutRefusal = await autopsy.recordCutRefusal(userId, {
            tradeId: t.id, symbol: t.symbol, venue: t.venue, direction: t.direction,
            entry: t.openPrice, stopPrice: t.stopPrice, takeProfitPrice: t.takeProfitPrice,
            price: cutPrice,
            savingR: cutGate ? cutGate.savingR : null,
            minSavingR: cutGate ? cutGate.minSavingR : cfg.minCutSavingR,
            gateReason: cutGate ? cutGate.reason : null,
            at: cutAt,
          });
        } catch (e) {
          await require('./log').error(userId, 'cut_refusal_record', e).catch(() => {});
        }
      }
      let closed = false;
      let closeError = null;
      if (d.close) {
        try { closed = !!(await closeFn(t, v)); } catch (e) { closeError = String(e.message || e).slice(0, 160); }
      }
      // TRD-95 (2026-09-18): this event carried the SYMBOL and nothing else, so no verdict could be
      // attributed to the trade it judged — the record held 941 `position_review` rows and ZERO of them
      // named a tradeId, leaving symbol+timestamp as the only possible join. That is how a monitor ended
      // up watching two Oil positions (#1063 sell, #1065 buy) and unable to say which verdict belonged
      // to which, and it is why no review can be replayed against the position it was about. Identity is
      // written at EMIT time, from the trade in hand, rather than inferred later from a timestamp.
      //
      // `skipped` is here for the same reason: a review that never ran is recorded as
      // `hold, confidence 1` (budget cap / market closed), which is indistinguishable from maximum
      // conviction. A skipped check is not a passed check, and the record now says which it was.
      const rec = {
        tradeId: t.id, strategyId: t.strategyId || null, skipped: v.skipped || null,
        symbol: t.symbol, action: v.action, confidence: v.confidence, reason: v.reason,
        model: v.model, tokens: v.tokens, closed,
        advisory: d.advisory, advisoryReason: d.advisoryReason, authority, authoritySource: source,
        // TRD-EXI-1: the suppression and the number behind it, on the SAME record that carries the verdict -
        // so "the desk declined to cut" is attributable, and the floor can be tuned from its own output.
        cutSuppressed: d.cutSuppressed, cutGate: d.cutGate, closeError, actor: `llm:${v.model}`, rationale: v.reason,
        // TRD-EXI-1b: WHICH of the suppressions the floor actually ENFORCED, and the id of the refusal it wrote -
        // so the review and the counterfactual that judges it join on an id instead of on a timestamp.
        cutEnforced: d.cutEnforced, cutRefusalId: cutRefusal ? cutRefusal.refusalId : null,
      };
      await store.logEvent(userId, 'position_review', rec);
      results.push(rec);
    } catch (e) {
      await require('./log').error(userId, 'position_review', e);
      results.push({ symbol: t.symbol, error: String(e.message || e).slice(0, 120) });
    }
  }
  return { reviewed: results.length, results, roundRobinStart: start, config: cfg };
}

// Demo desk (Plus500): closes go through the executor.
async function reviewDemo(userId, settings, opts = {}) {
  const trades = await store.getOpenTrades(userId);
  return reviewScope('demo', userId, settings, trades, {
    skipSymbols: opts.skipSymbols || [],
    all: opts.all === true,
    closeFn: (t) => require('./executor').closeTrade(userId, settings, t.id, { keepOpen: true, source: 'review' }).then((r) => r.closed || false),
  });
}

// Sim desk (paper ledger): closes go through the paper broker.
async function reviewSim(userId, settings, opts = {}) {
  const trades = await store.listPaperTrades(userId, { status: 'open', limit: 20 });
  return reviewScope('sim', userId, settings, trades, {
    skipSymbols: opts.skipSymbols || [],
    all: opts.all === true,
    closeFn: async (t, v) => {
      const px = await require('./paper').bestPrice(userId, t.symbol).catch(() => null);
      const price = px && px.price ? Number(px.price) : Number(t.openPrice);
      const row = await require('./paper').closeTrade(userId, settings, t, { price, reason: `position review: ${v.reason}` });
      return !!(row && row.status === 'closed');
    },
  });
}

module.exports = { reviewDemo, reviewSim, reviewOne, pr, startLoop, reviewAuthorityFor, decideClose };

// --- TRD-12: dedicated lightweight review loop ---------------------------------
// Reviews do NOT ride on the full wake anymore: the whole capture+quant+chair
// pipeline has nothing to do with a one-position hold/stop check. This loop
// runs on its own cadence (positionReview.reviewMinutes, default 5), reviews
// ONE position per cycle (round-robin), and costs a single small LLM call.
let reviewLoopTimer = null;
let lastRunAt = 0;

// TRD-EXI-1b (#1490): how often a refusal whose horizon has elapsed gets its counterfactual written. Own cadence
// on purpose — a review is throttled to `reviewMinutes`, and a MEASUREMENT that waited on the review cadence
// would lag the decision it measures by up to a day of exactly the position that needs watching. Free: no LLM,
// no clicks, no navigation. It runs even when position reviews are switched off, because the refusals it settles
// were recorded before that switch was thrown.
const REFUSAL_RESOLVE_MINUTES = 15;
let lastRefusalSweepAt = 0;

function startLoop(userId) {
  if (reviewLoopTimer) clearInterval(reviewLoopTimer);
  const tick = async () => {
    try {
      if (Date.now() - lastRefusalSweepAt >= REFUSAL_RESOLVE_MINUTES * 60000) {
        lastRefusalSweepAt = Date.now();
        const swept = await autopsy.resolveCutRefusals(userId, { resolvedBy: 'sweep' });
        if (swept.resolved) console.log('[trading] cut refusals settled:', JSON.stringify(swept));
      }
      const settings = await store.getSettings(userId);
      const cfg = pr(settings);
      if (!cfg.enabled) return;
      if (Date.now() - lastRunAt < cfg.reviewMinutes * 60000) return;
      lastRunAt = Date.now();
      const sim = !!(settings.paper && settings.paper.enabled);
      const r = sim ? await reviewSim(userId, settings) : await reviewDemo(userId, settings);
      if (r && r.results && r.results.length) {
        console.log('[trading] position review:', r.results.map((x) => `${x.symbol}:${x.action || x.error}`).join(' | '));
      }
    } catch (e) {
      await store.logEvent(userId, 'error', { where: 'review_loop', error: String(e.message || e).slice(0, 200) }).catch(() => {});
    }
  };
  reviewLoopTimer = setInterval(tick, 5000);
  console.log('[trading] position review loop started (lightweight, one position per cycle)');
}
