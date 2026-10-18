// trading/agent/structure.js — market-structure detection (design doc §3; S1a).
//
// PURE. No DB, no network, no clock, no randomness. Same shape as indicators.js: input series are
// oldest -> newest, arrays of numbers, and the only state is what you pass in.
//
// WHAT THIS FILE IS FOR, AND WHAT IT IS NOT
// It turns the ICT/SMC vocabulary in docs/structure-engine-design-2026-09-22.md §3 into quantities a
// backtest can be run against. It does NOT decide anything, gate anything, or read volume. In S1 it has
// NO CONSUMER: nothing imports it yet. That is deliberate — the whole point of computing first and
// publishing later is that the first version cannot change a decision.
//
// ★ THE TWO INVARIANTS EVERY LINE HERE SERVES. Break either and a backtest will be silently better than
// the desk.
//
//   1. NO LOOKAHEAD. Every fact carries the bar at which it BECAME TRUE (`confirmedAtIndex`), and the
//      function is only allowed to read bars[0..asOf]. Because of that, a swing that is confirmed at
//      `i + k <= asOf` has its ENTIRE defining window inside the view, so its confirmed status is
//      identical no matter how much more data exists. That is what makes the prefix property hold, and
//      the prefix property is what `test/structure.test.js` pins.
//
//   2. NO IMPLICIT WINDOW. `asOf` is REQUIRED and has no default. This is the house rule from TRD-92
//      (`deleteOldTicks`: "the caller resolves the window; this function does not guess one"). A default
//      of "the last bar" would be the lookahead path wearing a convenience's clothes — in S1 it would be
//      harmless and in a backtest it would be the bug.
//
// ★ TWO TERMS IN §3 ARE UNDERSPECIFIED, and this file RESOLVES them rather than guessing silently. Both
// resolutions are flagged for the design doc, because a reviewer should see the choice, not the outcome:
//
//   (a) BOS vs THE PROTECTED SWING. §3 says BOS is "a close beyond the protected swing in the trend
//       direction", and separately defines the protected swing as the one AGAINST the trend (bull: the
//       last swing low). Read literally that is unreachable — in a bull trend almost every close is above
//       the last swing low, so BOS would fire constantly and mean nothing. This file takes the standard
//       reading instead:
//         * protected = the level that HOLDS the structure (bull: last confirmed swing low)
//         * BOS       = a close beyond the last confirmed swing IN the trend direction (bull: above the
//                       last confirmed swing high) — continuation
//         * MSS/CHoCH = a close beyond the PROTECTED level, against the trend — the reversal
//       So BOS and MSS are NOT "the same event classified by side" (contradicting §3's MSS row); they are
//       two different levels. **§3 needs correcting to match this file, not the reverse.**
//
//   (b) THE EQUAL-HIGH TIE-BREAK ORDERING. §3 says "the later bar wins, with the higher close as the
//       second tie-break, then the later index again" — but if `later` is primary then the close can never
//       break a tie, so the sentence cannot mean what it says. This file orders it (close, then later
//       index), which is the only reading under which the second tie-break does any work.
//
// ★ ALSO UNDERSPECIFIED AND THEREFORE PARAMETERS HERE: §3's displacement rule uses `r` (a multiple of the
// mean body over the last `n` bars) and its OTE band uses 0.62/0.79, but §10 Q4's pre-registration list
// names only `k`, `d` and `m`. `r` and `n` are therefore parameters with defaults like the rest, and they
// need adding to the pre-registration before any promotion run.
'use strict';

const { atr } = require('./indicators');

