// scripts/record-2026-09-28-health-epoch-and-basis.js
//   · appends the F20/self-health epoch fix to the row that owns it  (--append=<id>)
//   · creates two new rows: the backtest name space, and the decision-basis template decision
// Dry by default:
//   node scripts/record-2026-09-28-health-epoch-and-basis.js            # discover + preview
//   node scripts/record-2026-09-28-health-epoch-and-basis.js --yes --append=1445
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const APPEND_ID = Number((process.argv.find((a) => a.startsWith('--append=')) || '').split('=')[1]) || null;
const MARK = '##2026-09-28 health-era-standing##';
const MARK_BKT = '##2026-09-28 backtest-namespace##';
const MARK_BAS = '##2026-09-28 basis-template##';

const APPEND = `

${MARK}
★★★ **THE F20 FLOOR CHECK WAS MEASURING TWO ERAS AND LOCKING THE BANNER ON. FIXED, AND THE EXCLUSION IS NOW NAMED.**

**WHAT WAS MEASURED.** \`venueLevelGeometry\` read \`TOP (50)\` level-bearing trades with **no date filter at all**:

    the 50 rows it read:  23 opened BEFORE the stop-cap boundary, 27 after
    below the 0.75 floor: #1046 only — Oil, opened 2026-09-17T13:26:50Z, realised R:R 0.220

So the ONE row holding \`overall\` at \`bad\` for ten days is a **pre-epoch** row: its \`stopPrice\` is the UNCAPPED
2xATR, and the epoch registry's own words for \`stop-cap\` are that a reward:risk computed from such a row
*"describes a stop the venue never received."* TRD-65 had already had to de-latch the **alert** for this exact
row; the **banner** was left behind, so the desk reported itself degraded on every run.

**THE FIX.** The population is scoped **in the \`WHERE\` clause** (not post-filtered — \`TOP (@limit)\` runs first,
so a JS filter would still read a 46%-pre-epoch window and could let pre-epoch rows crowd a live violation out
of the sample). The boundary is imported **by reference** from \`epoch.js\` (\`stop-cap\`, 2026-09-19), not from
the policy epoch: the cap is what invalidates level geometry, and 09-19/09-20 rows ARE comparable, so using the
later date would throw away evidence for no reason. The pre-epoch rows are **measured by the SAME code** and
reported **by name in every verdict**, including \`ok\`:

    44 PRE-EPOCH row(s) (opened before 2026-09-19) are EXCLUDED from this status and measured the same way:
    1 below the floor — #1046 realised R:R 0.22 against a floor of 0.75

★ **NON-VACUITY PROVEN, AND IT IS ONE CALL AWAY:** \`since: null\` restores the old unfiltered population and
\`#1046\` sets the status back to \`bad\` — 8 tests in \`test/field-levels-epoch.test.js\`, including one that
asserts the defect comes back. The live below-floor branch is **not** demoted, softened or marked standing.

★★★ **AND THE DEEPER FINDING: THREE OF THE FOUR NON-OK CHECKS COULD NEVER REACH \`ok\`, SO THE BANNER WAS
PERMANENTLY ON.** \`overall\` was \`bad ? 'bad' : warn ? 'warn' : 'ok'\` and the banner fires on \`status !== 'ok'\`:

    stops             6 desk-opened rows opened before levels could be recorded  (irreversible)
                      6 mirrored positions the desk never placed                 (unmeasurable, not fixable)
    field_risk_unit   fires whenever the notional cap BINDS — i.e. whenever a deliberate safety limit worked
    field_backtest_ref the name-space row below

**None is clearable by any action, and this file already says why that is the failure: \`stopCoverage\`'s own
comment argues that judging the residue *"would leave this amber forever over rows that cannot be fixed, which
is how a real alert gets tuned out"* — and then returned \`warn\` for exactly that residue.** The two halves
disagreed.

**WHAT SHIPPED.** A check may now declare its non-ok status **STANDING**: documented, irreversible or by design,
clearable by no action. A standing row **stays in \`checks\`** — the card renders it, the logged snapshot keeps
its full text — but it does not set \`overall\` and it does not page. \`bad\` stays \`bad\`; a real offender beside
a standing row still pages, and the test suite pins that adding a genuine offender still changes the alert key.
The snapshot carries the count (\`standing\`), so a reader of the EVENT can tell a clean desk from a muted one.

  · \`stops\` — the historical/mirrored branch is standing. The **live** branch (a desk-opened position with no
    declared risk, opened after the levels epoch) is unchanged and still \`bad\`.
  · \`field_risk_unit\` — split: a gap the cap **explains** (\`cappedAtPct\` present) is standing; a gap it does
    **not** explain is still a warn.
  · \`field_backtest_ref\` — standing (see the name-space row).

★ **VERIFIED:** \`self_health\` now returns **bad=0**, \`field_levels\` at **warn** with 27 post-epoch rows and the
pre-epoch exclusion named. Full suite **1557 tests, 1556 pass, 0 fail, 1 skipped**.

⚠ **WHAT IS NOT DONE, STATED PLAINLY:** the running server still holds the OLD code — **this needs a
\`restart-trading.ps1\` to be live.** And one active warn remains by design: \`field_levels\`'s anchor-drift branch
fires on any observed anchor off the fill by more than \`driftPct\` (0.05 — i.e. **0.05%, half a basis point**),
which is tight enough to fire on most runs; whether that threshold should be a materiality bound or the branch
should be standing is an owner decision, not a code one.
`;

