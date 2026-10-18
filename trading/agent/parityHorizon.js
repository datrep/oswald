// trading/agent/parityHorizon.js — WHEN does the parity gate actually open, and does it ever?
//
// WHY THIS EXISTS. `parity-preview.js` answers "what is the verdict today" and
// `expectancy.requiredSample` answers "how many trades would it take", but both answer it with
// `looks` HELD FIXED at today's value. That is a snapshot of a moving target, because the harness
// spends alpha on every look and a spent budget needs a BIGGER sample to clear the same edge:
//
//     target(n, L) = the n where   mean - z(L, n) * sd/sqrt(n) > 0
//     z(L, n) = t(n-1) * normInv(1 - alpha/L) / normInv(1 - alpha)
//
// `looks` grows on a clock (one look per ISO week) while `n` grows at whatever rate the desk
// actually closes trades. So the honest question is not "n=52, how long is that" — it is a
// FIXED POINT: does the data arrive faster than the bar rises?
//
// It does, and the reason is worth stating because it is not obvious: the target grows like
// sqrt(ln L) (the repeated-look penalty is logarithmic in the number of looks, because a normal
// tail is exponentially thin) while n grows LINEARLY in time. Linearity beats sqrt-log, so the
// system always converges. But the gap between the snapshot and the fixed point is not small —
// measured on the live desk it is 1.5x for one strategy and >2x for the other — so quoting only
// the snapshot understates the wait, which is the defect this module removes.
//
// WHAT THE SIGN DECIDES, AND WHAT THE SAMPLE DECIDES. With mean and sd held fixed (the only
// assumption this model makes), the interval is mean +/- z*se: as n grows, se -> 0 and the bounds
// collapse onto the mean. So:
//
//   * a POSITIVE observed mean can never reach `retire` — its upper bound is always > 0;
//   * a NEGATIVE observed mean can never reach `accept` — its lower bound is always < 0.
//
// The destination is therefore decided entirely by the SIGN of the mean, and the sample volume
// only decides WHEN (or whether, inside a practical horizon) the desk gets there. That is the
// single most useful thing this module says: for a strategy whose observed edge is a fraction of
// its own dispersion, "wait for more data" is not a plan — the data is not what is missing.
'use strict';

const { expectancyVerdict, requiredSample, num } = require('./expectancy');

// Closes per CALENDAR day, measured over the ledger's own span.
//
// The denominator is stated, not assumed — this desk has three defensible ones (per session, per
// SGT day, per live-window day) and they differ by 2x, so a rate without its denominator is not a
// measurement. Here it is closes per elapsed day between the FIRST and LAST dated close, which is
// the only definition a caller can reproduce from the ledger alone.
//
// Returns perDay: null when a span cannot be formed (fewer than two dated closes). A caller must
// NOT substitute a guess: an unmeasurable rate is not a slow rate.
function ratePerDay(closes, { now = null } = {}) {
  const ts = (closes || [])
    .map((c) => (c instanceof Date ? c.getTime() : Date.parse(c)))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (ts.length < 2) return { perDay: null, spanDays: null, n: ts.length, reason: 'fewer than two dated closes — no span to measure' };
  const end = now != null ? Math.max(ts[ts.length - 1], Number(now)) : ts[ts.length - 1];
  const spanDays = (end - ts[0]) / 86400000;
  if (!(spanDays > 0)) return { perDay: null, spanDays, n: ts.length, reason: 'zero-length span' };
  // (n - 1) intervals over the span; the first close is the origin, not an arrival.
  return { perDay: (ts.length - 1) / spanDays, spanDays, n: ts.length, reason: null };
}

// The fixed point. Steps a week at a time so `looks` and `n` advance together, exactly as they do
// in production (`analytics.parityCheck` is throttled to one look per ISO week).
//
// Every input that could be guessed is required or explicitly reported as missing — in particular
// a null ratePerDay yields no calendar translation at all rather than a default speed.
function horizon({ n, meanR, sdR }, {
  alpha = 0.05,
  looks = 1,
  minTrades = 10,
  ratePerDay: rate = null,
  looksPerWeek = 1,
  maxWeeks = 520,
} = {}) {
  const m = num(meanR);
  const s = num(sdR);
  const notes = [];
  const n0 = Math.max(0, Math.floor(Number(n) || 0));
  const L0 = Math.max(1, Math.floor(Number(looks) || 1));

  // A snapshot with the look budget frozen. This is the number a preview prints, and quoting it
  // alone is the mistake this module exists to correct.
  const snap = requiredSample({ meanR: m, sdR: s }, { alpha, looks: L0, minTrades });
  const naive = {
    acceptAt: snap.acceptAt,
    retireAt: snap.retireAt,
    unreachable: !!snap.unreachable,
    remaining: snap.acceptAt != null ? Math.max(0, snap.acceptAt - n0) : null,
    days: snap.acceptAt != null && rate > 0 ? Math.max(0, snap.acceptAt - n0) / rate : null,
    reason: snap.reason || null,
  };

  if (!Number.isFinite(m)) {
    return { naive, coupled: null, notes: [...notes, 'mean R is not a number — no edge has been measured'] };
  }
  if (!Number.isFinite(s) || !(s > 0)) {
    return { naive, coupled: null, notes: [...notes, `sd R is ${s} — dispersion is undefined or zero, so no interval exists`] };
  }
  if (m < 0) {
    notes.push(`observed mean R is ${m.toFixed(4)} — a negative mean can never clear a positive lower bound, so ACCEPT IS UNREACHABLE at any n and the strategy is approaching retirement instead`);
  }
  if (rate == null || !(rate > 0)) {
    notes.push('arrival rate not measurable — the fixed point cannot be translated into weeks or dates (an unmeasurable rate is not a slow rate)');
    return { naive, coupled: null, notes };
  }

  let nw = n0;
  let L = L0;
  let weeks = 0;
  let accepted = null;
  let retired = null;
  while (weeks < maxWeeks) {
    weeks += 1;
    L += looksPerWeek;
    nw += rate * 7;
    const v = expectancyVerdict({ n: Math.floor(nw), meanR: m, sdR: s }, { alpha, looks: L, minTrades });
    if (v.state === 'accept') {
      accepted = { weeks, n: Math.floor(nw), looks: L };
      break;
    }
    if (v.state === 'retire') {
      retired = { weeks, n: Math.floor(nw), looks: L };
      break;
    }
  }

  const targetAtAccept = accepted
    ? requiredSample({ meanR: m, sdR: s }, { alpha, looks: accepted.looks, minTrades }).acceptAt
    : null;

  const coupled = {
    accepted: !!accepted,
    retired: !!retired,
    weeks: accepted ? accepted.weeks : retired ? retired.weeks : null,
    n: accepted ? accepted.n : retired ? retired.n : null,
    looks: accepted ? accepted.looks : retired ? retired.looks : null,
    targetAtAccept,
    remaining: accepted ? Math.max(0, accepted.n - n0) : null,
    days: accepted ? accepted.weeks * 7 : null,
    // How much bigger the bar is by the time it is cleared. >1 always: this is the correction the
    // snapshot omits.
    inflation: accepted && naive.acceptAt ? targetAtAccept / naive.acceptAt : null,
    beyondHorizon: !accepted && !retired,
  };
  if (coupled.beyondHorizon) notes.push(`no verdict inside ${maxWeeks} weeks at this rate`);
  if (coupled.retired) notes.push(`would reach RETIRE at week ${coupled.weeks} (n=${coupled.n}) before any accept — the sign of the mean, not the volume of data, is the deciding fact`);

  return { naive, coupled, notes };
}

module.exports = { ratePerDay, horizon };
