// trading/agent/strategies/rsi2.js — short-horizon mean reversion (implied goal).
// Connors-style RSI(2) fade: extreme 2-bar RSI marks a stretched move; enter
// against it, exit when price returns across the SMA(5). Regime-gated to
// 'range' upstream (like meanrev) and sized at HALF the turtle's risk.
//
// 2026-09-18 — THE SHORT ARM IS OFF BY DEFAULT (`allowShort: false`).
//
// Canonical Connors RSI-2 is a LONG-ONLY rule: buy the panic when RSI(2) is extreme LOW inside a
// longer-term UPTREND. The symmetric overbought fade is a different and much weaker claim, and the
// desk has no evidence for it: 12 closed shorts, 1 win, -17.84, average hold 7.6 minutes. It was the
// desk's entire churn — thirteen entries in four hours — because the review loop closed each one by
// reading the uptrend the fade had just bet against, and the next wake re-entered. The LONG arm stays
// on: it is the published rule, it is not churning (89-minute holds), and it is what a range gate plus
// half-risk was designed to protect. Set `allowShort: true` to restore the symmetric fade — but note
// it is on the lab's UNCOVERED list (agent/lab/gate.js), so it is live on policy, not on evidence.
'use strict';

const { rsi, sma } = require('../indicators');
const { nightsFor } = require('../time'); // TRD-25 nights; TRD-49 venue funding clock via cfg

const DEFAULTS = {
  rsiPeriod: 2,
  low: 10,
  high: 90,
  smaExitPeriod: 5,
  riskPerTradePct: 0.5, // half the turtle's risk budget
  allowShort: false,    // 2026-09-18: the fade-long arm is the tested rule; the fade-short arm is not
};

const PARAMS = [
  { key: 'rsiPeriod', label: 'RSI period', type: 'number', def: 2, min: 2, max: 5, step: 1 },
  { key: 'low', label: 'Oversold entry', type: 'number', def: 10, min: 2, max: 25, step: 1, tightens: 'lower' },
  { key: 'high', label: 'Overbought entry', type: 'number', def: 90, min: 75, max: 98, step: 1, tightens: 'higher' },
  { key: 'smaExitPeriod', label: 'SMA exit period', type: 'number', def: 5, min: 3, max: 20, step: 1 },
  { key: 'riskPerTradePct', label: 'Risk per trade %', type: 'number', def: 0.5, min: 0.1, max: 2, step: 0.1, tightens: 'lower' },
  { key: 'allowShort', label: 'Allow short entries (fade overbought)', type: 'bool', def: false },
];

function paramsWith(cfg) {
  const out = {};
  for (const p of PARAMS) {
    const raw = cfg && cfg[p.key] != null ? cfg[p.key] : p.def;
    // A bool must NOT go through Number(): `Number('false')` is NaN and `Number(false)` is 0, so a
    // boolean read that way becomes silently falsy rather than true/false. The stored settings ship
    // booleans as JSON, the form may send strings — accept both.
    out[p.key] = p.type === 'bool'
      ? (raw === true || raw === 'true' || raw === 1 || raw === '1')
      : Number(raw);
  }
  return out;
}

const round4 = (n) => Math.round(n * 10000) / 10000;

// LIVE signal. ctx from quant.js (bar series + computed indicators).
function liveSignal({ closes, params, openTrade }) {
  const p = paramsWith(params);
  if (closes.length < p.smaExitPeriod + 2) return { type: null };
  const r = rsi(closes, p.rsiPeriod);
  const s5 = sma(closes, p.smaExitPeriod);
  if (r == null || s5 == null) return { type: null };
  const price = closes[closes.length - 1];
  const snap = { rsi2: round4(r), sma5: round4(s5) };

  if (openTrade && openTrade.peak != null && openTrade.trough != null) {
    const back = openTrade.direction === 'buy' ? price > s5 : price < s5;
    if (back) return { type: 'exit', direction: openTrade.direction, basis: `RSI-2: back across SMA${p.smaExitPeriod} ${round4(s5)}`, rsi2: snap };
  }

  if (r < p.low) return { type: 'entry', direction: 'buy', basis: `RSI-2 ${round4(r)} < ${p.low} (stretched down)`, rsi2: snap };
  if (r > p.high) {
    // The overbought fade is off by default — see the header. Suppression is NAMED rather than
    // returned as a bare `type: null`, so a suppressed setup cannot read as "no setup" in the
    // flat reason. (An unlabelled suppression is the F32 defect class: a real state no label names.)
    if (!p.allowShort) return { type: null, rsi2: snap, suppressed: 'short_disabled' };
    return { type: 'entry', direction: 'sell', basis: `RSI-2 ${round4(r)} > ${p.high} (stretched up)`, rsi2: snap };
  }
  return { type: null, rsi2: snap };
}