const NAME_BKT = 'TRD-BKT-1: Backtest registry — declare the module/strategy name space so a stored run can be resolved to an enabled strategy';
const INFO_BKT = `${MARK_BKT}
★★★ **THE BACKTEST COVERAGE CHECK COMPARES TWO NAME SPACES AND CALLED THE RESULT "NO RUN AT ALL".**

\`field_backtest_ref\` reported *"enabled strategy(ies) with NO run at all: survgold, survoil, survasilver …"* —
12 of 12. Measured:

    settings.strategies.enabled   12 ids, all \\\`surv*\\\` (configured instances)
    BacktestRuns.strategy         the MODULE names: turtle_ultimate, turtle, meanrev, rsi2, mtftrend, regturtle, macd
    overlap                       0 of 12

The survivors are the forward-validation survivors of that screen (\`survReplicas.SET_A\` **IS**
\`survGold.DEFAULTS\` by reference), so a run behind them is plausible — but a configured INSTANCE and a MODULE
cannot share a name, so the comparison **cannot see one either way**. This is TRD-44 ("strategyId labelled the
same strategy: a different name space") reproduced **inside the contract that exists to catch it**, and the
prose then overstated the measurement from "I cannot see one" to "there is none".

⚠ **I DID NOT RESOLVE IT BY PARAMS, AND THE NEGATIVE RESULT IS THE FIX:** matching on KEY NAMES is worthless
(six of the seven registry names carry the identical key set), and the one comparison completed on **VALUES**
DISAGREES — the sampled \`turtle\` config is \`adxGate=20\` while \`survGold.DEFAULTS\` is \`adxGate=0\`. So on
today's evidence **no stored run carries the survivors' frozen parameter set**, and neither direction is
established.

**WHAT IS NEEDED:** a DECLARED family/param map (strategy id -> the module + parameter set it is an instance of),
derived in ONE place and imported by the check. Until it exists, the check reports the name-space gap and marks
it standing, rather than asserting coverage it cannot see.
`;

const NAME_BAS = 'TRD-BAS-1: Decision basis — one template for a field that currently carries both a machine fact and an LLM sentence';
const INFO_BAS = `${MARK_BAS}
★★★ **\`basis\` IS ONE KEY WITH TWO PRODUCERS, SO IT IS A UNION TYPE READ AS ONE TYPE — AND IT IS NOT ON \`decision\`.**

Raised by the owner: Gold's decision description reads differently from other tickers. Measured — the reason is
**not** per-ticker. There is no shared template at all.

    kind carrying \\\`basis\\\`: shadow_signal 587 | wake 168 | decision 0

★ **FIRST CORRECTION: the decision does not carry its own stated reason.** The two producers have nothing in
common: **strategy code** composes a template literal per strategy (\`macd.js\`, \`mtfTrend.js\`, \`rsi2.js\`,
\`squeezeMeanRev.js\`, \`multiFactor.js\` — six dialects), while **\`shadow.js\` asks the model for
\`"basis":"one short sentence"\`** and \`shadowCall.js\` stores it verbatim. Grouped by opening phrase since the
policy epoch, the phrases are almost all **n=1**, spanning full sentences down to fragments:

    Gold             "Price has broken below the 20-period Donchian lower band while ADX…"
    Silver           "ADX14=23"          <- four characters
    Sinopec          "ADX14=52"
    Silver           "Price fell about 3" <- a truncated number stored as the whole reason

**REPORT WRITTEN, NOTHING IMPLEMENTED:** \`trading/docs/decision-basis-uniformity-2026-09-28.md\` proposes a
structured shape (\\\`schema\\\`, \\\`source\\\`, \\\`claim\\\`, \\\`gate\\\`, \\\`values\\\`, \\\`text\\\`) where \\\`values\\\` is the machine field and
\\\`text\\\` is RENDERED FROM it, so text and numbers cannot disagree.

⚠ **THIS AWAITS AN OWNER DECISION AND THAT IS THE TASK:** if \\\`basis\\\` is ever read programmatically, a template
is a prerequisite (a consumer would otherwise parse English); if it is read by humans only, it is a consistency
improvement. **No backfill is proposed** — the 755 existing rows are free text, and the \\\`schema\\\` field is what
would let a reader tell the eras apart.
`;

