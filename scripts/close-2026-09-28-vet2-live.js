// scripts/close-2026-09-28-vet2-live.js — TRD-VET-2 (#1448) verified live after the 2026-09-28 restart.
// Dry by default:  node scripts/close-2026-09-28-vet2-live.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-28 vet2-live##';
const ID = 1448;

const NOTE = `

${MARK}
★ **CLOSED 2026-09-28 — VERIFIED LIVE, NOT ASSUMED.** The code and the 14 tests landed on 2026-09-27 but the row was
deliberately left OPEN because \`decisions carrying attribution\` was **0** — the running server was still on the
old code, so the attribution existed only on disk. The desk restarted on 2026-09-28 and the check now passes.

**THE CHECK THAT CLOSED IT** (\`temp/probe-corr.js\`, read-only):

    SELECT COUNT(*) FROM TradingEvents
     WHERE kind='decision' AND CAST(payload AS nvarchar(max)) LIKE '%"attribution"%'   ->  8   (was 0)

Newest: **#103015, 2026-09-28T03:06:46.796Z**, \`attribution: "risk_veto"\`, \`tie: false\`.

★ **AND THE PART THAT MATTERS MORE THAN THE COUNT — THE DETERMINISTIC REFUSAL NOW CARRIES THE RIGHT ATTRIBUTION,
WHICH IS THE EXACT THING THIS ROW WAS RAISED FOR.** The risk-veto path returns BEFORE the committee exists, so
those rows have \`votes: null\`; they were the 14–17 rows that a tally written \`Number(p.votes && p.votes.total)\`
double-counted as exact TIES. Verbatim from the live record:

    #103014 Silver  attribution=risk_veto tie=false
      reason="risk veto: [correlation] correlation 0.7763 (30d log-returns) with open position Gold >= 0.7
              — gate notes: stop capped at 0.3% of price (declared 1.068%), venue cost 0.1936% = 65% of R; ..."

    #103015 SGX     attribution=risk_veto tie=false
      reason="risk veto: [venue_minimum] below venue minimum: computed 8.5336 < venue minimum 20 Shares
              — gate notes: stop cap 0.3% REFUSED for SGX: round trip is 0.6014% and the floor is 1.5x that
              (0.9021%) — using the declared stop; ..."

⇒ **\`attribution\` is now a TOTAL PARTITION on this desk**: a risk refusal says \`risk_veto\` and \`tie: false\`, so it
can no longer be mistaken for a committee tie. Two adjacent refusals in ONE wake carry two DIFFERENT codes
(\`correlation\` and \`venue_minimum\`), which is the machine-readable attribution working as designed — the same
pair used to be two prose sentences a reader had to interpret.

★ **THE REFUSAL LINE IS ALSO LIVE AND IN THE NEW ORDER** (\`vetoLine\`): the cause leads, the \`[code]\` follows the
colon immediately, and the passed-but-annotated gates trail under \`— gate notes:\`. Compare the pre-restart text
that prompted TRD-RSK-2, where a **resize note the gate had PASSED** led while the real cause (a correlation veto)
trailed four passed notes — and where \`[correlation]\` did not exist at all.

⚠ **NOT VERIFIED BY THIS CLOSURE, AND DELIBERATELY STILL OPEN:** \`TRD-TP-1\` (#1412) shares the same restart
dependency but its check is \`kind='stop_capped' AND payload LIKE '%"tpAnchor%'\`, which is still **0** — because
**no \`stop_capped\` event has fired since the restart** (newest is #101544 at 2026-09-28T01:06:57.733Z, ~2h
BEFORE the 03:0x restart). That is a pending *ticket*, not a pending restart, and it must not be closed on a
proxy. The take-profit anchor switch renders in the risk panel and reads \`risk.takeProfitAnchor = 'declared'\` via
the \`store.js\` default.
`;

(async () => {
  const pool = await getPool();
  const cur = (await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`)).recordset[0];
  if (!cur) { console.error(`#${ID} not found`); await pool.close(); process.exit(1); }
  const dup = (await pool.request().query(`SELECT id FROM Tasks WHERE id = ${ID} AND info LIKE '%${MARK}%'`)).recordset;
  console.log(`#${ID} state=${cur.state} info=${cur.len}${dup.length ? '  [marker present]' : ` -> ${Number(cur.len) + NOTE.length}`}`);
  if (dup.length) { console.log('marker present — nothing to do.'); await pool.close(); return; }
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }
  await pool.request()
    .input('t', NOTE)
    .query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t, state = 3 WHERE id = ${ID}`);
  const back = (await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`)).recordset[0];
  console.log(`✔ #${ID} closed: state=${back.state} info=${back.len} chars`);
  const s = (await pool.request().query('SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = 52 GROUP BY state')).recordset;
  console.log('edict 52 by state: ' + s.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
