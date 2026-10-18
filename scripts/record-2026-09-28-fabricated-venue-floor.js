// scripts/record-2026-09-28-fabricated-venue-floor.js
//   · turns risk.acceptVenueFloor back OFF (safer: the floor it satisfies has no venue provenance)
//   · creates TRD-EXE-2 — the venue minimum is captured from THIRD-PARTY pages, and the venue disproves one of them
// Dry by default:  node scripts/record-2026-09-28-fabricated-venue-floor.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');
const store = require('../trading/store');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-28 fabricated-venue-floor##';

const NAME = 'TRD-EXE-2: Instrument registry - every "venue minimum" comes from a THIRD-PARTY page, the prompt calls it the venue own sidebar, and the venue disproves one';

const INFO = `${MARK}
FOUND 2026-09-28, chasing the owner's question "the arabica coffee placed, placed on ORDERS". That led to the SGX
clamp firing, which led to \`Trades #1106\` being accepted at 10 Shares — **while the desk's registry says SGX's
minimum is 20 Shares.**

★★★ **THE MEASUREMENT: NOT ONE MINIMUM WAS READ FROM THE VENUE.** Every \`Instruments\` row's \`sourceUrl\`:

    source host    rows   distinct symbols        what it is
    yahoo           13    13                       finance.yahoo.com/quote/<ticker>       (all HK/SG equities, incl. SGX)
    other           27     7                       cmegroup.com · theice.com · bloomberg.com · bitadata.com
    plus500          1     1                       <-- ONE row, out of 41

    SGX              min 20 Shares       https://finance.yahoo.com/quote/S68.SI
    Gold             min 0.025 Troy Oz   https://www.bloomberg.com/quote/XAU:CUR
    Oil              min 2.5 Barrels     https://www.cmegroup.com/trading/energy/crude-oil/...
    Sugar            min 15 Contracts     https://www.theice.com/products/23/Sugar-No-11-Futures/data
    Bitcoin          min 0.001 Contracts  https://www.bitadata.com/pages/plus500/BTC

★★ **AND \`venueName\` DOES NOT NAME A VENUE — IT REPEATS THE SYMBOL.** \`venueName: "SGX"\`, \`"Gold"\`, \`"Oil"\`,
\`"Arabica Coffee"\`. So the row READS as the venue's own metadata while the actual source column points at Yahoo,
Bloomberg, CME and ICE product pages.

★★★ **THE VENUE DISPROVES IT DIRECTLY.** At 2026-09-28T05:14:34Z the desk submitted **SGX buy, size 10 Shares** and
the venue **FILLED it** (\`order_attempt #105118 ok=true\`; \`Trades #1106\`, \`plus500PositionId 1888436082\`).
**The venue accepts 10; the registry asserts 20.** One accepted order is one proof; the true floor is unknown
(≤10), and NOTHING in this repo has ever read it.

**WHAT THIS INVALIDATES — stated so nothing downstream keeps resting on it:**
  1. the **18 \`venue_minimum\` refusals**, all SGX, all in 2h24m — they refused on a Yahoo number;
  2. \`TRD-RSK-4\` (#1453)'s premise that SGX's floor forces **2.34x** the risk cap — the 2.34x is
     \`20 x 0.3390 / equity\`, and the \`20\` is Yahoo's;
  3. **\`risk.acceptVenueFloor\`, the clamp I added TODAY** — it exists to satisfy a floor with no venue
     provenance, so it was RAISED RISK ON A FABRICATED NUMBER. **Turned back OFF as part of this row** (see below);
  4. **A FALSE PROVENANCE CLAIM PRINTED INTO EVERY CHAIR PROMPT.** \`costFactLines\` renders the section header
     *"--- VENUE COST OF CARRY (per instrument, read from the venue's own Info sidebar) ---"* and each line begins
     \`min size N <unit>\`. **The chair is told these are the venue's own facts.** They are third-party index
     values. Every seat, every wake, since the section was added.
  5. \`instruments.js\`'s header describes the floor as *"the venue's minimum tradable unit"* and
     \`checkSize\` VETOES a trade on it. A veto sourced from a page that cannot know the answer.

★ **THIS IS TRD-45's SUBJECT AND TRD-45 IS STILL OPEN** (#1287: *"the venue universe with contract metadata
(lot/min/step/leverage/spread)"*). Its own finding — \`lotSize|minTrade|contractSize|leverage\` return NOTHING
repo-wide — is the same gap. So the registry was populated from whatever page carried a number, and the desk has
been enforcing it as the venue's since 2026-09-14. **No task recorded the provenance, so nothing could catch it.**

**IMMEDIATE STATE CHANGE MADE WITH THIS ROW:** \`risk.acceptVenueFloor\` set back to **false** (re-read to confirm).
Rationale: between "refuse SGX on a fabricated 20-share floor" and "size SGX at 2.34x the risk cap to satisfy a
fabricated 20-share floor", **the second is the one that moves real risk.** Neither is correct; refusing is inert,
clamping is not. The refund of SGX to normal sizing needs the floor to stop being enforced, which is acceptance 1.

ACCEPTANCE
  1. **A FLOOR IS ONLY ENFORCED WHEN ITS PROVENANCE IS THE VENUE.** \`checkSize\`/\`floorVerdict\` already returns the
     resolved row, so the check is available: a \`sourceUrl\` that is not the venue's own page must fall through to
     the EXISTING \`venue_minimum_unknown\` path (allow + report), which the module already defines and already
     treats as *"recorded and distinguishable from 'we checked'"*. This is a small change and it uses a path that
     exists — do not invent a new state;
  2. the bundle's provenance line must stop claiming the venue's sidebar until the data earns it — **a sentence the
     chair reads is a claim, and this one is false**;
  3. every registry row's provenance recorded (source host + capture date + the venue's own URL once one exists),
     so "is this the venue's number" is answerable from the row;
  4. TRD-45's Phase 0 is the real fix and is unchanged: read the venue's own Info tab. Until then the desk has no
     venue minimum for any instrument, and should say so rather than assert one.
NON-GOALS: do not "correct" SGX to 10. **One accepted order bounds the floor from above; it does not establish it.**
Writing 10 would repeat the original error with a better-sourced number.
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

const RSK4 = `

