// trading/agent/trd26.js — TRD-26 fresh-data gate: automation + findings report.
//
// The gate re-scores the three frozen turtle survivors once a fresh
// (post-development) section of the 729d yahoo 1h series is deep enough.
// Both conditions must hold at invocation (verified from live bar data):
//   (a) W4 (last 10% of the evaluated series) is fully post-development
//       → seriesDays <= 10 * (post-dev elapsed days - SAFETY_DAYS);
//   (b) W4 carries n >= 20 trades at the variant's rate
//       → seriesDays >= 200 / rate   (rate = conservative MIN of the live
//         W4 and W25 windows — smaller rate = longer wait).
//
// Auto-fire: ONE retest per candidate; a re-fire is allowed only after an
// INSUFFICIENT-DATA verdict (that is not a real verdict). Never fires before
// the conditions hold — each call books a fresh release row.
//
// Reports: TradingEvents (trd26_check / trd26_gate / trd26_report) + Telegram
// + a markdown artifact in trading/reports/. A FINAL report is written once
// all three candidates hold terminal verdicts (PASS/FAIL). The gate is
// EVALUATE-ON-RUN, not schedule-at-date: every check recomputes readiness
// from live data, so an intermittent/offline machine cannot miss it — it
// fires on the first check after the conditions hold (report writes are
// idempotent and recover verdicts even if a fire was interrupted).
//
// Manual path: trading/scripts/trd26-gate.js (CHECK / --run).
// Contract: acceptance = rule L ONLY; if m<5 pairs reach n>=20 →
// fdrAvailable:false (descriptive p + owner review, no FDR claim); no
// promotion without paper-forward (n>=50) + owner approval.
'use strict';
const path = require('path');
const fs = require('fs');
const store = require('../store');
const backtest = require('./backtest');
const strategies = require('./strategies');
const lab = require('./lab');
const scoreboard = require('./lab/scoreboard');
const log = require('./log');

const CAND_IDS = [20, 21, 22];
const DEV_END = Date.parse('2026-09-11T00:00:00Z'); // "post-2026-09-10" development end
const SAFETY_DAYS = 1;
const CHECK_THROTTLE_H = 6;
const TERMINAL = ['PASS', 'FAIL'];
// Concurrency guard: the wake step, the service tick and the boot catch-up all
// converge on checkAndFire — overlapping runs must never double-fire a retest.
// Stored as an ISO timestamp; a stale lock (crashed run) expires after 10 min.
let inFlight = null;

const seriesDaysNeeded = (rate) => (rate > 0 ? Math.ceil(200 / rate) : Infinity);
const freshnessCapDays = (elapsedDays, safetyDays = SAFETY_DAYS) => Math.floor((elapsedDays - safetyDays) * 10);

// Fire decision: ready + not yet gated (or only INSUFFICIENT so far) → fire.
function decide({ ready, priorVerdict }) {
  if (!ready) return 'skip_not_ready';
  if (!priorVerdict || priorVerdict === 'INSUFFICIENT-DATA') return 'fire';
  return 'skip_gated';
}

// Idempotent report plan (pinned): write when the terminal-verdict set differs
// from the last report; escalate to FINAL once all candidates are terminal;
// never write again after a final. Recovered verdicts (a fire interrupted
// before reporting, or the manual script fired) are reported too — nothing is
// silently unreported, nothing is double-reported.
function reportPlan({ verdicts, last, total }) {
  if (last && last.final) return { write: false, final: false };
  if (verdicts.length >= total) return { write: true, final: true };
  const lastVerdicts = last && Array.isArray(last.verdicts) ? last.verdicts : [];
  const lastMap = Object.fromEntries(lastVerdicts.map((v) => [v.id, v.verdict]));
  const changed = verdicts.length !== lastVerdicts.length || verdicts.some((v) => lastMap[v.id] !== v.verdict);
  return { write: changed, final: false };
}

