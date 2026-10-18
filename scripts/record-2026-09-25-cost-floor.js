// scripts/record-2026-09-25-cost-floor.js — record the stop-cap / cost-floor finding on the dashboard.
//
//   creates TRD-RSK-2: the stop cap and the cost floor pull against each other, and a single global cap
//   silently EXCLUDES instruments — measured, with a slider that now says so before it is saved.
//
// Appends, never replaces. Dry by default.
//
//   node scripts/record-2026-09-25-cost-floor.js          # report what would change
//   node scripts/record-2026-09-25-cost-floor.js --yes    # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
// ⚠ LIKE-safe marker. `[...]` in T-SQL LIKE is a CHARACTER CLASS — the earlier `[2026-09-25 …]` marker matched
// 192 rows, i.e. an idempotency guard that always said "already done". `#` is not a metacharacter.
const MARK = '##2026-09-25 cost-floor##';

const NAME = 'TRD-RSK-2: Risk — the stop cap and the cost ceiling pull against each other, so ONE global cap '
  + 'silently EXCLUDES whole instruments (SGX, Sugar, Bitcoin measured); the slider must state its floor';

const INFO = `
${MARK}
★ THE OWNER'S OBSERVATION WAS RIGHT, AND THE MECHANISM IS EXACT. They reported "positions getting capped
because the LLM likely doesn't know what cap it is, so it gets rejected — and not like the LLM knows if it got
rejected or not, it's silent." The mechanism is real and silent, but for a DIFFERENT reason than the cap being
unknown: the cap and the cost ceiling are the SAME dial seen twice. \`stopPolicy.costShareCheck\` computes

    costShare = venue round trip % / stop cap %

so MOVING THE CAP TIGHTER RAISES THE COST SHARE, and past the ceiling the risk gate refuses the entry.

★ THE REJECTION THAT STARTED THIS WAS NOT THE CAP. The Silver refusal records \`costShareOfR: 0.6453\` against
\`costShareCeiling: 0.65\` — the ceiling did NOT fire (0.0047 under). It was the CORRELATION GATE:
\`"correlation 0.7761 (30d log-returns) with open position Gold >= 0.7"\`, and \`llmCalled: false\` — the model was
never consulted, which is why nothing could report a cap it "didn't know". Recorded because the wrong diagnosis
would have been "raise the cap", which would not have changed that outcome at all.

★★ THERE ARE TWO CAP RULES IN ONE MODULE, AND THE FLOOR IS THE STRICTER OF THEM — NOT ONE OF THEM.
  (a) \`adverseStopCap\`   refuses the CAP ITSELF (falling back to the declared stop, silently) when
                          \`cap < costPct x maxAdverseCostMultiple\`   [live mult 1.5]
  (b) \`costShareCheck\`   refuses the TRADE when \`costPct / cap > maxCostShareOfR\`  [live ceiling 0.65]
Both bind at different settings: at the live ceiling (0.65 => x1.5385) rule (b) is tighter, but the two are only
2.5% apart, and LOOSENING the ceiling past 0.667 HANDS THE BINDING CONSTRAINT TO (a). A floor computed from (b)
alone would then under-report and bless a cap the code silently refuses. The floor is therefore

    minCapPct = max( costPct / ceiling , costPct x mult )

★ MEASURED, LIVE, 2026-09-25 — via the new \`GET /api/trading/risk/cost-floors\` (the desk's own cost model, not
an estimate). Ceiling 0.65 from \`maxCostShareOfR\`, cap multiple 1.5, running cap 0.30%:

    symbol            roundTrip%   min cap%   basis          at the CURRENT cap (0.30%)
    HKEx                 0.8498     1.3074   v2-derived     REFUSED  (share 2.8327)
    Swire Pacific        0.6024     0.9268   v2-derived     REFUSED  (share 2.0080)
    SGX                  0.6014     0.9252   v2             REFUSED  (share 2.0047)
    SATS                 0.6006     0.9240   v2-derived     REFUSED  (share 2.0020)
    DBS Group            0.6005     0.9238   v2-derived     REFUSED  (share 2.0017)
    Sugar                0.2634     0.4052   v2             REFUSED  (share 0.8780)
    Bitcoin              0.2500     0.3846   v2             REFUSED  (share 0.8333)
    Silver               0.1936     0.2978   v2             ok       (share 0.6453)
    Arabica Coffee       0.1756     0.2702   v2             ok       (share 0.5853)
    Oil                  0.1728     0.2658   v2             ok       (share 0.5760)
    Gold                 0.1194     0.1837   v2             ok       (share 0.3980)
    Dairy Farm Intl         n/a        n/a   v1-flat        (no cost basis — null, never 0)
    GLOBAL MIN CAP (nothing excluded at or above): 1.3074%

★★ THE LIVE DEFECT: THREE OF THE SEVEN ENABLED INSTRUMENTS CANNOT ENTER AT ALL. Sugar, Bitcoin and SGX are
scoped, enabled, replicated, and refused by the cost gate at the running cap of 0.30% — before any signal, any
quant or any chair is consulted. The owner added SGX strategies on 2026-09-25 and SGX needs a cap of 0.9252% to
be admissible, so as configured the SGX replicas CANNOT FIRE. This is not a tuning preference: it is a whole
instrument unreachable by construction, and it is invisible from every existing surface.

★ WHY SGX IS THE EXPENSIVE ONE, and this matters for the fix: its basis is labelled \`v2\` — the CURATED table,
not the flat fallback (\`v1-flat\`) and not a derived value. Round trip 0.6014% implies a half-spread of ~0.2507%
per side on a CFD, which is the magnitude of a CASH-EQUITY BROKERAGE COMMISSION (SGX clearing 0.0325% + trading
0.0075% + brokerage, ~0.28% minimum), not of a CFD spread. The four \`v2-derived\` HK instruments land at an
almost identical ~0.60%, which is itself suspicious as a shared artefact. ⚠ THE COST TABLE IS THEREFORE A
CANDIDATE SUSPECT, and correcting a curated cost is a DATA decision with its own evidence bar — it is NOT taken
here. What is recorded is that the two routes to admissibility are (i) correct the cost basis, or (ii) raise the
cap, and they have opposite consequences for risk (below).

⚠ RAISING THE CAP IS NOT FREE, AND THE COST IS NOT WHERE IT LOOKS. The take-profit is \`1.5 x the DECLARED\`
distance while the stop is \`min(declared, cap)\`, so a cap BELOW the declared stop does not shorten the target —
it LENGTHENS the effective R:R above 1.5 (that is TRD-TP-1's finding). Raising the cap therefore moves the stop
back toward the declared 2xATR, which (a) restores R:R to exactly 1.5 rather than above it, and (b) WIDENS the
stop, so a fixed \`riskPerTradePct\` SHRINKS the position. Admitting Bitcoin at 0.3846% is a different trade from
the one the desk has been pricing, not merely a bigger number in a box.

★ WHAT SHIPPED WITH THIS ROW.
  · \`GET /api/trading/risk/cost-floors\` — the floor per instrument, computed from \`backtest.costCfgFor\` +
    \`venueComparability.roundTripBpsFromCfg\` + the LIVE ceiling and multiple, returning \`globalMinCapPct\` (the
    one number a global cap needs) and carrying each instrument's cost-model \`basis\` label so a CURATED cost can
    be told from a DERIVED one. \`minCapPct\` is NULL, never 0, when there is no cost basis.
  · Two sliders on the risk panel, applying to every position: \`stop cap % of price\` (risk.maxAdversePct) and
    \`take-profit offset\` (risk.takeProfitOffsetPct). Both render 0 as the word "off" rather than "0%", because
    \`adverseStopCap\` treats \`<= 0\` as NO CAP — an off dial that renders as 0% is exactly the confusion this row
    exists to prevent.
  · \`test/cost-floor.test.js\` (6 tests) pins the arithmetic against BOTH real rules at the boundary, in both
    directions, including the loose-ceiling case where the binding rule SWITCHES — and asserts non-vacuity
    (a floor of 99% would satisfy the permissive half, so a hair below the floor must be refused).

⚠ WHAT IS DELIBERATELY NOT DONE. The running cap was NOT changed. Both routes above are owner decisions: one
edits a cost basis, the other re-prices every open and future position. The desktop default remains 0.30%, which
admits Gold, Oil, Silver and Arabica Coffee and excludes Sugar, Bitcoin and SGX — now stated on the panel rather
than discoverable only by watching an instrument never trade.
`;

