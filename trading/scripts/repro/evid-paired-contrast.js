// trading/scripts/repro/evid-paired-contrast.js — TRD-EVD-1's harness. READ-ONLY: writes nothing, releases
// nothing, registers nothing. The pre-registration it executes is
// docs/trd-evd-1-pre-registration-2026-09-23.md; this file's job is to obey it, including the parts that
// constrain what may be REPORTED and in what ORDER.
//
// THE UNIT. One trade of `survoil`, labelled condition-true/false by the already-registered S3 predicate.
// The endpoint is the WITHIN-SIGNAL difference in mean R — condition-true minus condition-false — which
// cancels the signal's own expectancy and the market regime because both cells share them.
//
// ★ WHY R IS THE RATIO OF netPnl. `turtleUltimate.backtest` sizes every position as
//   `size = (capital * riskPerTradePct/100) / stopDist`, so `size * stopDist` — the nominal risk — is the
//   SAME CONSTANT on every trade. R = netPnl / nominalRisk is therefore an exact positive rescaling of
//   netPnl, and the contrast, its CI and the twin distribution are all invariant to it. The reported MDE
//   in the pre-registration is stated in R, so the scaling is applied rather than assumed away.
//
// ★ WHAT THIS SCRIPT REFUSES TO DO, from §7 of the pre-registration:
//   1. it prints the WINDOW IN FORCE first (bars, span, range argument), because the window's identity
//      depends on the 12,000-bar cap, not on the range argument alone;
//   2. it prints BOTH CELL SIZES and the floor check BEFORE any difference is quoted;
//   3. it reports the grid even when the primary is negative — the grid is a specificity check and a
//      failing cell is NEUTRAL, not a contradiction;
//   4. it never promotes a grid cell, and never reports a below-floor cell as evidence.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { getPool } = require('../../../shared/db');
const backtest = require('../../agent/backtest');
const strategies = require('../../agent/strategies');
const lab = require('../../agent/lab');
const { computeStructure } = require('../../agent/structure');
const s3 = require('../../agent/strategies/survGoldStruct');
const { seedFor } = require('../../agent/lab/scoreboard');
const wf = require('../../agent/lab/walkforward');

const USER = 1;
const SYMBOL = 'Oil';          // §3.2: the primary. `survgoldstruct` is Gold-only, so this tests the PREDICATE.
const VENUE = 'yahoo';         // the signal series (`IND_VENUE_PREF` resolves Oil to yahoo)
const TF = '1h';
const RANGE = null;            // §3.4: the registered window. NOT '1y'.
const SEED_NUM = 9001;         // §3.3: declared constant, deliberately outside the registration namespace
const FLOOR = 20;              // §3.3: n per cell, inherited from releaseAll's verdict rule
const TWINS = 200;             // §5: N >= 200
const CAPITAL_KEY = 'capital';

// Declared here, not beside the grid, because the PARAMETER ROUTING PROBE consumes them before the grid does.
const PARAM_KEYS = ['k', 'd', 'r', 'n'];
const GRID_VALS = s3.SENSITIVITY_GRID;

const args = process.argv.slice(2);
const GRID = args.includes('--grid=full') ? 'full' : 'oat';   // one-at-a-time vs the full product
const NO_GRID = args.includes('--no-grid');

// ---- helpers ---------------------------------------------------------------------------------------

// mulberry32 — a small seeded PRNG. Deterministic so the twin distribution is reproducible from the seed.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function sd(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function pct(list, f) {
  if (!list.length) return NaN;
  const r = [...list].sort((a, b) => a - b);
  return r[Math.min(r.length - 1, Math.floor(r.length * f))];
}
function pf(xs) {
  const w = xs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const l = Math.abs(xs.filter((x) => x < 0).reduce((a, b) => a + b, 0));
  return l > 0 ? w / l : null;
}