// Live density measurement on the full stored series (same data source the
// retest will pull): full backtest → trade counts inside the last 10%/25% of
// BARS by entry time.
async function measure(cand) {
  const loaded = await backtest.loadSeries(1, { symbol: cand.symbol, venue: cand.venue || 'yahoo', timeframe: '1h', range: null, refreshData: true });
  if (loaded.error) return { error: loaded.error };
  const series = loaded.series;
  const strat = strategies.get(cand.strategy);
  if (!strat || !strat.backtest) return { error: `strategy ${cand.strategy} has no backtest` };
  const cfg = { ...backtest.DEFAULTS, ...backtest.costCfgFor(cand.symbol), ...(cand.params || {}) };
  const raw = strat.backtest(series, cfg, lab.labContext(series));
  const n = series.length;
  const windowStats = (frac) => {
    const start = series[Math.floor(n * (1 - frac))].time;
    const end = series[n - 1].time;
    const count = (raw.trades || []).filter((t) => t.entryTime >= start && t.entryTime <= end).length;
    const days = (new Date(end) - new Date(start)) / 86400000;
    return { n: count, rate: days > 0 ? count / days : 0 };
  };
  const w4 = windowStats(0.1);
  const w25 = windowStats(0.25);
  return { bars: n, spanDays: loaded.spanDays, w4, w25 };
}

// Latest fresh-family release verdict for one candidate (null = never gated).
async function priorRelease(userId, candId) {
  const releases = await store.listLabReleases(userId, { familyType: 'fresh', limit: 100 }).catch(() => []);
  let last = null;
  for (const r of releases) {
    const s = Array.isArray(r.summary) ? r.summary.find((x) => x && x.id === candId) : null;
    if (s) last = { at: r.createdAt, verdict: s.verdict, lockbox: s.lockbox, releaseId: r.id };
  }
  return last;
}

// Markdown findings report (pure — pinned by test/trd26-gate.test.js).
function renderReport({ at, final, rows }) {
  const lines = [];
  lines.push(`# TRD-26 fresh-data gate — findings${final ? ' (FINAL)' : ''}`);
  lines.push('');
  lines.push(`_generated ${at} · rule-L acceptance only · if fewer than 5 pairs reach n≥20 → fdrAvailable:false (descriptive p + owner review, no FDR claim) · no promotion without paper-forward (n≥50) + owner approval._`);
  lines.push('');
  lines.push('| # | variant | verdict | n | PF | p (one-sided BCa) | seriesDays | earliest | fired |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const f = (x) => (x == null ? '—' : x);
    lines.push(`| ${r.id} | ${r.label} | ${f(r.verdict || (r.error ? 'ERROR' : 'NOT YET'))} | ${f(r.n)} | ${f(r.pf)} | ${f(r.p)} | ${f(r.seriesDays)} | ${f(r.earliest)} | ${f(r.firedAt ? String(r.firedAt).slice(0, 10) : null)} |`);
  }
  lines.push('');
  lines.push('## Candidate notes');
  for (const r of rows) {
    if (r.error) { lines.push(`- **#${r.id}** ${r.label}: ERROR — ${r.error}`); continue; }
    if (r.verdict === 'PASS') lines.push(`- **#${r.id}** ${r.label}: **PASS** (n=${r.n}, PF=${r.pf}, p=${r.p}) — owner review next; on approval the paper-forward track targets n≥50.`);
    else if (r.verdict === 'FAIL') lines.push(`- **#${r.id}** ${r.label}: **FAIL** (n=${r.n}, PF=${r.pf}, p=${r.p}) — candidate closed per the rule-L contract (re-tuning voids it).`);
    else if (r.verdict === 'INSUFFICIENT-DATA') lines.push(`- **#${r.id}** ${r.label}: INSUFFICIENT-DATA — not a verdict; re-fires automatically once READY (rate ${r.rate == null ? '—' : Number(r.rate).toFixed(3)}/d, seriesDays ${r.seriesDays}).`);
    else lines.push(`- **#${r.id}** ${r.label}: not yet gated — ready=${r.ready ? 'YES' : 'no'}, earliest ≈ ${r.earliest || '—'} (seriesDays ${r.seriesDays || '—'}).`);
  }
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(rows, null, 1));
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

