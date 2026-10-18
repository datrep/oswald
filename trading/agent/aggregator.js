// trading/agent/aggregator.js — deterministic aggregation (amendment A2).
// Gate order: quant proposal -> risk gate (veto ABSOLUTE: `risk.veto` returns before any chair is called)
// -> chair vote overlay -> committee verdict.
//
// THE COMMITTEE VERDICT, after the owner decision on TRD-VET-1 (2026-09-20): **a chair MAJORITY vetoes an
// ENTRY, and only an entry.** Before that the line here read "Risk veto or chair 'no' or tie = no trade",
// which described a policy this file did not implement — the chair overlay was a pure 50/50 blend in which
// two of three chairs dissenting was outvoted by a unanimous quant panel — and that sentence was read as the
// specification for two weeks. The rule now lives in ONE place, `committeeVerdict` below, where it is pinned
// by tests. Only the risk gate vetoes in every direction; the chair veto cannot touch an exit by
// construction, which is what makes it safe to leave enabled.
'use strict';

const chair = require('./chair');
const riskMod = require('./risk');
const store = require('../store');
const { buildBundle, buildBundleObj, isStale } = require('./promptBuilder');
const { committeePlan, skipReasonText } = require('./committee');
// ★★ TRD-TRL-1 defect 1(b) (2026-09-30) — THE TOLERANCE GATE USED TO RUN AFTER THE CHAIR. See
// `./deliberationScope` for the measurement and the three things this is deliberately NOT. The selector lives in
// its own pure module because `decide` opens a DB pool, so a spending rule written inline here could not be
// pinned by behaviour — the same reason `settingsDiff`, `scopeResolution` and `stopPolicy` are separate.
const { deliberationSymbols, suppressedCount } = require('./deliberationScope');

function round4(n) { return Math.round(n * 10000) / 10000; }

// P1-10 (2026-09-10): evidence-weighted votes. Per-strategy live record in
// every chair bundle, gated at n >= 20 closed trades — below that the section
// says "insufficient data" so the LLM can't anchor on 2-trade noise.
const MIN_EVIDENCE_TRADES = 20;

function strategyStatsSection(stats) {
  const lines = [`--- STRATEGY TRACK RECORD (live evidence; below ${MIN_EVIDENCE_TRADES} closed trades = insufficient) ---`];
  for (const s of stats || []) {
    lines.push(s.n >= MIN_EVIDENCE_TRADES
      ? `${s.strategyId}: ${s.n} closed | ${s.winRate}% win | net ${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(2)}`
      : `${s.strategyId}: insufficient data (${s.n} closed)`);
  }
  if (!stats || !stats.length) lines.push('(no tagged closed trades yet)');
  return '\n' + lines.join('\n') + '\n';
}

// ★ TRD-LLM-2 (2026-09-25): THE LIVE TICKET GEOMETRY, IN WORDS, BESIDE THE PROPOSAL.
//
// The bundle now states the RULES (the cap, the cost ceiling, the sizing formula). This states what those rules
// DID to the ticket in front of the seat — which is the thing it is actually voting on. The size note used to be
// one clause: `proposed size N units (risk 2% / (2 x ATR 9.35))`, i.e. the chair was told a size while the stop
// it was derived from, the cap that may have truncated it, and the cost share that may get the trade refused
// were all invisible.
//
// ⚠ EVERY NUMBER IS READ OFF THE RISK EVALUATION, never re-derived from settings here. A second derivation is
// exactly how the card came to publish a declared stop beside a cost share computed on the capped one (TRD-RSK-1);
// the seat's note and the engine's size must come from one computation or they will disagree.
function ticketGeometryNote(risk, proposal, settings) {
  const r = risk || {};
  const px = Number(proposal && proposal.price);
  const declared = Number(r.stopDistance);
  const effective = Number(r.effectiveStopDistance);
  const cap = r.stopCap || null;
  const mult = Number((settings && settings.risk && settings.risk.maxAdverseCostMultiple)) || 1.5;
  const pct = (d) => (px > 0 && d > 0 ? `${(d / px * 100).toFixed(4)}%` : null);
  const bits = [];
  const declaredPct = pct(declared);
  const effectivePct = pct(effective);
  const truncated = declared > 0 && effective > 0 && Math.abs(declared - effective) > 1e-9;
  if (declaredPct) bits.push(`declared stop ${declaredPct} of price`);
  if (effectivePct) {
    bits.push(truncated
      ? `venue stop ${effectivePct} of price — TRUNCATED${cap && cap.capPct != null ? ` by the ${cap.capPct}% cap` : ''}`
      : `venue stop ${effectivePct} of price (cap not binding)`);
  }
  if (truncated) {
    // ★ THE NUMBER THE SEAT MOST NEEDED AND NEVER HAD. The target is placed at 1.5 x the DECLARED distance, so a
    // truncated stop leaves the target proportionally further away: this ticket's reward:risk, which is NOT 1.5.
    bits.push(`the target at 1.5x DECLARED therefore sits ${(1.5 * declared / effective).toFixed(2)}R away, and a wider R needs a LOWER hit rate to pay`);
  }
  if (r.costShareOfR != null) {
    bits.push(`cost share of R ${Number(r.costShareOfR).toFixed(4)} against the ${r.costShareCeiling} ceiling${Number(r.costShareOfR) > Number(r.costShareCeiling) ? ' — OVER, so this ticket is refused on cost' : ''}`);
  }
  // ⚠ L4 (2026-09-29): `cap.pct` → `cap.capPct`, and the `cap.note` branch DELETED (it could never fire).
  //
  // Both were real defects of the "authoritative surface" class, and `test/ticket-geometry-note.test.js` could
  // not see either because its FIXTURE invented the same keys production never produces — a test that certifies
  // a branch is *harder* to write than one that certifies a value, because the fixture has to agree with a
  // writer it never reads. The fixture now mirrors `risk.js`'s real object, and the pin lives in that file.
  //
  // `note` genuinely cannot appear here: `stopPolicy` attaches it only on the REFUSAL path, where `cappedBy` is
  // null — and `risk.js` sets `v.stopCap` to null in exactly that case. The refusal IS surfaced to the seat, one
  // line up, through `reasons` (`risk.js` pushes `stopCap.note` there). So this branch was unreachable by
  // construction, not merely unpopulated.
  if (cap && cap.floor != null && cap.capPct != null) {
    bits.push(`the cap must clear ${Number(cap.floor).toFixed(4)}% (${mult}x the ${Number(cap.costPct).toFixed(4)}% round trip) or it is refused outright`);
  }
  // ★ THE VENUE FLOOR (2026-09-28) — the minimum has been in the bundle since the floor was added, but it was
  // never ON THE TICKET.
  //
  // `min size N <unit>` sits in `--- VENUE COST OF CARRY ---`, roughly forty lines above the proposal, among six
  // other facts, and it is attached to the SYMBOL. This note is the one place that states what the rules DID to
  // the proposal in front of the seat, and it omitted `venueFloor` entirely — even though `risk.evaluate` has
  // returned it since the same change. Measured 2026-09-28: **SGX was proposed at 8.5363 Shares against a
  // 20-Share floor and refused on `venue_minimum`**, i.e. the seat is asked about a ticket the venue cannot
  // accept, and the two numbers that decide it were never on the same line.
  //
  // ⚠ EVERY NUMBER IS READ OFF THE RISK EVALUATION, per this function's own rule — no second derivation.
  const vf = r.venueFloor || null;
  if (vf) {
    const unit = vf.unitKind ? ` ${vf.unitKind}` : '';
    const min = Number(vf.minUnits);
    const sizeN = Number(r.size);
    if (vf.accepted) {
      // The floor was ACCEPTED (owner setting) and the size was raised to meet it. This is the disclosed
      // half of that decision: the seat is told the ticket is not the size the dial computed.
      const at = Number(vf.intendedRiskPct);
      const forced = Number(vf.forcedRiskPct);
      bits.push(`★ the venue floor was ACCEPTED by an owner setting: the ticket was RAISED to the venue's minimum ${min}${unit}`
        + (Number.isFinite(forced) && Number.isFinite(at)
          ? `, so it carries ${forced.toFixed(4)}% of equity instead of the ${at.toFixed(4)}% the dial computed — ${vf.multiple != null ? Number(vf.multiple).toFixed(2) + 'x' : 'more than'} the intended risk`
          : ''));
    } else if (Number.isFinite(min) && min > 0) {
      const clears = Number.isFinite(sizeN) && sizeN >= min;
      bits.push(`venue minimum ${min}${unit} against this ticket's ${Number.isFinite(sizeN) ? sizeN : 'unreadable size'}`
        + (clears ? ' — the ticket clears the floor' : ' — BELOW the floor, so the venue cannot accept this size'));
      // The risk the FLOOR would force, when the floor is the binding constraint. This is the number that says
      // whether "take the minimum anyway" is available at this risk dial at all.
      const eq = Number(r.sizeCalc && r.sizeCalc.equity);
      const eff = Number(r.effectiveStopDistance);
      if (!clears && Number.isFinite(sizeN) && sizeN > 0 && eq > 0 && eff > 0) {
        const atSize = ((sizeN * eff) / eq) * 100;
        bits.push(`taking the ${min}${unit} minimum anyway would risk about ${(atSize * (min / sizeN)).toFixed(4)}% of equity instead of the ${atSize.toFixed(4)}% this size carries`);
      }
    } else if (vf.ok === true) {
      bits.push(`the venue minimum for this symbol is ${vf.reason === 'registry_unavailable' ? 'UNREADABLE' : 'UNKNOWN'}, so this size was NOT checked against a floor`);
    }
  }
  if (!bits.length) return '';
  return ` TICKET GEOMETRY (deterministic, measured for THIS proposal): ${bits.join('; ')}.`;
}

