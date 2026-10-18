// scripts/record-2026-09-28-dead-overrides-corrected.js — records the dead-override removal ACCURATELY.
//
// The removal's own gate refused to call it a no-op, and it was right: 2 of 154 (strategy, symbol) pairs changed
// their RESOLVED value even though every removed pair was unreachable for trading. Those are different claims and
// the record must not conflate them.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const USER = 1;
const ID = 1458;
const MARK = '##2026-09-28 dead-overrides-removed##';

const store = require('../trading/store');
const strategies = require('../trading/agent/strategies');

const REMOVED = {
  'Gold . turtle': { donchianPeriod: 20, adxPeriod: 14, adxGate: 0, atrPeriod: 14, atrStopMultiple: 2, riskPerTradePct: 1 },
  'Oil . turtle': { donchianPeriod: 5, adxPeriod: 14, adxGate: 20, atrPeriod: 14, atrStopMultiple: 2, riskPerTradePct: 1 },
  'Sugar . meanrev': { rsiPeriod: 14, rsiLow: 30, rsiHigh: 70, bbPeriod: 20, bbStd: 2, riskPerTradePct: 0.5 },
  'Arabica Coffee . meanrev': { rsiPeriod: 14, rsiLow: 30, rsiHigh: 70, bbPeriod: 20, bbStd: 2, riskPerTradePct: 0.5 },
  'Bitcoin . rsi2': { rsiPeriod: 2, low: 10, high: 90, smaExitPeriod: 5, riskPerTradePct: 0.5, allowShort: false },
};

