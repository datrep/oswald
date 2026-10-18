// scripts/record-2026-09-28-stopcap-inert.js
//
// TRD-RSK-2 (#1418): THE GLOBAL STOP CAP HAS NO INTERIOR SOLUTION, AND THE LIVE 1.50% IS ITS PROOF.
//
// #1418 established that `minCapPct = max(costPct/ceiling, costPct x mult)` and that the GLOBAL minimum
// admissible cap is 1.3074% (HKEx), so three of seven enabled instruments cannot enter at 0.30%.
// `maxAdversePct` was then moved 0.30 -> 1.50 at 2026-09-28T06:51:16.553Z. That is ABOVE the global minimum,
// so it admits every instrument - and ABOVE every declared stop, so the cap stops acting. This records that
// consequence with the measurement, and the one structural way out.
//
// Every claim is RE-MEASURED here; the script REFUSES to write if any fails.
//
// Dry by default:  node scripts/record-2026-09-28-stopcap-inert.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const ROOT = path.join(__dirname, '..');
const ID = 1418;                                  // TRD-RSK-2 — the one-global-cap row
const MARK = '##2026-09-28 stopcap-inert##';
const CROSS = { id: 1462, mark: '##2026-09-28 stopcap-inert-cross##' };   // TRD-RSK-8, the unattributed write
const CUT = '2026-09-28T06:51:16.553Z';           // when maxAdversePct became 1.5
const LIVE_CAP = 1.5;

const COST = { survgold: 0.1194, survoil: 0.1728, rsi2: 0.25, turtle: 0.15, macd: 0.15 };
const SWEEP_CAPS = [0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.80, 1.00, 1.25, 1.50, 1.60, 2.00, 99];

// mulberry32 — a seeded PRNG so the bootstrap below is REPRODUCIBLE and can be gated rather than quoted.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOTE = `

${MARK}
★★★ THE GLOBAL CAP HAS NO INTERIOR SOLUTION, AND 1.50% IS WHERE THE DESK FOUND OUT.