// The live account strip, CACHED ONLY.
//
// ⚠ A FRESH READ NAVIGATES THE SHARED PAGE. `getAccount({ fresh: true })` would collide with the wake's own
// capture and the ticket lock, and this call sits inside a bundle build — so the poller's 1s strip is the right
// source and a few seconds of age is acceptable for a prompt. An absent strip returns null, and the bundle
// states UNAVAILABLE rather than printing a zero.
//
// ⚠ THE CONNECTOR CONTRACT'S `getAccount` IS NOT ARITY-STABLE: `connector/browser.js` takes
// `(settings, { fresh })` while `connector/paper.js` takes `(userId, settings)`. Branching on the connector's
// own `kind` follows the object actually being called, instead of re-deriving the mode from `settings` and
// getting it wrong when the two disagree.
async function readAccountStrip(userId, settings) {
  try {
    const conn = require('../connector').getConnector(settings);
    const a = conn.kind === 'sim' ? await conn.getAccount(userId, settings) : await conn.getAccount(settings, { fresh: false });
    if (!a || a.equity == null) return null;
    return a;
  } catch { return null; }
}

// TRD-9 H: configurable deliberators. quantPanel = deterministic voters,
// chairs = LLM voters (1-3). Weights normalize within each group; the two
// groups carry equal weight in the final score.
const DELIB_DEFAULTS = {
  quantPanel: [
    { type: 'turtle', weight: 1 },
    { type: 'adx', weight: 0.5 },
    { type: 'meanrev', weight: 0.5 },
  ],
  chairs: [
    { id: 'chair-1', model: null, temperature: null, weight: 1, persona: 'trend' },
    { id: 'chair-2', model: null, temperature: null, weight: 1, persona: 'risk' },
    { id: 'chair-3', model: null, temperature: null, weight: 1, persona: 'macro' },
  ],
};

function deliberators(settings) {
  const d = settings.deliberation || {};
  return {
    quantPanel: Array.isArray(d.quantPanel) && d.quantPanel.length ? d.quantPanel : DELIB_DEFAULTS.quantPanel,
    chairs: Array.isArray(d.chairs) ? d.chairs.slice(0, 3) : DELIB_DEFAULTS.chairs,
  };
}

// ★ TRD-DEL-1 (2026-09-25): A SEAT'S PERSONA HAS TWO SOURCES AND ONLY ONE OF THEM WAS VISIBLE.
// `deliberators()` returns the chairs AS STORED, and a chair saved with no persona carries `persona: null`.
// `chairVotes` then fell back to the seat's POSITION (trend -> risk -> macro), so such a chair really did vote
// through a persona lens — while the settings UI rendered that same seat as a bare "seat default".
//
// THE COST WAS NOT COSMETIC. The operator was reading three chairs' reasons and tuning three chairs' weights
// with no way to see which lens produced which sentence, so a chair that disagreed could not be traced to
// `risk` or `macro` rather than to the model. Measured on the live config: every seat carried a null persona
// and the panel showed "seat default" three times.
//
// `resolveChairs` is now the ONE place the fallback happens, and it REPORTS which source supplied the value,
// so a caller can show the stored value AND the resolved one (`seat default -> risk`) instead of a word that
// means something the reader cannot see. `chairRoster` is the settings-shaped entry point for read-only
// callers, so the UI cannot drift from what `chairVotes` actually sends.
const SEAT_PERSONAS = ['trend', 'risk', 'macro'];
function resolveChairs(chairs) {
  return (Array.isArray(chairs) ? chairs : []).map((c, i) => {
    const src = c && typeof c === 'object' ? c : {};
    const explicit = src.persona ? String(src.persona) : null;
    const fallback = SEAT_PERSONAS[i] || null;
    return {
      ...src,
      id: src.id || 'chair',
      weight: Number(src.weight) || 0,
      persona: explicit || fallback,
      personaSource: explicit ? 'configured' : (fallback ? 'seat-default' : 'none'),
    };
  });
}

function chairRoster(settings) {
  return resolveChairs(deliberators(settings).chairs);
}

// Deterministic panel votes on the proposal, each in [-1, 1].
function quantVotes(quantResult, proposal, panel) {
  const votes = [];
  for (const p of panel) {
    const w = Number(p.weight) || 0;
    let vote = 0;
    let note = 'no signal';
    if (p.type === 'turtle') {
      vote = proposal ? 1 : 0;
      note = proposal ? 'proposal present' : 'no proposal';
    } else if (p.type === 'adx') {
      const adxNow = proposal ? proposal.adx14 : null;
      if (adxNow == null) note = 'adx unavailable';
      else if (adxNow > 20) { vote = 1; note = `ADX ${adxNow} trending`; }
      else { vote = -1; note = `ADX ${adxNow} choppy`; }
    } else if (['meanrev', 'macd', 'rsi2'].includes(p.type)) {
      vote = proposal && proposal.strategy === p.type ? 1 : 0;
      note = proposal ? (proposal.strategy === p.type ? `${p.type} proposal present` : `not a ${p.type} proposal (${proposal.strategy})`) : 'no proposal';
    } else if (p.type === 'rsi') {
      const sym = (quantResult.symbols || []).find((s) => s.symbol === (proposal && proposal.symbol));
      const r = sym && sym.indicators ? sym.indicators.rsi : null;
      if (r == null) note = 'rsi unavailable';
      else if (proposal && proposal.direction === 'buy' && r > 70) { vote = -1; note = `RSI ${r} overbought`; }
      else if (proposal && proposal.direction === 'sell' && r < 30) { vote = -1; note = `RSI ${r} oversold`; }
      else { vote = proposal ? 1 : 0; note = `RSI ${r} not extreme`; }
    } else {
      note = `unknown panel type ${p.type}`;
    }
    votes.push({ type: p.type, weight: w, vote, note });
  }
  const tw = votes.reduce((s, v) => s + v.weight, 0);
  const score = tw > 0 ? votes.reduce((s, v) => s + v.weight * v.vote, 0) / tw : 0;
  return { votes, score };
}

