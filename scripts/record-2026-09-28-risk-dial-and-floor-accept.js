// scripts/record-2026-09-28-risk-dial-and-floor-accept.js
//   · turns ON risk.acceptVenueFloor (the owner's "accept the risk" decision for SGX)
//   · appends the RISK-DIAL analysis to TRD-RSK-4 (#1453)
//   · appends the #1082 quantification to TRD-ANC-1 (#1405) — a severity upgrade on an open row
// Dry by default:  node scripts/record-2026-09-28-risk-dial-and-floor-accept.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');
const store = require('../trading/store');

const YES = process.argv.includes('--yes');
const MARK_DIAL = '##2026-09-28 risk-dial-analysis##';
const MARK_ANC = '##2026-09-28 anc1-risk-breach##';

const DIAL_NOTE = `

${MARK_DIAL}
★★★ **THE OWNER ASKED: *"could you check if ~0.07% of risk on positions is too stringent?"* MEASURED, AND THE
ANSWER HAS THREE PARTS THAT POINT THREE DIFFERENT WAYS.**

**(1) IN EXPECTANCY TERMS THE DIAL IS IRRELEVANT — IT IS NOT IN THE COST FORMULA AT ALL.**

    cost / R  =  (roundTrip% x notional) / (stopDist x size)  =  roundTrip% x price / stopDist
              =  roundTrip% / stopPct                        <- NO SIZE TERM

⇒ **\\\`maxRiskPerTradePct\\\` cannot change how expensive a trade is.** It scales the win, the loss and the cost by
the SAME factor. Raising it 10x multiplies every outcome by 10 and the book's expectancy by 1.
**MEASURED, over the 262 decisions carrying \\\`costShareOfR\\\`:**

    min 0.2999 · mean 0.5105 · max 0.6453      (ceiling 0.65)
    <20%: 0   ·  20-40%: 80   ·  40-60%: 127   ·  60-65%: 55   ·  >65%: 0

★ **NOT ONE TICKET HAS A COST SHARE BELOW 30%, the median is ~0.51, and 55 of 262 (21%) sit within 0.05 of the
hard ceiling.** So a losing trade costs ~1.3-1.65R and a winner nets ~0.35-0.70R. **The dial neither causes nor
cures that.** The lever that does is cost/R, and cost/R is set by the STOP CAP against the spread — which is
TRD-RSK-2 (#1418) and TRD-114, and whose measured optimum (0.30%) is already in force.

**(2) IN CAPITAL TERMS IT IS VERY SMALL, AND THAT IS THE REAL COST.** $2.89 of risk on ~$4,133 equity. A +2R winner
returns $5.78 = **0.14% of equity**. At the desk's measured edge (negative) nothing compounds; even at a
hypothetical +0.10R/trade it would take ~3,600 trades to double the account. The dial is not protecting a
working engine — it is measuring a stopped one.

**(3) IN ELIGIBILITY TERMS IT IS TOO STRINGENT, AND BY EXACTLY ONE INSTRUMENT.** The dial required to clear each
venue floor (\\\`minUnits x effStop / equity\\\`, equity 4,132.71):

    Gold 0.0077% · Arabica 0.0101% · Silver 0.0113% · Bitcoin 0.0140% · Oil 0.0168% · Sugar 0.0549%
    SGX 0.1641%   <-- the only one above the 0.07% dial

⇒ **a dial of ~0.164% clears every symbol; 0.07% blocks SGX alone.** Sugar at 0.0549% is the next closest and has
only ~27% headroom.

★ **AND THE REALISED RISK IS NOT 0.07% EITHER — one post-cap trade carries 2.5x it.** See TRD-ANC-1 (#1405):
\\\`Trades #1082\\\` was raised from 0.0698% to **0.1756%** by a 0.415 fill drift that the re-anchor declined to
correct. So the dial is not even the binding quantity it appears to be.

---

★ **OWNER DECISION, 2026-09-28: *"accept the risk then..."*** — i.e. accept the floor for SGX rather than drop
the symbol or raise a dial that has no per-symbol form.

**IMPLEMENTED AS A DISCLOSED, OPT-IN CLAMP — NOT A QUIET ONE.** \\\`\\\`\\\`risk.acceptVenueFloor\\\`\\\`\\\` (default
**FALSE**, so the \\\`venue_minimum\\\` veto is unchanged unless an owner turns it on). When on and the computed size
is below the venue's floor: the size is RAISED to the floor, and the exceedance is named in \\\`reasons\\\`, carried on
\\\`venueFloor.accepted\\\` with its multiple, printed in the TICKET GEOMETRY note the seat reads, and recorded on the
decision row. \\\`instruments.js\\\`'s header rejects clamping because it would do so *"quietly"* — this answers that
objection rather than overriding it.

    the seat now reads, verbatim for SGX:
    "★ the venue floor was ACCEPTED by an owner setting: the ticket was RAISED to the venue's minimum
     20 Shares, so it carries 0.1640% of equity instead of the 0.0700% the dial computed — 2.34x the
     intended risk"

**SET LIVE on 2026-09-28** (\\\`TradingSettings.risk.acceptVenueFloor = true\\\` via \\\`saveSettings\\\`, re-read to
confirm it held — the stale-write hazard this repo has hit before). \\\`test/venue-floor-disclosure.test.js\\\` now
carries 10 tests including a STRUCTURAL PIN that the clamp is gated on \\\`=== true\\\`, that the veto survives as the
ELSE path, and that the shipped default is \\\`false\\\`.

⚠ **WHAT THIS DOES NOT DO:** it does not make SGX a good trade. Its cost share is ~0.40 and its round trip is
0.6014% — the highest on the book — so SGX will be taken at 2.34x the risk with a worse-than-median cost. The
decision is to stop refusing it, not to claim it is attractive. **If SGX's realised P&L goes negative, the
reversal is one boolean.**
`;