async function writeReportFile(md) {
  const dir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `trd26-gate-${stamp}${md.includes('(FINAL)') ? '-final' : ''}.md`);
  fs.writeFileSync(file, md);
  return file;
}

// One automation pass. `fire: false` = inspect only (the manual CHECK mode).
// Self-throttled by the trd26_check event unless `force`.
async function checkAndFire(userId, settings, { force = false, fire = true } = {}) {
  // Claim the slot SYNCHRONOUSLY (before any await) so two triggers landing in
  // the same tick can never both run; stale locks expire after 10 minutes.
  if (inFlight && Date.now() - new Date(inFlight).getTime() < 10 * 60000) return { skipped: 'inflight', since: inFlight };
  inFlight = new Date().toISOString();
  if (!force) {
    const last = await store.latestEvent(userId, 'trd26_check');
    if (last && Date.now() - new Date(last.createdAt).getTime() < CHECK_THROTTLE_H * 3600000) {
      inFlight = null;
      return { skipped: 'throttled', lastAt: last.createdAt };
    }
  }
  const now = Date.now();
  const elapsedDays = (now - DEV_END) / 86400000;
  const maxSeriesDays = freshnessCapDays(elapsedDays);
  const rows = [];
  const fired = [];
  try {
    for (const id of CAND_IDS) {
      const row = { id, label: `#${id}` };
      try {
        const cand = await store.getLabCandidate(userId, id);
        if (!cand) { row.error = 'candidate missing'; rows.push(row); continue; }
        row.label = `${cand.symbol} ${cand.strategy} ${JSON.stringify(cand.params || {})}`;
        // The subject's own lifecycle status travels with every row. Cands 20/21/22
        // are `archived` BY DESIGN: scoreboard.js's header describes this path as
        // "the fresh-data gate on an ARCHIVED candidate", and archiving only removes a
        // pair from the family RELEASE (releaseAll loads frozen/registered). Without
        // this field a reader cannot tell a deliberate quarantine - which is what the
        // 2026-09-10 archive was - from an abandoned subject, and that misreading is
        // what produced "the subjects were withdrawn, so it cannot resolve".
        row.subjectStatus = cand.status || null;
        const m = await measure(cand);
        if (m.error) { row.error = m.error; rows.push(row); continue; }
        const rate = Math.min(m.w4.rate, m.w25.rate);
        const needed = seriesDaysNeeded(rate);
        row.rate = rate;
        row.seriesDays = Number.isFinite(needed) ? needed : null;
        // W4/W25 DENSITY of the series as it stands TODAY. These SIZE THE WAIT; they are
        // NOT the gate's sample. `w4n` keeps its published name (existing trd26_check
        // events and the 2026-09-23 stage audit cite it) - and that name is exactly how
        // it came to be read as "the row already clears the n>=20 floor" when the row
        // carried w4n=33/61/51. The gate's own n is `n`/`gateN`, and it exists ONLY
        // after a fire, copied from the lockbox. The series* aliases below are the
        // unambiguous names; new consumers should use those.
        row.seriesW4n = m.w4.n;
        row.seriesW4rate = +m.w4.rate.toFixed(3);
        row.seriesW25n = m.w25.n;
        row.seriesW25rate = +m.w25.rate.toFixed(3);
        row.w4n = row.seriesW4n;
        row.w4rate = row.seriesW4rate;
        row.w25n = row.seriesW25n;
        row.w25rate = row.seriesW25rate;
        row.gateN = null; // the gate's sample size; set from the lockbox only on fire
        row.ready = Number.isFinite(needed) && needed <= maxSeriesDays;
        row.earliest = Number.isFinite(needed) ? new Date(DEV_END + (needed / 10 + SAFETY_DAYS) * 86400000).toISOString().slice(0, 10) : null;
        const prior = await priorRelease(userId, id);
        row.priorVerdict = prior ? prior.verdict : null;
        if (prior) {
          row.verdict = prior.verdict;
          if (prior.lockbox) { row.n = prior.lockbox.n; row.gateN = row.n; row.pf = prior.lockbox.pf; row.p = prior.lockbox.p; }
        }
        const action = decide({ ready: row.ready, priorVerdict: row.priorVerdict });
        if (action === 'fire' && fire) {
          const res = await scoreboard.retestCandidate(userId, id, { seriesDays: needed });
          const s = res && res.release && res.release.summary && res.release.summary[0];
          if (!s) { row.error = (res && res.error) || 'retest returned no summary'; rows.push(row); continue; }
          row.verdict = s.verdict;
          row.n = s.lockbox && s.lockbox.n;
          row.gateN = row.n;
          row.pf = s.lockbox && s.lockbox.pf;
          row.p = s.lockbox && s.lockbox.p;
          row.firedAt = new Date().toISOString();
          fired.push({ id, symbol: cand.symbol, verdict: s.verdict, n: row.n, pf: row.pf, p: row.p });
          await log.write(userId, 'trd26_gate', {
            id, symbol: cand.symbol, verdict: s.verdict, lockbox: s.lockbox, seriesDays: needed, releaseId: res.release.id,
          }, { actor: 'system:trd26' }).catch(() => {});
        } else {
          row.action = action;
        }
      } catch (e) {
        row.error = String(e.message || e).slice(0, 160);
      }
      rows.push(row);
    }
  } catch (e) {
    const summary = { at: new Date().toISOString(), elapsedDays: +elapsedDays.toFixed(2), maxSeriesDays, error: String(e.message || e).slice(0, 200), rows, fired };
    await store.logEvent(userId, 'trd26_check', summary).catch(() => {});
    inFlight = null;
    return summary;
  }

  const summary = {
    at: new Date().toISOString(),
    elapsedDays: +elapsedDays.toFixed(2),
    maxSeriesDays,
    maxSeriesDaysNote: maxSeriesDays < 0 ? 'gate not open yet' : null,
    rows,
    fired,
  };
  await store.logEvent(userId, 'trd26_check', summary).catch(() => {});

  // Reports (idempotent, crash-recovery aware): terminal verdicts are
  // recovered from prior releases too — a verdict is reported even if the
  // fire that produced it was interrupted before reporting, or arrived via
  // the manual script. Nothing unreported; nothing double-reported.
  const terminals = rows.filter((r) => TERMINAL.includes(r.verdict))
    .map((r) => ({ id: r.id, verdict: r.verdict, n: r.n, pf: r.pf, p: r.p }));
  const lastReport = await store.latestEvent(userId, 'trd26_report');
  const plan = reportPlan({ verdicts: terminals, last: lastReport ? lastReport.payload : null, total: CAND_IDS.length });
  if (plan.write) {
    const md = renderReport({ at: summary.at, final: plan.final, rows });
    let file = null;
    try { file = await writeReportFile(md); } catch { /* file is best-effort */ }
    await store.logEvent(userId, 'trd26_report', { final: plan.final, file, verdicts: terminals }).catch(() => {});
    const text = plan.final
      ? `OSWALD TRD-26 gate CONCLUDED — ${rows.map((r) => `#${r.id} ${r.verdict}`).join('; ')}. Owner review + paper-forward (n>=50) next. Report: ${file || 'trading/reports'}`
      : `OSWALD TRD-26 gate: ${terminals.map((v) => `#${v.id} ${v.verdict} (n=${v.n}, PF ${v.pf}, p ${v.p})`).join(' | ')}. Report: ${file || 'trading/reports'}`;
    await require('../lib/http').telegramAlert(text).catch(() => {});
    summary.report = { file, final: plan.final };
  }  inFlight = null;  return summary;
}

module.exports = {
  CAND_IDS, DEV_END, SAFETY_DAYS, CHECK_THROTTLE_H,
  seriesDaysNeeded, freshnessCapDays, decide, reportPlan, measure, priorRelease, renderReport, checkAndFire,
};