// ★ TRD-LLM-3 (2026-09-25): THE PANEL'S VOTES WERE COMPUTED ONE LINE BEFORE THEY WERE THROWN AWAY.
//
// `quantVotes` ran for the record and for the blend, and the result never reached the chair — so a seat was asked
// to vote on a proposal whose only in-scope deterministic confirmation was invisible to it, while the READER of
// the decision record saw both. The seat was judging one half of a 50/50 blend while seeing neither half.
//
// ⚠ THE BLENDED SCORE IS DELIBERATELY NOT SHOWN, and the row that raised this said why: a single number invites
// deference — the past defect recorded in promptBuilder is "the panel always outvoted it, because the panel had
// scored the live number". Each vote is stated as a FACT WITH ITS OWN BASIS instead, so a seat can argue with a
// voter rather than defer to a figure. That is the row's own recommended direction, taken deliberately.
//
// The last line is not padding: the measured history is that the SEATS are the real filter (chairScore negative
// in 219 of 343 decisions, 174 declined by the score rule against only 34 vetoes), so a seat told "here is what
// the panel thinks" must also be told that its own dissent is counted, or the disclosure becomes pressure.
function quantPanelNote(qv) {
  const votes = qv && Array.isArray(qv.votes) ? qv.votes : [];
  if (!votes.length) return '';
  const lines = ['', '--- DETERMINISTIC QUANT PANEL (already computed for this proposal, before your vote) ---'];
  for (const v of votes) {
    const sign = Number(v.vote) > 0 ? `+${v.vote}` : String(v.vote);
    lines.push(`${v.type} weight ${v.weight} vote ${sign} — ${v.note}`);
  }
  lines.push('The panel is deterministic code, it votes on the SAME proposal, and its group score enters the committee blend at the same weight as the seats\' do. It is given to you as FACTS with their bases rather than as a blended score, so that you can disagree with a particular voter instead of deferring to a number. Your own dissent is scored, not discarded — judge the proposal yourself.');
  return `\n${lines.join('\n')}\n`;
}

// LLM chair votes. Transport failures / parse failures = ABSTAIN (an offline
// chair must not read as a "no").
async function chairVotes(userId, bundleText, settings, chairs) {
  const votes = [];
  let wSum = 0, wAcc = 0, responded = 0;
  // Persona fallback by seat order (trend -> risk -> macro), through the SHARED resolver: even chairs
  // configured in settings without an explicit persona stay differentiated instead of echoing each other's
  // sentences. TRD-DEL-1 moved the rule into `resolveChairs` so the settings panel reads the SAME resolution
  // this loop applies — a second copy here is exactly how a displayed persona drifts from a voting one.
  const roster = resolveChairs(chairs);
  for (let i = 0; i < roster.length; i++) {
    const c = roster[i];
    const w = Number(c.weight) || 0;
    const persona = c.persona;
    // `personaSource` travels with the vote so a stored decision says whether the seat chose its lens or
    // inherited it from its position — otherwise a later reader cannot tell a configured seat from a defaulted one.
    const base = { id: c.id || 'chair', weight: w, persona, personaSource: c.personaSource };
    try {
      const v = await chair.vote(userId, bundleText, settings, { id: c.id || null, model: c.model || null, temperature: c.temperature, persona });
      // TRD-12 bug fix (2026-09-10): a budget-capped or abstaining chair is
      // NOT a "no" — counting it as one turned a valid proposal into
      // "deliberation declined" with a -1 chair score.
      // TRD-113 (2026-09-21): `regex-fallback` joins the abstain set. A reply rescued out of prose is the
      // model NOT HAVING ANSWERED, and the desk must not blend it as an opinion — the fix in deepseek.js
      // (a rescue is retried, then becomes parse_failure) is the first line, and this is the second, so a
      // future path that produces a rescue cannot reach the blend either way.
      const isAbstain = v.decision === 'abstain' || /^(llm_error|parse_failure|budget_cap|regex-fallback)/.test(v.reason || '');
      if (isAbstain) {
        votes.push({ ...base, vote: 'abstain', reason: v.reason || 'abstained', model: v.model });
        continue;
      }
      const sign = v.decision === 'yes' ? 1 : -1;
      votes.push({ ...base, vote: v.decision, sign, confidence: v.confidence, reason: v.reason, model: v.model, usage: v.usage, latencyMs: v.latencyMs });
      responded++; wSum += w; wAcc += w * sign;
    } catch (e) {
      votes.push({ ...base, vote: 'abstain', reason: String(e.message || e).slice(0, 120) });
    }
  }
  const score = wSum > 0 ? wAcc / wSum : 0;
  return { votes, score, responded, abstained: votes.length - responded };
}

// ---------------------------------------------------------------------------
// TRD-VET-1 (2026-09-20, owner decision): A CHAIR MAJORITY VETOES AN ENTRY — AND ONLY AN ENTRY.
//
// WHAT IT WAS. `total = 0.5 x quantScore + 0.5 x chairScore`, `approved = total > 0`. So two of three chairs
// dissenting (chairScore -1/3) was outvoted by a unanimous quant panel (total +1/3), and the panel only
// blocked on unanimity AGAINST a non-unanimous quant score. Measured across the desk's whole history
// (`temp/chair-veto-analysis.sql`): 13 decisions carried a chair MAJORITY dissenting and **all 13 were
// approved** — 12 entries and 1 exit — and the 11 that filled came to **-37.27 gross** on a 4-win/7-loss
// split. The single biggest item in that set was the biggest WINNER of the period (+28.86), which is the
// honest shape of this rule: it removes the tail in both directions.
//
// WHY ENTRY-ONLY, and this is the part that makes it safe to switch on. A vetoed ENTRY skips a trade. A
// vetoed EXIT does not skip anything — it HOLDS a position on the panel's say-so, with only the venue stop
// underneath, and that is the one direction with an unbounded consequence. So `kind === 'exit'` is exempt,
// and the veto can therefore only ever REMOVE an entry: it cannot size up, cannot hold, cannot touch the
// deterministic risk gate, which still vetoes absolutely and first.
//
// THE MAJORITY TEST IS THE WEIGHTED SCORE, not a count of "no"s, so the rule stays correct if the seats are
// re-weighted — the live panel is 0.5 / 1 / 1.5, where chairs 2+3 dissenting is a majority and chairs 1+2
// dissenting is exactly a tie (score 0) and therefore not dissent. A TIE IS NOT A VETO.
//
// AN ABSTENTION IS NOT DISSENT. `responded` gates the whole rule, and a budget-exhausted panel keeps its
// existing quant-only path untouched. `minResponders: 2` is deliberate: with a single seat configured,
// "majority" has no meaning, and one LLM blocking every entry is not what was decided.
//
// PURE, so the rule is pinned by tests instead of inferred from a live wake.
function committeeVerdict({ quantScore, chairScore, chairResponded, hasChairs, kind, chairOffline, veto = null, minResponders = 2 }) {
  const qs = Number(quantScore) || 0;
  const cs = Number(chairScore) || 0;
  const responded = Number(chairResponded) || 0;
  const total = hasChairs ? 0.5 * qs + 0.5 * cs : qs;
  const base = chairOffline ? qs > 0 : total > 0;
  const majorityDissents = responded >= minResponders && cs < 0;
  const vetoApplies = base && !chairOffline && kind !== 'exit'
    && !!(veto && veto.enabled !== false) && majorityDissents;
  const approved = base && !vetoApplies;
  // ★★ TRD-VET-2 (2026-09-28): WHO DECIDED, AS A FIELD, BECAUSE THE RECORD COULD NOT SAY.
  //
  // The test below has always asserted that the exact tie is NOT labelled a veto — correctly, *"the blend blocked
  // this one; saying 'veto' would misattribute it"* — but nothing replaced the missing label, so the record kept
  // only `chairVeto: false` and the sentence "deliberation declined". Measured over all 165 decisions: 33 approved,
  // 35 chair vetoes, and **92 declined with no veto**. **57 of those 92 are EXACT TIES — the halves weighted 0.5
  // each, so a unanimous panel against a unanimous committee gives `total` of exactly 0** — and every one of them
  // reads in the record exactly like a moderate chair-majority decline. So the desk's ONLY machine-readable answer
  // to "why is nothing entering" (the veto counter) reports **35 where the chair side actually decided 113**.
  //
  // ⚠ THIS CHANGES NOTHING ABOUT WHAT TRADES. `approved`, `total`, `vetoApplies` and `reason` are untouched — the
  // tie still declines, which is the default the owner set on 2026-09-20 and which the only outcome measurement
  // on record (TRD-VET-1: 13 overruled-dissent decisions, −37.27 gross on 4W/7L) supports. This adds the NAME.
  // ⚠ AND THE MEASUREMENT THAT WOULD JUSTIFY CHANGING THE RULE WAS RUN AND CAME BACK EMPTY (see TRD-VET-2):
  // the 57 ties were replayed against the venue's own ticks — 52 resolved, 23 target / 29 stop, 44.2% hit at a
  // mean 1.60R — and the aggregate +0.10R is carried entirely by groups of 4 and 2, while the dominant group
  // (**44 Oil buys, 77% of the population, four of them inside six minutes**) is **−0.034R at a 39% hit rate**.
  // Heavy overlap means n=44 is not 44 observations, so the honest reading is **no measurable edge either way**.
  const tie = hasChairs && !chairOffline && Math.abs(total) < 1e-9;
  const attribution = approved ? 'approved'
    : vetoApplies ? 'chair_veto'
      : tie ? 'tie'
        : !hasChairs ? 'quant'
          : chairOffline ? 'quant'
            : cs < 0 && qs >= 0 ? 'chair'
              : qs < 0 && cs >= 0 ? 'quant'
                : 'both';
  let reason = chairOffline ? 'chair unavailable'
    : approved ? 'deliberation approved' : 'deliberation declined';
  if (vetoApplies) {
    reason = `chair VETO — weighted chair score ${round4(cs)} of ${responded} responding seat(s): a majority dissented, so the ENTRY is blocked. Exits are exempt by construction.`;
  }
  return { approved, total, chairVeto: vetoApplies, majorityDissents, tie, attribution, reason };
}