// The paired bootstrap: resample TRADE INDICES once, form BOTH cells from the same resample, recompute the
// difference. Pairing is what makes this a within-signal contrast rather than two independent samples.
function pairedBootstrap(labels, rs, { draws = 2000, seed = seedFor(SEED_NUM) } = {}) {
  const n = rs.length;
  if (!n) return { lo: NaN, hi: NaN, note: 'no trades' };
  const rand = rng(seed);
  const out = [];
  for (let d = 0; d < draws; d++) {
    const idx = [];
    for (let i = 0; i < n; i++) idx.push(Math.floor(rand() * n));
    const a = [];
    const b = [];
    for (const i of idx) (labels[i] ? a : b).push(rs[i]);
    if (!a.length || !b.length) continue;
    out.push(mean(a) - mean(b));
  }
  if (out.length < draws * 0.5) return { lo: NaN, hi: NaN, note: `only ${out.length} usable draws — a cell was empty too often` };
  return { lo: pct(out, 0.025), hi: pct(out, 0.975), draws: out.length };
}

// ---- the predicate, at the registered convention ---------------------------------------------------
//
// `survGoldStruct.gateAt` is the registered code. It rebuilds the whole bar array on every call, which is
// O(n) per trade and unaffordable across a grid, so this precomputes the normalised bars ONCE and reproduces
// `asOf = i - 1` exactly. ★ The reproduction is ASSERTED against `gateAt` on a sample below, because the
// alternative — assuming they agree — is the field-name/behaviour mismatch this project has already been
// bitten by twice (a gate that silently read `closePrice` as undefined and reported "zero trades" as a
// finding).
function makePredicate(series) {
  const bars = s3.toStructureBars(series);
  const cache = new Map();
  const structureAt = (i, params) => {
    const key = `${params ? JSON.stringify(params) : 'default'}|${i}`;
    if (cache.has(key)) return cache.get(key);
    let s = null;
    try { s = computeStructure({ bars, asOf: i - 1, params: params || undefined }); } catch { s = null; }
    cache.set(key, s);
    return s;
  };
  return { bars, structureAt, cache };
}

// §5's alternative predicates, implemented against the REAL structure fields (verified in structure.js:
// `bos` carries `{ index, direction, lagBars, level }`; `sweeps` is a list with `direction`).
const PREDICATES = {
  direction_agrees: (s, want) => !!s && s.state === 'ok' && s.direction === want,
  bos_agrees: (s, want) => !!s && s.state === 'ok' && !!s.bos && s.bos.direction === want,
  // ★ `structure.js` emits `swingKind: 'high' | 'low'`, NOT `direction`. A first version of this predicate
  // read `sw.direction`, which is `undefined` on every sweep, so `!some(...)` was `true` on 421 of 423
  // trades and produced a 1.05R "difference" that BEAT the twin threshold — a field-name mismatch that would
  // have fired falsifier 5 as a FALSE POSITIVE, i.e. an unstable-looking result invented by a typo. This is
  // the third time in this project that a field-name/shape mismatch presented as a plausible number.
  // A sweep is AGAINST a bullish entry when it took a HIGH (liquidity above, then closed back inside).
  // ⚠ §12's version of this predicate carried a `lag <= L`; L was never derived (its blocking rate swung
  // 31%->55% across L=3/10/unbounded), which is why the screen eliminated it. Run here WITHOUT L.
  no_sweep_against: (s, want) => {
    if (!s || s.state !== 'ok') return false;                 // fails CLOSED
    if (!Array.isArray(s.sweeps)) return false;              // unexpected shape fails closed, never open
    const against = want === 'bullish' ? 'high' : 'low';
    return !s.sweeps.some((sw) => sw && sw.swingKind === against);
  },
};

