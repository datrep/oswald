// scripts/record-2026-09-30-exe4-measured.js
//
// TRD-EXE-4 (#1464): the discriminator is now MEASURED, and the remaining step is an OWNERSHIP decision rather
// than an implementation one. Appends to #1464. DRY RUN by default (pass --yes).
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const WARN = '\u26A0', STAR = '\u2605', EM = '\u2014', CHECK = '\u2705', ARROW = '\u2192';

const MARKER = '##2026-09-30 exe4 discriminator measured##';
const INFO = `${MARKER} THE DISCRIMINATOR IS MEASURED, AND WHAT IS LEFT IS AN OWNERSHIP DECISION, NOT CODE.##

${STAR} THE RULE THIS ROW NEEDS IS EXACTLY AVAILABLE, AND IT IS THE VENUE'S OWN MINIMUM TRADE SIZE.
The known instance: **#1110 Sugar buy sent 11.9862**, the venue held **exactly 15**, and **Sugar's venue
'Instruments.unitAmount' is 15 Contracts**. 15 is not a coincidence and not a partial fill ${EM} it is the venue
snapping the desk's own order UP to the smallest size it accepts. The registry that holds that number is the same
one 'instruments.checkSize' already reads on every ticket, so the reconcile path can answer "is this venue size a
snap of what we sent?" without a new read or a new failure mode.

${WARN}${WARN} AND THAT IS PRECISELY WHY THE FIX IS NOT MINE TO MAKE. 'executor.js' declines to claim the position
on purpose, and its reason is sound: *"Claiming the position would write our stopPrice and decisionId onto
something that might be a manual trade the owner placed in the same instrument, and attaching our stop to
somebody else's exposure is a worse error than the one being fixed."* A minimum-snap test narrows that risk but
does not remove it: a hand-placed 15-contract Sugar trade is indistinguishable from a snapped 11.9862 one by size
alone. **Deciding whose exposure it is is an ownership decision about the owner's own money, and it stays with the
owner.**

${CHECK} THE EVIDENCE THAT WOULD HAVE SETTLED IT DOES NOT EXIST ${EM} AND THAT IS MEASURED, NOT ASSUMED.
  * 'order_adopt_suspect' events: **0**. 'order_recovered': **0**. TRD-RSK-9's guard has NEVER fired.
  * 'order_unconfirmed' events: **7**, last at **2026-09-28T07:09:21Z**; 'order_unconfirmed_expired': **7**, last
    at 07:40:36Z. There has been **no unresolved submit since** ${EM} and every guard in that family is gated on
    an unresolved submit existing.
${ARROW} so the matcher is NOT broken and NOT inert-by-construction: it has simply had no input since it landed.
The module header's warning ("a guard that silently does nothing is worse than no guard, because it reads as
coverage") does not apply here, and the difference matters: an inert guard is a defect, a guard with no input is
a quiet desk. **That distinction was worth the measurement, because the two look identical from the count alone.**

${WARN} THE HARM THIS ROW NAMES IS REAL AND IS STILL TWO RECORDS FOR ONE POSITION. #1110 was expired as **FAILED**
at 07:40:36Z while the venue was holding the 15 contracts that submit had created (#1111, opened 07:31:10Z, no
stop, origin 'venue'). So the desk asserts a failure it can see is false, and the position that exists carries no
risk. That is the 'stops' health red, and it is why this row is Tier 1.

SUGGESTED NEXT STEP (owner decision, one line): either
  (a) ACCEPT that a venue size equal to 'Instruments.unitAmount' with a smaller sent size IS our position, and let
      the adopt branch claim it ${EM} one record, the stop preserved, and the ambiguity named on the event; or
  (b) keep declining, and instead make the second record honest: when a submit is expired, check whether a venue
      position in the same symbol and direction was adopted as a stranger during that submit's life, and say so on
      the expiry event rather than reporting a bare FAILED.
(a) fixes the stop; (b) only fixes the record. Both need the owner, because (a) attaches the desk's stop to a
position that might not be ours.

⚠ NOT IMPLEMENTED. No ownership rule was added and no checkout behaviour changed ${EM} there is not one
observation to validate a claiming rule against, and a live desk is the wrong place to run an untested one.`;

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;
  console.log('=== TRD-EXE-4: the discriminator ===\n');

  // 1. The venue minimum is in the registry, and the known case matches it exactly.
  const min = (await q(`SELECT unitAmount, unitKind FROM Instruments
      WHERE userId=1 AND symbol='Sugar' AND venue='plus500' AND instrumentClass='spot'`))[0];
  if (!min) throw new Error('no Sugar spot row in Instruments — the discriminator cannot be cited');
  if (Number(min.unitAmount) !== 15) throw new Error(`Sugar's unitAmount is ${min.unitAmount}, not 15 — the snap claim is wrong`);
  console.log(`  ${CHECK} Instruments: Sugar spot unitAmount = ${min.unitAmount} ${min.unitKind}`);

  const t1110 = (await q(`SELECT id, size, status FROM Trades WHERE id=1110`))[0];
  const t1111 = (await q(`SELECT id, size, status, stopPrice, origin FROM Trades WHERE id=1111`))[0];
  if (!t1110 || !t1111) throw new Error('the #1110/#1111 pair is gone — the instance cannot be cited');
  if (Number(t1110.size) >= 15) throw new Error(`#1110 sent ${t1110.size}, not less than the 15 minimum`);
  if (Number(t1111.size) !== 15) throw new Error(`#1111 held ${t1111.size}, not the 15 minimum`);
  if (Number(t1110.size) === Number(t1111.size)) throw new Error('the two sizes match — there would be no defect');
  console.log(`  ${CHECK} #1110 sent ${t1110.size} (status ${t1110.status}) vs #1111 held ${t1111.size} (stop ${t1111.stopPrice ?? 'NULL'}) ⇒ a MINIMUM SNAP`);
  if (t1111.stopPrice != null) throw new Error('#1111 carries a stop — the "no stop" harm is gone and this row needs re-measuring');

  // 2. The guard has never fired, and there has been no input for it since it landed.
  for (const [kind, want] of [['order_adopt_suspect', 0], ['order_recovered', 0]]) {
    const n = Number((await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind='${kind}'`))[0].n);
    if (n !== want) throw new Error(`${kind} now has ${n} events — it HAS fired, and this row's evidence changed`);
  }
  const unc = (await q(`SELECT COUNT(*) AS n, MAX(createdAt) AS last FROM TradingEvents WHERE kind='order_unconfirmed'`))[0];
  if (!unc || unc.last == null) throw new Error('no order_unconfirmed events — the "no input since" claim cannot be made');
  console.log(`  ${CHECK} order_adopt_suspect 0 · order_recovered 0 · last order_unconfirmed ${new Date(unc.last).toISOString()} ⇒ a guard with NO INPUT, not an inert one`);

  const exe4 = (await q(`SELECT id FROM dbo.Tasks WHERE name LIKE 'TRD-EXE-4:%'`))[0];
  if (!exe4) throw new Error('TRD-EXE-4 not found');
  const already = ((await q(`SELECT CAST(info AS NVARCHAR(MAX)) AS info FROM dbo.Tasks WHERE id=${exe4.id}`))[0].info || '').includes(MARKER);
  console.log(`  would append to TRD-EXE-4 (#${exe4.id})${already ? ' — ALREADY PRESENT' : ''}`);
  if (INFO.includes('\u0060')) throw new Error('the addendum contains a backtick');
  console.log(`  ${CHECK} no backticks`);

  if (!YES) { console.log(`\nDRY RUN ${EM} nothing written.\n`); await pool.close(); return; }
  if (!already) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${INFO.replace(/'/g, "''")}' WHERE id = ${exe4.id}`);
    const after = (await q(`SELECT LEN(CAST(info AS NVARCHAR(MAX))) AS n FROM dbo.Tasks WHERE id=${exe4.id}`))[0].n;
    console.log(`  ${CHECK} appended; TRD-EXE-4 (#${exe4.id}) is now ${after} chars`);
  }
  await pool.close();
})().catch((e) => { console.error(`\n${WARN} ${e.message}\n`); process.exit(1); });