// Pre-registered STARTING POINTS, not fitted values (§7 rule 5, §10 Q4). Every run echoes back the
// params it actually used, so a later reader can never wonder which set produced a number.
const DEFAULTS = Object.freeze({
  // ★ k IS NOT 2 ANY MORE, AND IT WAS CHOSEN FROM MEASUREMENT RATHER THAN PROPOSED (2026-09-22).
  // `trading/scripts/repro/structure-k-sweep.js` measured three structural properties across k=2..10 on
  // the desk's own series, on both candidate venues, for four symbols. `k=2` was the WORST value on all
  // three, on both venues: 15% of its swing levels sat inside 0.5 ATR of the market — inside the noise,
  // where a stop placed behind the level is a stop placed in the spread.
  //
  //   k   swings  bars/swing  median dist(ATR)  %<0.5ATR  same-kind
  //   2     42       3.8           1.29            15%        17%
  //   4    23.5      7.0           2.03            11%        13%   <- the knee
  //  10      9      17.3           3.07             5%        15%
  //
  // k=4 is the first value with meaningful separation AND the lowest same-kind adjacency (a clean
  // structural sequence alternates high/low; beyond k=4 that share RISES while swings fall away).
  //
  // ★ THIS IS A DEFINITIONAL CHOICE, NOT A FITTED ONE. The metrics are structural — how far a level sits
  // in volatility units, and whether the sequence alternates — not how much money anything made. Choosing
  // k to make "a swing" mean something is not the §7 rule 5 failure (tuning a parameter on the data that
  // judges it); choosing the window that maximised a backtest would be.
  //
  // ⚠ AND ONE MEASUREMENT LIMITATION, stated because it affects k's re-check rather than the choice:
  // `dist/ATR` is VENUE-RELATIVE, and the venue with the understated ATR scores better on it. plus500's
  // mean bar range is 2.4x smaller than plus500_chart's (§4.1), which inflates its ATR ratio. The
  // RANKING of k is the same on both venues (4 beats 2, 3, 5, 6, 8, 10 on each), so the choice is robust —
  // but the absolute number will move once the venue of record is settled, and should be re-read then.
  k: 4,          // swing window half-width: bar i is a candidate if it is the extreme over [i-k, i+k]
  d: 1.5,        // displacement: body >= d * ATR14
  r: 1.5,        // displacement: body >= r * mean body of the last n bars  ← NOT in §10 Q4's list
  n: 20,         //   ... those last n bars                                ← NOT in §10 Q4's list
  m: 3,          // sweep: bars allowed for the close to come back inside
  eqHi: 0.70,    // premium: position within the dealing range >= this
  eqLo: 0.30,    // discount: <= this
  oteLow: 0.62,  // OTE retracement band
  oteHigh: 0.79,
  atrPeriod: 14,
  minBars: 60,   // SEPARATE FROM quant.MIN_BARS (30). A swing engine needs a warm-up quant's do not.
  sweepLookback: 120, // bound the sweep scan; sweeps are only reported near the decision bar
});

const isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v));
const round = (v, dp = 4) => (isNum(v) ? Math.round(Number(v) * 10 ** dp) / 10 ** dp : null);

