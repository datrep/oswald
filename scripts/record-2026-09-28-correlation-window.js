// scripts/record-2026-09-28-correlation-window.js
//   · creates TRD-RSK-3 — the correlation veto is computed over ~733 days while its comment AND its user-facing
//     message say "30d", and on tonight's real case the difference changes the verdict
//   · appends a short note to TRD-RSK-2 (#1418) recording that the new refusal format is live-verified
// Dry by default:  node scripts/record-2026-09-28-correlation-window.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-28 corr-window##';
const MARK_1418 = '##2026-09-28 rs2-live-format##';

const NAME = 'TRD-RSK-3: Risk - the correlation veto runs over 733 days while its comment and its message say 30d, and the difference changes the verdict';

const INFO = `${MARK}
FOUND 2026-09-28 by MEASUREMENT, after the owner asked what the correlation veto actually computes. Registered under
the owner rule that a novel repo-specific finding becomes a task.

★★★ **THE CLAIM IS "30-DAY LOG-RETURNS". THE WINDOW IS 733 DAYS. AND TONIGHT THE DIFFERENCE DECIDED A TRADE.**

    comment   risk.js:12   "correlation veto on LOG RETURNS of 1h closes over a FIXED 30-DAY WINDOW"
    message   risk.js:462  "correlation 0.7763 (30d log-returns) with open position Gold >= 0.7"   <- what the owner saw
    code      risk.js:31   store.listBars(userId, { timeframe:'1h', symbol, venue, limit: 12000 })

\`listBars\` (\`store/bars.js:244\`) applies **NO DATE FILTER**. It is \`SELECT TOP (@limit) ... ORDER BY barStart DESC\`,
clamped to \`Math.min(limit, 12000)\`. At 1h, **12,000 bars is ~500 days**, and yahoo's own history supplies more than
that. So the "fixed 30-day window" is really "as many bars as exist, up to 12,000".

**MEASURED** (\`temp/probe-corr-window.js\`, read-only, using the gate's own function and the gate's own venue order):

    Gold   via yahoo   11,748 bars   2024-09-11T16:00Z .. 2026-09-28T02:33Z
    Silver via yahoo   11,493 bars   2024-09-25T05:00Z .. 2026-09-28T02:33Z
    PAIRED on barStart 11,474  ->  11,473 log-return pairs
    ACTUAL SPAN                         732.9 days
    rho over the ACTUAL window (n=11473)   0.7763      *** VETO ***
    rho over a TRUE 30d window (n=433)     0.6888      *** NO VETO ***

⇒ **THE SILVER PROPOSAL REFUSED AT 2026-09-28T03:06:46Z WAS REFUSED ON A WINDOW ITS OWN MESSAGE DOES NOT NAME,
AND ON THE WINDOW IT DOES NAME IT WOULD HAVE BEEN APPROVED.** That is the whole row. 0.6888 < 0.7 < 0.7763.

★★ **AND THE THRESHOLD'S OWN STATED BASIS IS A 30-DAY READING.** \`risk.js:451\` justifies the value as
*"threshold 0.7 for a 3-slot book"*, and P1-9 (2026-09-10) set it when it replaced the old raw-price-level method
(*"the 0.73 Gold/Silver figure was computed on raw levels over <=120 ticks"*). So 0.7 was chosen to separate a
30-day reading — and a 30-day reading of this pair sits at **0.6888**, i.e. just under the line. Every threshold in
this family was calibrated against a quantity the code does not compute.

★ **WHY IT MATTERS BEYOND THIS PAIR: A 733-DAY rho IS A REGIME-BLENDED NUMBER.** It spans the desk's own policy
epoch (2026-09-21), the 2024-26 metals regimes, and every structural break in between. The desk's own doctrine is
exactly this: *"a measurement spanning it reports a mean of two systems."* The veto message asserts a *current*
correlation from a *two-year* statistic, which is the same defect class the epoch registry exists to prevent.

⚠ **AND THE SECOND STALENESS, RECORDED BUT DELIBERATELY NOT CALLED A DEFECT:** the justification says **"3-slot
book"**; live \`risk.maxPositions\` is **10**. Whether 0.7 is still the right line at ten slots is a real question
(a cluster bound, not a per-pair bound) but it is a CALIBRATION DECISION, not a bug, and it belongs with the owner.
Recorded here so the two stalenesses are seen together.

★ **THE THIRD THING THIS TOUCHES: THE MINIMUM IS A MINIMUM, NOT A WINDOW.** \`CORR_MIN_BARS = 30\` gates whether a
symbol is *usable*; nothing in the function bounds it from ABOVE. A short-history symbol and a two-year symbol
therefore produce different statistics under one label, and the read is silently "the most recent N bars where
N = the shorter history", which is a different quantity per pair.

**WHAT IS *NOT* WRONG, verified before claiming a defect:**
  · the arithmetic is correct — the live matrix (\`temp/probe-corr-matrix.js\`, the gate's own function) reproduces
    **0.7763** for Gold|Silver, matching the decision record to 4dp;
  · the test is \`Math.abs(c) >= 0.7\`, so a strong NEGATIVE correlation also vetoes — deliberate for a
    concentration rule, and worth knowing when reading the matrix (Arabica Coffee|SGX is **-0.4217**);
  · the same-pairId exemption (TRD-17/24) skips the veto BETWEEN an intended pair's own legs only;
  · the layer fails OPEN on error (\`catch { /* correlation is a soft layer — skip on error */ }\`) and returns
    \`null\` when data is short — so this rule can never block a trade for a data reason. That is a design choice,
    stated, not a hidden one.

ACCEPTANCE
  1. \`returnsCorrelation\` gains a REAL window parameter with a date floor, and the number it reports is the number
     its message names — or the message stops saying "30d";
  2. a ruling on whether the veto is a 30-day (regime-current) or a long-window (structural) quantity, because the
     two answer different questions and tonight they disagree on a live trade;
  3. the 0.7 value re-derived, or explicitly re-ratified, against the window that is actually used — and against
     \`maxPositions\` 10 rather than the 3 the comment cites;
  4. the pair count and the date span printed in the refusal, so a reader can see the window without reading code.
`;