// Pick the primary proposal: exits first (risk reduction), then entries.
// `lockReason` is the SESSION'S OWN sentence, passed through rather than restated: this function used to
// hard-code 'SESSION_LOCK observation window', which was a lie the moment the lock came from a scheduled
// event instead of a pre/post-open window (2026-09-15).
function pickProposal(quantResult, sessionLock, killTier, bridgePaused, lockReason = null, additionalBlock = null) {
  const ok = (quantResult.symbols || []).filter((s) => s.status === 'ok' && s.signal);
  const exits = ok.filter((s) => s.signal.type === 'exit');
  const entries = ok.filter((s) => s.signal.type === 'entry');
  // ⚠ AN EXIT IS RETURNED BEFORE THE BLOCK CHECK, and that ordering is load-bearing: it is what lets a lock
  // stop ENTRIES without trapping a position. The micro-wake entry lock relies on it.
  if (exits.length) return { proposal: { ...exits[0].signal, symbol: exits[0].symbol, venue: exits[0].venue, price: exits[0].price, atr14: exits[0].atr14, adx14: exits[0].adx14, series: exits[0].series || null }, quant: exits[0] };
  // Order is by SPECIFICITY: a paused bridge names itself, then the session, then the kill tier, and a
  // micro-wake's entry lock is the least specific claim so it is stated last.
  const blocked = bridgePaused ? 'UI Fallback Pause (selector health)' : sessionLock ? `SESSION_LOCK — ${lockReason || 'entries locked'}` : killTier === 'soft' || killTier === 'hard' ? `kill switch tier ${killTier}` : (additionalBlock || null);
  if (blocked) return { proposal: null, quant: null, blocked };
  // TRD-12 Phase 2: pass the REAL series (correlation veto used to be dead).
  if (entries.length) return { proposal: { ...entries[0].signal, symbol: entries[0].symbol, venue: entries[0].venue, price: entries[0].price, atr14: entries[0].atr14, adx14: entries[0].adx14, series: entries[0].series || null }, quant: entries[0] };
  return { proposal: null, quant: null };
}

