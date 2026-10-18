// scripts/record-2026-09-27-scl11-social-media-bible.js
//
//   Adds SCL-11 to edict 221 "Business Scaling" — the social media bible the owner asked for on
//   2026-09-27: "ill plan to slowly build a websitre, and also draft a 'social media bible', for a
//   future employrs." The website is already SCL-3; this is the bible.
//
// Same schema discipline as scripts/record-2026-09-27-listing-and-scaling-sets.js:
//   plannedStart is NOT NULL and must be a JS Date (written as UTC wall-clock, or `active` computes to 0);
//   `active` is COMPUTED and must never be named in an INSERT; state 1 = the open band; sortOrder is PER
//   EDICT; and idempotency is guarded by a marker inside `info`, not by the label, because Tasks.name has
//   no uniqueness check.
//
// Usage (repo root):
//   node scripts/record-2026-09-27-scl11-social-media-bible.js          # DRY RUN
//   node scripts/record-2026-09-27-scl11-social-media-bible.js --yes    # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 scl11 social media bible##';

const EDICT_NAME = 'Business Scaling';
const OPEN = 1;
const PRIORITY = 2;
const E = '\u2014';

const NAME = `SCL-11: Content ${E} a social media bible, so a future employee can run the accounts without the owner`;

const INFO =
`${MARK}
RAISED BY THE OWNER 2026-09-27, unprompted, as the piece he wants to write himself over time: a "social
media bible" for a future employee. The website half of the same sentence is already SCL-3 ("slowly build a
website", which is exactly the report's month-1 foundation step).

★ WHY THIS IS NOT SCL-7. SCL-7 is the HANDOFF MECHANICS - what gets filmed, where it lands, who edits and
posts, and how fast. This is the STANDARDS: what a non-owner is allowed to say on the business's behalf when
the owner is not in the room. Those are different artefacts and they fail differently. A bad handoff means
nothing gets posted; a missing bible means something gets posted or promised that the business has to honour.

★ WHAT IT HAS TO CONTAIN, AND ALL OF IT ALREADY EXISTS SOMEWHERE IN THIS REPO:

  (a) VOICE - conversational Singapore English, short paragraphs, no corporate vocabulary (no "leverage",
      "optimal performance", "cutting-edge", "enterprise-grade"). State the facts and let the numbers talk.
      From the listing directives.

  (b) CLAIM DISCIPLINE - the three rules the 2026-09-27 audit produced, because each one is a rule a helper
      would break in good faith:
        - never publish a performance figure without its test conditions (LST-12: two listings, same GPU,
          Minecraft 120+ against 200+, and both carry a warranty that turns a number into a claim);
        - never state a capacity figure that disagrees with the parts list (LST-10: "600GB" against 680GB
          of drives, inside one document);
        - never promise the buyer that upgrading later will be cheap, and never mention DDR5 falling -
          it tells them the machine is temporary.

  (c) DISCLOSURE IS THE PRODUCT - the IO shield, the 80% SSD health, the minimal dust. The scaling report's
      own thesis is that documented testing plus a real warranty is the moat; the disclosures are what make
      the testing believable. A helper who tidies those away is destroying the differentiator, not
      protecting the sale.

  (d) WHAT A HELPER MAY NEVER COMMIT THE BUSINESS TO. These are owner-only:
        - warranty terms and periods, and anything about shipping damage. The live listings currently
          promise "damage caused by shipping" cover while the delivery option offered is untracked and
          excluded by the platform (LST-11) - the exact clause a helpful reply would extend further;
        - buyback or trade-in prices (LST-14: there was no rule at all before 2026-09-27);
        - any price move. Measured 2026-09-27, the five unsold PCs hold S$99.50 of margin between them,
          8.3% of the parts cost - one improvised discount erases it, and two erase the sale.

  (e) THE LEGAL CONSTRAINTS A HELPER MUST NOT BREACH - no soliciting, no door-to-door or estate flyering
      (SCL-2: illegal under HBBS and Town Council by-laws), no publishing a physical address (SCL-3), and
      no employees who do not live in the flat (SCL-8).

  (f) ESCALATION - which questions stop and go to the owner. The test is simple: anything that creates an
      obligation beyond the machine in front of the buyer.

⚠ SEQUENCING. (a) to (c) are safe to write now. (e) depends on SCL-1 - if hands-on repair turns out to sit
outside HBBS, the constraint set changes and a bible written against the current model would document the
wrong thing. Write the voice and claims half first.

ACCEPTANCE: a new helper can answer a Carousell enquiry and post a video without asking the owner, and
cannot commit the business to anything the owner has not already agreed.`;

(async () => {
  const pool = await getPool();

  const ed = await pool.request().input('n', EDICT_NAME).query(`SELECT id FROM Edicts WHERE name = @n`);
  if (!ed.recordset.length) throw new Error(`edict "${EDICT_NAME}" not found — run the listing/scaling set first`);
  const edictId = ed.recordset[0].id;

  const done = await pool.request().input('m', `%${MARK}%`)
    .query(`SELECT COUNT(*) AS n FROM Tasks WHERE info LIKE @m`);
  if (Number(done.recordset[0].n)) {
    console.log(`⚠ marker already present (${done.recordset[0].n} row) — nothing to do.`);
    await pool.close();
    return;
  }

  const s = await pool.request().input('e', edictId)
    .query(`SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks WHERE edictId = @e`);
  const sortOrder = Number(s.recordset[0].m) + 1;

  console.log(`edict ${edictId} ("${EDICT_NAME}") — would write:\n`);
  console.log(`  [${sortOrder}] ${NAME}`);
  console.log(`  state ${OPEN} (open) · priority ${PRIORITY} · info ${INFO.length} chars\n`);

  if (!YES) { console.log('DRY RUN — pass --yes to write. No DB write performed.'); await pool.close(); return; }

  const ins = await pool.request()
    .input('name', NAME).input('info', INFO)
    .input('plannedStart', new Date())   // JS Date -> UTC wall-clock, so active computes to 1
    .input('sortOrder', sortOrder).input('edictId', edictId)
    .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
            OUTPUT INSERTED.id AS id
            VALUES (@name, @info, @plannedStart, ${PRIORITY}, ${OPEN}, @edictId, @sortOrder, SYSUTCDATETIME())`);
  const id = ins.recordset[0].id;

  const back = await pool.request().query(
    `SELECT id, sortOrder, state, active, LEN(CAST(info AS nvarchar(max))) AS info_len, name FROM Tasks WHERE id = ${Number(id)}`);
  const r = back.recordset[0];
  console.log(`\n✔ created #${r.id} sort=${r.sortOrder} state=${r.state} active=${r.active} info=${r.info_len}`);
  console.log(`  ${r.name}`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
