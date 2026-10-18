// trading/agent/shadowGate.js — TRD-SHW-3 (2026-09-14).
//
// THE PRE-REGISTERED PROMOTION GATE for the shadow-signal ledger.
//
// PURE: no DB, no network, no clock. The runner (trading/scripts/shadow-gate.js)
// fetches rows and bars and hands them here; this file decides, and renders.
//
// WHY PRE-REGISTRATION IS THE WHOLE POINT
// The shadow ledger exists to answer one question — can the desk's AI see a move
// before the desk's own instruments record it — and this desk has a documented
// history (EVIDENCE_THRESHOLDS.md) of thresholds being CHOSEN after the fact and
// then quietly becoming load-bearing. So every quantity that could be moved once
// the data is visible is fixed HERE, in code, before the data exists:
//   the two populations, the two baselines, the family size, the multiplicity
//   rule, the bootstrap seed, and the promotion criteria.
//
// The gate therefore REFUSES to compute a test it has not unlocked. When n is
// short, evaluateShadowGate returns p:null and the renderer prints NOT RUN, rather
// than producing a p-value that a reader would inevitably interpret. A p-value
// computed early is worse than no p-value, because it looks like evidence.
//
// THE NULL IS CONDITIONAL, AND THE REPORT MUST SAY SO IN THESE WORDS: a negative
// result means "on a bundle with the desk's own signal withheld, the AI does not
// see moves early" — NOT "the AI cannot see early signs". The variant with the
// signal present is untestable, because the signal is the desk's verdict and
// showing it makes the question circular.
'use strict';

const { expectancyVerdict, requiredSample, sampleSd } = require('./expectancy');
const { HORIZON_BARS } = require('./shadow');
const { benchmarkLongPct, rOf, riskPctOf } = require('./shadowScore');

// ---------------------------------------------------------------------------
// FROZEN. Changing any value here invalidates every look already taken, so a
// change must be recorded as a new prompt version and a new pre-registration,
// never as an edit to this block.
// ---------------------------------------------------------------------------
const GATE = {
  MIN_TOTAL_CALLS: 50, // gate 1: enough calls to establish the yes rate
  MIN_YES: 50,         // gate 2: enough YES answers to test an edge on
  Q: 0.10,             // Benjamini-Hochberg false-discovery rate
  FAMILY_K: 2,         // exactly two hypotheses: shadow-vs-B and shadow-vs-C
  ALPHA: 0.05,         // one-directional, per family member, before BH
  BOOT_TRIALS: 5000,   // bootstrap resamples for the paired means
  C_TRIALS: 500,       // random-entry draws per row for baseline C
  SEED: 20260914,      // fixed so two runs on one dataset cannot disagree
};

const CONDITIONAL_NULL =
  'Negative means: on a bundle with the desk\'s own signal withheld, the AI does not '
  + 'see moves early. It does NOT mean the AI cannot see early signs — the variant with '
  + 'the signal present is untestable, because the signal is the desk\'s verdict and '
  + 'showing it makes the question circular.';

