// trading/agent/lab/scoreboard.js — candidate scoreboard orchestrator (TRD-14).
// Enforces §Validation 1-20 of the Strategy Lab plan:
//   - registration: k counter (352 prior configs + every registered pair);
//   - scoring: rolling walk-forward (A/B/lockbox) per pair, CFD-cost-adjusted,
//     BCa p-values, advisory stage screens;
//   - release: ONE shot — every registered pair is lockbox-scored regardless
//     of A/B, then ONE Benjamini-Hochberg pass (q = 0.10) over the full frozen
//     family (INSUFFICIENT-DATA pairs have no p and do not enter BH), the PRDS
//     cross-correlation check, and three-state verdicts;
//   - retest: the fresh-data gate on an archived candidate with a fresh
//     family counter k' (one BH pass per re-score event).
// The promotion pipeline (eligibility -> paper-forward -> owner approval) is
// TRD-21's concern — this module produces verdicts and eligibility inputs.
'use strict';

const store = require('../../store');
const backtest = require('../backtest');
const strategies = require('../strategies');
const stats = require('./statistics');
const wf = require('./walkforward');

const K_BASE = 352; // prior configs: 28-cell audit + 324-config hunt (pair-level)
const Q = 0.10;
const SEED_BASE = 0xABCD;

function seedFor(registrationNo) {
  return SEED_BASE + Number(registrationNo);
}

// Load the yahoo 1h series for a pair (the Lab's shared deep dataset).
async function loadLabSeries(userId, cand) {
  const loaded = await backtest.loadSeries(userId, { symbol: cand.symbol, venue: cand.venue || 'yahoo', timeframe: '1h', range: '1y', refreshData: false });
  return loaded;
}

// Run the ADVISORY stages (A/B) for one candidate and persist its score.
// The lockbox is deliberately NOT touched here — it releases once, at the
// single release event (§Validation 13); "every registered pair scored
// together" then. Zero-edge discipline: W4 is spent exactly once.
async function scoreCandidate(userId, cand, { save = true } = {}) {
  const loaded = await loadLabSeries(userId, cand);
  if (loaded.error) return { error: loaded.error };
  const strat = strategies.get(cand.strategy);
  if (!strat || !strat.backtest) return { error: `strategy ${cand.strategy} has no backtest` };
  const cfg = { ...backtest.DEFAULTS, ...backtest.costCfgFor(cand.symbol), ...(cand.params || {}) };
  const stages = wf.runWalkForward({
    series: loaded.series,
    strat,
    cfg,
    seed: seedFor(cand.registrationNo),
    stageList: ['A', 'B'],
  });
  const score = {
    scoredAt: new Date().toISOString(),
    venue: cand.venue || 'yahoo',
    bars: loaded.series.length,
    spanDays: loaded.spanDays || null,
    lockboxSpent: false,
    stages,
  };
  if (save) await store.updateLabCandidate(userId, cand.id, { score });
  return { ok: true, score };
}