// Quant summary for wake events / UI visibility (no LLM spend).
function summarizeQuant(q) {
  const symbols = (q && q.symbols) || [];
  const signals = symbols
    .filter((s) => s.status === 'ok' && s.signal)
    .map((s) => ({ symbol: s.symbol, type: s.signal.type, direction: s.signal.direction, basis: s.signal.basis, price: s.price, adx14: s.adx14, atr14: s.atr14 }));
  return {
    evaluated: symbols.length,
    withSignal: signals.length,
    insufficient: symbols.filter((s) => s.status === 'insufficient_data').length,
    errors: symbols.filter((s) => s.status === 'error').length,
    signals,
  };
}
// Summarize a chair-vote round into the fields every decision shares:
// offline flag, weighted vote label, average confidence.
function chairSummary(cv, chairs) {
  const chairOffline = chairs.length > 0 && cv.responded === 0;
  const withConf = cv.votes.filter((v) => v.confidence != null);
  const avgConf = withConf.length
    ? withConf.reduce((s, v) => s + v.confidence, 0) / withConf.length
    : null;
  const weightedChairVote = cv.responded
    ? (cv.score > 0 ? 'yes' : cv.score < 0 ? 'no' : 'abstain')
    : (chairs.length ? 'offline' : null);
  return { chairOffline, avgConf, weightedChairVote };
}
async function decide({ userId, trigger, now, session, quantResult, settings, openTrades, closedTrades, digest, alert, pulse, meta, multi, congress, userInput, venueCostFacts = null, suppressedExits = null }) {
  const killTier = (settings.kill || {}).tier || 'off';
  // ONE decision function for "is entry allowed", shared with the wake aggregate and the prompt builder
  // (agent/sessions.isEntryLocked). Re-deriving it here is how the observation window and a scheduled
  // macro event could drift into disagreeing about what a lock is.
  const sessionLock = require('./sessions').isEntryLocked(session.state);
  const bridgePaused = !!(settings.bridge && settings.bridge.paused);
  const stale = isStale(quantResult, now);
  const qs = summarizeQuant(quantResult);
  // Agent-managed positions (the user's own mirrored trades stay advisory).
  const hasAgentPositions = (openTrades || []).some((t) => !String(t.note || '').includes('mirrored from Plus500'));

  // ★★ 2026-09-28: A MICRO WAKE IS A PROXIMITY GUARD, NOT A TRADING OPPORTUNITY.
  //
  // `microWake` exists to watch an OPEN position's stop/TP proximity on a ~2-minute cadence
  // (`wake.microWake.minIntervalMin`). It was running the FULL deliberation and proposing ENTRIES.
  // Measured 2026-09-28: **Arabica Coffee was re-proposed as an entry every ~121 s** for as long as the venue
  // was shut — nine decisions between 07:32 and 08:35, all `action: entry`, `chairVote: offline`. Two causes
  // stacked: the micro cadence, and a SHUT MARKET FREEZING THE LAST PRICE, which makes the same donchian
  // breakout a permanent signal (`price 277.77` identical at 08:24, 08:26, 08:28, 08:30 and 08:32).
  //
  // ⚠ AND IT WAS THE FASTEST ROUTE TO THE BUDGET. Every one of those wakes set `llmCalled: true`; at ~8k
  // tokens a call and a 2-minute cadence that is ~240k tokens/hour, so making the chair available again
  // (budget.totalDaily raised the same day) would have been spent on entries that CANNOT BE PLACED.
  //
  // ⚠ WHY A LOCK AND NOT A PROMPT CHANGE: `blocked` removes entries from `proposalObjs`, so they never reach
  // the bundle and the chair is never asked about them — while `pickProposal` returns an EXIT before the block
  // check, so the proximity case this cadence exists for still works. Same path as the session lock, no new
  // state. `reentryCooldownBars` is 0 ON THE OWNER'S INSTRUCTION (2026-09-28) and is NOT touched here.
  const microEntryLock = trigger === 'micro'
    ? 'MICRO WAKE — proximity check only; new entries belong on the scheduled cadence, not this one'
    : null;

  const { blocked } = pickProposal(quantResult, sessionLock, killTier, bridgePaused, session.detail, microEntryLock);
  // Proposal list (exits first, then entries) — built BEFORE the bundle so
  // every proposal is visible to the chairs. No per-wake cap: EVERY signal
  // gets its own risk gate + chair vote (user decision 2026-09-10). Token
  // spend is bounded by the chair budget, not by skipping signals.
  //
  // ⚠ `suppressedExits` IS NOT "SKIPPING SIGNALS" — it is the one class where a chair vote cannot change the
  // outcome, because the execution step refuses the order regardless (see `deliberationSymbols`).
  const proposalSyms = deliberationSymbols(quantResult, { blocked, suppressedExits });
  const proposalObjs = proposalSyms.map((s) => ({ ...s.signal, symbol: s.symbol, venue: s.venue, price: s.price, atr14: s.atr14, adx14: s.adx14, series: s.series || null }));
  const proposal = proposalObjs[0] || null;
  // TRD-12 Phase 2: the market-state white paper (weekly/monthly/yearly) rides
  // along in every bundle — the chair works from grounded evidence.
  const whitepaper = await require('./whitepaper').bundleSections(userId).catch(() => null);
  // Last wake's execution outcomes (2026-09-10): the chairs must KNOW when an
  // exit was deferred by the small-loss tolerance policy or an entry failed
  // to fill — otherwise they re-litigate the same decision blind.
  const prevWakeEvent = await store.latestEvent(userId, 'wake');
  const prevOutcomes = prevWakeEvent && prevWakeEvent.payload && Array.isArray(prevWakeEvent.payload.executions)
    ? prevWakeEvent.payload.executions : null;
  // ★ TRD-LLM-2: THE CHAIR IS TOLD THE ACCOUNT IT IS SIZING AGAINST. Until 2026-09-25 the only account line in
  // the whole bundle was `Account: DEMO (paper).` — no equity, no free funds — while the bundle asked the seat
  // to vote on `size=<N>`, a number derived from exactly that equity.
  //
  // ⚠ CACHED STRIP ONLY, NEVER A FRESH READ. `getAccount({ fresh: true })` navigates the shared page, and a
  // bundle build must not collide with the wake's own capture or the ticket lock. The poller's 1s strip is free
  // and a few seconds old; if it is absent the bundle says UNAVAILABLE rather than inventing a figure.
  const account = await readAccountStrip(userId, settings);
  const bundleObj = buildBundleObj({ userId, trigger, now, session, quantResult, openTrades, closedTrades, digest, proposal, alert, stale, pulse, meta, multi, congress, whitepaper, proposals: proposalObjs, userInput, prevOutcomes, venueCostFacts, settings, account });
  const bundleText = buildBundle({ userId, trigger, now, session, quantResult, openTrades, closedTrades, digest, proposal, alert, stale, pulse, meta, multi, congress, whitepaper, proposals: proposalObjs, userInput, prevOutcomes, venueCostFacts, settings, account });
  // P1-10 (2026-09-10): evidence-weighted votes — per-strategy live track
  // record rides in EVERY bundle, gated at n >= 20 closed trades (below
  // that the section says "insufficient data" so the LLM can't anchor on
  // 2-trade noise).
  const strategyStats = await store.listStrategyStats(userId).catch(() => []);
  const statsText = strategyStatsSection(strategyStats);
  const bundleTextFinal = bundleText + statsText;
  bundleObj.strategyStats = strategyStats;
  bundleObj.text = bundleTextFinal;

  // Hard evacuation: the waker refuses to wake at all; soft pause + no proposal:
  // log a lightweight wake, no LLM spend.
  if (killTier === 'hard') {
    return finish({ userId, trigger, bundleObj, bundleText: bundleTextFinal, action: 'none', reason: 'kill switch: hard evacuation', llmCalled: false, decision: null, extra: { quant: qs, session: session.state, stale, positions: openTrades.length } });
  }

  // TRD-55 (2026-09-14): convene the committee ONLY when there is a proposal to
  // vote on. A chair vote is a veto on a proposal, so with no proposal the
  // answer is already in the contract (chair.js: "If no proposal is presented,
  // vote no") and a round buys that answer at the price of a full bundle per
  // chair. Measured: 177 chair votes on no-proposal wakes, ALL of them no or
  // abstain (not one yes), ~628,910 input tokens = 44% of the desk LLM input
  // bill. Position oversight is NOT lost: review.js reviews every open position
  // on its own loop (~1,374 input vs ~11,253 per deliberation round).
  const plan = committeePlan({ proposals: proposalObjs, hasAgentPositions });
  if (!plan.convene) {
    // IMPLIED GOAL #2: no proposal = deterministic flat with ZERO LLM tokens
    // (chairs add nothing when there is nothing to vote on).
    const reason = skipReasonText(plan.reason, { blocked });
    const decision = { action: 'none', reason, llmCalled: false, chairVote: null, confidence: null };
    const promptId = await store.createPrompt(userId, {
      triggerType: trigger, bundle: { ...bundleObj, text: bundleTextFinal }, response: null, decision, model: null, usage: null, latencyMs: null,
    });
    // ★★ ONE WAKE, ONE EVENT (TRD-WAK-2, 2026-09-27). THIS `store.logEvent(userId,'wake',…)` WAS REMOVED, and the
    // reason matters more than the removal. The aggregator wrote a wake event on THREE paths (here, the `decide`
    // tail, and `finish`), and `wakePipeline` wrote a FOURTH — guarded by
    //     `if (!String(result.reason || '').startsWith('no_signal'))`
    // i.e. a test on the PROSE of the reason, which covers exactly ONE of the aggregator's three reasons. So most
    // wakes wrote two events: MEASURED over 14 days, 815 of 1,426 wakes carried a duplicate pair (and one carried
    // five). The pipeline's own comment claimed the two were mutually exclusive; the guard never made that true.
    //
    // The pipeline is now the SINGLE writer, because it holds strictly more: it knows what was EXECUTED, which the
    // aggregator cannot. The fields only this path produced travel out on the return value instead, and
    // `demoWakePayload` merges them — so nothing is lost by removing the write, and no consumer has to read two
    // rows to reconstruct one wake.
    return {
      action: 'none', reason, llmCalled: false, decision, promptId,
      blocked: blocked || null, quant: qs, committee: plan, session: session.state, stale, positions: openTrades.length,
    };
  }

  // Risk gate (deterministic, instant). Veto is absolute. The cooldown veto
  // needs a wider closed-trade window than the bundle's 3.
  const cooldownClosed = await store.getClosedTrades(userId, 20);

  // --- Multi-proposal deliberation (implied goal): EVERY symbol with a
  // signal gets its own risk gate + chair vote in this wake (exits first,
  // then entries). No signal is silently skipped.
  const { quantPanel, chairs } = deliberators(settings);
  const decisions = [];
  let anyLlm = false;
  let allVoteAgg = null;
  // ★ TRD-EXE-7 (#1475) — THIS WAKE'S ALREADY-ACCEPTED EXPOSURE, IN NOTIONAL %. The risk gate sizes each ticket
  // against the OPEN book, and open positions only exist AFTER a wake places them — so without this accumulator
  // every non-vetoed proposal in a wake was sized as though it were the only one. Measured 2026-09-29: wake #5661
  // sized Silver 34.15% and Sugar 34.15% against a 50% cap whose remaining room was 37.29% for EACH, taking the
  // book to 81.01% — a 31-point overshoot.
  //
  // ⚠ COUNTED AT THE RISK GATE, NOT AT THE FILL. A ticket the committee later declines still consumes budget for
  // the remainder of this wake, because the gate did approve that size. That direction OVER-counts rather than
  // under-counts, which is the way a risk control should err: being too conservative for one wake costs a missed
  // entry, and being too generous is the overshoot this fixes.
  let committedPct = 0;

  const voteAggFrom = (cv) => cv.votes.length ? {
    raw: JSON.stringify({ chairs: cv.votes }),
    model: cv.votes.map((v) => v.model || 'chair').join(', '),
    usage: cv.votes.reduce((s, v) => ({
      promptCacheHitTokens: s.promptCacheHitTokens + (v.usage && v.usage.promptCacheHitTokens || 0),
      promptCacheMissTokens: s.promptCacheMissTokens + (v.usage && v.usage.promptCacheMissTokens || 0),
      completionTokens: s.completionTokens + (v.usage && v.usage.completionTokens || 0),
    }), { promptCacheHitTokens: 0, promptCacheMissTokens: 0, completionTokens: 0 }),
    latencyMs: Math.max(0, ...cv.votes.map((v) => v.latencyMs || 0)),
  } : null;

  const deliberateOne = async (proposal, focusText) => {
    // The budget sees the open book PLUS what this wake has already accepted (TRD-EXE-7 / #1475).
    // ★★ AND THE INSTRUMENT'S CONTRACT SCALE TRAVELS WITH IT (2026-10-01). `pointValue` is resolved HERE, once,
    // from the registry — the ONE source — instead of being re-derived inside `risk.js` at each of the eight
    // notional sites, which is how `fx` was fixed in six places while `pointValue` stayed missing in all of them.
    // ⚠ A RESOLUTION FAILURE YIELDS `1`. That is the identity, so the arithmetic degrades to exactly today's
    // behaviour; it cannot invent a scale, and it cannot silently zero a notional.
    const inst = await require('./instruments').resolve(userId, { symbol: proposal.symbol }).catch(() => null);
    const pointValue = inst && inst.pointValue ? inst.pointValue : 1;
    // ★★ AND THE OPEN BOOK'S SCALES, which are NOT the proposal's. `risk.js` applies `pointValueBySymbol` to its
    // two BOOK-WIDE sums (the open exposure and the open margin), and an absent map means identity 1 — so
    // threading only the proposal's factor would size the NEW ticket correctly while every OPEN cents-quoted
    // position kept a 100x-overstated contribution to the caps that decide whether the ticket fits at all.
    // ⚠ RESOLVED PER SYMBOL AND MEMOISED: the book can mix a USD-quoted contract with a cents-quoted one, and
    // one factor applied to both would be the same unit error in the opposite direction. A resolution failure
    // yields 1, which degrades to exactly today's arithmetic rather than inventing a scale.
    const pointValueBySymbol = {};
    for (const t of (openTrades || [])) {
      const sym = t && t.symbol;
      if (!sym || pointValueBySymbol[sym] !== undefined) continue;
      const o = await require('./instruments').resolve(userId, { symbol: sym }).catch(() => null);
      pointValueBySymbol[sym] = o && o.pointValue ? o.pointValue : 1;
    }
    pointValueBySymbol[proposal.symbol] = pointValue;
    const risk = await riskMod.evaluate(userId, settings, proposal, openTrades, cooldownClosed, { committedPct, pointValue, pointValueBySymbol });
    if (risk.veto) {
      return {
        action: 'none', symbol: proposal.symbol, direction: proposal.direction, type: proposal.type,
        strategy: proposal.strategy || null, size: null, chairVote: null, confidence: null,
        reason: riskMod.vetoLine(risk),
        votes: null, riskReasons: risk.reasons, riskSize: risk.size, sizeCalc: risk.sizeCalc || null,
        blockedReason: blocked || null, sessionLock, stale, llmCalled: false,
        // TRD-114: carried on the REFUSAL path too — the case that most needs auditing is the one the gate
        // stopped, and a refusal whose number is not recorded cannot be argued with later.
        //
        // ⚠ AND SINCE 2026-09-25 THE DISTANCES TRAVEL WITH IT. A refusal that publishes `costShareOfR`
        // without the stop it was computed ON is unreconcilable by construction — and this path carried no
        // stop distance of any kind, so there was nothing to reconcile against. See the note on the approved
        // path below for the measured Oil case that exposed it.
        stopDistance: risk.stopDistance || null,
        effectiveStopDistance: risk.effectiveStopDistance ?? null,
        stopCap: risk.stopCap || null,
        costShareOfR: risk.costShareOfR ?? null,
        costShareCeiling: risk.costShareCeiling ?? null,
        // ★ TRD-RSK-2 (2026-09-27): THE MACHINE-READABLE CAUSE, BESIDE THE PROSE. `riskReasons` says what happened
        // in sentences; this says WHICH rule fired, so a report never has to read the sentences to attribute a
        // refusal. Measured need: on 2026-09-25 the same prose ("venue cost 0.1936% = 65% of R") was read as a
        // breach of the 65% cost ceiling when the rule that fired was the correlation guard and the cost share was
        // 0.6453, i.e. UNDER. One wrong diagnosis, from prose, on the exact question this field answers.
        riskVetoCodes: risk.vetoCodes || [],
        // ★ TRD-RSK-7: WHICH RISK PROFILE SIZED THIS TICKET, and which keys it overrode. On the decision row
        // so the resolution is auditable from the record rather than only from the settings that happened to
        // be in force — the same channel and the same argument as `vetoCodes` above it.
        riskProfile: risk.riskProfile || null,
        // ★ TRD-VET-2 (2026-09-28): `risk_veto` completes the attribution partition. THIS PATH RETURNS BEFORE
        // THE COMMITTEE EXISTS — `votes` is null — so a census that groups non-approvals by `attribution` would
        // have silently dropped exactly the refusals that never reached a seat. Measured: 17 of 167 decisions are
        // this shape, and they are the only ones the desk ever refused deterministically.
        //
        // ⚠ AND THESE 17 ARE THE REASON TWO OF MY OWN TALLIES DISAGREED BY 14. `Number(p.votes && p.votes.total)`
        // is `Number(null)` on a votes-less row, and `Number(null) === 0` — so a veto with NO committee at all
        // was counted as an EXACT TIE, and its `quantScore` read as 0, which made it look like "the quant half
        // declined 14 entries". It is the same coercion this file's own comments warn about ("`Number(null) === 0`
        // made a null rate a FREE bucket"), reproduced one layer up in a report. The real quant-side count is 0.
        attribution: 'risk_veto',
        tie: false,
      };
    }
    // ★ TRD-EXE-7 (#1475): the gate approved a size, so it is committed for the rest of this wake. `notionalPct` is
    // published by the gate itself rather than recomputed here — the size has been through the whole cap chain by
    // then, and a second computation would be a second place to disagree.
    if (risk.sizeCalc && Number.isFinite(Number(risk.sizeCalc.notionalPct))) {
      committedPct += Number(risk.sizeCalc.notionalPct);
    }
    proposal.size = risk.size;
    const qv = quantVotes(quantResult, proposal, quantPanel);
    let cv = { votes: [], score: 0, responded: 0, abstained: 0 };
    let llmCalled = false;
    if (chairs.length) {
      const sizeNote = ` RISK ENGINE (deterministic): proposed size ${risk.size} units (${risk.units}${risk.reasons.length ? '; notes: ' + risk.reasons.join('; ') : ''}).`
        + ticketGeometryNote(risk, proposal, settings);
      // ★ TRD-LLM-3: `qv` is computed ABOVE and used to be discarded here — the seat voted without the panel.
      cv = await chairVotes(userId, focusText + sizeNote + quantPanelNote(qv), settings, chairs);
      llmCalled = true; anyLlm = true;
      if (!allVoteAgg) allVoteAgg = voteAggFrom(cv);
    }
    const { chairOffline, avgConf, weightedChairVote } = chairSummary(cv, chairs);
    // Degraded entries (2026-09-10): when every chair abstained ONLY because
    // of budget caps (a resource limit, not a malfunction), the desk may
    // still enter at a reduced size instead of blocking outright. Transport
    // / parse failures stay fail-secure — never trade on a broken LLM path.
    const offlineCauses = cv.votes.map((v) => v.reason || '');
    const benignOffline = chairOffline && offlineCauses.length > 0
      && offlineCauses.every((r) => String(r).startsWith('budget_cap'));
    // TRD-VET-1: ONE place decides the committee's verdict, so the rule can be read and tested without
    // reconstructing it from four locals (see committeeVerdict above for the rule and the measured case).
    const verdict = committeeVerdict({
      quantScore: qv.score,
      chairScore: cv.score,
      chairResponded: cv.responded,
      hasChairs: chairs.length > 0,
      kind: proposal.type,
      chairOffline,
      veto: settings.deliberation && settings.deliberation.chairVeto,
    });
    const total = verdict.total;
    const approved = verdict.approved;
    let action = approved ? (proposal.type === 'exit' ? 'exit' : 'entry') : 'none';
    let execSize = risk.size;
    let sizeCalc = risk.sizeCalc || null;
    let reason = verdict.reason;
    if (chairOffline && action === 'entry') {
      const deg = (settings.deliberation && settings.deliberation.chairDegraded) || {};
      const factor = Math.max(0, Math.min(1, Number(deg.sizeFactor != null ? deg.sizeFactor : 0.5)));
      if (benignOffline && deg.enabled !== false && factor > 0 && Number(execSize) > 0) {
        const preDegradeSize = Number(execSize);
        const halved = Math.round(preDegradeSize * factor * 10000) / 10000;
        // ★★ TRD-EXE-3 (2026-09-30) — THE DEGRADE IS APPLIED *AFTER* THE VENUE'S FLOOR WAS SATISFIED, SO IT
        // CAN PUSH THE SIZE BACK BELOW IT, AND NOTHING RE-CHECKED.
        //
        // `risk.js` enforces `size >= venue minimum` (or is granted the floor by `acceptVenueFloor`), and it
        // now snaps the size onto the venue's step. This multiplies the RESULT of both by `factor` — 0.5 by
        // default — which is the one size mutation in the desk that happens downstream of every floor check.
        //
        // MEASURED: 16 of the 44 degraded decisions on file sent a size BELOW the venue's minimum. Because
        // the pre-degrade size is always >= the floor and the factor is 0.5, the halved size is always at
        // least HALF a floor, so the venue always resolved it to EXACTLY one floor. #1106 is the worked case
        // — SGX: decision #105106 carries the clamp's own `acceptedSize: 20` and `intendedRiskPct: 0.07`
        // beside `forcedRiskPct: 0.1640`; `order_attempt` then shows `size: 10` physically sent;
        // `Trades.size` recorded 10; `position_pnl` shows the venue holding 20. The "50% size" safety
        // measure produced a position at 100% of the floor-forced size and the record claimed the opposite.
        //
        // RE-SNAP AND RECORD THE FACTOR THAT WAS ACTUALLY ACHIEVED. The size sent is the size the venue
        // would have held either way, so the POSITION IS UNCHANGED — what changes is that the record stops
        // claiming a reduction the venue undid. `degradedFactorEffective` is the honest number, and it is
        // 1 on exactly the symbols where the floor is binding (SGX 2.34x, Sugar 15 Contracts).
        //
        // ⚠ NOTHING HERE DECIDES WHETHER SUCH AN ENTRY SHOULD PROCEED AT ALL. `degradedFloorDefeated`
        // reports the condition so the desk can be asked; refusing the entry would be a behavioural change
        // on a live risk path, and that is the owner's call, not this branch's.
        const step = require('./instruments').snapToVenueStep(halved, risk.venueFloor && risk.venueFloor.minUnits);
        execSize = step.snapped ? step.size : halved;
        const effectiveFactor = preDegradeSize > 0 ? Math.round((execSize / preDegradeSize) * 10000) / 10000 : null;
        // DEFEATED means the venue put BACK risk the degrade had taken off: the snapped size is exactly one
        // step while the pre-degrade size was more than one, so the achieved factor is worse than the one
        // the policy asked for. Reporting it as a plain x0.5 while it is really x1.0 is the defect.
        const floorDefeated = step.snapped && step.steps === 1
          && effectiveFactor != null && effectiveFactor > factor + 1e-9;
        action = 'entry';
        reason = `chair unavailable (budget cap) — degraded entry at ${Math.round(factor * 100)}% size, quant-only`;
        if (sizeCalc) {
          sizeCalc = {
            ...sizeCalc, finalSize: execSize, degradedChair: true, degradedFactor: factor,
            degradedFactorEffective: effectiveFactor,
            degradedFloorDefeated: floorDefeated,
            degradedFloorMinUnits: step.minUnits == null ? null : step.minUnits,
            degradedSteps: step.steps == null ? null : step.steps,
            reasons: [
              ...(sizeCalc.reasons || []),
              `chair budget offline — degraded entry x${factor}`,
              floorDefeated
                ? `⚠ the venue's floor DEFEATED the degradation: ${preDegradeSize} x ${factor} = ${halved}, below the venue's own minimum ${step.minUnits}, which the venue resolves to ${step.steps} x ${step.minUnits} = ${execSize} — this entry therefore carries ${effectiveFactor}x the pre-degrade size, NOT x${factor}`
                : `degraded factor honoured: ${preDegradeSize} x ${factor} = ${execSize}`,
            ],
          };
        }
      } else {
        action = 'none';
        execSize = null;
        reason = 'chair unavailable — new entries blocked (fail-secure)';
      }
    }
    if (action === 'entry' && sessionLock) { action = 'none'; execSize = null; reason = `SESSION_LOCK blocks new entries — ${session.detail || 'entries locked'}`; }
    return {
      action, symbol: proposal.symbol, direction: proposal.direction, type: proposal.type,
      strategy: proposal.strategy || null, size: action === 'none' ? null : execSize,
      // ⚠⚠ TWO DISTANCES, AND UNTIL 2026-09-25 ONLY ONE WAS PUBLISHED — THE ONE THE NUMBERS ARE NOT ABOUT.
      // `risk.js` carries `stopDistance` = the DECLARED 2xATR (kept because the TAKE-PROFIT is placed at
      // 1.5 x declared) and `effectiveStopDistance` = the capped distance the VENUE ACTUALLY ENFORCES. Every
      // cost and risk number in this record is computed on the SECOND: `costShareOfR` is
      // `costPct / (effectiveStopDist/price)`, and the size cap is `risk$ / effectiveStopDist`.
      //
      // MEASURED on the 2026-09-25 Oil decision: the card published `stopDistance: 1.3538` (1.4586% of
      // 92.815) BESIDE `costShareOfR: 0.576`, and those two cannot both describe that position —
      // `costShareOf(0.1728, 1.4586)` is 0.1185, while 0.576 is exactly what the capped 0.3000% gives. The
      // ratio is 4.86x, so a reader who took the published stop and recomputed the share got 11.9% where the
      // desk meant 57.6%: the record could support the OPPOSITE conclusion about the trade. That is the
      // TRD-96/98/101/102/114 defect class ("a number that does not mean what it says") reappearing one layer
      // ABOVE where it was fixed.
      //
      // ⚠ AND THE CHAIR REACHED THE RIGHT ANSWER FROM PROSE. chair-2's veto quoted the risk note's sentence
      // ("stop capped at 0.3% of price (declared 1.459%) ... venue cost 0.1728% consumes 58% of R"); the
      // structured field beside it said 1.459%. A seat reasoning from the FIELD would have seen a 1.46% stop
      // with an 11.9% cost share — a comfortable trade. Both distances therefore travel together now.
      stopDistance: risk.stopDistance || null,
      effectiveStopDistance: risk.effectiveStopDistance ?? null,
      stopCap: risk.stopCap || null,
      chairVote: weightedChairVote, confidence: avgConf,
      votes: { quantVotes: qv.votes, quantScore: round4(qv.score), chairVotes: cv.votes, chairScore: round4(cv.score), total: round4(total), chairVeto: verdict.chairVeto, tie: verdict.tie, attribution: verdict.attribution },
      reason, riskReasons: risk.reasons, riskSize: risk.size, sizeCalc,
      // ★ TRD-RSK-7: the profile travels on BOTH decision shapes. A field that appears on one path and not the
      // other is how a resolution becomes unauditable on exactly the path a reader happens to be looking at.
      riskProfile: risk.riskProfile || null,
      blockedReason: blocked || null, sessionLock, stale, llmCalled,
      // TRD-114 (2026-09-21): THE NUMBER THIS ROW WAS ABOUT WAS RECORDED NOWHERE. `costShareOfR` lived only
      // inside risk.js, so neither a study nor the UI could read what the venue round trip was worth
      // relative to the risk unit on a given ticket — which is how 40%-of-R ran unnoticed for a week. It
      // lands beside the size and the stop distance, and `costShareCeiling` says what it was compared
      // against, so the pair cannot be re-derived wrongly later.
      //
      // ⚠ THAT LAST CLAIM WAS FALSE UNTIL 2026-09-25, AND THE MEASUREMENT SAYS SO. It "lands beside the stop
      // distance" — but the distance beside it was the DECLARED one, which this number is not computed on, so
      // the pair COULD be, and was, re-derived wrongly. Carrying `effectiveStopDistance` is what makes the
      // sentence above true rather than aspirational.
      costShareOfR: risk.costShareOfR ?? null,
      costShareCeiling: risk.costShareCeiling ?? null,
    };
  };

  for (const s of proposalSyms) {
    const proposal = { ...s.signal, symbol: s.symbol, venue: s.venue, price: s.price, atr14: s.atr14, adx14: s.adx14, spread: s.spread, series: s.series || null };
    const focus = bundleTextFinal + `\n\nVOTE ON THIS PROPOSAL ONLY: ${proposal.type} ${proposal.direction} ${proposal.symbol} — basis: ${proposal.basis}.`;
    decisions.push(await deliberateOne(proposal, focus));
  }

  // TRD-55 (2026-09-14): the BOOK ROUND used to live here - positions open and
  // no proposal meant the chairs were still convened on the full bundle, and
  // they returned a foreordained "no" (chair.js: no proposal = vote no) while
  // this row's action was hardcoded 'none', so the round could never close
  // anything. It is GONE: `committeePlan` above returns before this point, so
  // an agent position with no proposal now costs zero LLM tokens. Do not
  // reintroduce a chair call in a no-proposal path - if the desk should act on
  // an open position, that decision belongs in review.js with a stated ask.

  const firstExec = decisions.find((d) => d.action === 'entry' || d.action === 'exit') || null;
  // ★ TRD-TRL-1 defect 1(b) (2026-09-30): A SUPPRESSED EXIT IS STILL AN EXIT THE DESK SIGNALLED.
  //
  // When the pre-deliberation tolerance gate removes the wake's only signal, `decisions` is empty and the
  // naive reading would report `no_signal` — i.e. the wake log would claim the desk saw nothing, on a wake
  // where the trail fired and the desk chose to hold. That is precisely the "state that is not the state"
  // class this suppression exists to keep out of the ledger, so the wake reports the exit and says why it was
  // not deliberated. `no_signal` remains reserved for a wake that genuinely had none.
  const suppressedOnly = !firstExec && !decisions.length && suppressedCount(suppressedExits) > 0;
  const action = firstExec ? firstExec.action : (suppressedOnly ? 'exit' : 'none');
  const reason = firstExec ? firstExec.reason
    : (decisions.length ? decisions[0].reason
      : (suppressedOnly ? 'deferred_before_deliberation' : (blocked || 'no_signal')));
  const promptId = await store.createPrompt(userId, {
    triggerType: trigger,
    bundle: { ...bundleObj, text: bundleText },
    response: decisions.length ? JSON.stringify({ decisions }) : null,
    decision: {
      action, reason,
      symbol: firstExec ? firstExec.symbol : null,
      direction: firstExec ? firstExec.direction : null,
      llmCalled: anyLlm,
      decisions,
    },
    model: allVoteAgg ? allVoteAgg.model : null,
    usage: allVoteAgg ? allVoteAgg.usage : null,
    latencyMs: allVoteAgg ? allVoteAgg.latencyMs : null,
  });

  // DESIGN BIBLE v1: the LLM is a distinct, auditable actor; rationale is
  // logged VERBATIM alongside each per-symbol decision. Vetoed proposals
  // are logged too (actor system:risk — the risk engine, not the LLM).
  const log = require('./log');
  for (const d of decisions) {
    const chairModels = (d.votes && d.votes.chairVotes || []).map((v) => v.model).filter(Boolean);
    await log.write(userId, 'decision', { promptId, ...d }, {
      actor: d.llmCalled ? `llm:${chairModels[0] || 'unknown'}:${promptId}` : 'system:risk',
      correlationId: `wake:${promptId}`,
      rationale: d.reason || null,
    });
  }
  // ★★ ONE WAKE, ONE EVENT (TRD-WAK-2, 2026-09-27). The `log.write(userId,'wake',…)` that stood here is GONE.
  // This was the second of the aggregator's three wake writers, and the pipeline wrote a fourth; see the long note
  // on the no-proposal path above for the measurement (815 of 1,426 wakes duplicated). The per-decision rows it
  // carried are reconstructed by `demoWakePayload` from the same `decisions` array returned below, so the record
  // keeps every field it had.
  return {
    promptId, action, reason, llmCalled: anyLlm, blocked: blocked || null,
    quant: qs, session: session.state, stale, positions: openTrades.length,
    decision: {
      action, reason,
      symbol: firstExec ? firstExec.symbol : null,
      direction: firstExec ? firstExec.direction : null,
      decisions,
    },
  };
}