// BACKTEST: rolling RSI(2) + SMA(5) exits. Trade shape matches the turtle
// backtester so worksheet()/sweep/walk-forward all work unchanged.
function backtest(bars, cfg) {
  const p = paramsWith(cfg);
  const c = { ...cfg, ...p };
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const closes = bars.map((b) => b.close);
  const times = bars.map((b) => b.time || b.barStart);

  let capital = c.capital;
  const trades = [];
  let pos = null;
  let peakEquity = capital;
  let maxDrawdown = 0;

  const closePos = (price, idx, reason) => {
    const pnl = pos.direction === 'buy' ? (price - pos.entryPrice) * pos.size : (pos.entryPrice - price) * pos.size;
    capital += pnl;
    trades.push({
      direction: pos.direction, size: round4(pos.size),
      entryTime: pos.entryTime, entryPrice: pos.entryPrice,
      exitTime: times[idx], exitPrice: price,
      nights: nightsFor(pos.entryTime, times[idx], c.cfdSwapClockMinuteUtc),
      pnlMid: round4(pnl), reason,
    });
    const dd = capital < peakEquity ? ((peakEquity - capital) / peakEquity) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = round4(dd);
    if (capital > peakEquity) peakEquity = capital;
    pos = null;
  };

  // Wilder RSI(2) rolling state.
  let avgGain = 0, avgLoss = 0, prevClose = null;
  const rsiStep = (price) => {
    if (prevClose == null) { prevClose = price; return null; }
    const chg = price - prevClose;
    prevClose = price;
    const gain = chg > 0 ? chg : 0;
    const loss = chg < 0 ? -chg : 0;
    avgGain = avgGain * (p.rsiPeriod - 1) / p.rsiPeriod + gain / p.rsiPeriod;
    avgLoss = avgLoss * (p.rsiPeriod - 1) / p.rsiPeriod + loss / p.rsiPeriod;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  };

  for (let i = 1; i < bars.length; i++) {
    const r = rsiStep(closes[i]);
    if (i < p.smaExitPeriod + 2) continue;
    // Ruin guard (2026-09-10): stop when capital is exhausted — negative
    // capital would flip the size sign and compound fake P&L.
    if (capital <= 0) break;
    if (r == null) continue;
    const s5 = closes.slice(i - p.smaExitPeriod, i).reduce((a, b) => a + b, 0) / p.smaExitPeriod;
    if (pos) {
      const back = pos.direction === 'buy' ? closes[i] > s5 : closes[i] < s5;
      if (back) closePos(closes[i], i, 'sma_exit');
      continue;
    }
    // Stop-distance proxy floored at 0.05% of price (2026-09-10): an
    // absolute 0.0001 floor explodes size on flat/gapped bars (high == low).
    const range = Math.max(highs[i] - lows[i], closes[i] * 0.0005);
    const size = (capital * (p.riskPerTradePct / 100)) / (2 * range);
    if (r < p.low) {
      pos = { direction: 'buy', size, entryPrice: closes[i], entryIdx: i, peak: closes[i], trough: closes[i], entryTime: times[i] };
    } else if (r > p.high) {
      pos = { direction: 'sell', size, entryPrice: closes[i], entryIdx: i, peak: closes[i], trough: closes[i], entryTime: times[i] };
    }
  }
  if (pos) closePos(closes[closes.length - 1], bars.length - 1, 'end_of_data');

  return { trades, finalCapital: round4(capital), maxDrawdown, start: times[0], end: times[times.length - 1] };
}

module.exports = {
  id: 'rsi2',
  name: 'RSI-2 Fade',
  description: 'Connors-style short-horizon fade: RSI(2) extremes mark stretched moves; exit across SMA(5). Range-regime only, half turtle risk.',
  // TRD-89 (2026-09-18): how a position from THIS strategy must be judged. The review loop used to
  // close these on trend grounds ("strong bullish trend, Aroon up 100, short thesis broken"), which is a
  // category error: the entry IS an extreme fade, so price continuing against it is the entry condition,
  // not a break. Thirteen rsi2 positions were closed within minutes that way.
  exitThesis: 'MEAN REVERSION — the entry is a 2-bar RSI extreme, so this position is deliberately on the other side of the recent move. Price continuing that way is the ENTRY CONDITION and is not by itself a broken thesis. The mechanical exit is price crossing back through SMA(5), which means the stretch reverted; that is the thesis COMPLETING, so take it as satisfied rather than as a reason to hold longer. Close early only if the stop is about to be hit, or if the stretch has demonstrably reverted while the position has not followed. Do NOT judge this position with trend tools (Aroon, SMA50/200, Bollinger breakouts): they describe exactly the move this trade is fading.',
  // TRD-89 (2026-09-18): the exit chair may ADVISE on this strategy but may not CLOSE it. The reviewer is
  // a trend reader, and for a fade its central judgement (the move is against the position) is the entry
  // condition — so its authority to stop the position was the category error, not its opinion. The
  // position is protected by its venue stop and by its own mechanical exit (SMA(5) reclaim, computed in
  // liveSignal), and an advisory verdict is still recorded and still visible.
  reviewAuthority: 'advisory',
  params: PARAMS,
  DEFAULTS,
  paramsWith,
  liveSignal,
  backtest,
};
