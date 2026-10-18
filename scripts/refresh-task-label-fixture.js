// scripts/refresh-task-label-fixture.js — regenerate the label test fixture from the LIVE register.
//
// WHY A CAPTURED FILE AND NOT A HAND-WRITTEN ONE. `test/task-labels.test.js` must assert against the ACTUAL
// `Tasks.name` strings, because a fixture re-typed from the code's belief CANNOT FAIL — the standing lesson
// (and the same trap that hid the shadow-scorer defect for a week). But the unit suite must not need a
// database. So the register is captured once into `test/fixtures/task-labels.register.json`, and the test
// reads that. Re-run this whenever the register changes materially; the `capturedAt` field records when.
//
// Usage (from the repo root):  node scripts/refresh-task-label-fixture.js [--yes]
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { getPool } = require('../shared/db');
const { labelOf, repeats } = require('../shared/taskLabels');

const OUT = path.join(__dirname, '..', 'test', 'fixtures', 'task-labels.register.json');

(async () => {
  const pool = await getPool();
  const r = await pool.request().query(`
    SELECT id, edictId, name, state FROM Tasks WHERE name IS NOT NULL ORDER BY id
  `);

  const rows = r.recordset.map((t) => ({ id: t.id, edictId: t.edictId, name: t.name, state: t.state }));
  const labelled = rows.filter((t) => labelOf(t.name));
  const reps = repeats(rows).map((x) => ({
    label: x.label,
    count: x.rows.length,
    ids: x.rows.map((y) => y.id),
    states: x.rows.reduce((m, y) => (m[y.state] = (m[y.state] || 0) + 1, m), {}),
  }));

  const payload = {
    capturedAt: new Date().toISOString(),
    note: 'Captured from dbo.Tasks by scripts/refresh-task-label-fixture.js. Real strings, deliberately: a '
      + 're-typed fixture cannot fail. Regenerate when the register changes materially.',
    total: rows.length,
    labelled: labelled.length,
    unlabelled: rows.length - labelled.length,
    repeats: reps,
    rows,
  };

  console.log(`rows ${rows.length}  labelled ${labelled.length}  unlabelled ${rows.length - labelled.length}`);
  console.log(`repeats: ${reps.map((x) => `${x.label} x${x.count}`).join(', ')}`);

  if (!process.argv.includes('--yes')) { console.log('\nDRY RUN — pass --yes to write the fixture.'); process.exit(0); }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1), 'utf8');
  console.log(`\nwrote ${OUT} (${fs.statSync(OUT).size} bytes)`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