(async () => {
  await getPool();
  const strat = strategies.get('survoil');
  if (!strat) { console.error('FAILED: no strategy `survoil`'); process.exit(1); }

  // ---- 0. THE WINDOW IN FORCE (§7 item 1) ----------------------------------------------------------
  const loaded = await backtest.loadSeries(USER, {
    symbol: SYMBOL, venue: VENUE, timeframe: TF, range: RANGE, refreshData: false,
  });
  if (loaded.error) { console.error('FAILED: loadSeries —', loaded.error); process.exit(1); }
  const series = loaded.series;
  const n = series.length;
  const win = wf.windowIndices(n, 'LOCKBOX');

  console.log('=== 0. WINDOW IN FORCE (§7 item 1) ===');
  console.log(`  range argument passed : ${RANGE === null ? 'null' : `'${RANGE}'`}`);
  console.log(`  bars received         : ${n}          <- the binding constraint is the 12,000-bar cap`);
  console.log(`  span                  : ${loaded.spanDays} d`);
  console.log(`  ${loaded.rangeNote ? `range note: ${loaded.rangeNote}` : 'no range note'}`);
  console.log(`  W4 (secondary)        : bars ${win.start}..${win.end - 1}  (${win.end - win.start} bars)`);
  console.log(`  seed                  : seedFor(${SEED_NUM}) = ${seedFor(SEED_NUM)}  (twins only; trades are seed-independent)`);

  // ---- 1. THE CONTROL'S TRADES, and the pairing index ------------------------------------------------
  const cfg = { ...backtest.DEFAULTS, ...backtest.costCfgFor(SYMBOL), ...(strat.DEFAULTS || {}) };
  const labCtx = lab.labContext(series, {});
  const raw = strat.backtest(series, cfg, labCtx);
  const trades = raw.trades || [];
  if (!trades.length) { console.error('FAILED: no trades — refusing to report a null from an empty run'); process.exit(1); }
  const sheet = backtest.worksheet(trades, cfg, 'cfd');

  const timeToIdx = new Map(series.map((b, i) => [new Date(b.time).getTime(), i]));
  const nominalRisk = (Number(cfg[CAPITAL_KEY]) * Number(cfg.riskPerTradePct)) / 100;
  if (!(nominalRisk > 0)) { console.error(`FAILED: nominalRisk ${nominalRisk} — capital/riskPerTradePct missing`); process.exit(1); }

  const rows = [];
  let unmapped = 0;
  for (let k = 0; k < trades.length; k++) {
    const t = trades[k];
    const i = timeToIdx.get(new Date(t.entryTime).getTime());
    if (i == null) { unmapped++; continue; }
    rows.push({
      i, direction: t.direction, entryTime: t.entryTime,
      want: t.direction === 'buy' ? 'bullish' : 'bearish',
      netPnl: sheet.rows[k] ? sheet.rows[k].netPnl : 0,
      inW4: i >= win.start && i <= win.end - 1,
    });
  }
  for (const r of rows) r.r = r.netPnl / nominalRisk;

  console.log(`\n  nominal risk per trade: ${nominalRisk.toFixed(4)} (capital ${cfg[CAPITAL_KEY]} × ${cfg.riskPerTradePct}%)`);
  console.log(`  trades: ${trades.length}   paired: ${rows.length}` +
    `${unmapped ? `   ⚠ UNMAPPED (entryTime not in the series): ${unmapped}` : ''}`);
  if (unmapped) console.log('  ⚠ an unmapped entry means the pairing index is wrong for that trade — reported, not dropped silently');

  // ---- 2. EQUIVALENCE CHECK: the fast path must equal the registered gate ----------------------------
  const { structureAt } = makePredicate(series);
  {
    const probe = rows.slice(0, Math.min(12, rows.length));
    let mismatch = 0;
    for (const r of probe) {
      const mine = !!structureAt(r.i, null) && PREDICATES.direction_agrees(structureAt(r.i, null), r.want);
      const theirs = s3.gateAt(series, r.i, r.direction, null);
      if (mine !== theirs) mismatch++;
    }
    console.log(`\n=== 1. PREDICATE EQUIVALENCE — fast path vs the registered gateAt ===`);
    console.log(`  probed ${probe.length} trades, mismatches: ${mismatch}  ${mismatch ? '★ THE FAST PATH IS NOT THE REGISTERED PREDICATE — results below are void' : '(identical)'}`);
    if (mismatch) process.exit(1);
  }

  // ---- 3. CELL SIZES AND THE FLOOR, BEFORE ANY DIFFERENCE (§7 item 2) --------------------------------
  const label = (predicate, params) => rows.map((r) => predicate(structureAt(r.i, params), r.want));
  const primaryLabels = label(PREDICATES.direction_agrees, null);
  const nTrue = primaryLabels.filter(Boolean).length;
  const nFalse = primaryLabels.length - nTrue;

  console.log(`\n=== 2. CELL SIZES AND THE FLOOR (§7 item 2 — BEFORE any difference) ===`);
  console.log(`  condition-true  n = ${nTrue}`);
  console.log(`  condition-false n = ${nFalse}`);
  console.log(`  binding rate    = ${(nTrue / rows.length * 100).toFixed(1)}%   (Gold measured ~16%)`);
  const floorOk = nTrue >= FLOOR && nFalse >= FLOOR;
  console.log(`  floor (n >= ${FLOOR} PER CELL): ${floorOk ? 'CLEARED' : `★ NOT CLEARED — the answer is INSUFFICIENT-DATA (§3.3), not a small result`}`);

  // ---- 4. THE PRIMARY -------------------------------------------------------------------------------
  const rTrue = rows.filter((_, i) => primaryLabels[i]).map((x) => x.r);
  const rFalse = rows.filter((_, i) => !primaryLabels[i]).map((x) => x.r);
  const diff = nTrue && nFalse ? mean(rTrue) - mean(rFalse) : NaN;
  const ci = pairedBootstrap(primaryLabels, rows.map((x) => x.r));
  const sig = ci.lo != null && Number.isFinite(ci.lo) && (ci.lo > 0 || ci.hi < 0);

  console.log(`\n=== 3. PRIMARY — difference in mean R (condition-true − condition-false) ===`);
  if (!floorOk) {
    console.log(`  INSUFFICIENT-DATA. A cell is below the floor, so no difference is reported as a result.`);
    console.log(`  (The raw numbers are shown for completeness only and MUST NOT be cited as evidence.)`);
    console.log(`  raw: true meanR ${isNaN(mean(rTrue)) ? 'n/a' : mean(rTrue).toFixed(4)} · false meanR ${isNaN(mean(rFalse)) ? 'n/a' : mean(rFalse).toFixed(4)} · diff ${isNaN(diff) ? 'n/a' : diff.toFixed(4)}`);
  } else {
    console.log(`  difference  = ${diff.toFixed(4)}R`);
    console.log(`  paired bootstrap 95% CI = [${ci.lo.toFixed(4)}, ${ci.hi.toFixed(4)}]  (${ci.draws} draws)`);
    console.log(`  → ${sig ? 'DISTINGUISHABLE from zero' : 'NOT distinguishable from zero'}`);
    console.log(`\n  reported alongside (description, NOT a second hypothesis — no correction applied):`);
    console.log(`    cell            n     meanR      sdR     winRate   PF`);
    for (const [name, xs] of [['condition-true ', rTrue], ['condition-false', rFalse]]) {
      const wr = xs.filter((x) => x > 0).length / (xs.length || 1) * 100;
      const p = pf(xs);
      console.log(`    ${name}  ${String(xs.length).padStart(4)}  ${mean(xs).toFixed(4).padStart(8)}  ${sd(xs).toFixed(4).padStart(7)}  ${wr.toFixed(1).padStart(6)}%   ${p == null ? 'n/a' : p.toFixed(3)}`);
    }
    // ★ The pre-registration's MDE was computed AT THE FLOOR (n=20/cell). This run cleared the floor by a
    // wide margin, so the figure that matters is the ACHIEVED one — quoting the floor's MDE here would
    // understate this run's resolution and make a real null look weaker than it is.
    const seDiff = Math.sqrt((sd(rTrue) ** 2) / rTrue.length + (sd(rFalse) ** 2) / rFalse.length);
    console.log(`\n  ⚠ POWER, ACHIEVED: SE(diff) = ${seDiff.toFixed(4)}R from n=${rTrue.length}/${rFalse.length} and sd ${sd(rTrue).toFixed(3)}/${sd(rFalse).toFixed(3)}`);
    console.log(`    → MDE ≈ ${(1.96 * seDiff).toFixed(4)}R at 5% two-sided. The observed ${Math.abs(diff).toFixed(4)}R is `);
    console.log(`      ${Math.abs(diff) < 1.96 * seDiff ? 'BELOW that, so non-significance here is EXPECTED and the null is weak' : 'ABOVE that, which is a discrepancy worth checking before believing it'}.`);
    console.log(`    (The pre-registration's ≈0.89R was computed AT THE FLOOR n=20/cell; this run did not run at the floor.)`);
    console.log(`    A non-significant result is weak evidence of no effect, NOT proof of one (§3.3).`);
  }

  // ---- 5. SECONDARY: the same difference inside W4, DIAGNOSTIC ONLY ---------------------------------
  const w4 = rows.map((r, i) => ({ ...r, label: primaryLabels[i] })).filter((r) => r.inW4);
  const w4t = w4.filter((r) => r.label).map((r) => r.r);
  const w4f = w4.filter((r) => !r.label).map((r) => r.r);
  console.log(`\n=== 4. SECONDARY — W4 only, DIAGNOSTIC ONLY (§3.3: W4's right edge has been seen) ===`);
  console.log(`  W4 trades ${w4.length}   true ${w4t.length}   false ${w4f.length}   (the per-cell floor applies to the GRID, not to a diagnostic)`);
  console.log(`  diff = ${w4t.length && w4f.length ? (mean(w4t) - mean(w4f)).toFixed(4) : 'n/a'}R  — may not be cited as evidence`);

  if (NO_GRID) { console.log('\n(--no-grid: grid skipped by flag)'); process.exit(0); }

  // ---- 6b. PARAMETER ROUTING PROBE ------------------------------------------------------------------
  // ★ A parameter the ENGINE IGNORES and a parameter that never REACHED the engine produce byte-identical
  // rows in the grid below. They are different claims — "the predicate does not read it" vs "the harness is
  // silently passing `null`" — and this desk has already been burned once by exactly that ambiguity (a gate
  // that read `closePrice` as undefined and reported "zero trades" as a finding). So the probe checks whether
  // each parameter changes ANY structure field, on the bars the pairing actually uses.
  const probeIdx = rows.slice(0, 40).map((r) => r.i);
  const variants = [];
  for (const key of PARAM_KEYS) for (const v of GRID_VALS[key]) variants.push({ lb: `${key}=${v}`, params: { [key]: v } });
  for (const [lo, hi] of GRID_VALS.ote) variants.push({ lb: `ote=${lo}/${hi}`, params: { oteLow: lo, oteHigh: hi } });
  const baseStructs = probeIdx.map((i) => structureAt(i, null));
  const routing = [];
  for (const v of variants) {
    const moved = new Set();
    probeIdx.forEach((i, j) => {
      const s = structureAt(i, v.params);
      const b = baseStructs[j];
      if (!s || !b) return;
      for (const f of ['state', 'direction']) if (s[f] !== b[f]) moved.add(f);
      for (const f of ['bos', 'mss', 'displacement', 'ote', 'sweeps', 'protected', 'position']) {
        if (JSON.stringify(s[f]) !== JSON.stringify(b[f])) moved.add(f);
      }
    });
    routing.push({ lb: v.lb, moved: [...moved] });
  }
  const movesDirection = routing.filter((r) => r.moved.includes('direction')).map((r) => r.lb);
  const movesNothing = routing.filter((r) => !r.moved.length).map((r) => r.lb);
  const withSweeps = baseStructs.filter((s) => s && Array.isArray(s.sweeps) && s.sweeps.length).length;

  console.log(`\n=== 6. PARAMETER ROUTING PROBE — is a cell inert, or is the parameter not applied? ===`);
  console.log(`  probed ${probeIdx.length} pairing bars against ${variants.length} non-primary parameter sets`);
  for (const r of routing) console.log(`    ${r.lb.padEnd(16)} moves: ${r.moved.length ? r.moved.join(',') : 'NOTHING'}`);
  console.log(`  → parameters that move \`direction\` (and so can move predicate (a)): ${movesDirection.join(', ') || 'none'}`);
  if (movesNothing.length) console.log(`  → parameters that move NO field at all: ${movesNothing.join(', ')}`);
  console.log(`  ⚠ `+`${withSweeps}/${probeIdx.length} probed bars carry a sweep, which bounds how meaningful\n     \`no_sweep_against\` can be as a predicate on this symbol/period.`);
  console.log('  ★ Predicate (a) reads ONLY `state` and `direction`. A parameter that moves `displacement` or' );
  console.log('    `ote` but not `direction` is therefore INERT FOR THIS PREDICATE BY CONSTRUCTION — not a');
  console.log('    confirmation of it. The grid below marks strings identical to the primary.');

  // ---- 7. THE GRID — specificity, NOT consistency (§5) ----------------------------------------------
  console.log(`\n=== 5. SENSITIVITY GRID (grid mode: ${GRID}) — a FAILING cell is NEUTRAL; a PASSING one weakens specificity ===`);

  const cells = [];
  const primarySig = `${nTrue}/${nFalse}/${diff.toFixed(6)}`;
  const addCell = (name, labels) => {
    const nt = labels.filter(Boolean).length;
    const nf = labels.length - nt;
    const a = rows.filter((_, i) => labels[i]).map((x) => x.r);
    const b = rows.filter((_, i) => !labels[i]).map((x) => x.r);
    const d = nt && nf ? mean(a) - mean(b) : NaN;
    // ★ IDENTICAL LABELS ARE NOT AN INDEPENDENT CONFIRMATION. A cell whose labels match the primary's exactly
    // is the primary restated under a different parameter name, and presenting it as agreement would inflate
    // the apparent robustness of a finding. It is marked instead.
    const inert = `${nt}/${nf}/${d.toFixed(6)}` === primarySig;
    // §12's own screen logic: a gate that blocks ~2% cannot show an effect, and one that blocks ~96% has
    // thrown the signal away and is testing a different strategy. Either way it is not a filter.
    const binds = nt + nf ? nt / (nt + nf) : 0;
    const extreme = binds > 0.95 || binds < 0.05;
    cells.push({ name, nt, nf, diff: d, belowFloor: nt < FLOOR || nf < FLOOR, inert, extreme, binds });
  };

  for (const [pname, fn] of Object.entries(PREDICATES)) {
    if (pname === 'direction_agrees') continue;
    addCell(`predicate(${pname})`, rows.map((r) => fn(structureAt(r.i, null), r.want)));
  }

  const paramKeys = PARAM_KEYS;
  const gridVals = GRID_VALS;
  for (const key of paramKeys) {
    for (const v of gridVals[key]) {
      if (Number(v) === Number(backtest.DEFAULTS[key] ?? NaN)) continue;   // skip the primary itself
      addCell(`${key}=${v}`, label(PREDICATES.direction_agrees, { [key]: v }));
    }
  }
  for (const [lo, hi] of gridVals.ote) {
    addCell(`ote=${lo}/${hi}`, label(PREDICATES.direction_agrees, { oteLow: lo, oteHigh: hi }));
  }
  if (GRID === 'full') {
    console.log('  (full product requested: this nests every k×d×r×n combination — runtime is the cost)');
    for (const k of gridVals.k) {
      for (const d of gridVals.d) {
        for (const r of gridVals.r) {
          for (const nn of gridVals.n) {
            addCell(`k=${k},d=${d},r=${r},n=${nn}`, label(PREDICATES.direction_agrees, { k, d, r, n: nn }));
          }
        }
      }
    }
  }

  // Random twins matched on binding rate — N >= 200, and the percentile is the 97.5th (§3.3's primary is
  // TWO-SIDED at 0.05; a 95th-percentile cut would be a one-sided criterion the document never agreed to).
  const rand = rng(seedFor(SEED_NUM));
  const twinDiffs = [];
  for (let d = 0; d < TWINS; d++) {
    const picks = new Set();
    while (picks.size < nTrue) picks.add(Math.floor(rand() * rows.length));
    const a = [];
    const b = [];
    rows.forEach((x, i) => (picks.has(i) ? a : b).push(x.r));
    if (a.length && b.length) twinDiffs.push(mean(a) - mean(b));
  }
  const twin975 = pct(twinDiffs, 0.975);

  console.log(`\n  cell                                                   nTrue  nFalse      diff  belowFloor         flag`);
  for (const c of cells) {
    const flags = [c.belowFloor ? 'BELOW FLOOR (not evidence)' : '', c.inert ? '=PRIMARY' : '', c.extreme ? `BINDS ${(c.binds * 100).toFixed(1)}% (not a filter)` : ''].filter(Boolean).join(' · ');
    console.log(`  ${c.name.padEnd(52)} ${String(c.nt).padStart(6)} ${String(c.nf).padStart(7)} ${c.diff.toFixed(4).padStart(9)}  ${(c.belowFloor ? 'YES' : 'no').padEnd(9)} ${flags}`);
  }
  const inertCount = cells.filter((c) => c.inert).length;
  const extremeCount = cells.filter((c) => c.extreme && !c.belowFloor).length;
  if (inertCount) console.log(`  ★ ${inertCount} of ${cells.length} cells reproduce the primary's labels exactly — inert for this predicate, NOT corroboration.`);
  if (extremeCount) console.log(`  ★ ${extremeCount} cell(s) bind ~always or ~never (flagged above) — the §12 screen's own logic says such a predicate is testing a different strategy, not filtering this one.`);

  console.log(`\n=== 6. RANDOM TWINS — a null DISTRIBUTION, not a draw (§5) ===`);
  console.log(`  ${twinDiffs.length} twins at the primary's binding rate (${nTrue}); distribution of the difference:`);
  console.log(`    p50 ${pct(twinDiffs, 0.5).toFixed(4)}   p90 ${pct(twinDiffs, 0.9).toFixed(4)}   p95 ${pct(twinDiffs, 0.95).toFixed(4)}   p97.5 ${twin975.toFixed(4)}`);
  const beatsTwins = floorOk && Number.isFinite(twin975) && diff > twin975;
  console.log(`  primary diff ${isNaN(diff) ? 'n/a' : diff.toFixed(4)}R  vs  p97.5 ${twin975.toFixed(4)}R  →  ${beatsTwins ? 'BEATS the twin distribution' : 'does NOT beat the twin distribution'}`);

  // ---- 7. THE FALSIFIER THAT FIRED (§7 item 5) ------------------------------------------------------
  const passingCells = cells.filter((c) => !c.belowFloor && !c.inert && !c.extreme && Number.isFinite(c.diff) && c.diff > twin975);
  const fired = [];
  const observed = [];
  if (!floorOk) fired.push('2 — either cell fails n >= 20: the unit change alone did not fix the power problem');
  if (floorOk && !sig) fired.push('1 — the difference is not distinguishable from zero once both cells clear the floor (the honest null)');
  if (floorOk && sig && !beatsTwins) fired.push('3 — condition-true outperforms but the random twins do too: the finding belongs to a filter, not to structure');
  if (passingCells.length) fired.push(`5 — grid cells beat the twin distribution too (${passingCells.map((c) => c.name).join(', ')}), so the result is parameter-dependent and suspect`);

  // ★ FALSIFIER 4'S REGISTERED TRIGGER IS "Oil's cells FAIL THE FLOOR for a structural reason". They did not
  // fail it. The binding-rate sub-condition is met, and that is a notable observation — but reporting it as a
  // fired falsifier would be a STRICTER reading than the registration, and quietly tightening a criterion
  // after seeing the data is the thing pre-registration exists to prevent. So it is reported, separately,
  // as an observation.
  const bindRate = rows.length ? nTrue / rows.length : 0;
  if (floorOk && (bindRate > 0.45 || bindRate < 0.02)) {
    observed.push(`falsifier 4's SUB-CONDITION is met — the gate binds ${(bindRate * 100).toFixed(1)}% on Oil `
      + `against ~16% on Gold, so the frozen constants do not mean the same thing here. ⚠ Its REGISTERED `
      + `trigger (cells failing the floor) did NOT obtain, so this is an OBSERVATION, not a firing.`);
  }
  if (!fired.length) fired.push('none of the registered falsifiers fired — read the numbers; this is still not a promotion');

  console.log(`\n=== 8. FALSIFIER FIRED ===`);
  for (const f of fired) console.log(`  ${f}`);
  if (observed.length) {
    console.log(`\n=== 9. OBSERVATIONS (not registered firings) ===`);
    for (const o of observed) console.log(`  ${o}`);
  }
  console.log(`\n★ NOTHING WAS WRITTEN. No release, no candidate row, no verdict. This is a measurement.`);
  console.log(`  'This condition discriminates' is NOT 'this pair is profitable' — a positive result promotes nothing.`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