// ---------------------------------------------------------------------------
// Small deterministic statistics. mulberry32 is re-implemented here rather than
// imported from backtest.js, which keeps it private; the test asserts the
// sequence is stable, so a future dedup cannot silently change a reported CI.
// ---------------------------------------------------------------------------
function mulberry32(a) {
  let t = a >>> 0;
  return function rng() {
    t = (t + 0x6D2B79F5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantileSorted = (s, q) => {
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
};
const round = (n, dp = 4) => (isNum(n) ? Math.round(Number(n) * 10 ** dp) / 10 ** dp : null);

// Paired bootstrap of a mean. Returns the house-shaped interval: `lower` and
// `upper` are each one-directional at `alpha`, matching expectancyVerdict, so
// `lower > 0` is accept and `upper < 0` is retire and the two rules agree.
function bootstrapMean(xs, { trials = GATE.BOOT_TRIALS, seed = GATE.SEED, alpha = GATE.ALPHA } = {}) {
  const n = xs.length;
  if (!n) return { n: 0, mean: null, lower: null, upper: null, p: null, trials: 0, seed };
  const rng = mulberry32(seed);
  const draws = new Array(trials);
  let leZero = 0;
  for (let t = 0; t < trials; t++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[(rng() * n) | 0];
    const m = s / n;
    draws[t] = m;
    if (m <= 0) leZero++;
  }
  draws.sort((a, b) => a - b);
  return {
    n,
    mean: mean(xs),
    sd: sampleSd(xs),
    // The +1 correction keeps p strictly positive: a bootstrap cannot observe a
    // probability of zero, and reporting one would be a certainty claim.
    p: (leZero + 1) / (trials + 1),
    lower: quantileSorted(draws, alpha),
    upper: quantileSorted(draws, 1 - alpha),
    trials,
    seed,
  };
}

// Benjamini-Hochberg step-up, general m.
//
// ★ THE NON-OBVIOUS PROPERTY, and the one a reader will get wrong: this is a
// STEP-UP procedure. It finds the LARGEST rank whose p clears that rank's cutoff
// `(rank/m)*q` and then declares EVERY rank at or below it. So with m=2, q=0.10,
// p = [0.06, 0.08] declares BOTH — rank 2's cutoff (0.10) carries rank 1
// (whose own cutoff is 0.05). That is the method working as defined, not a bug,
// and it is deliberately NOT the rule "each p < 0.10" and NOT the stricter
// "rank 1 must clear 0.05 on its own".
//
// ★ A null p-value is NEVER significant. In JS `null <= 0.05` evaluates to TRUE
// (null coerces to 0), so an unrun test would otherwise be declared a discovery —
// which is exactly the failure this gate exists to prevent. Hence `p != null`.
function benjaminiHochberg(pvals, q = GATE.Q) {
  const m = pvals.length;
  const ordered = pvals
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p == null ? 2 : a.p) - (b.p == null ? 2 : b.p) || a.i - b.i);
  const steps = ordered.map((e, rank) => ({
    i: e.i, p: e.p, rank: rank + 1, cutoff: round(((rank + 1) / m) * q, 6),
  }));
  let largest = -1;
  for (let rank = 0; rank < m; rank++) {
    const p = ordered[rank].p;
    if (p != null && p <= ((rank + 1) / m) * q) largest = rank;
  }
  const significant = new Array(m).fill(false);
  for (let rank = 0; rank <= largest; rank++) significant[ordered[rank].i] = true;
  return { q, m, significant, steps, declared: significant.filter(Boolean).length };
}

// ---------------------------------------------------------------------------
// Baselines. A = the shadow call's own realised R (in the row). B = the
// UNMIRRORED long return of the same window, already stored in R units by the
// scorer. C = random ENTRY within the same span, unmirrored long, in R units.
//
// B is deliberately not mirrored to the call's direction: a benchmark that
// mirrors the treatment has the treatment's payoff by construction and measures
// nothing. See the rev-5 correction in the plan doc.
// ---------------------------------------------------------------------------
function barsAfter(bars, fromIso) {
  const from = new Date(fromIso).getTime();
  return (bars || [])
    .filter((b) => new Date(b.barStart).getTime() > from)
    .sort((a, b) => new Date(a.barStart).getTime() - new Date(b.barStart).getTime());
}

// A random entry uniformly inside the same HORIZON_BARS-bar span the call itself
// covered, held for HORIZON_BARS. Bounding the entry to the call's own span is
// what makes C a comparable baseline rather than a different market regime.
function randomEntryPct(row, bars, rng) {
  const win = barsAfter(bars, row.createdAt);
  if (win.length <= HORIZON_BARS) return null; // no freedom to enter elsewhere
  const maxOffset = Math.min(HORIZON_BARS - 1, win.length - HORIZON_BARS - 1);
  const offset = (rng() * (maxOffset + 1)) | 0;
  const slice = win.slice(offset, offset + HORIZON_BARS);
  return benchmarkLongPct(slice);
}

// Returns one baseline-C R per row (the mean of its draws), so the shadow-vs-C
// test is paired on the row exactly like shadow-vs-B.
function baselineCRows(rows, barsFor, { trials = GATE.C_TRIALS, seed = GATE.SEED } = {}) {
  const rng = mulberry32(seed);
  return rows.map((row) => {
    const riskPct = riskPctOf(row.atr14, row.priceAtCall);
    const draws = [];
    const bars = typeof barsFor === 'function' ? barsFor(row) : barsFor;
    for (let t = 0; t < trials; t++) {
      const pct = randomEntryPct(row, bars, rng);
      if (pct != null) draws.push(rOf(pct, riskPct));
    }
    return { row, cR: draws.length ? mean(draws) : null, draws: draws.length };
  });
}

function gateStatus({ totalCalls, yesCount }) {
  const g1 = totalCalls >= GATE.MIN_TOTAL_CALLS;
  const g2 = yesCount >= GATE.MIN_YES;
  const waitingOn = g2 ? null : g1 ? 'yes' : 'calls';
  return {
    totalCalls,
    yesCount,
    gate1: g1,
    gate2: g2,
    minTotalCalls: GATE.MIN_TOTAL_CALLS,
    minYes: GATE.MIN_YES,
    waitingOn,
    message: g2
      ? `both gates open (${totalCalls} calls, ${yesCount} yes)`
      : g1
        ? `gate 2 waiting: ${yesCount}/${GATE.MIN_YES} yes answers (${GATE.MIN_YES - yesCount} to go)`
        : `gate 1 waiting: ${totalCalls}/${GATE.MIN_TOTAL_CALLS} calls recorded`,
  };
}

// ---------------------------------------------------------------------------
// The gate itself.
// ---------------------------------------------------------------------------
function evaluateShadowGate({ signals, barsFor, looks = 1, seed = GATE.SEED, trials = GATE.BOOT_TRIALS } = {}) {
  const all = signals || [];
  const directional = all.filter((r) => r.direction === 'buy' || r.direction === 'sell');
  const scored = directional.filter((r) => isNum(r.realisedR));
  const status = gateStatus({ totalCalls: all.length, yesCount: scored.length });

  const aAll = scored.map((r) => Number(r.realisedR));
  const winPct = aAll.length ? (aAll.filter((x) => x > 0).length / aAll.length) * 100 : null;

  const report = {
    generatedFor: 'TRD-SHW-3',
    promptVersion: require('./shadow').PROMPT_VERSION,
    horizonBars: HORIZON_BARS,
    looks,
    seed,
    gate: status,
    counts: {
      totalCalls: all.length,
      directional: directional.length,
      unscoredDirectional: directional.length - scored.length,
      yes: scored.length,
    },
    sample: {
      n: aAll.length,
      meanR: round(mean(aAll)),
      medianR: round(median(aAll)),
      sdR: round(sampleSd(aAll)),
      winPct: round(winPct, 2),
    },
    baselines: {},
    tests: { run: false, reason: null, family: [] },
    bh: null,
    verdict: null,
    conditionalNull: CONDITIONAL_NULL,
  };

  if (!status.gate2) {
    report.tests.reason = status.message;
    report.verdict = 'not_ready';
    return report;
  }

  // T1: shadow vs B, paired on the row (same symbol, same window).
  const pairedB = scored.filter((r) => isNum(r.benchmarkLongR));
  const d1 = pairedB.map((r) => Number(r.realisedR) - Number(r.benchmarkLongR));

  // T2: shadow vs C, paired on the row (C's own randomness averaged out first).
  const cRows = baselineCRows(scored, barsFor, { seed });
  const pairedC = cRows.filter((c) => isNum(c.cR));
  const d2 = pairedC.map((c) => Number(c.row.realisedR) - Number(c.cR));

  const t1 = bootstrapMean(d1, { trials, seed });
  const t2 = bootstrapMean(d2, { trials, seed: seed + 1 });
  const bh = benjaminiHochberg([t1.p, t2.p], GATE.Q);

  report.baselines = {
    A_shadow: report.sample,
    B_unmirroredLong: { n: pairedB.length, meanR: round(mean(pairedB.map((r) => Number(r.benchmarkLongR)))), note: 'same window, unmirrored long, in R units' },
    C_randomEntry: { n: pairedC.length, meanR: round(mean(pairedC.map((c) => Number(c.cR)))), trials: GATE.C_TRIALS, note: 'uniform entry inside the call\'s own span, held the same horizon' },
  };
  report.tests = {
    run: true,
    reason: null,
    family: [
      { id: 'shadow_vs_B', hypothesis: 'mean(R_shadow - R_unmirroredLong) > 0', ...t1, significant: bh.significant[0] },
      { id: 'shadow_vs_C', hypothesis: 'mean(R_shadow - R_randomEntry) > 0', ...t2, significant: bh.significant[1] },
    ],
  };
  report.bh = bh;

  const promoted = bh.declared > 0
    && report.tests.family.some((t) => t.id === 'shadow_vs_B' && t.significant);
  report.verdict = promoted ? 'promote' : 'reject_at_this_n';

  // The house verdict on the shadow sample itself, so alpha spending across
  // repeated looks is applied by the same rule every other strategy uses.
  report.alphaSpent = expectancyVerdict(
    { n: aAll.length, meanR: report.sample.meanR, sdR: report.sample.sdR },
    { alpha: GATE.ALPHA, looks, minTrades: GATE.MIN_YES },
  );
  report.sampleToVerdict = requiredSample(
    { meanR: report.sample.meanR, sdR: report.sample.sdR },
    { alpha: GATE.ALPHA, looks, minTrades: GATE.MIN_YES },
  );
  return report;
}

// ---------------------------------------------------------------------------
// Renderer. The report is the artefact a human reads, so the caveats are part
// of the template rather than something an author must remember to add.
// ---------------------------------------------------------------------------
function renderReport(r) {
  const L = [];
  const p = (s) => L.push(s);
  p('# Shadow-signal promotion gate');
  p('');
  p(`Prompt version \`${r.promptVersion}\` · horizon ${r.horizonBars} bars · looks ${r.looks} · bootstrap seed ${r.seed}`);
  p('');
  p('## Gates');
  p('');
  p(`- **Gate 1** (total calls ≥ ${r.gate.minTotalCalls}): ${r.gate.gate1 ? 'OPEN' : 'WAITING'} — ${r.counts.totalCalls}`);
  p(`- **Gate 2** (yes answers ≥ ${r.gate.minYes}): ${r.gate.gate2 ? 'OPEN' : 'WAITING'} — ${r.counts.yes}`);
  p('');
  p(`**${r.gate.message}**`);
  p('');
  p('## Sample');
  p('');
  p(`| n | mean R | median R | sd | win % |`);
  p(`|---|---|---|---|---|`);
  p(`| ${r.sample.n} | ${r.sample.meanR} | ${r.sample.medianR} | ${r.sample.sdR} | ${r.sample.winPct} |`);
  p('');
  if (!r.tests.run) {
    p('## Tests — **NOT RUN**');
    p('');
    p(`\`${r.tests.reason}\`. No p-value is computed and none is reported: a p-value`);
    p('taken before the gate opens looks like evidence and is not.');
    p('');
    p(`**Verdict: not ready.**`);
  } else {
    p('## Baselines');
    p('');
    p(`| baseline | n | mean R | definition |`);
    p(`|---|---|---|---|`);
    p(`| A — shadow | ${r.baselines.A_shadow.n} | ${r.baselines.A_shadow.meanR} | the AI's call, scored as the desk scores |`);
    p(`| B — unmirrored long | ${r.baselines.B_unmirroredLong.n} | ${r.baselines.B_unmirroredLong.meanR} | ${r.baselines.B_unmirroredLong.note} |`);
    p(`| C — random entry | ${r.baselines.C_randomEntry.n} | ${r.baselines.C_randomEntry.meanR} | ${r.baselines.C_randomEntry.note} |`);
    p('');
    p(`## Tests (BH q=${r.bh.q}, m=${r.bh.m})`);
    p('');
    p(`| test | n | mean diff | lower | upper | p | BH cutoff | significant |`);
    p(`|---|---|---|---|---|---|---|---|`);
    for (const [i, t] of r.tests.family.entries()) {
      const step = r.bh.steps.find((s) => s.i === i);
      p(`| ${t.id} | ${t.n} | ${round(t.mean)} | ${round(t.lower)} | ${round(t.upper)} | ${round(t.p, 6)} | ${step ? step.cutoff : ''} | ${t.significant ? '**yes**' : 'no'} |`);
    }
    p('');
    p(`BH declared ${r.bh.declared} of ${r.bh.m}. Note that q=${r.bh.q} with m=2 is *not*`);
    p('"p < 0.10 each": rank 1 must clear 0.05, rank 2 must clear 0.10.');
    p('');
    p(`**Verdict: ${r.verdict}.**`);
  }
  p('');
  p('## The null is conditional');
  p('');
  p(r.conditionalNull);
  p('');
  p('## Scope limits');
  p('');
  p('- `scheduledEvent` is covered for FOMC (imported from federalreserve.gov into');
  p('  `CorporateEvents`) and for halts the desk already stores. **CPI / NFP and other');
  p('  BLS releases are NOT covered** and need manual rows.');
  p('- Counterfactual R assumes the call could have been entered at its own price and');
  p('  held the full horizon. The desk\'s real exits (venue SL/TP, trailing, position');
  p('  review) differ, so shadow R is not the R the desk would have booked.');
  p('');
  return L.join('\n');
}

module.exports = {
  GATE, CONDITIONAL_NULL, mulberry32, mean, median, quantileSorted,
  bootstrapMean, benjaminiHochberg, barsAfter, randomEntryPct, baselineCRows,
  gateStatus, evaluateShadowGate, renderReport,
};
