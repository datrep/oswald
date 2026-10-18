// scripts/record-2026-09-27-rsk2-and-tp1.js — the two rows the last of this cycle's work belongs to.
//
//   1. APPENDS to TRD-RSK-2 (#1418) — the reporting half is built; the two OWNER decisions inside it stay open
//   2. APPENDS to TRD-TP-1 (#1412) — the target-anchor measurement, which is decisive and contradicts intuition
//
// Appends, never replaces. Dry by default.
//   node scripts/record-2026-09-27-rsk2-and-tp1.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const M1 = '##2026-09-27 refusals-visible##';
const M2 = '##2026-09-27 anchor-measured##';

const RSK_ADD = `
${M1}
★ THE REPORTING ARGUMENT OF THIS ROW IS BUILT. "A refusal that happens before the committee should be VISIBLE as a
refusal" — done in three parts, all verified live.

 1. **THE GATE EMITS CODES.** Every one of the 14 sites in \`agent/risk.js\` that sets \`v.veto = true\` now goes
    through ONE helper that sets the flag AND records a machine-readable code:
    \`kill_switch_hard · baseline_unusable · equity_unavailable · already_held · max_positions · max_new_trades ·
    reentry_cooldown · daily_halt · data_missing · cost_ceiling · size_zero · exposure_budget · correlation ·
    venue_minimum\`.
    The prose stays (it carries the numbers a human reads); the code is what a REPORT groups by. This is the direct
    remedy for the error this row's own investigation made: the sentence "venue cost 0.1936% = 65% of R" was read as
    a breach of the 65% cost ceiling when the CORRELATION guard had fired and the cost share was 0.6453 — UNDER.
    A code cannot be misread that way.
 2. **THE CODES TRAVEL.** \`aggregator\` puts \`riskVetoCodes\` on the refusal decision and \`demoWakePayload\` carries
    them per decision, so the cause reaches the stored wake event without a second row.
 3. **A SURFACE, AND IT IS ON A SCREEN.** \`GET /api/trading/risk/refusals\` groups by layer and by code, and the risk
    panel renders it as a live line: "why nothing is entering — … no proposal 55% · step error 19.5% · committee
    19.1% · early skip 3.4% · risk veto 2.7%".
    ⚠ IT COUNTS WAKES, NOT EVENTS (2,247 events were 1,426 wakes), and **it reports its own read cap**: the first
    version asked for 1000 and compared against 1000 while \`store.listEvents\` clamps at \`EVENT_QUERY_CAP\` (500),
    so the read WAS truncated and \`truncated\` still said false — the TRD-77 defect, reproduced in new code an hour
    after reading the comment describing it. It now reads the store's own constant and returns \`truncated\`,
    \`eventCap\`, \`coveredSince\` beside \`requestedSince\`.

⚠ TWO DECISIONS INSIDE THIS ROW STAY OPEN, and both are owner calls:
  · **the stop cap's value** (0.30%). The floor per instrument is measured — Sugar 0.4052%, Bitcoin 0.3846%,
    SGX 0.9252% — so at 0.30% three enabled instruments are excluded by COST before any signal. Raising it admits
    them and widens every stop; TRD-TP-1 now prices that trade-off.
  · **the correlation threshold** (0.7). |Silver, Gold| = 0.7761 means the desk can hold Gold OR Silver, never both.
⚠ AND \`maxRiskPerTradePct\` (0.07%) — which BINDS every ticket while the declared \`riskPerTradePct\` (2%) is inert —
now has a panel control and an on-screen explanation, because a dial that decides the size of every position should
not be reachable only by editing JSON.
`;

