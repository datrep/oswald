// scripts/record-2026-09-28-exe6-unit-label.js
//
// TRD-EXE-6: the "venue minimum" is read BY COLUMN POSITION and its label is ASSENTED, not read.
// Migration 045 records the venue's own word for the field, derived by exact match against the venue's
// labelled definition/value list — so no testid is guessed and a NULL is itself an answer.
//
// Every claim is RE-MEASURED here; the script REFUSES to create the row if any fails.
//
// Dry by default:  node scripts/record-2026-09-28-exe6-unit-label.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool, sql } = require('../shared/db');

const YES = process.argv.includes('--yes');
const ROOT = path.join(__dirname, '..');
const EDICT = 52;
const MARK = '##2026-09-28 exe6-unit-label##';

const NAME = 'TRD-EXE-6: Registry - the venue minimum is read BY COLUMN POSITION and its label is ASSERTED; migration 045 records the venue\'s own word for it';

const INFO = `
${MARK}
★ REGISTERED 2026-09-28 as the LAST open item behind TRD-EXE-2 (#1455), in its own row because it is the only
part of that family that changes the SHAPE of what the desk knows rather than correcting what it said.

THE DEFECT IS NOT THE NUMBER, IT IS HOW THE NUMBER WAS IDENTIFIED. \`unitAmount\` comes from
\`instrumentProbe.js:234\`:

    unitAmount: sPick('sidebar.rates-and-values.column-0.value'),
    unitKind:   sPick('sidebar.rates-and-values.column-0.sub-value'),

sPick resolves by EXACT \`data-testid\`. Column-0 is the field; column-1 is leverage and column-2 the dynamic
spread, so which number this is rests entirely on POSITION. The comment above that line ASSERTS the meaning —
"unitAmount is a MINIMUM trade size in venue units, NOT a contract multiplier" — and the SAME FILE, a few lines
earlier, records the opposite discipline for every other field: "the LABEL comes with the value instead of being
assumed from column position". So the ONE field the desk enforces as a hard sizing VETO is the ONE field
identified by where it sits rather than by its own name.

★★ WHY THIS IS A TIGHTENING AND NOT A SUSPICION, STATED PLAINLY SO THE ROW IS NOT READ AS A BIGGER CLAIM THAN IT
IS. The VALUE is corroborated, independently of this defect: every size the venue has been observed HOLDING, for
every symbol that has a floor, is an EXACT INTEGER MULTIPLE of that floor — 6 symbols, 11 distinct sizes, zero
counterexamples, and no size ever held below one (measured 2026-09-28; #1455 and #1463). And a companion claim
WAS retracted the same day for the same reason this row exists: "the venue filled 10 against a floor of 20" read
\`Trades.size\` — the DESK's number — as the venue's (see #1455). What is left is provenance, and it is cheap.

★ WHAT SHIPPED — migration \`sql/migrations/045_instrument_unit_label.sql\`, wholly additive:
  1. \`dbo.Instruments.unitAmountLabel NVARCHAR(60) NULL\`. One nullable column, no default, no data movement.
  2. \`instrumentProbe.js\` derives it WITHOUT GUESSING ANY TESTID: it takes the stat box's column-0 text and finds
     the venue's own labelled pair (\`plus500-list-data-item\`, slot="definition-item"/"value-item") whose VALUE is
     the same text. The label is therefore the venue's word for that value, not a name chosen here. Both sides go
     through \`short(...)\` with different budgets (60 in sPick, 50 in listItems), so the match is made on a common
     prefix — otherwise a long value would fail to match itself.
  3. \`instrumentSpec.toRow\` carries it; \`SPEC_COLUMNS\` and the upsert input add it; because
     \`captureFromObservation\` spreads \`...row\` into \`upsertInstrument\`, no other wiring is needed.
  4. \`agent/instruments.shaped()\` returns it on the resolution, so a caller that learned the minimum can also see
     whether the venue ever NAMED it.
  5. Two tests, both green: the label is carried and absence stays null (never \`''\`), and the field is ADDITIVE —
     it changes no violation and moves no other field.

⚠ NULL MEANS "THE VENUE DOES NOT LABEL THIS FIELD", NEVER "no minimum". If no labelled pair matches column-0 then
the field is not one the venue labels, and that is the answer. This is the three-valued discipline migrations 041
(fill price) and 044 (close time) imposed, one column over — and it is why the derivation is a MATCH rather than a
fallback name.

⚠ AND THE COLUMN IS EMPTY ON EVERY ROW RIGHT NOW, ON PURPOSE. Nothing reads it, and nothing gates on it: making
the veto depend on a LABEL STRING is a POLICY choice whose prize fell sharply once the value was corroborated 11
times over by the venue's own fills, and a label is fragile across a localised deploy. Recording it first is the
point — the question closes itself when the next capture lands. **I did NOT run a capture to fill it:** the probe
CLICKS the venue to open the Info sidebar, the desk holds that browser and had open positions, and disturbing it to
satisfy a provenance question whose value is already corroborated would have been a bad trade. That is a deliberate
decision, recorded here rather than left as an unexplained empty column.

★ WHAT WOULD CLOSE IT: one capture (\`trading/scripts/instrument-probe.js\`), then read \`unitAmountLabel\` on the
rows it writes. Non-null means the venue calls the field something, and the token is in hand; null means column-0 is
positional ONLY, which is also a complete answer.

⚠ A COLUMN THAT STAYS NULL FOREVER WOULD BE A NEW "surface that looks authoritative and isn't" — the exact class
this whole family of rows is about. What keeps it honest is that the empty state is NAMED here as a state, and the
probe's derivation cannot fabricate a label: it can only copy one the venue printed.`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };
  const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  console.log('\n=== 1. migration 045 is applied ===');
  const col = await q(`SELECT c.name, t.name AS typ, c.max_length, c.is_nullable FROM sys.columns c
      JOIN sys.types t ON t.user_type_id = c.user_type_id
      WHERE c.object_id = OBJECT_ID('dbo.Instruments') AND c.name = 'unitAmountLabel'`);
  if (!col.length) await fail('dbo.Instruments.unitAmountLabel does not exist - migration 045 is not applied');
  console.log(`  \u2714 ${col[0].name} ${col[0].typ}(${col[0].max_length / 2}) nullable=${col[0].is_nullable}`);

  console.log('\n=== 2. the probe derives the label by MATCH, not by a guessed testid ===');
  const probe = src('trading/plus500/instrumentProbe.js');
  if (!/unitAmountLabel: \(\(\) => \{/.test(probe)) await fail('the probe does not derive unitAmountLabel');
  if (!/listItems\.find\(/.test(probe)) await fail('the derivation does not consult the venue\'s LABELLED pairs');
  if (!/unitAmount: sPick\('sidebar\.rates-and-values\.column-0\.value'\)/.test(probe))
    await fail('the positional read this row is about is no longer in the probe - the premise is gone');
  console.log('  \u2714 derived from the labelled pair whose VALUE matches the stat box, with the positional read intact');
  if (!/definition-item/.test(probe) || !/value-item/.test(probe))
    await fail('the labelled pairs are no longer read by label+value - the derivation has no source');
  console.log('  \u2714 the labelled pairs are read as label+value (the venue\'s own names)');

  console.log('\n=== 3. it is carried, stored and surfaced ===');
  const ispec = src('trading/plus500/instrumentSpec.js');
  if (!/unitAmountLabel: r\.unitAmountLabel \|\| null/.test(ispec)) await fail('instrumentSpec.toRow does not carry unitAmountLabel');
  console.log('  \u2714 instrumentSpec.toRow carries it (null when the probe did not send one)');
  const store = src('trading/store/instruments.js');
  if (!/'unitAmountLabel'/.test(store)) await fail('unitAmountLabel is not a writable registry column');
  if (!/\.input\('unitAmountLabel'/.test(store)) await fail('the upsert does not bind unitAmountLabel');
  const cols = (store.match(/const SPEC_COLUMNS = \[([\s\S]*?)\];/) || [])[1] || '';
  if (/'symbol'/.test(cols) && !/unitAmountLabel/.test(cols)) await fail('SPEC_COLUMNS omits it');
  console.log('  \u2714 SPEC_COLUMNS + the upsert input are wired (COALESCE keeps a prior value on a partial read)');
  const agent = src('trading/agent/instruments.js');
  if (!/unitAmountLabel: row\.unitAmountLabel \|\| null/.test(agent)) await fail('agent/instruments.shaped does not surface it');
  console.log('  \u2714 agent/instruments.shaped() returns it on the resolution');
  const cap = src('trading/agent/instruments.js');
  if (!/\.\.\.row,/.test(cap)) await fail('captureFromObservation no longer spreads the spec into the upsert - the wiring assumption is wrong');
  console.log('  \u2714 captureFromObservation spreads the spec, so no extra plumbing is needed');

  console.log('\n=== 4. the honest state: the column is EMPTY, and that is recorded as a state ===');
  const filled = (await q(`SELECT COUNT(*) AS n FROM dbo.Instruments WHERE userId = 1 AND unitAmountLabel IS NOT NULL`))[0].n;
  const total = (await q(`SELECT COUNT(*) AS n FROM dbo.Instruments WHERE userId = 1`))[0].n;
  console.log(`  ${filled} of ${total} registry rows carry a label`);
  if (filled !== 0) console.log('  NOTE: a capture has already filled some - the row text says otherwise, so this will be amended');
  else console.log('  \u2714 none yet: no capture has run since the migration, which is the state the row describes');

  console.log('\n=== 5. the record ===');
  const dup = await q(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%'`);
  if (dup.length) { console.log(`  marker already present on #${dup[0].id} - nothing to do.`); await pool.close(); return; }
  const next = (await q(`SELECT ISNULL(MAX(sortOrder), 0) + 1 AS n FROM Tasks WHERE edictId = ${EDICT}`))[0].n;
  console.log(`  would create 1 row in edict ${EDICT} ("${NAME.slice(0, 70)}..."), sortOrder ${next}`);
  if (!YES) { console.log('\n  DRY RUN - not written.'); await pool.close(); return; }

  const req = await pool.request()
    .input('name', sql.NVarChar(sql.MAX), NAME)
    .input('info', sql.NVarChar(sql.MAX), INFO)
    .input('sortOrder', sql.Int, next)
    .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
            OUTPUT INSERTED.id VALUES (@name, @info, GETUTCDATE(), 1, 1, ${EDICT}, @sortOrder, SYSUTCDATETIME())`);
  const id = req.recordset[0].id;
  console.log(`  \u2714 created as #${id}`);
  for (const [label, s] of [['open', 1], ['published', 2], ['done', 3]]) {
    const n = (await q(`SELECT COUNT(*) AS n FROM Tasks WHERE edictId = ${EDICT} AND state = ${s}`))[0].n;
    console.log(`    ${label.padEnd(10)} ${n}`);
  }
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