const ANC_NOTE = `

${MARK_ANC}
★★★ **SEVERITY UPGRADE (2026-09-28): THIS IS NOT ONLY A BOOKKEEPING DEFECT — IT COSTS REAL RISK CONTROL.**
**\\\`Trades #1082\\\` carried 2.52x the risk cap, and this row's un-fired re-anchor is why.**

**THE TRADE AND ITS OWN EVENTS, verbatim from the record:**

    decision   #73036  2026-09-23T13:43:17Z  Oil buy  size 10.5435  declaredStop 1.0108  costShareOfR 0.576
    stop_capped #73038 2026-09-23T13:43:17Z  the stop is capped to 0.3% of price
    entry_reanchored #73049 13:44:24.076Z    tradeId 1082  decisionPrice 91.125
                                             stopBefore 90.8516  stopAfter 90.8516   shift 0   <-- NO SHIFT
                                             stopDist 0.2734   note "levels shifted to the price the order was
                                             submitted at; risk distance unchanged (F20)"
    trade_opened #73050 13:44:24.080Z        tradeId 1082  FILL 91.54   fillDelayMs 66889

**THE ARITHMETIC.**
    the stop was placed at  decisionPrice - cappedStopDist  =  91.125 - 0.2734  =  90.8516   (correct, as designed)
    the order FILLED at                                      91.54            (0.415 ABOVE the decision price)
    so the distance from the FILL to the stop  =             91.54 - 90.8516   =  0.6884
    INTENDED risk = 0.2734 x 10.5435 = $2.88 = 0.0698% of equity
    REALISED risk = 0.6884 x 10.5435 = $7.26 = 0.1756% of equity        =>  **2.52x the cap**

★★ **AND THE RE-ANCHOR HAD A REAL DISCREPANCY IN FRONT OF IT.** \\\`entry_reanchored\\\` exists to move the levels to
the price the order was actually submitted at (F20). It ran 6ms before the open event, recorded
\\\`decisionPrice 91.125\\\`, and left \\\`stopBefore === stopAfter\\\` with \\\`shift: 0\\\` — while the fill landed 0.415 away.
**This row's headline ("30/30 shift=0 because it compares the desk's tick to itself") is no longer only a
bookkeeping fact: on this trade a 0.455% drift was available to correct and was not corrected, and the whole of
it became extra risk.** \\\`fillDelayMs 66889\\\` (67 SECONDS) is what creates the drift — the price moves between
submit and fill, and the un-fired re-anchor leaves the geometry anchored to the stale price.

**THE UNCOMFORTABLE HALF, STATED PLAINLY: HERE THE DEFECT PAID.** \\\`maePct\\\` is -0.4151%, so the trade went
0.380 adverse (91.16). A re-anchored stop would have sat at 91.54 - 0.2734 = **91.2666**, i.e. **above 91.16 — the
trade would have been STOPPED OUT for about -$2.88 instead of closing +$13.85** ("venue closed — Profit call").
⇒ **re-anchoring changes the P&L distribution in BOTH directions, so it cannot be switched on as an obvious
improvement.** It removes a hidden risk increase and it also removes the lucky wins that hidden increase produced.
**That is precisely why this must be pre-registered and measured, not fixed incidentally.** It also means the
"cost" of this defect has been invisible in both directions: a 2.52x risk breach on a winner reads as a *good*
trade in every P&L summary the desk produces.

★ **EXPOSURE, MEASURED AND BOUNDED:** over every \\\`plus500\\\` trade opened since the 2026-09-19 stop cap, **exactly
one carries more than 1.6x the dial — #1082.** So the rate is ~1 in 28, not routine. The row's own \\\`30/30
shift=0\\\` count is what says the mechanism is ALWAYS present; this is the first instance with a measured
consequence. **A 1-in-28 rate on a 2.5x breach is small in count and large in tail: the same mechanism can lift a
0.07% risk to 0.25%+ on any ticket where the fill runs.**
`;