const ADD_1418 = `

${MARK_1418}
★ **THE NEW REFUSAL FORMAT IS LIVE-VERIFIED AS OF THE 2026-09-28 RESTART.** The restarted server now writes the
order this row asked for — cause first, \`[code]\` immediately after the colon, passed-but-annotated gates trailing
under \`— gate notes:\`. Two adjacent refusals in ONE wake, verbatim from the record:

    #103014 Silver  [correlation]   "risk veto: [correlation] correlation 0.7763 (30d log-returns) with open
                                     position Gold >= 0.7 — gate notes: stop capped at 0.3% of price (declared
                                     1.068%), venue cost 0.1936% = 65% of R; ..."
    #103015 SGX     [venue_minimum] "risk veto: [venue_minimum] below venue minimum: computed 8.5336 < venue
                                     minimum 20 Shares — gate notes: stop cap 0.3% REFUSED for SGX: round trip is
                                     0.6014% and the floor is 1.5x that (0.9021%) — using the declared stop; ..."

Compare the text that prompted this row, where a RESIZE NOTE THE GATE HAD PASSED led and the real cause (a
correlation veto) trailed four passed notes. ★ **And note #103015 is the case this row's subject predicted: the
cost floor and the stop cap DO pull against each other on a real instrument — SGX's round trip (0.6014%) is
2x the cap, so its stop is refused and the declared stop is used instead.** The owner's open decision (the cap
value) is unchanged by this; the REFUSAL now at least names the winner and the loser in one line.
`;

(async () => {
  const pool = await getPool();

  const meta = (await pool.request().query(`
    SELECT c.max_length, t.name AS typ FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
    WHERE c.object_id = OBJECT_ID('dbo.Tasks') AND c.name = 'name'`)).recordset[0];
  const LIMIT = meta.typ === 'nvarchar' ? meta.max_length / 2 : meta.max_length;
  console.log(`Tasks.name limit ${LIMIT}; candidate ${NAME.length} ${NAME.length <= LIMIT ? 'OK' : '*** TOO LONG ***'}`);
  if (NAME.length > LIMIT) { console.error('refusing to write'); await pool.close(); process.exit(1); }
  if ([...NAME].some((c) => c.charCodeAt(0) > 126)) { console.error('name is not pure ASCII'); await pool.close(); process.exit(1); }

  console.log('\n=== TRD-RSK label occupancy (a collision check, per TRD-REG-1) ===');
  for (const r of (await pool.request().query(`SELECT id, state, LEFT(name,80) AS name FROM Tasks WHERE name LIKE 'TRD-RSK-%' OR name LIKE 'TRD-RSK:%' ORDER BY id`)).recordset)
    console.log(`  #${r.id} state=${r.state}  ${r.name}`);

  const dup = (await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%' OR name LIKE 'TRD-RSK-3:%'`)).recordset;
  console.log(`\ninfo ${INFO.length} chars`);
  if (dup.length) console.log(`already recorded as #${dup[0].id} — nothing to do.`);
  else if (!YES) console.log('DRY RUN — not written.');
  else {
    const mx = (await pool.request().query('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks')).recordset;
    const anchor = (await pool.request().query('SELECT TOP 1 plannedStart FROM Tasks WHERE id = 1448')).recordset[0];
    const ins = await pool.request()
      .input('name', NAME).input('info', INFO).input('plannedStart', anchor.plannedStart).input('sortOrder', Number(mx[0].m) + 1)
      .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
              OUTPUT INSERTED.id
              VALUES (@name, @info, @plannedStart, 2, 1, 52, @sortOrder, SYSUTCDATETIME())`);
    const id = ins.recordset[0].id;
    let back = (await pool.request().query(`SELECT state, active, sortOrder FROM Tasks WHERE id=${id}`)).recordset[0];
    if (!(back.active === true || back.active === 1)) {
      await pool.request().query(`UPDATE Tasks SET plannedStart = (SELECT plannedStart FROM Tasks WHERE id=1448) WHERE id=${id}`);
      back = (await pool.request().query(`SELECT state, active, sortOrder FROM Tasks WHERE id=${id}`)).recordset[0];
      console.log('  active repaired via sibling plannedStart');
    }
    console.log(`✔ TRD-RSK-3 created as #${id} state=${back.state} active=${back.active} sortOrder=${back.sortOrder}`);
  }

  console.log('\n=== pointer on #1418 (TRD-RSK-2) ===');
  const cur = (await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = 1418`)).recordset[0];
  const d2 = (await pool.request().query(`SELECT id FROM Tasks WHERE id = 1418 AND info LIKE '%${MARK_1418}%'`)).recordset;
  console.log(`  #1418 state=${cur.state} info=${cur.len}${d2.length ? '  [marker present]' : ` -> ${Number(cur.len) + ADD_1418.length}`}`);
  if (d2.length) console.log('  marker present — nothing to do.');
  else if (!YES) console.log('  DRY RUN — not written.');
  else {
    await pool.request().input('t', ADD_1418).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = 1418`);
    const b = (await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = 1418`)).recordset[0];
    console.log(`  ✔ #1418 appended -> ${b.len} chars`);
  }

  const s = (await pool.request().query('SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = 52 GROUP BY state')).recordset;
  console.log('\nedict 52 by state: ' + s.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