async function createRow(pool, { name, info, marker, label }) {
  const mx = await pool.request().query('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks');
  const sortOrder = Number(mx.recordset[0].m) + 1;
  // ⚠ `Tasks.name` is nvarchar(510) = 255 CHARACTERS (max_length is reported in BYTES). Read the limit from the
  // schema and check BEFORE writing: this row's first name was 258 chars and the INSERT was rejected outright.
  const meta = await pool.request().query(`
    SELECT c.max_length, t.name AS typ FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
    WHERE c.object_id = OBJECT_ID('dbo.Tasks') AND c.name = 'name'`);
  const LIMIT = meta.recordset[0].typ === 'nvarchar' ? meta.recordset[0].max_length / 2 : meta.recordset[0].max_length;
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${marker}%'`);
  console.log(`\n[${label}] name ${name.length}/${LIMIT} chars ${name.length <= LIMIT ? 'OK' : '*** TOO LONG ***'} · info ${info.length} chars`);
  console.log(`  ${name}`);
  if (name.length > LIMIT) throw new Error(`refusing to write ${label}: name ${name.length} > ${LIMIT}`);
  if (dup.recordset.length) { console.log(`  already recorded as #${dup.recordset[0].id} — nothing to do.`); return null; }
  if (!YES) { console.log('  DRY RUN — not written.'); return null; }
  const ins = await pool.request()
    .input('name', name).input('info', info).input('plannedStart', new Date()).input('sortOrder', sortOrder)
    .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
            OUTPUT INSERTED.id
            VALUES (@name, @info, @plannedStart, 1, 1, 52, @sortOrder, SYSUTCDATETIME())`);
  console.log(`  ✔ created as #${ins.recordset[0].id}`);
  return ins.recordset[0].id;
}

(async () => {
  const pool = await getPool();

  if (!APPEND_ID) {
    console.log('=== candidate rows to append the health record to ===');
    const c = await pool.request().query(`
      SELECT TOP 12 id, state, LEFT(name, 120) AS name
        FROM Tasks
       WHERE name LIKE '%F20%' OR name LIKE '%floor%' OR name LIKE '%self-health%' OR name LIKE '%self health%'
          OR info LIKE '%minRealisedRrPct%' OR info LIKE '%TRD-37%'
       ORDER BY id DESC`);
    if (!c.recordset.length) console.log('  (none found — pass --append=<id> explicitly)');
    for (const r of c.recordset) console.log(`  #${String(r.id).padEnd(6)} state=${r.state}  ${r.name}`);
    console.log('\nno --append given: discovery only.');
  } else {
    const cur = await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${APPEND_ID}`);
    if (!cur.recordset.length) { console.error(`#${APPEND_ID} not found`); await pool.close(); process.exit(1); }
    const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%'`);
    const c = cur.recordset[0];
    console.log(`#${APPEND_ID} state=${c.state} info=${c.len}${dup.recordset.length ? '  [marker present]' : ` -> ${Number(c.len) + APPEND.length}`}`);
    if (!YES) console.log('DRY RUN — pass --yes to write.');
    else if (dup.recordset.length) console.log('marker present — nothing to do.');
    else {
      await pool.request().input('t', APPEND).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${APPEND_ID}`);
      const back = await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${APPEND_ID}`);
      console.log(`✔ #${APPEND_ID} appended -> ${back.recordset[0].len} chars`);
    }
  }

  await createRow(pool, { name: NAME_BKT, info: INFO_BKT, marker: MARK_BKT, label: 'TRD-BKT-1' });
  await createRow(pool, { name: NAME_BAS, info: INFO_BAS, marker: MARK_BAS, label: 'TRD-BAS-1' });

  const s = await pool.request().query('SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = 52 GROUP BY state');
  console.log('\nedict 52 by state: ' + s.recordset.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
