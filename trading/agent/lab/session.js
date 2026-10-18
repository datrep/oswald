// trading/agent/lab/session.js — TRD-18 session/timing filter (FROZEN).
// Study outcome (2026-09-10, W1 ONLY — 423 pooled batch-1 candidate trades):
// losses DO show mild clustering (17-19 UTC: 67% loss rate, PF excl. +9.6%;
// 06-08 UTC: 69%, +9.3%; 19-21: 73%, +6.4%) but NO 3-hour window met the
// PRE-DECLARED usability criterion (n >= 25, loss rate >= 60%, >= +10%
// relative PF improvement, coverage <= 30%), so the study verdict is
// NOT USABLE and the hard-fallback path applies: Stage B runs WITHOUT the
// timing filter and nothing applies at the lockbox.
// The constant below is the frozen record; `entryAllowed` is the integration
// point — candidates consult it at ENTRY time (re-train semantics, never
// post-hoc trade deletion, §Validation 4). A future study that derives a
// usable filter flips `usable` + `skipHoursUtc` here (or injects
// cfg.sessionFilter in a re-score run).
'use strict';

const SESSION_FILTER = {
  usable: false,
  skipHoursUtc: [],
  derivedAt: '2026-09-10',
  sampleTrades: 423,
  criterion: 'best 3h window: n>=25, lossRate>=0.60, PF improvement>=+10% rel, coverage<=30%',
  bestRejected: [
    { hours: [17, 18, 19], n: 43, lossRate: 0.67, pfImprovementPct: 9.6 },
    { hours: [6, 7, 8], n: 54, lossRate: 0.69, pfImprovementPct: 9.3 },
    { hours: [19, 20, 21], n: 33, lossRate: 0.73, pfImprovementPct: 6.4 },
  ],
  verdict: 'NOT USABLE — hard fallback: no timing filter in Stage B or lockbox',
  note: 'pooled W1 PF 0.9124 — the clustering is real but too weak to clear the pre-declared bar; documenting beats fitting.',
};

// Entry gate. Returns TRUE when the entry is allowed.
// filter = SESSION_FILTER by default; candidates may pass cfg.sessionFilter
// (re-score/experiment override) — a filter is only enforced when usable.
function entryAllowed(timeMs, filter = SESSION_FILTER) {
  const f = filter || SESSION_FILTER;
  if (!f.usable || !Array.isArray(f.skipHoursUtc) || !f.skipHoursUtc.length) return true;
  const t = Number(timeMs);
  if (!Number.isFinite(t) || t <= 0) return true;
  const hour = new Date(t).getUTCHours();
  return !f.skipHoursUtc.includes(hour);
}

module.exports = { SESSION_FILTER, entryAllowed };