const TP_ADD = `
${M2}
★★★ THE ANCHOR QUESTION IS NOW ANSWERED ON THE DESK'S OWN RECORDED TRADES, AND THE ANSWER IS ROUTE (2) — ANCHOR THE
TARGET TO THE STOP THAT IS ACTUALLY PLACED. It does not need a backtest, and it does not need an assumption.

**THE METHOD, which is exact rather than simulated.** \`Trades.mfePct\` is the MAXIMUM FAVOURABLE EXCURSION already
recorded per trade — the best the price got during the hold. So a target at \`k\` x the stop distance would have been
touched **if and only if \`mfePct >= k x stopPct\`**, and the expectancy in R is \`P x (k+1) - 1\`. Every candidate \`k\`
therefore has a first-touch hit rate on the desk's real trades.

⚠ WHAT IT IS NOT, BEFORE THE NUMBERS. A first-touch counterfactual on the recorded path is not a re-simulation: a
trade that closed EARLIER at a closer target would have been followed by a different day. It answers "was the price
ever there", which is exactly what a target placement asks, and it does not answer "what would the equity curve have
been". A BASIS, not a qualification — the owner's own rule.

★ AND IT IS SPLIT BY ERA, because the stop cap arrived with TRD-98/102 on 2026-09-19 and the owner's standing ruling
is that data predating the current policy set is a basis rather than a qualification. **The two eras disagree, and
the post-cap one is the one that describes the desk now.**

    era                     n    mean realised R   runs >1.6R   won     gross P/L
    all closed trades       57        2.41            56.1%      35.1%     -64.12
    post stop-cap (>=1066)  28        3.40            89.3%      32.1%      +1.03

★★ **COUNTERFACTUAL EXPECTANCY, in R, by target distance (target = k x the stop that is placed):**

    k      post-cap hit-rate   post-cap EV(R)     all-history EV(R)
    1.00        60.7%             +0.214            -0.193
    1.25        46.4%             +0.045            -0.329
    1.50        46.4%             +0.161            -0.430
    1.75        39.3%             +0.080            -0.469
    2.00        32.1%             -0.036            -0.526
    2.50        17.9%             -0.375            -0.693
    3.00        10.7%             -0.571            -0.790

**On the current policy set the curve is POSITIVE for k <= 1.75 and NEGATIVE from k = 2 upward.** The desk is running
a mean realised 3.40R on the post-cap trades, which sits deep in the negative half.

★★ **THE DECISIVE SUBSET — the 25 post-cap trades that actually ran MORE than 1.6R (89% of them):**
    at their ACTUAL target (mean 3.63R):   touched  4/25 = 16.0%   expectancy **-0.2598R**   real gross P/L -20.78
    at a true 1.5R target:                 touched 12/25 = 48.0%   expectancy **+0.2000R**
**A +0.46R per-trade swing, on the trades where the cap is the binding distortion.** This row's own hypothesis is
confirmed: capping the stop while leaving the target at 1.5x DECLARED leaves the target too far away, and the
measured consequence is a 16% touch rate against the 22-29% the geometry needs.

⚠ **AND THE 5% TAKE-PROFIT OFFSET IS NOT EARNING ITS KEEP ONCE THE ANCHOR IS RIGHT.** At k = 1.5 the offset moves
expectancy from +0.1607R to +0.1259R — i.e. it makes it WORSE, because it lowers the reward more than it raises the
hit rate. It also catches only **1 of 4** near-misses; the median offset those near-misses required is **11.69%**,
and an offset of 10% catches 2 of 4. The offset was shipped because it was the SMALLEST change that converts a
near-miss into a fill, and that remains what it is — but on this evidence it is a patch for the wrong dial.

⚠ **CAVEATS, stated rather than buried.** n=25 for the decisive subset is small. The counterfactual assumes EQUAL
RISK per trade (the R-multiple convention), so it compares a shape, not an account. And the post-cap window mixes
strategies, so the result should be re-run per strategy before a change is committed.

★ **THE RECOMMENDATION, for the owner to take or refuse:** route (2). Anchor the target to the stop the venue will
ACTUALLY receive, so every ticket carries the 1.5R the strategies declared, and then re-price the offset (including
the option of turning it off). It changes no sizing, no admissibility and no gate — it changes where the target sits,
which is the one thing this row measured and the one thing still wrong.
⚠ NOT CHANGED HERE. \`LEVEL_RR\` is 1.5 and route (2) edits the geometry of every frozen candidate, which needs the
annotation this row already requires.
`;

(async () => {
  const pool = await getPool();
  const plan = [
    { id: 1418, tag: 'TRD-RSK-2', mark: M1, add: RSK_ADD },
    { id: 1412, tag: 'TRD-TP-1', mark: M2, add: TP_ADD },
  ];
  for (const p of plan) {
    const cur = await pool.request().query(`SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${p.id}`);
    if (!cur.recordset.length) { console.error(`#${p.id} not found — aborting`); process.exit(1); }
    const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${p.mark}%'`);
    const c = cur.recordset[0];
    console.log(`#${p.id} ${p.tag.padEnd(10)} state=${c.state} info=${c.len}${dup.recordset.length ? '  [marker present]' : ` -> ${Number(c.len) + p.add.length}`}`);
  }
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }
  for (const p of plan) {
    const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${p.mark}%'`);
    if (dup.recordset.length) { console.log(`#${p.id} marker present — skipped`); continue; }
    await pool.request().input('t', p.add).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${p.id}`);
    console.log(`✔ #${p.id} ${p.tag} appended`);
  }
  const chk = await pool.request().query(
    `SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id IN (1412, 1418) ORDER BY id`);
  console.log('\nread-back:');
  for (const r of chk.recordset) console.log(`  #${r.id} state=${r.state} info=${r.len}`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