// ---------------------------------------------------------------------------
// Swing detection. Two stages because they are different questions:
//   1. which bars are EXTREMES of a window of width 2k+1
//   2. which of those are CONFIRMED as of the decision bar (i + k <= asOf)
// A bar in (asOf-k, asOf] has a window that runs off the end of the view. It may still be the extreme of
// the VISIBLE part, and it is useful — but it is PROVISIONAL and it is labelled so, never counted.
// ---------------------------------------------------------------------------
function findSwings(bars, asOf, k) {
  const swings = [];
  for (const kind of ['high', 'low']) {
    const v = kind === 'high'
      ? bars.map((b) => Number(b.high))
      : bars.map((b) => Number(b.low));

    // ---- confirmed: the whole window [i-k, i+k] lies inside the view ----
    const candidates = [];
    for (let i = k; i + k <= asOf; i++) {
      let isExtreme = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (kind === 'high' ? v[j] > v[i] : v[j] < v[i]) { isExtreme = false; break; }
      }
      if (isExtreme) candidates.push(i);
    }

    // Collapse a PLATEAU into one swing. Three consecutive equal highs is ONE level, not three: emitting
    // three would manufacture HH/LL labels out of nothing (design doc §3).
    // Tie-break, in the order this file defines: higher close wins, then the later index.
    let plateau = [];
    const flush = () => {
      if (!plateau.length) return;
      let best = plateau[0];
      for (const i of plateau) {
        const bc = Number(bars[best].closePrice);
        const ic = Number(bars[i].closePrice);
        if (ic > bc) best = i;                       // higher close wins
        else if (ic === bc && i > best) best = i;    // else the later index
      }
      swings.push({ kind, index: best, price: v[best], status: 'confirmed', confirmedAtIndex: best + k, plateau: plateau.slice() });
      plateau = [];
    };
    for (const i of candidates) {
      if (plateau.length && (i !== plateau[plateau.length - 1] + 1 || v[i] !== v[plateau[0]])) flush();
      plateau.push(i);
    }
    flush();

    // ---- provisional: window clipped by the decision bar ----
    for (let i = Math.max(k, asOf - k + 1); i <= asOf; i++) {
      if (i > asOf) break;
      let leads = true;
      for (let j = Math.max(0, i - k); j <= asOf; j++) {
        if (j === i) continue;
        if (kind === 'high' ? v[j] > v[i] : v[j] < v[i]) { leads = false; break; }
      }
      // A bar that is ALREADY a confirmed swing is not re-emitted as provisional.
      if (leads && !swings.some((s) => s.kind === kind && s.index === i)) {
        swings.push({ kind, index: i, price: v[i], status: 'provisional', confirmedAtIndex: i + k, plateau: [] });
      }
    }
  }
  swings.sort((a, b) => a.index - b.index || (a.kind === 'high' ? -1 : 1));
  return swings;
}

// HH/HL/LH/LL against the PREVIOUS CONFIRMED SWING OF THE SAME TYPE (§3). Provisional swings never
// receive a label: a label that can change is worse than no label, because HH/LL is what a later reader
// would take as settled.
function labelSwings(swings) {
  const last = { high: null, low: null };
  for (const s of swings) {
    s.label = null;
    if (s.status !== 'confirmed') continue;
    const prev = last[s.kind];
    if (prev) {
      if (s.kind === 'high') s.label = s.price > prev.price ? 'HH' : (s.price < prev.price ? 'LH' : 'EQH');
      else s.label = s.price > prev.price ? 'HL' : (s.price < prev.price ? 'LL' : 'EQL');
    }
    last[s.kind] = s;
  }
  return swings;
}

// Direction, and with it the protected level. Deterministic and stated: compare the last two CONFIRMED
// swing lows; if there are not two, fall back to the last two confirmed swing highs. With fewer than two
// swings of either kind there is no prevailing direction and it is 'range' — in which case there is
// nothing to protect and neither BOS nor MSS is defined. Saying so beats inventing a direction.
function directionAndProtected(confirmed) {
  const lows = confirmed.filter((s) => s.kind === 'low');
  const highs = confirmed.filter((s) => s.kind === 'high');
  const lastLow = lows.length ? lows[lows.length - 1] : null;
  const lastHigh = highs.length ? highs[highs.length - 1] : null;

  let direction = 'range';
  if (lows.length >= 2) direction = lastLow.price > lows[lows.length - 2].price ? 'bullish' : 'bearish';
  else if (highs.length >= 2) direction = lastHigh.price > highs[highs.length - 2].price ? 'bullish' : 'bearish';

  let protectedLevel = null;
  if (direction === 'bullish' && lastLow) protectedLevel = lastLow;
  if (direction === 'bearish' && lastHigh) protectedLevel = lastHigh;
  return { direction, protectedLevel, lastLow, lastHigh };
}

// The most recent bar at or before `asOf`, at or after `from`, whose close is beyond `price` on `side`.
// Returns the LAST occurrence, not the first: "is structure broken NOW" is a question about the most
// recent state, and the first crossing may be dozens of bars stale.
function mostRecentCross(bars, asOf, from, price, side) {
  let hit = null;
  for (let j = Math.max(0, from); j <= asOf; j++) {
    const c = Number(bars[j].closePrice);
    if (!isNum(c)) continue;
    if (side === 'above' ? c > price : c < price) hit = { index: j, close: c };
  }
  return hit;
}