// ★ DELETED 2026-09-27 (TRD-WAK-2): `extraQuantFields` existed only to spread { quant, session, stale, positions }
// into the aggregator's OWN wake event. With that event gone and the pipeline the single writer, these fields are
// returned directly on the result and merged by `demoWakePayload`, so keeping the helper would leave a function
// whose only purpose was the duplicate.
async function finish({ userId, trigger, bundleObj, bundleText, action, reason, llmCalled, decision, vote, blocked, extra }) {
  if (bundleText) bundleObj.text = bundleText;
  const promptId = await store.createPrompt(userId, {
    triggerType: trigger,
    bundle: bundleObj,
    response: vote ? vote.raw : null,
    decision,
    model: vote ? vote.model : null,
    usage: vote ? vote.usage : null,
    latencyMs: vote ? vote.latencyMs : null,
  });
  // DESIGN BIBLE v1: the LLM is a distinct, auditable actor; rationale is
  // logged VERBATIM (never paraphrased) alongside the action.
  const chairModels = (decision && decision.votes && decision.votes.chairVotes || []).map((v) => v.model).filter(Boolean);
  const logCtx = {
    actor: `llm:${chairModels[0] || 'unknown'}:${promptId}`,
    correlationId: `wake:${promptId}`,
    rationale: decision && decision.reason ? String(decision.reason) : undefined,
    durationMs: vote && vote.latencyMs != null ? vote.latencyMs : undefined,
  };
  const log = require('./log');
  if (decision) await log.write(userId, 'decision', { promptId, ...decision }, logCtx);
  // ★★ NO `log.write(userId,'wake',…)` HERE EITHER (TRD-WAK-2). See the note on the no-proposal path: the
  // pipeline is the single wake writer, so this path returns its fields instead. The `decision` event ABOVE stays
  // — it is a different kind, with a different consumer, and it was never duplicated.
  return {
    promptId, action, reason, llmCalled, decision, blocked: blocked || null,
    quant: (extra && extra.quant) || null, stale: (extra && extra.stale) == null ? null : extra.stale,
    positions: (extra && extra.positions) == null ? null : extra.positions,
  };
}

module.exports = { decide, pickProposal, deliberators, quantVotes, DELIB_DEFAULTS, committeeVerdict, resolveChairs, chairRoster, quantPanelNote, ticketGeometryNote, deliberationSymbols };