// RELEASE: freeze every registered pair, lockbox-score the FULL set, run BH
// once, PRDS check, verdicts. One release, one shot. Resumable: pairs already
// frozen (e.g. a crashed first attempt) are picked up as long as they carry no
// releaseId — the freeze step is idempotent and lockbox scoring is seeded, so
// re-running cannot change a number.
async function releaseAll(userId) {
  const all = await store.listLabCandidates(userId, { statuses: ['registered', 'frozen'] });
  const candidates = all.filter((c) => !c.releaseId);
  if (!candidates.length) return { error: 'no registered candidates to release' };
  const now = new Date().toISOString();

  // Freeze first (the family is frozen at release).
  for (const c of candidates) await store.updateLabCandidate(userId, c.id, { status: 'frozen', frozenAt: now });

  // Lockbox-score EVERY frozen pair at the release (A/B outcomes do not
  // excuse a pair). Pairs already A/B-scored merge the lockbox in; the rest
  // run the full walk-forward now.
  const results = [];
  for (const c of candidates) {
    const loaded = await loadLabSeries(userId, c);
    if (loaded.error) { results.push({ cand: c, ok: false, error: loaded.error, lockbox: null, w4Split: null }); continue; }
    const strat = strategies.get(c.strategy);
    if (!strat || !strat.backtest) { results.push({ cand: c, ok: false, error: `strategy ${c.strategy} has no backtest`, lockbox: null, w4Split: null }); continue; }
    const cfg = { ...backtest.DEFAULTS, ...backtest.costCfgFor(c.symbol), ...(c.params || {}) };
    const prev = c.score ? JSON.parse(c.score) : null;
    const haveAB = !!(prev && prev.stages && prev.stages.A && prev.stages.B);
    let stages;
    if (haveAB) {
      const lockbox = wf.runStage({ series: loaded.series, strat, cfg, stage: 'LOCKBOX', seed: seedFor(c.registrationNo), w4Split: true });
      const screen = (r) => (r.n < 20 ? 'INSUFFICIENT-DATA' : r.pf != null && r.pf > 1 && r.p != null && r.p < 0.05 ? 'PASS' : 'FAIL');
      lockbox.verdict = screen(lockbox);
      stages = { ...prev.stages, LOCKBOX: lockbox };
    } else {
      stages = wf.runWalkForward({ series: loaded.series, strat, cfg, seed: seedFor(c.registrationNo) });
    }
    const score = { ...(prev || {}), scoredAt: new Date().toISOString(), venue: c.venue || 'yahoo', bars: loaded.series.length, spanDays: loaded.spanDays || null, lockboxSpent: true, stages };
    await store.updateLabCandidate(userId, c.id, { score });
    results.push({ cand: c, ok: true, error: null, lockbox: stages.LOCKBOX, w4Split: stages.LOCKBOX.w4Split });
  }

  // BH family: pairs WITH a lockbox p-value (INSUFFICIENT-DATA pairs have no p).
  const withP = results.filter((r) => r.ok && r.lockbox && r.lockbox.p != null);
  const m = withP.length;
  const mFrozen = results.length;
  const pValues = withP.map((r) => r.lockbox.p);
  const bhResult = m ? stats.bh(pValues, Q) : { m: 0, q: Q, significant: [], ranks: [], note: 'no pairs with a lockbox p-value' };

  // PRDS check from the W4 halves of pairs that traded.
  const prds = stats.prdsCheck(results.filter((r) => r.ok && r.w4Split).map((r) => r.w4Split));

  // Post-mortem rule (review round 6, 2026-09-10): when PRDS is rejected, NO
  // pair is declared significant regardless of BH rank — the release returns
  // to owner review. When the BH family is tiny (m < 5), the FDR claim is not
  // available and is recorded as such (BH over survivors is not the intended
  // multiple-testing defense).
  const fdrAvailable = !prds.flagged && m >= 5;
  if (prds.flagged) bhResult.significant = [];
  bhResult.fdrAvailable = fdrAvailable;
  bhResult.note = prds.flagged
    ? 'PRDS rejected — no significance declared; release returns to owner review'
    : m < 5
      ? 'BH family below 5 pairs — the FDR claim is NOT available for this release'
      : 'FDR claim available';

  // Verdicts (three states). Lockbox pass = BH significance + PF > 1 + n >= 20.
  const sigSet = new Set(bhResult.significant.map((i) => withP[i].cand.id));
  const summary = [];
  for (const r of results) {
    let verdict = 'FAIL';
    if (!r.ok) verdict = 'FAIL';
    else if (r.lockbox.n < 20) verdict = 'INSUFFICIENT-DATA';
    else if (r.lockbox.pf != null && r.lockbox.pf > 1 && r.lockbox.n >= 20 && sigSet.has(r.cand.id)) verdict = 'PASS';
    summary.push({
      id: r.cand.id, strategy: r.cand.strategy, symbol: r.cand.symbol,
      registrationNo: r.cand.registrationNo, verdict,
      lockbox: r.lockbox ? { n: r.lockbox.n, pf: r.lockbox.pf, p: r.lockbox.p, smallSample: r.lockbox.pSmallSample, ciLower: r.lockbox.ciLower } : null,
      error: r.error,
    });
    await store.updateLabCandidate(userId, r.cand.id, { verdict });
  }

  const kCounter = K_BASE + (await store.countLabCandidates(userId));
  const release = await store.createLabRelease(userId, {
    familyType: 'batch', m, mFrozen, kCounter, q: Q,
    bhResult, prdsCheck: prds, summary,
  });
  for (const s of summary) await store.updateLabCandidate(userId, s.id, { releaseId: release.id });
  return { ok: true, release: { id: release.id, m, mFrozen, kCounter, q: Q, bhResult, prdsCheck: prds, summary } };
}