const NOTE = (journalId, compared) => `

${MARK}
★ **THE FIVE \`symbolParams\` ENTRIES WERE REMOVED.** Owner, 2026-09-28: *"inert overrides remove? are they even needed?"* **They were not needed.**

WHAT WAS REMOVED — kept here, because this record is now their only copy:
\`\`\`
${JSON.stringify(REMOVED, null, 2)}
\`\`\`

WHY THEY WERE DEAD (measured before touching anything): **0 of the 5 pairs were reachable** — the strategies they
name (\`turtle\`, \`meanrev\`, \`rsi2\`) are in no \`symbolScope\` entry and not in \`strategies.enabled\`, which now holds
the twelve survivor replicas. The script REFUSED to proceed unless that still held.

★ **AND TWO OF THEM DUPLICATED INTENT ALREADY IMPLEMENTED PROPERLY.** \`Gold.turtle.adxGate = 0\` (ADX filter OFF)
is \`survGold.js\` **FROZEN**, imported **by reference** as \`SET_A\` by \`survReplicas.js:41\`; \`Oil.turtle.donchianPeriod
= 5\` (a 4x shorter breakout) is \`survOil.js\` **FROZEN**, imported as \`SET_C\`. The desk promoted those two settings
into first-class frozen strategies, so the overrides were a SECOND expression of the same intent living in a layer
nothing trades.

★★ **THE CLAIM I GOT WRONG, AND HOW IT WAS CAUGHT — THIS IS THE PART WORTH KEEPING.** I expected the removal to be a
NO-OP on the effective layer. **It was not.** Comparing \`paramsFor\` across every (strategy, symbol) pair before and
after — ${compared} pairs — **exactly 2 changed**:
\`\`\`
turtle@Gold:  adxGate 0  -> 20
turtle@Oil:   donchianPeriod 5 -> 20
\`\`\`
⇒ **"UNREACHABLE" AND "INERT" ARE DIFFERENT CLAIMS, and only the first was ever measured.** A pair being unable to
trade says nothing about what the RESOLVER returns for it, and \`paramsFor\` reads \`symbolParams\` regardless of scope.
The reachability gate could never have caught this; the before/after comparison did. The removal script had been
written to REFUSE to describe itself as a no-op if any pair differed, and it refused — which is the only reason this
is recorded honestly instead of as a clean-up that "changed nothing".

★ **AND THE CHANGE IS AN IMPROVEMENT, not a regression.** Those two overrides were a TRAP: had \`turtle\` ever been
scoped to Gold, it would have silently inherited a SURVIVOR's ADX setting (\`adxGate: 0\`) and a survivor's breakout
window — settings belonging to \`survgold\`/\`survoil\`, adopted by a different strategy, without anyone deciding it.
\`turtle\` now resolves to its OWN defaults (\`adxGate 20\`, \`donchianPeriod 20\`), which is what a strategy that is not
a survivor should carry. Nothing traded on either value: the only change in reachable behaviour is none.

★ **THE WRITE WENT THROUGH \`store.saveSettings\`, SO THE JOURNAL RECORDED IT — the second item of the approved
order, and the reason this was done second and not first.** TRD-RSK-8 exists because a live risk setting moved at
2026-09-28T06:51:16Z with nothing recording it. Removing these first would have added five more unattributable
changes to that list. Latest \`settings_write\` event: **#${journalId}** — the desk can now say what was removed,
from the event log, without this document.

⚠ **WHAT THIS DOES NOT DO.** \`strategies.params\` (the GLOBAL layer, the layer the tuner WRITES) still carries entries
for \`turtle\`, \`multi\` and \`rsi2\` — also not enabled. Whether those should go is a DIFFERENT question with a
different answer (the tuner writes that layer, so removing it changes what the tuner can propose), and it belongs to
TRD-TUN-2. Flagged rather than silently bundled.

★ **THIS UNBLOCKS TRD-RSK-7 (#1458, per-desk risk profiles).** Its gate was TRD-TUN-2 (#1393), whose note says profile
work "must resolve TRD-TUN-2 first or it writes a THIRD resolver". Both halves are now in place — one resolution with
per-param provenance, and the tuner excluded from writing a layer it cannot make effective — and the per-symbol layer
is now EMPTY, so a profile layer can be added without a second silent source of truth.`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };

  console.log('\n=== 1. the removal actually happened ===');
  const s = await store.getSettings(USER);
  const sp = (s.strategies || {}).symbolParams;
  const n = sp ? Object.keys(sp).length : 0;
  console.log(`  strategies.symbolParams = ${JSON.stringify(sp)} (${n} symbol keys)`);
  if (n !== 0) await fail(`symbolParams still has ${n} keys — the removal did not complete`);

  console.log('\n=== 2. the two changed pairs, confirmed by re-resolving now ===');
  for (const [sym, key, want] of [['Gold', 'adxGate', 20], ['Oil', 'donchianPeriod', 20]]) {
    const v = strategies.paramsFor(s, 'turtle', sym)[key];
    console.log(`  turtle@${sym}.${key} = ${v}  ${String(v) === String(want) ? '✔ matches the recorded claim' : '✘ DOES NOT MATCH'}`);
    if (String(v) !== String(want)) await fail(`turtle@${sym}.${key} is ${v}, not ${want} — the record would be wrong`);
  }
  const pairs = strategies.list(s).length * require('../trading/scopeResolution').watchlistSymbols(s.watchlist).length;
  console.log(`  (${pairs} (strategy, symbol) pairs on the watchlist)`);

  console.log('\n=== 3. did the journal record the removal? (j[0], not j) ===');
  const rows = await q(`SELECT TOP 2 id, createdAt, payload FROM TradingEvents WHERE kind = 'settings_write' ORDER BY id DESC`);
  if (!rows.length) await fail('NO settings_write event — the journal did not fire; do not claim it did');
  for (const r of rows) {
    let p = null; try { p = JSON.parse(r.payload); } catch { p = null; }
    console.log(`  #${r.id} ${r.createdAt.toISOString()} changed=${p && p.changed} truncated=${p && p.truncated}`);
    console.log(`     keys: ${p && p.keys ? p.keys.slice(0, 8).join(', ') : '(unparseable)'}${p && p.keys && p.keys.length > 8 ? ' …' : ''}`);
  }
  const journalId = rows[0].id;

  console.log('\n=== 4. and the global layer is deliberately untouched ===');
  console.log('  strategies.params keys: ' + JSON.stringify(Object.keys((s.strategies || {}).params || {})));
  console.log('  (left for TRD-TUN-2 — removing it changes what the tuner can propose)');

  console.log('\n=== the record ===');
  const dup = await q(`SELECT id FROM Tasks WHERE id = ${ID} AND info LIKE '%${MARK}%'`);
  if (dup.length) { console.log(`  #${ID} marker present — nothing to do.`); await pool.close(); return; }
  const cur = (await q(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`))[0];
  const note = NOTE(journalId, pairs);
  console.log(`  #${ID} state=${cur.state} info=${cur.len} -> ${Number(cur.len) + note.length}`);
  if (!YES) { console.log('  DRY RUN — not written.'); await pool.close(); return; }
  await pool.request().input('t', note).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const b = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`))[0];
  console.log(`  \u2714 #${ID} appended -> ${b.len} chars`);
  const st = await q(`SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = 52 GROUP BY state`);
  console.log('  edict 52 by state: ' + st.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