(async () => {
  const pool = await getPool();

  const existing = await pool.request().query(
    `SELECT id, name, LEN(CAST(info AS nvarchar(max))) AS info_len, state FROM Tasks WHERE edictId = 52 AND name LIKE 'TRD-RSK-%'`);
  for (const r of existing.recordset) {
    console.log(`#${r.id} state=${r.state} info=${r.info_len}  ${String(r.name).slice(0, 80)}`);
  }

  const already = await pool.request().query(
    `SELECT id, LEN(CAST(info AS nvarchar(max))) AS info_len FROM Tasks WHERE info LIKE '%${MARK}%'`);
  if (already.recordset.length) {
    console.log(`\n⚠ ${already.recordset.length} row(s) already carry the marker — nothing to do:`);
    for (const r of already.recordset) console.log(`   #${r.id} (${r.info_len} chars)`);
    await pool.close();
    return;
  }

  const maxSort = await pool.request().query('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks');
  const sortOrder = Number(maxSort.recordset[0].m) + 1;
  console.log(`\n  create "${NAME.slice(0, 64)}..." info ${INFO.length} chars, sortOrder ${sortOrder}`);

  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }

  // ⚠ plannedStart is NOT NULL and must be UTC or the row renders "Inactive" for 8 hours.
  // ⚠ AND `state` IS NOT WHAT IT LOOKS LIKE: on edict 52 the OPEN rows are state 1 (Draft) — 42 of them — while
  // state 3 (Archived, 121 rows) is the DONE pile. Writing 2 here would file an open defect in the one band the
  // dashboard does not list, which is how a fix gets lost. Priority 1 matches the neighbouring TRD-RSK-1.
  const now = new Date();
  const ins = await pool.request()
    .input('name', NAME).input('info', INFO)
    .input('plannedStart', now).input('sortOrder', sortOrder)
    .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
            OUTPUT INSERTED.id
            VALUES (@name, @info, @plannedStart, 1, 1, 52, @sortOrder, SYSUTCDATETIME())`);
  const id = ins.recordset[0].id;
  console.log(`\n✔ created #${id}`);

  const back = await pool.request().query(
    `SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS info_len, plannedStart FROM Tasks WHERE id = ${Number(id)}`);
  const r = back.recordset[0];
  console.log(`  read-back: #${r.id} state=${r.state} info=${r.info_len} plannedStart=${r.plannedStart.toISOString()}`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