function computeStructure({ bars, asOf, params, basis } = {}) {
  const p = { ...DEFAULTS, ...(params || {}) };

  // ---- the caller's contract, enforced rather than assumed ----
  if (!Array.isArray(bars)) throw new TypeError('structure: bars must be an array');
  if (!Number.isInteger(asOf)) {
    throw new TypeError('structure: asOf is required and must be an integer index (there is deliberately '
      + 'no default — see the header; a default would make "the last bar" an implicit lookahead)');
  }
  if (asOf < 0 || asOf >= bars.length) throw new RangeError(`structure: asOf ${asOf} is outside 0..${bars.length - 1}`);
  if (p.k < 1 || !Number.isInteger(p.k)) throw new RangeError(`structure: k must be an integer >= 1 (got ${p.k})`);

  const outBasis = {
    venue: (basis && basis.venue) || null,
    // ★ WHICH SERIES, AND WHY IT WAS CHOSEN. The venue is no longer simply "the venue the desk trades at":
    // that venue stores TWO different series (a sampled tick-hour and the venue's own chart series) and
    // the sampled one understates the hour's extremes — which are exactly what this engine reads. A level
    // is only as good as the high and low it was built from, so the reason travels with the fact
    // (design doc §10 residual Q1, settled 2026-09-22 by `trading/scripts/repro/venue-fidelity-audit.js`).
    venueWhy: (basis && basis.venueWhy) || null,
    venueBars: (basis && basis.venueBars) || null,
    timeframe: (basis && basis.timeframe) || null,
    // ★ Carried because tfMap maps BOTH 1800 and 3600 to '1h', so a '1h' row has two possible provenances
    // and only this field distinguishes them (design doc §4.1).
    sourceIntervalSec: (basis && basis.sourceIntervalSec) || null,
    asOf,
    asOfBarStart: bars[asOf] ? bars[asOf].barStart : null,
  };

  // Keep the view inside the decision bar. Written as an explicit slice so that any future edit which
  // reaches for `bars` beyond `asOf` is a visible change to this line rather than an invisible one.
  const view = bars.slice(0, asOf + 1);

  // `insufficient_history` is its OWN state, never an empty structure (§4.3, §7 rule 3): a blank
  // structure is indistinguishable from "no structure", and that distinction already cost this desk once
  // (TRD-66's not_demo / blank).
  if (view.length < p.minBars) {
    // `swings: []` rather than undefined, so a consumer never has to handle two absences. The shape of a
    // result must not depend on WHY there was not enough history.
    return { state: 'insufficient_history', reason: `bars ${view.length} < minBars ${p.minBars}`, basis: outBasis, params: p, swings: [] };
  }

  const swings = labelSwings(findSwings(view, asOf, p.k));
  const confirmed = swings.filter((s) => s.status === 'confirmed');
  for (const s of swings) {
    s.barStart = view[s.index] ? view[s.index].barStart : null;
    s.close = view[s.index] ? Number(view[s.index].closePrice) : null;
    s.lagBars = s.confirmedAtIndex > asOf ? null : asOf - s.confirmedAtIndex; // null == not yet true
    s.confirmedAtBarStart = view[s.confirmedAtIndex] ? view[s.confirmedAtIndex].barStart : null;
  }

  if (!confirmed.length) {
    // NOT an empty structure (§4.3, §7 rule 3) — but also not a blank one: any PROVISIONAL candidate the
    // scan found is returned with it. A caller told "not enough history" should still be able to see that
    // a swing is forming; discarding that is how a candidate becomes invisible until it is already old.
    return { state: 'insufficient_history', reason: `no confirmed swing in ${view.length} bars at k=${p.k}`, basis: outBasis, params: p, swings };
  }

  const { direction, protectedLevel, lastLow, lastHigh } = directionAndProtected(confirmed);

  // ---- BOS (continuation) / MSS (reversal) — see header note (a) ----
  let bos = null;
  let mss = null;
  if (direction === 'bullish') {
    if (lastHigh) {
      const hit = mostRecentCross(view, asOf, lastHigh.confirmedAtIndex, lastHigh.price, 'above');
      if (hit) bos = { index: hit.index, barStart: view[hit.index].barStart, close: round(hit.close), level: round(lastHigh.price), levelIndex: lastHigh.index, direction, lagBars: asOf - hit.index };
    }
    if (protectedLevel) {
      const hit = mostRecentCross(view, asOf, protectedLevel.confirmedAtIndex, protectedLevel.price, 'below');
      if (hit) mss = { index: hit.index, barStart: view[hit.index].barStart, close: round(hit.close), level: round(protectedLevel.price), levelIndex: protectedLevel.index, direction, lagBars: asOf - hit.index };
    }
  } else if (direction === 'bearish') {
    if (lastLow) {
      const hit = mostRecentCross(view, asOf, lastLow.confirmedAtIndex, lastLow.price, 'below');
      if (hit) bos = { index: hit.index, barStart: view[hit.index].barStart, close: round(hit.close), level: round(lastLow.price), levelIndex: lastLow.index, direction, lagBars: asOf - hit.index };
    }
    if (protectedLevel) {
      const hit = mostRecentCross(view, asOf, protectedLevel.confirmedAtIndex, protectedLevel.price, 'above');
      if (hit) mss = { index: hit.index, barStart: view[hit.index].barStart, close: round(hit.close), level: round(protectedLevel.price), levelIndex: protectedLevel.index, direction, lagBars: asOf - hit.index };
    }
  }

  // ---- displacement: BOTH conditions, because each alone flags noise (§3) ----
  const highs = view.map((b) => Number(b.high));
  const lows = view.map((b) => Number(b.low));
  const closes = view.map((b) => Number(b.closePrice));
  const bodies = view.map((b) => Math.abs(Number(b.closePrice) - Number(b.openPrice)));
  let displacement = null;
  for (let i = view.length - 1; i >= 1; i--) {
    if (i + 1 <= p.atrPeriod) continue;
    const a = atr(highs.slice(0, i + 1), lows.slice(0, i + 1), closes.slice(0, i + 1), p.atrPeriod);
    if (!isNum(a) || a === 0) continue;
    const from = Math.max(0, i - p.n + 1);
    const window = bodies.slice(from, i + 1);
    const meanBody = window.reduce((s, v) => s + v, 0) / window.length;
    if (bodies[i] >= p.d * a && (meanBody === 0 || bodies[i] >= p.r * meanBody)) {
      displacement = {
        index: i, barStart: view[i].barStart, body: round(bodies[i]), atr14: round(a), meanBody: round(meanBody),
        ratioAtr: round(bodies[i] / a, 2), ratioMean: meanBody === 0 ? null : round(bodies[i] / meanBody, 2),
        lagBars: asOf - i,
      };
      break;
    }
  }

  // ---- liquidity sweep: a WICK beyond a confirmed swing whose CLOSE returns inside, within m bars ----
  // The worst lag in the set (§3): a sweep cannot be known until `m` bars have passed, so it is only
  // reported once those bars exist inside the view.
  const sweeps = [];
  for (const s of confirmed) {
    if (s.index < asOf - p.sweepLookback) continue;
    for (let j = s.confirmedAtIndex; j <= Math.min(asOf, s.index + p.m + p.sweepLookback); j++) {
      const beyond = s.kind === 'high' ? Number(view[j].high) > s.price : Number(view[j].low) < s.price;
      if (!beyond) continue;
      for (let c = j; c <= Math.min(asOf, j + p.m); c++) {
        const back = s.kind === 'high' ? Number(view[c].closePrice) < s.price : Number(view[c].closePrice) > s.price;
        if (back) {
          sweeps.push({
            swingIndex: s.index, swingKind: s.kind, swingPrice: round(s.price),
            sweepIndex: j, sweepBarStart: view[j].barStart,
            extreme: round(s.kind === 'high' ? Number(view[j].high) : Number(view[j].low)),
            closeBackInsideIndex: c, closeBackInsideBarStart: view[c].barStart,
            lagBars: asOf - c, // the bar at which the sweep became knowable
          });
          break;
        }
      }
      break; // one sweep per swing
    }
  }

  // ---- FVG / imbalance: fully determined at bar i+1's close, so no lag beyond that ----
  const fvg = [];
  for (let i = 1; i < view.length - 1; i++) {
    const prev = view[i - 1];
    const next = view[i + 1];
    if (Number(prev.high) < Number(next.low)) {
      fvg.push({ kind: 'bullish', index: i, barStart: view[i].barStart, from: round(Number(prev.high)), to: round(Number(next.low)), confirmedAtIndex: i + 1, lagBars: asOf - (i + 1) });
    } else if (Number(prev.low) > Number(next.high)) {
      fvg.push({ kind: 'bearish', index: i, barStart: view[i].barStart, from: round(Number(next.high)), to: round(Number(prev.low)), confirmedAtIndex: i + 1, lagBars: asOf - (i + 1) });
    }
  }

  // ---- order block: the last OPPOSING candle before the displacement leg that produced the BOS ----
  // Defined by construction (§3), which is why it is derived from `bos` and `displacement` rather than
  // pattern-matched. Absent unless BOTH exist: an order block with no displacement behind it is a candle.
  let orderBlock = null;
  if (bos && displacement && displacement.index <= bos.index) {
    const wantBearish = bos.direction === 'bullish'; // a bull leg's order block is the last DOWN candle
    for (let i = displacement.index; i >= 0; i--) {
      const b = view[i];
      const bearish = Number(b.closePrice) < Number(b.openPrice);
      if (bearish === wantBearish && Number(b.closePrice) !== Number(b.openPrice)) {
        orderBlock = { index: i, barStart: b.barStart, kind: wantBearish ? 'bearish' : 'bullish', high: round(Number(b.high)), low: round(Number(b.low)), lagBars: asOf - i };
        break;
      }
    }
  }

  // ---- dealing range, premium/discount/equilibrium, OTE ----
  let dealingRange = null;
  let position = null;
  let ote = null;
  if (lastHigh && lastLow) {
    const hi = Math.max(lastHigh.price, lastLow.price);
    const lo = Math.min(lastHigh.price, lastLow.price);
    dealingRange = {
      high: round(hi), low: round(lo),
      highIndex: lastHigh.price >= lastLow.price ? lastHigh.index : lastLow.index,
      lowIndex: lastHigh.price >= lastLow.price ? lastLow.index : lastHigh.index,
      fromSwingHigh: lastHigh.index, fromSwingLow: lastLow.index,
    };
    if (hi > lo) {
      const px = Number(view[asOf].closePrice);
      const pct = (px - lo) / (hi - lo);
      position = { pct: round(pct, 4), zone: pct >= p.eqHi ? 'premium' : (pct <= p.eqLo ? 'discount' : 'equilibrium') };
      // Retracement of the leg that ENDED at the extreme: measured back from `hi`, in the direction the
      // leg travelled. Bullish leg (low -> high): the band sits just below the high.
      const leg = hi - lo;
      const bullish = direction === 'bullish';
      const bandLow = bullish ? hi - p.oteHigh * leg : lo + (1 - p.oteHigh) * leg;
      const bandHigh = bullish ? hi - p.oteLow * leg : lo + (1 - p.oteLow) * leg;
      ote = { low: round(Math.min(bandLow, bandHigh)), high: round(Math.max(bandLow, bandHigh)), active: px >= Math.min(bandLow, bandHigh) && px <= Math.max(bandLow, bandHigh) };
    }
  }

  return {
    state: 'ok',
    basis: outBasis,
    params: p,
    direction,
    protected: protectedLevel
      ? { side: protectedLevel.kind, price: round(protectedLevel.price), index: protectedLevel.index, barStart: protectedLevel.barStart, lagBars: protectedLevel.lagBars }
      : null,
    swings,
    bos,
    mss,
    displacement,
    sweeps,
    fvg,
    orderBlock,
    dealingRange,
    position,
    ote,
  };
}

module.exports = { computeStructure, findSwings, labelSwings, DEFAULTS };