##2026-09-28 rsk4-superseded-by-provenance##
⚠ **THE 2.34x IN THIS ROW RESTS ON A NUMBER WITH NO VENUE PROVENANCE — see TRD-EXE-2.** The floor was
\`20 Shares x 0.3390 / equity\` and the \`20\` came from **finance.yahoo.com/quote/S68.SI**, not from Plus500.
At 05:14:34Z the venue **filled SGX buy at 10 Shares**, so the 20 is wrong. \`risk.acceptVenueFloor\` has been set
back to **false**, because the only thing it was doing was raising risk to satisfy a fabricated floor.
⇒ **The dial analysis in this row is unaffected** (cost/R has no size term) — but the SGX eligibility conclusion
is void until the floor has a venue source.
`;

(async () => {
  const pool = await getPool();

  const meta = (await pool.request().query(`
    SELECT c.max_length, t.name AS typ FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
    WHERE c.object_id = OBJECT_ID('dbo.Tasks') AND c.name = 'name'`)).recordset[0];
  const LIMIT = meta.typ === 'nvarchar' ? meta.max_length / 2 : meta.max_length;
  console.log(`Tasks.name limit ${LIMIT}; candidate ${NAME.length} ${NAME.length <= LIMIT ? 'OK' : '*** TOO LONG ***'}; info ${INFO.length}`);
  if (NAME.length > LIMIT || [...NAME].some((c) => c.charCodeAt(0) > 126)) { console.error('refusing to write'); await pool.close(); process.exit(1); }

  // ── GATE: the claim this note makes must be true before it is written ─────────────────────────────
  console.log('\n=== verify the provenance claim ===');
  const prov = (await pool.request().query(`SELECT
      SUM(CASE WHEN sourceUrl LIKE '%plus500%' THEN 1 ELSE 0 END) AS plus500Rows,
      COUNT(*) AS total FROM Instruments WHERE userId=1`)).recordset[0];
  console.log(`  Instruments rows: ${prov.total}; whose sourceUrl names plus500: ${prov.plus500Rows}`);
  if (Number(prov.plus500Rows) !== 1) { console.error('  refusing to write: the note claims exactly ONE plus500-sourced row'); await pool.close(); process.exit(1); }

  console.log('\n=== verify the venue ACCEPTED a below-floor size ===');
  const t = (await pool.request().query(`SELECT id, size, openPrice, status FROM Trades WHERE id=1106`)).recordset[0];
  console.log(`  Trades #${t.id} SGX size=${t.size} filled at ${t.openPrice} (registry floor says 20)`);
  if (Number(t.size) >= 20) { console.error('  refusing to write: #1106 is not below the asserted floor'); await pool.close(); process.exit(1); }

  // ── 1. set the clamp back OFF ────────────────────────────────────────────────────────────────────
  console.log('\n=== set risk.acceptVenueFloor = false ===');
  const before = (await pool.request().query(`SELECT TOP 1 JSON_VALUE(settings,'$.risk.acceptVenueFloor') AS v FROM TradingSettings ORDER BY userId`)).recordset[0];
  console.log(`  before: ${JSON.stringify(before.v)}`);
  if (!YES) console.log('  DRY RUN — not written.');
  else {
    await store.saveSettings(1, { risk: { acceptVenueFloor: false } });
    const back = (await pool.request().query(`SELECT TOP 1 JSON_VALUE(settings,'$.risk.acceptVenueFloor') AS v FROM TradingSettings ORDER BY userId`)).recordset[0];
    console.log(`  after : ${JSON.stringify(back.v)}  ${String(back.v) === 'false' ? 'HELD' : '*** DID NOT HOLD ***'}`);
    if (String(back.v) !== 'false') { console.error('refusing to continue'); await pool.close(); process.exit(1); }
  }

  // ── 2. the records ───────────────────────────────────────────────────────────────────────────────
  console.log('\n=== records ===');
  const dup = (await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%' OR name LIKE 'TRD-EXE-2:%'`)).recordset;
  if (dup.length) console.log(`  [TRD-EXE-2] already recorded as #${dup[0].id} — nothing to do.`);
  else if (!YES) console.log('  [TRD-EXE-2] DRY RUN — not written.');
  else {
    const mx = (await pool.request().query('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks')).recordset;
    const anchor = (await pool.request().query('SELECT TOP 1 plannedStart FROM Tasks WHERE id = 1448')).recordset[0];
    const ins = await pool.request()
      .input('name', NAME).input('info', INFO).input('plannedStart', anchor.plannedStart).input('sortOrder', Number(mx[0].m) + 1)
      .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
              OUTPUT INSERTED.id VALUES (@name, @info, @plannedStart, 1, 1, 52, @sortOrder, SYSUTCDATETIME())`);
    const id = ins.recordset[0].id;
    const b = (await pool.request().query(`SELECT state, active, sortOrder FROM Tasks WHERE id=${id}`)).recordset[0];
    console.log(`  ✔ [TRD-EXE-2] created as #${id} state=${b.state} active=${b.active} sortOrder=${b.sortOrder}`);
  }
  await append(pool, 1453, RSK4, '##2026-09-28 rsk4-superseded-by-provenance##', 'TRD-RSK-4');
  await append(pool, 1287, RSK4.replace('##2026-09-28 rsk4-superseded-by-provenance##', '##2026-09-28 trd45-provenance##'), '##2026-09-28 trd45-provenance##', 'TRD-45');
  const s = (await pool.request().query('SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = 52 GROUP BY state')).recordset;
  console.log('\nedict 52 by state: ' + s.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