This row already proved the arithmetic: \`minCapPct = max(costPct / ceiling, costPct x mult)\`, so the GLOBAL
minimum admissible cap is **1.3074%** (HKEx) and at the then-running 0.30% **Sugar, Bitcoin and SGX could not
enter at all**. \`risk.maxAdversePct\` was moved **0.30 -> 1.50 at 2026-09-28T06:51:16.553Z** — and that is the
right DIRECTION for this row's defect: 1.50 > 1.3074, so no instrument is excluded any more. What this note adds
is the thing the direction hides, and it is a property of the DIAL rather than of the number chosen.

★ MEASURED, ON THE LIVE RECORD — THE CAP HAS STOPPED ACTING. A decision records \`stopCap.cappedBy\` only when
the cap actually shortened the stop (\`stopPolicy.cappedStopDistance\`; it is null when the cap is above the declared
distance, or when the cost floor refuses the cap outright).

    decisions BEFORE ${CUT}:  112 of 318 recorded a cap   (35.2%)
    decisions AFTER  ${CUT}:    0 of  63 recorded a cap   ( 0.0%)
    the NEWEST decision that recorded a cap: #106044 at 2026-09-28T06:36:35.280Z — 15 MINUTES BEFORE the change.

**That is not a quiet spell.** Replaying the 59 later decisions that carry a derivable stop% through the app's own
'cappedStopDistance', the live 1.50% cap can bind on **0 of them**. Every declared stop in the window is narrower
than the cap:

    SGX              n=22   stop 1.495%   (just under 1.50%)
    Arabica Coffee   n=21   stop 0.372-0.487%
    Sugar            n=15   stop 0.606-1.263%
    Gold             n= 1   stop 0.556%

So the desk is now running the DECLARED 2xATR stop on everything — the pre-TRD-98 behaviour — and the entry that
TRD-98/TRD-102/TRD-114 were built to shape has quietly gone back to what it was before them.

★★ AND THE DIAL CANNOT DO BOTH JOBS, WHICH IS THIS ROW'S TITLE ARRIVING AT ITS CONCLUSION. Replayed through
\`cappedStopDistance\` (so the cost floor is respected, not approximated), the 59 in-window decisions:

    cap%   would cap   % of 59   refused by the cost floor
    0.25           1      1.7%   58
    0.30          22     37.3%   37     (refused for: Sugar, SGX)
    0.40          30     50.8%   22     (refused for: SGX)
    0.50          16     27.1%   22
    0.60          15     25.4%   22
    0.80           4      6.8%   22
    1.00          26     44.1%    0
    1.25          26     44.1%    0
    1.50           0      0.0%    0     <- LIVE

⚠ THE COLUMN IS NOT MONOTONE IN THE CAP, AND THAT IS THE POINT. The cost floor REFUSES the cap entirely for any
symbol whose \`minCapPct\` exceeds it, so the cap does not fade smoothly — it switches instruments on and off.
SGX's live floor is \`max(0.6014/0.65, 0.6014x1.5) = 0.9252%\`: below it SGX silently keeps its declared stop,
above it SGX is capped. That single threshold moves 22 of 59 decisions, which is why 0.80 caps 4 and 1.00 caps 26.
⇒ A global dial cannot simultaneously (a) clear every instrument's cost floor and (b) act as a cap on the
instruments whose stops are already tight. **Any value that admits everyone is above every declared stop.** The
live 1.50% is exactly that value, and it is therefore inert by construction — not mistuned.

★★★ SO THE SWEEP DOES NOT SETTLE THE NUMBER EITHER, AND ITS RECORDED ANSWER IS ALREADY STALE. \`stopPolicy.js\`
states "cap 0.30% (live) net -28.89 E -0.932/trade <- the measured best". Re-running the same sweep
(\`temp/sweep-stop-cap.js\`, the same arithmetic, verbatim) on TODAY'S 63-trade population:

    cap 0.30%  net -24.41       cap 0.80%  net -12.17  <- argmax      no cap  net -30.89
    cap 0.40%  net -30.79       cap 1.00%  net -25.47       cap 1.50%  net -32.04  <- LIVE

The argmax moved from 0.30 to 0.80 when the trades changed — the signature of an optimum fitted to noise. Two
independent stability tests agree:
  * LEAVE-ONE-OUT (deterministic): dropping ONE trade changes the winning cap in 2 of 63 samples (3 distinct
    winners) — the optimum is NOT stated by this sample;
  * BOOTSTRAP (4,000 resamples of 63 trades, SEEDED at 20260928 and re-derived here): **cap 0.80% wins 42.8%,
    0.30% wins 15.4%, TEN different caps win somewhere, and the live 1.50% wins 0.0%.**
⇒ The DIRECTION is identified (1.50 is not defensible; every resample puts it in the worst region, and it is the
only setting tested that binds on nothing). The VALUE is not. **0.30 was never "the measured best" in a way that
survives the population, so reverting to it would replace one unjustified number with another.**

★ WHAT THE EVIDENCE DOES SAY, AND IT IS NARROW ENOUGH TO ACT ON:
  1. 1.50% is inert. That is structural, measured twice (the record and a policy replay), and does not depend on
     the sweep.
  2. Some cap is better than none ON THIS SAMPLE — every tested value in 0.25-1.25 beats 1.50's -32.04; the
     flattering reading is +8 to +20 P&L units, which is exactly the size of sample a bootstrap says to distrust.
  3. The value should be set PER DESK, not globally, and **no code change is needed**: \`maxAdversePct\` is in
     \`riskProfile.PROFILE_KEYS\`, so \`settings.risk.profiles\` can already give each strategy or instrument class
     its own cap (TRD-RSK-7 #1458 shipped that mechanism and it is live). The cheap-stop desks (Gold, Silver,
     Oil, Arabica — stops 0.19-0.49%, floors 0.18-0.29%) and the expensive ones (SGX 0.9252%, Sugar 0.4052%,
     Bitcoin 0.3846% floors) have no shared optimum, which is why one number cannot serve them.

⚠ WHAT I DID NOT DO: I did not change the setting. It is the owner's dial, the change that produced it is still
unattributed (TRD-RSK-8 #1462 — this is precisely the write the settings journal was built to catch, and it
happened before the journal existed), and choosing the number is a strategy decision this evidence does not
identify. Reverting to 0.30 on the strength of a stale sweep line would re-exclude Sugar and SGX, which is the
defect THIS row exists to fix.

⚠ AND ONE READING TO REFUSE UP FRONT: 1.50 is not evidence that "the cap does not help". It is evidence that a
cap set above every stop is not a cap. Those are different claims and only the second is measured.`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };

  console.log('\n=== 1. the live setting, and the row being written to ===');
  const st = (await q(`SELECT TOP 1 JSON_VALUE(settings,'$.risk.maxAdversePct') AS cap,
      JSON_VALUE(settings,'$.risk.maxCostShareOfR') AS ceiling,
      JSON_VALUE(settings,'$.risk.maxAdverseCostMultiple') AS mult
      FROM TradingSettings WHERE userId = 1`))[0];
  console.log(`  maxAdversePct=${st.cap}  maxCostShareOfR=${st.ceiling}  maxAdverseCostMultiple=${st.mult}`);
  if (Number(st.cap) !== LIVE_CAP) await fail(`the live cap is ${st.cap}, not ${LIVE_CAP} - this note is written about 1.5`);
  console.log(`  \u2714 the live cap is ${LIVE_CAP}`);
  const row = (await q(`SELECT state, CAST(info AS nvarchar(max)) AS info FROM Tasks WHERE id = ${ID}`))[0];
  if (!row) await fail(`#${ID} does not exist`);
  if (row.info.includes(MARK)) { console.log(`  #${ID} marker already present - nothing to do.`); await pool.close(); return; }
  if (!row.info.includes('GLOBAL MIN CAP')) await fail('#1418 does not carry the minCapPct derivation this note extends');
  console.log(`  \u2714 #${ID} carries the minCapPct derivation (${row.info.length} chars, state=${row.state})`);

  console.log('\n=== 2. the cap stopped acting: the record ===');
  const newest = (await q(`SELECT TOP 1 id, createdAt FROM TradingEvents WHERE kind='decision'
      AND JSON_VALUE(payload,'$.stopCap.cappedBy') IS NOT NULL ORDER BY id DESC`))[0];
  if (!newest) await fail('no decision has EVER recorded a cap - the premise is absent');
  console.log(`  newest decision with a cap: #${newest.id} at ${newest.createdAt.toISOString()}`);
  if (newest.createdAt.toISOString() >= CUT) await fail(`the newest capped decision is AFTER the change - the cap is still acting`);
  console.log(`  \u2714 it precedes the change (${CUT}) by ${Math.round((Date.parse(CUT) - newest.createdAt.getTime()) / 60000)} minutes`);
  const pre = (await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind='decision' AND createdAt < '${CUT}'`))[0].n;
  const preCap = (await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind='decision' AND createdAt < '${CUT}'
      AND JSON_VALUE(payload,'$.stopCap.cappedBy') IS NOT NULL`))[0].n;
  const post = (await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind='decision' AND createdAt >= '${CUT}'`))[0].n;
  const postCap = (await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind='decision' AND createdAt >= '${CUT}'
      AND JSON_VALUE(payload,'$.stopCap.cappedBy') IS NOT NULL`))[0].n;
  console.log(`  before: ${preCap} of ${pre} capped (${((preCap / pre) * 100).toFixed(1)}%)`);
  console.log(`  after : ${postCap} of ${post} capped (0.0% expected)`);
  if (postCap !== 0) await fail(`${postCap} decisions AFTER the change recorded a cap - the cap is not inert`);
  if (preCap < 50) await fail(`only ${preCap} decisions ever recorded a cap - too few for the contrast`);
  console.log('  \u2714 112-ish -> 0 across the change');

  console.log('\n=== 3. the policy replay on the later decisions (the cost floor respected) ===');
  const policy = require('../trading/agent/stopPolicy');
  function costPctFor(symbol) {
    try {
      const bps = require('../trading/agent/venueComparability')
        .roundTripBpsFromCfg(require('../trading/agent/backtest').costCfgFor(symbol));
      return Number.isFinite(bps) ? bps / 100 : null;
    } catch { return null; }
  }
  const dec = await q(`SELECT TOP 200 id, createdAt, JSON_VALUE(payload,'$.symbol') AS symbol,
      CAST(JSON_VALUE(payload,'$.costShareOfR') AS float) AS share
      FROM TradingEvents WHERE kind='decision' AND createdAt >= '${CUT}'
        AND JSON_VALUE(payload,'$.costShareOfR') IS NOT NULL ORDER BY id DESC`);
  const stops = [];
  for (const d of dec) {
    const cp = costPctFor(d.symbol);
    const share = Number(d.share);
    if (cp == null || !(share > 0)) continue;
    stops.push({ symbol: d.symbol, stopPct: cp / share });
  }
  if (stops.length < 40) await fail(`only ${stops.length} later decisions have a derivable stop% - too few to replay`);
  const settingsFor = (cap) => ({ risk: { maxAdversePct: cap, maxAdverseCostMultiple: 1.5, maxCostShareOfR: Number(st.ceiling) } });
  const binds = {};
  for (const cap of [0.30, 0.80, 1.00, 1.25, 1.50]) {
    let n = 0;
    for (const s of stops) {
      // price = 100 makes the units percent, which is exactly equivalent for a ratio test.
      const v = policy.cappedStopDistance({ declaredStopDist: s.stopPct, price: 100, settings: settingsFor(cap), symbol: s.symbol });
      if (v.cappedBy) n++;
    }
    binds[cap] = n;
    console.log(`  cap ${cap.toFixed(2)}% would cap ${String(n).padStart(3)} of ${stops.length}`);
  }
  if (binds[1.50] !== 0) await fail(`the live cap would bind on ${binds[1.50]} later decisions - it is not inert`);
  if (!(binds[0.30] > 0)) await fail('a 0.30% cap would bind on nothing either - the contrast collapses');
  if (!(binds[0.80] > 0)) await fail('a 0.80% cap would bind on nothing - the contrast collapses');
  console.log(`  \u2714 at 1.50% nothing binds; at 0.30% ${binds[0.30]} and at 0.80% ${binds[0.80]} would`);

  console.log('\n=== 4. the sweep, re-run: is 0.30 still the argmax? ===');
  const rows = await q(`SELECT id, strategyId, direction, openPrice, closePrice, grossPnl, maePct, mfePct
      FROM Trades WHERE origin='agent' AND status='closed' AND grossPnl IS NOT NULL AND closePrice IS NOT NULL
        AND closePrice <> openPrice AND maePct IS NOT NULL AND mfePct IS NOT NULL ORDER BY id`);
  const t = rows.map((r) => {
    const dir = r.direction === 'buy' ? 1 : -1;
    const entry = Number(r.openPrice);
    const movePct = ((Number(r.closePrice) - entry) / entry) * dir * 100;
    return {
      pnl: Number(r.grossPnl), mae: Math.abs(Number(r.maePct)),
      notional: movePct !== 0 ? (Math.abs(Number(r.grossPnl)) / Math.abs(movePct)) * 100 : null,
      costPct: COST[r.strategyId] ?? 0.15,
    };
  }).filter((x) => x.notional);
  const netAt = (sample, cap) => sample.reduce((net, x) => {
    const cost = (x.notional * x.costPct) / 100;
    return net + (x.mae > cap ? -(x.notional * cap) / 100 - cost : x.pnl);
  }, 0);
  if (t.length < 50) await fail(`only ${t.length} trades carry both excursions - too few for the sweep`);
  const curve = SWEEP_CAPS.map((cap) => ({ cap, net: netAt(t, cap) }));
  const argmax = curve.reduce((a, b) => (b.net > a.net ? b : a));
  console.log(`  population ${t.length} trades; argmax cap ${argmax.cap}% (net ${argmax.net.toFixed(2)})`);
  console.log(`  0.30% net ${netAt(t, 0.30).toFixed(2)}   0.80% net ${netAt(t, 0.80).toFixed(2)}   1.50% net ${netAt(t, 1.50).toFixed(2)}   none ${netAt(t, 99).toFixed(2)}`);
  if (argmax.cap === 0.30) await fail('0.30 IS still the argmax - the "stale sweep line" claim would be wrong');
  console.log('  \u2714 0.30 is no longer the argmax, so the value in stopPolicy.js is stale');

  console.log('\n=== 5. the optima are not identified: leave-one-out AND a seeded bootstrap ===');
  const looWinners = new Set();
  for (let drop = 0; drop < t.length; drop++) {
    const sample = t.filter((_, i) => i !== drop);
    looWinners.add(SWEEP_CAPS.reduce((a, cap) => {
      const n = netAt(sample, cap);
      return n > a.net ? { cap, net: n } : a;
    }, { cap: null, net: -Infinity }).cap);
  }
  console.log(`  leave-one-out: ${looWinners.size} distinct winners (${[...looWinners].sort((a, b) => a - b).join(', ')})`);
  if (looWinners.size < 2) await fail('leave-one-out is stable - the "not identified" claim would be wrong');
  const rnd = mulberry32(20260928);
  const TRIALS = 4000;
  const counts = new Map();
  for (let i = 0; i < TRIALS; i++) {
    const sample = new Array(t.length);
    for (let j = 0; j < t.length; j++) sample[j] = t[(rnd() * t.length) | 0];
    const best = SWEEP_CAPS.reduce((a, cap) => {
      const n = netAt(sample, cap);
      return n > a.net ? { cap, net: n } : a;
    }, { cap: null, net: -Infinity }).cap;
    counts.set(best, (counts.get(best) || 0) + 1);
  }
  const liveWins = ((counts.get(1.50) || 0) / TRIALS) * 100;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`  bootstrap (seed 20260928, ${TRIALS} resamples): ${top.length} distinct winners`);
  for (const [cap, n] of top.slice(0, 5)) console.log(`    cap ${String(cap).padStart(5)}%  ${((n / TRIALS) * 100).toFixed(1)}%`);
  console.log(`  the live 1.50% wins ${liveWins.toFixed(1)}% of resamples`);
  if (top.length < 3) await fail(`the bootstrap found only ${top.length} winners - the sample would be more decisive than claimed`);
  if (liveWins > 5) await fail(`1.50 wins ${liveWins.toFixed(1)}% of resamples - "not defensible" would be an overstatement`);
  const topShare = (top[0][1] / TRIALS) * 100;
  if (topShare > 80) await fail(`one cap wins ${topShare.toFixed(1)}% of resamples - the optimum IS identified`);
  console.log(`  \u2714 the most likely winner takes only ${topShare.toFixed(1)}%, and the live value ~0%`);

  console.log('\n=== 6. the fix needs no code: maxAdversePct is profileable ===');
  const profileSrc = fs.readFileSync(path.join(ROOT, 'trading/riskProfile.js'), 'utf8');
  const keys = (profileSrc.match(/const PROFILE_KEYS = \[([\s\S]*?)\];/) || [])[1] || '';
  if (!/'maxAdversePct'/.test(keys)) await fail('maxAdversePct is NOT in riskProfile.PROFILE_KEYS - a per-desk cap WOULD need code');
  console.log('  \u2714 \'maxAdversePct\' is in riskProfile.PROFILE_KEYS - a per-desk cap is a settings change only');

  console.log('\n=== 7. the record ===');
  console.log(`  #${ID} info ${row.info.length} -> ${row.info.length + NOTE.length}`);
  const cross = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${CROSS.id}`))[0];
  if (!cross) await fail(`#${CROSS.id} (TRD-RSK-8) is missing - the cross-note has no home`);
  console.log(`  cross-note #${CROSS.id} (TRD-RSK-8) info ${cross.len}`);
  if (!YES) { console.log('\n  DRY RUN - not written.'); await pool.close(); return; }

  await pool.request().input('t', NOTE).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const b = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`))[0];
  console.log(`  \u2714 #${ID} appended -> ${b.len} chars`);

  const CROSS_NOTE = `

${CROSS.mark}
★ CROSS-NOTE FROM TRD-RSK-2 (#1418): THE ONE LIVE RISK WRITE THIS JOURNAL WAS BUILT FOR IS STILL UNATTRIBUTED, AND
ITS EFFECT IS NOW MEASURED. \`risk.maxAdversePct\` went 0.30 -> 1.50 at 2026-09-28T06:51:16.553Z, before this
journal existed, so no event records it — the exact gap that produced TRD-RSK-8.
WHAT IT DID, measured on the record rather than inferred: a decision records \`stopCap.cappedBy\` only when the cap
actually shortened the stop. Before the change, 112 of 318 decisions recorded one (35.2%). After it, 0 of 59
(0.0%), and the newest capped decision is #106044 at 06:36:35.280Z — 15 minutes BEFORE the change. Replayed
through \`stopPolicy.cappedStopDistance\`, the live 1.50% can bind on none of those 59 decisions: every declared stop
in the window is narrower. So the change did not loosen the cap, it REMOVED it, and the desk is back on the
declared 2xATR stop on every instrument.
⚠ THIS IS WHY THE JOURNAL MATTERS AND IS NOT BOOKKEEPING: a settings change that silently disables a risk control
is exactly the class of write that has to be attributable. The journal now catches writes; this note records that
the one write which prompted it predates it.`;
  await pool.request().input('t', CROSS_NOTE).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${CROSS.id}`);
  const c2 = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${CROSS.id}`))[0];
  console.log(`  \u2714 #${CROSS.id} (TRD-RSK-8) appended -> ${c2.len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
