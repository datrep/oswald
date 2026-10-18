'use strict';
// trading/scripts/resim-exits.js — PATH-DEPENDENT EXIT RE-SIMULATION (2026-10-05, owner-approved
// "buildable now" item; corroboration follow-up: docs/trading-reports-corroboration-2026-10-05.md).
//
// WHY THIS EXISTS. The first corroboration pass simulated exits as STOP-FIRST-THEN-TARGET inside each bar
// (the chair-test methodology), which cannot answer the TWO most-asked questions: "would a breakeven stop
// after +0.5R help?" and "would a tighter trail help?" — both are PATH-DEPENDENT (the stop moves only
// after the path has moved). This harness replays each historical entry against its bars under several
// exit policies and reports each policy's bracket.
//
// METHOD (pinned, because brackets that are not stated get read as point estimates):
//   · Signals: identical extraction to temp/chair-test.js (decisions with chairVotes, wake-price map,
//     4 h per symbol+direction dedup, effectiveStopDistance). The BASELINE arm reproduces chair-test.
//   · Bars: PriceBars, one timeframe (default 1h — the only lane current through 2026-10-05; 5m yahoo
//     exists but stops 08:47Z today and covers a subset of symbols). Venue preference: plus500 >
//     plus500_chart > yahoo > binance > okx.
//   · WITHIN-BAR ORDER IS UNKNOWN (OHLC has no sequence), so every policy runs TWICE per bar:
//     'adv-first' (the adverse extreme checked before the favourable one — conservative for the holder)
//     and 'fav-first' (optimistic). Results are reported as brackets; the truth sits between, and a
//     policy that looks good only in one ordering is NOT good.
//   · Entry bar included at hourStart(decision) — same convention as chair-test (comparable), which
//     assumes entry at the bar's start; documented bias, identical across policies, deltas remain valid.
//   · NO spread/slippage inside R — run additionally WITH a measured per-symbol cost in R units
//     (spread% of price / stop% of price, measured 2026-10-05 from Trades; see COST_R). Costs matter:
//     measured 0.10 (Oil) to 0.29 (SGX/ETH) R per round trip.
//
// POLICIES:
//   baseline      stop -1R, target +1.41R (1.5R net of the live 6% offset), horizon 48 bars
//   be05          + once +0.5R touched, stop -> entry (~0R)
//   trail1R       + ratcheting stop at 1.0R below the peak (= TRD-TRL-2 distanceMultiple 1, the config
//                   that exists in settings and is currently OFF)
//   trail075      + ratcheting stop at 0.75R (the report's "1.5xATR" idea; live stop = 2xATR)
//   partial1R     + half off at +1R (bank +0.5R), remainder runs baseline rules
//   target1R      baseline with target +1.0R (less give-back)
//
// Usage: node trading/scripts/resim-exits.js [--tf=1h] [--since=2026-09-21T00:00:00]
// Writes: temp/resim-exits-out.json (analysis artifact; no DB writes of any kind).

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { getPool } = require('../../trading/db');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const TF = String(args.tf || '1h');
const SINCE = String(args.since || '2026-09-21T00:00:00');
const HORIZON_BARS = 48;
const TARGET_R = 1.41;
const DEDUP_MS = 4 * 3600 * 1000;
const BAR_MS = { '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000 }[TF];
if (!BAR_MS) { console.error('unsupported --tf:', TF); process.exit(2); }

// Measured 2026-10-05 (temp/corroborate-reports.js perSymbol): round-trip spread as R units per symbol
// (spread% of price / avg stop% of price). Applied as a fixed deduction per trade in the costs pass.
const COST_R = {
  Gold: 0.18, Oil: 0.10, 'Arabica Coffee': 0.10, Sugar: 0.20, Silver: 0.21,
  Bitcoin: 0.20, SGX: 0.29, Soybeans: 0.28, Ethereum: 0.29,
};
const VENUE_PREF = ['plus500', 'plus500_chart', 'yahoo', 'binance', 'okx'];

const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const utcMs = (naive) => new Date(String(naive).replace(' ', 'T') + 'Z').getTime();
const barFloor = (ms) => Math.floor(ms / BAR_MS) * BAR_MS;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// PATH SIMULATION — one proposal, one policy, one ordering. Returns { R, bars, reason }.
//
// Position bookkeeping: `stop` is the working stop level, `peak` the best favourable extreme seen, and
// `bankedR`/`halfLeft` the partial-exit state. All in PRICE units except R outputs.
function resimPolicy({ bars, startMs, d, P, D, policy, favFirst }) {
  const stop0 = P - d * D;
  const armBE = P + d * 0.5 * D;               // be05
  const armPartial = P + d * 1.0 * D;          // partial1R
  const target = P + d * (policy === 'target1R' ? 1.0 : TARGET_R) * D;
  const trailDist = policy === 'trail1R' ? 1.0 * D : policy === 'trail075' ? 0.75 * D : null;
  let stop = stop0;
  let peak = P;                                 // best favourable price seen
  let beArmed = false;
  let partialBankedR = 0, halfLeft = 1;         // fraction of position still open
  let n = 0, last = null;

  const favUpd = (fx) => { if (d === 1 ? fx > peak : fx < peak) peak = fx; };
  const ratchet = () => {
    if (policy === 'be05' && beArmed) stop = d === 1 ? Math.max(stop, P) : Math.min(stop, P);
    if (trailDist != null) stop = d === 1 ? Math.max(stop0, peak - trailDist) : Math.min(stop0, peak + trailDist);
  };
  const exitR = (price, reason) => ({
    R: +(partialBankedR + halfLeft * (d * (price - P) / D)).toFixed(3), bars: n, reason,
  });

  for (let k = 0; k < 3000 && n < HORIZON_BARS; k++) {
    const b = bars.get(startMs + k * BAR_MS);
    if (!b) continue;                           // gap hour — same skip convention as chair-test
    if (b.h > P * 1.6 || b.l < P * 0.6) continue; // 2026-10-07 DATA FIX: skip wrong-scale venue bars (plus500_chart serves Soybeans at ~1/20 scale in off-hours: ~61 vs ~1278)
    n++; last = b;
    const fav = d === 1 ? b.h : b.l;            // favourable extreme this bar
    const adv = d === 1 ? b.l : b.h;            // adverse extreme this bar

    const adverseStep = () => {
      const stopHit = d === 1 ? adv <= stop : adv >= stop;
      if (!stopHit) return null;
      const why = trailDist != null && stop > stop0 ? 'trail' : (beArmed && stop === P ? 'be' : (halfLeft < 1 ? 'partial_stop' : 'stop'));
      return exitR(stop, why);
    };
    const favourableStep = () => {
      favUpd(fav);
      if (policy === 'be05' && !beArmed && (d === 1 ? fav >= armBE : fav <= armBE)) { beArmed = true; }
      if (policy === 'partial1R' && halfLeft === 1 && (d === 1 ? fav >= armPartial : fav <= armPartial)) {
        partialBankedR = 0.5; halfLeft = 0.5;
      }
      ratchet();
      const tgtHit = d === 1 ? fav >= target : fav <= target;
      if (tgtHit) return exitR(target, halfLeft < 1 ? 'partial_target' : 'target');
      return null;
    };

    // ORDERING. adv-first: the adverse extreme is applied with the stop as it stood BEFORE this bar's
    // favourable extreme could ratchet it (conservative). fav-first: the favourable extreme may arm/ratchet
    // first, then the adverse extreme is applied against the UPDATED stop.
    const first = favFirst ? favourableStep() : adverseStep();
    if (first) return first;
    const second = favFirst ? adverseStep() : favourableStep();
    if (second) return second;
  }
  if (!last) return null;
  return exitR(last.c, halfLeft < 1 ? 'timeout_partial' : 'timeout');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  const p = await getPool();

  // 1. entry proposals with chair votes — identical extraction to temp/chair-test.js
  const decRows = (await p.request().query(
    "SELECT id, CONVERT(varchar(19),createdAt,120) t, CAST(payload AS varchar(max)) pl " +
    "FROM TradingEvents WHERE userId=1 AND kind='decision' AND createdAt > '" + SINCE + "' AND CAST(payload AS varchar(max)) LIKE '%chairVotes%'"
  )).recordset;
  const proposals = [];
  for (const r of decRows) {
    const j = parseJson(r.pl);
    if (!j || j.type !== 'entry') continue;
    const eff = Number(j.effectiveStopDistance);
    const stop = Number.isFinite(eff) && eff > 0 ? eff : Number(j.stopDistance);
    if (!(stop > 0) || !j.symbol || !j.direction) continue;
    proposals.push({
      evId: r.id, t: r.t, tMs: utcMs(r.t), promptId: j.promptId, symbol: j.symbol, direction: j.direction,
      strategy: j.strategy, stop, chairVote: j.chairVote,
    });
  }
  console.log('entry proposals (raw):', proposals.length);

  // 2. prices from wake payloads — identical to chair-test
  const wakeRows = (await p.request().query(
    "SELECT CAST(payload AS varchar(max)) pl FROM TradingEvents WHERE userId=1 AND kind='wake' AND createdAt > '" + SINCE + "' AND CAST(payload AS varchar(max)) LIKE '%signals%'"
  )).recordset;
  const priceMap = new Map();
  for (const r of wakeRows) {
    const j = parseJson(r.pl);
    if (!j || !j.quant || !Array.isArray(j.quant.signals)) continue;
    for (const s of j.quant.signals) {
      if (!s || !s.symbol || s.price == null) continue;
      priceMap.set(j.promptId + '|' + s.symbol + '|' + s.direction + '|' + (s.type || 'entry'), Number(s.price));
    }
  }
  console.log('wake price entries:', priceMap.size);

  // 3. bars for the requested timeframe
  const barRows = (await p.request().query(
    "SELECT symbol, venue, CONVERT(varchar(19),barStart,120) bs, high, low, closePrice FROM PriceBars " +
    "WHERE userId=1 AND timeframe='" + TF + "' AND barStart > '2026-09-20' ORDER BY symbol, barStart"
  )).recordset;
  const barsBy = new Map();
  for (const b of barRows) {
    if (!barsBy.has(b.symbol)) barsBy.set(b.symbol, new Map());
    const m = barsBy.get(b.symbol);
    const key = utcMs(b.bs);
    const rank = VENUE_PREF.indexOf(b.venue);
    const cur = m.get(key);
    if (!cur || (rank >= 0 && cur.rank > rank)) {
      m.set(key, { h: Number(b.high), l: Number(b.low), c: Number(b.closePrice), rank: rank === -1 ? 99 : rank });
    }
  }
  console.log('symbols with', TF, 'bars:', barsBy.size, '| total bar-slots:', [...barsBy.values()].reduce((s, m) => s + m.size, 0));

  // 4. dedup + collect simulation-ready proposals (prices identical to chair-test)
  const POLICIES = ['baseline', 'be05', 'trail1R', 'trail075', 'partial1R', 'target1R'];
  const kept = [];
  const seenAt = new Map();
  let deduped = 0, missingPrice = 0, priceFallback = 0;
  for (const pr of proposals) {
    const k = pr.symbol + '|' + pr.direction;
    const prev = seenAt.get(k) || 0;
    if (pr.tMs - prev < DEDUP_MS) { deduped++; continue; }
    seenAt.set(k, pr.tMs);
    let P = priceMap.get(pr.promptId + '|' + pr.symbol + '|' + pr.direction + '|entry');
    if (P == null) {
      const m = barsBy.get(pr.symbol);
      if (m) for (let k2 = 0; k2 < 6; k2++) { const b = m.get(barFloor(pr.tMs) - k2 * BAR_MS); if (b) { P = b.c; priceFallback++; break; } }
    }
    if (P == null) { missingPrice++; continue; }
    kept.push({ ...pr, P });
  }
  console.log('kept:', kept.length, '| deduped:', deduped, '| missingPrice:', missingPrice, '| priceFallback:', priceFallback);

  // 5. run every policy under both orderings; costs applied as a second pass
  const results = {};   // results[policy][ordering] = { rs: [...], reasons: {...} }
  for (const policy of POLICIES) {
    results[policy] = {};
    for (const favFirst of [false, true]) {
      const ord = favFirst ? 'fav-first' : 'adv-first';
      const rs = [], reasons = {};
      for (const it of kept) {
        const m = barsBy.get(it.symbol);
        if (!m) continue;
        const sim = resimPolicy({ bars: m, startMs: barFloor(it.tMs), d: it.direction === 'buy' ? 1 : -1, P: it.P, D: it.stop, policy, favFirst });
        if (!sim) continue;
        rs.push({ i: it, R: sim.R, costR: COST_R[it.symbol] ?? null });
        reasons[sim.reason] = (reasons[sim.reason] || 0) + 1;
      }
      results[policy][ord] = { rs, reasons };
    }
  }

  // 6. stats + paired bootstrap vs baseline (same ordering)
  const stat = (arr) => {
    const n = arr.length; if (!n) return { n: 0 };
    const rs = arr.map((x) => x.R);
    const mean = rs.reduce((s, x) => s + x, 0) / n;
    const sorted = [...rs].sort((x, y) => x - y);
    return {
      n, meanR: +mean.toFixed(3), medR: +sorted[Math.floor(n / 2)].toFixed(3),
      winPct: +(100 * rs.filter((x) => x > 0).length / n).toFixed(1),
      sumR: +rs.reduce((s, x) => s + x, 0).toFixed(1),
    };
  };
  const statNet = (arr) => { // costs pass: R - costR per row; rows without a cost are excluded
    const rows = arr.filter((x) => x.costR != null).map((x) => ({ R: x.R - x.costR }));
    return { ...stat(rows), nCosted: rows.length };
  };
  function bootDiff(a, b, iters = 10000) {
    const ra = a.map((x) => x.R), rb = b.map((x) => x.R);
    if (!ra.length || ra.length !== rb.length) return null;   // paired: keep index alignment
    const diffs = [];
    for (let i = 0; i < iters; i++) {
      let s = 0;
      for (let j = 0; j < ra.length; j++) { const idx = (Math.random() * ra.length) | 0; s += ra[idx] - rb[idx]; }
      diffs.push(s / ra.length);
    }
    diffs.sort((x, y) => x - y);
    return { lo90: +diffs[Math.floor(0.05 * iters)].toFixed(3), hi90: +diffs[Math.floor(0.95 * iters)].toFixed(3) };
  }

  const table = {};
  for (const policy of POLICIES) {
    table[policy] = {};
    for (const ord of ['adv-first', 'fav-first']) {
      const cur = results[policy][ord], base = results.baseline[ord];
      table[policy][ord] = {
        gross: stat(cur.rs),
        net: statNet(cur.rs),
        reasons: cur.reasons,
        delta_vs_baseline: policy === 'baseline' ? null : bootDiff(cur.rs, base.rs),
      };
    }
  }

  // chair split on the three headline policies (adv-first ordering)
  const chairSplit = {};
  for (const policy of ['baseline', 'be05', 'trail1R']) {
    const rows = results[policy]['adv-first'].rs;
    chairSplit[policy] = {
      CHAIRS_YES: stat(rows.filter((x) => x.i.chairVote === 'yes')),
      CHAIRS_NO: stat(rows.filter((x) => x.i.chairVote === 'no')),
      ALL: stat(rows),
    };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    method: 'path-dependent exit re-sim; within-bar order unknown -> adv-first/fav-first bracket; entry bar at barFloor (chair-test convention); no spread inside R except the net pass',
    tf: TF, since: SINCE, kept: kept.length,
    policies: POLICIES,
    table, chairSplit,
    costR: COST_R,
  };
  console.log('\n===== EXIT POLICY RE-SIM (' + TF + ', n=' + kept.length + ' kept, costs in R per symbol) =====');
  for (const policy of POLICIES) {
    for (const ord of ['adv-first', 'fav-first']) {
      const t = table[policy][ord];
      const d = t.delta_vs_baseline;
      console.log(`${policy.padEnd(12)} ${ord.padEnd(10)} gross meanR ${String(t.gross.meanR).padStart(6)} sumR ${String(t.gross.sumR).padStart(6)} win% ${String(t.gross.winPct).padStart(4)} | net meanR ${String(t.net.meanR).padStart(6)} | delta ${d ? `${String(d.lo90).padStart(6)} .. ${String(d.hi90).padStart(6)}` : '-'}`);
    }
  }
  console.log('\nreason mix (adv-first):');
  for (const policy of POLICIES) console.log('  ' + policy.padEnd(12), JSON.stringify(table[policy]['adv-first'].reasons));
  console.log('\nchair split (adv-first, gross meanR):');
  for (const policy of Object.keys(chairSplit)) {
    const c = chairSplit[policy];
    console.log(`  ${policy.padEnd(12)} YES n=${c.CHAIRS_YES.n} ${c.CHAIRS_YES.meanR} | NO n=${c.CHAIRS_NO.n} ${c.CHAIRS_NO.meanR} | ALL ${c.ALL.meanR}`);
  }

  fs.writeFileSync(path.join(__dirname, '../../temp/resim-exits-out.json'), JSON.stringify(out, null, 2));
  console.log('\nwrote temp/resim-exits-out.json');
  await p.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