// Fresh-data gate retest: same walk-forward on a fresh series (different
// venue or later-pulled period), SAME registration seed, fresh family k'.
// seriesDays (optional): size the evaluated series explicitly — plan §14 says
// "which series applies is stated at gate invocation". The gate needs W4
// (last 10%) both fully post-development and n>=20; the shortest series whose
// W4 clears the n floor starts W4 exactly at the development end date.
async function retestCandidate(userId, candId, { venue = null, seriesDays = null } = {}) {
  const cand = await store.getLabCandidate(userId, candId);
  if (!cand) return { error: 'candidate not found' };
  const venueUsed = venue || cand.venue || 'yahoo';
  const days = Number(seriesDays) > 0 ? Math.round(Number(seriesDays)) : null;
  const loaded = await backtest.loadSeries(userId, { symbol: cand.symbol, venue: venueUsed, timeframe: '1h', range: days ? null : '1y', refreshData: true });
  if (loaded.error) return { error: loaded.error };
  let series = loaded.series;
  if (days) {
    const cutoff = Date.now() - days * 86400000;
    series = series.filter((b) => new Date(b.time).getTime() >= cutoff);
    if (series.length < 25) return { error: `insufficient bars after seriesDays=${days} filter (${series.length})` };
  }
  const strat = strategies.get(cand.strategy);
  if (!strat || !strat.backtest) return { error: `strategy ${cand.strategy} has no backtest` };
  const cfg = { ...backtest.DEFAULTS, ...backtest.costCfgFor(cand.symbol), ...(cand.params || {}) };
  const stages = wf.runWalkForward({ series, strat, cfg, seed: seedFor(cand.registrationNo) });
  const lockbox = stages.LOCKBOX;
  const kp = (await store.countLabReleases(userId, { familyType: 'fresh' })) + 1;
  const pValues = lockbox.p != null ? [lockbox.p] : [];
  const bhResult = stats.bh(pValues, Q);
  const verdict = lockbox.p != null && lockbox.n >= 20 && lockbox.pf != null && lockbox.pf > 1 && bhResult.significant.includes(0) ? 'PASS' : lockbox.n < 20 ? 'INSUFFICIENT-DATA' : 'FAIL';
  const summary = [{ id: cand.id, strategy: cand.strategy, symbol: cand.symbol, registrationNo: cand.registrationNo, verdict, seriesDays: days, lockbox: { n: lockbox.n, pf: lockbox.pf, p: lockbox.p, smallSample: lockbox.pSmallSample, ciLower: lockbox.ciLower } }];
  const release = await store.createLabRelease(userId, {
    familyType: 'fresh', m: pValues.length, mFrozen: 1, kCounter: K_BASE + (await store.countLabCandidates(userId)), q: Q,
    bhResult, prdsCheck: { r: null, n: 0, flagged: false, note: 'single-pair fresh-data family — PRDS check not applicable' }, summary,
  });
  // TRD-74: the computed verdict must land on the CANDIDATE, not only inside the release summary.
  // releaseAll() has always persisted it; this path did not, so a retested candidate kept
  // verdict = NULL and anything reading that column - the live-eligibility gate in particular
  // (agent/lab/eligibility.js) - would see no verdict at all, forever.
  await store.updateLabCandidate(userId, cand.id, {
    score: { scoredAt: new Date().toISOString(), venue: venueUsed, bars: series.length, seriesDays: days, spanDays: loaded.spanDays || null, stages, retest: true },
    releaseId: release.id,
    verdict,
  });
  return { ok: true, release: { id: release.id, familyType: 'fresh', kp, q: Q, bhResult, summary } };
}

// ARCHIVE a candidate: withdraw it from the frozen family. TRD-74 - this is the missing WRITER for
// status='archived'. Before it, no code in trading/ set that status (the three turtle rows were
// archived out of band) and archivedAt was never populated, so an archived candidate had no verdict
// AND no record of when it left the family. Archiving scores nothing and changes no verdict: it
// removes the candidate from the release family, because releaseAll() loads only frozen/registered.
// What archiving MEANS for live scope is agent/lab/eligibility.js, not this function.
async function archiveCandidate(userId, candId, { reason = '', now = new Date().toISOString() } = {}) {
  const cand = await store.getLabCandidate(userId, candId);
  if (!cand) return { error: 'candidate not found' };
  if (String(cand.status || '').toLowerCase() === 'archived') {
    return { ok: true, already: true, id: cand.id, archivedAt: cand.archivedAt || null };
  }
  await store.updateLabCandidate(userId, candId, { status: 'archived', archivedAt: now });
  return { ok: true, already: false, id: cand.id, archivedAt: now, reason: String(reason || '') };
}

// Scoreboard view: k counter, candidates (with scores + verdicts), releases.
async function scoreboard(userId) {
  const [candidates, releases] = await Promise.all([
    store.listLabCandidates(userId),
    store.listLabReleases(userId, { limit: 20 }),
  ]);
  return {
    kBase: K_BASE,
    k: K_BASE + candidates.length,
    q: Q,
    seedBase: SEED_BASE,
    candidates: candidates.map((c) => ({ ...c, score: c.score ? JSON.parse(c.score) : null })),
    releases,
  };
}

module.exports = { K_BASE, Q, SEED_BASE, seedFor, scoreCandidate, releaseAll, retestCandidate, archiveCandidate, scoreboard };