async function append(pool, id, text, mark, label) {
  const cur = (await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${id}`)).recordset[0];
  const dup = (await pool.request().query(`SELECT id FROM Tasks WHERE id = ${id} AND info LIKE '%${mark}%'`)).recordset;
  console.log(`  [${label}] #${id} state=${cur.state} info=${cur.len}${dup.length ? '  [marker present]' : ` -> ${Number(cur.len) + text.length}`}`);
  if (dup.length) { console.log('    marker present — nothing to do.'); return; }
  if (!YES) { console.log('    DRY RUN — not written.'); return; }
  await pool.request().input('t', text).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${id}`);
  const b = (await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${id}`)).recordset[0];
  console.log(`    ✔ appended -> ${b.len} chars`);
}

(async () => {
  const pool = await getPool();

  // ── GATE: the exposure claim in the #1405 note must be true BEFORE it is written ──────────────────
  console.log('=== verify the exposure claim (must be exactly [#1082]) ===');
  const dial = Number((await pool.request().query(`SELECT TOP 1 JSON_VALUE(settings,'$.risk.maxRiskPerTradePct') AS d FROM TradingSettings ORDER BY userId`)).recordset[0].d);
  const eq = Number((await pool.request().query(`SELECT TOP 1 JSON_VALUE(payload,'$.equity') AS e FROM TradingEvents WHERE kind='account' ORDER BY id DESC`)).recordset[0].e);
  const breaches = [];
  const rows = (await pool.request().query(`SELECT id, symbol, size, openPrice, stopPrice FROM Trades
      WHERE userId=1 AND venue='plus500' AND status='closed' AND openAt >= '2026-09-19'
        AND openPrice IS NOT NULL AND stopPrice IS NOT NULL AND size IS NOT NULL ORDER BY id`)).recordset;
  for (const r of rows) {
    const pct = (Math.abs(Number(r.openPrice) - Number(r.stopPrice)) * Number(r.size)) / eq * 100;
    if (pct > dial * 1.6) breaches.push(`#${r.id} ${r.symbol} ${pct.toFixed(4)}% (${(pct / dial).toFixed(2)}x)`);
  }
  console.log(`  post-cap trades: ${rows.length}; breaches > 1.6x the dial: ${breaches.length ? breaches.join(', ') : 'none'}`);
  if (breaches.length !== 1 || !breaches[0].startsWith('#1082')) {
    console.error(`  refusing to write: the note claims exactly one breach and it is #1082. Measured: ${breaches.join(', ') || 'none'}`);
    await pool.close(); process.exit(1);
  }

  // ── 1. the owner's decision, set live ────────────────────────────────────────────────────────────
  console.log('\n=== set risk.acceptVenueFloor = true ===');
  const cur = (await pool.request().query(`SELECT TOP 1 JSON_VALUE(settings,'$.risk.acceptVenueFloor') AS v FROM TradingSettings ORDER BY userId`)).recordset[0];
  console.log(`  before: ${JSON.stringify(cur.v)}`);
  if (!YES) console.log('  DRY RUN — not written.');
  else {
    await store.saveSettings(1, { risk: { acceptVenueFloor: true } });
    // ⚠ RE-READ: a settings write can be silently reverted by a stale-holder caller (the hazard this repo
    // already paid for). A successful save is not a durable setting.
    const back = (await pool.request().query(`SELECT TOP 1 JSON_VALUE(settings,'$.risk.acceptVenueFloor') AS v FROM TradingSettings ORDER BY userId`)).recordset[0];
    console.log(`  after : ${JSON.stringify(back.v)}  ${String(back.v) === 'true' ? 'HELD' : '*** DID NOT HOLD ***'}`);
    if (String(back.v) !== 'true') { console.error('refusing to continue'); await pool.close(); process.exit(1); }
  }

  // ── 2. the records ──────────────────────────────────────────────────────────────────────────────
  console.log('\n=== records ===');
  await append(pool, 1453, DIAL_NOTE, MARK_DIAL, 'TRD-RSK-4');
  await append(pool, 1405, ANC_NOTE, MARK_ANC, 'TRD-ANC-1');
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
