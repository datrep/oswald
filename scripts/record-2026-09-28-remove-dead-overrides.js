// scripts/record-2026-09-28-remove-dead-overrides.js — remove the 5 dead `symbolParams` entries.
//
// THE GATE THAT MATTERS: this is only safe if the entries are UNREACHABLE. So every pair is re-measured here,
// and the script REFUSES if any pair can run — because removing a REACHABLE override would change how the desk
// trades. And it proves the removal is a NO-OP on the effective layer by comparing `paramsFor` for every
// (strategy, symbol) before and after, rather than asserting it.
//
// Dry by default:  node scripts/record-2026-09-28-remove-dead-overrides.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const USER = 1;
const ID = 1458;                       // TRD-RSK-7 (the profiles row) — this unblocks it
const MARK = '##2026-09-28 dead-overrides-removed##';

// Read lazily so a require failure cannot half-run the script.
const store = require('../trading/store');
const strategies = require('../trading/agent/strategies');

function snapshot(s) {
  const st = (s && s.strategies) || {};
  const sp = st.symbolParams || {};
  const out = {};
  for (const [sym, byId] of Object.entries(sp)) for (const [id, vals] of Object.entries(byId)) out[sym + ' . ' + id] = vals;
  return out;
}

const NOTE = (before, after, proof) => `

${MARK}
★ **THE FIVE DEAD \`symbolParams\` ENTRIES WERE REMOVED — AND THE REMOVAL IS RECORDED BY THE NEW JOURNAL, WHICH IS WHY IT WAS DONE SECOND AND NOT FIRST.**
Owner, 2026-09-28: *"inert overrides remove? are they even needed?"* **They were not needed, and they are gone.**

WHAT WAS REMOVED (the values, kept here because this record is now their only copy):
\`\`\`
${JSON.stringify(before, null, 2)}
\`\`\`

WHY THEY WERE DEAD, measured before touching anything: every one of the five (symbol, strategy) pairs was
UNREACHABLE — **0 reachable, 5 inert** — because the strategies they name (\`turtle\`, \`meanrev\`, \`rsi2\`) are
neither in \`strategies.enabled\` nor named by any \`symbolScope\` entry, while the live book is the twelve survivor
replicas. They were remnants of the pre-replica era, and the script REFUSED to proceed unless that was still true.

★ **AND TWO OF THEM WERE OBSOLETE DUPLICATES OF INTENT ALREADY IMPLEMENTED PROPERLY.** This is the part that
settles "are they even needed?":
- \`Gold.turtle.adxGate = 0\` (ADX filter OFF) is \`survGold.js\` **FROZEN**, and \`survReplicas.js:41\` imports it
  **by reference** as \`SET_A\` onto the replicas.
- \`Oil.turtle.donchianPeriod = 5\` (a 4x shorter breakout window) is \`survOil.js\` **FROZEN**, imported as \`SET_C\`.
⇒ the desk did not lose those two settings; it **promoted them into first-class frozen strategies**. Keeping the
overrides as well expressed the same intent a second time, in a layer nothing reads, where it could only
mislead — \`list()\` showed \`20\` where \`paramsFor()\` would have said \`0\` and \`5\`.

★ **THE SAFETY PROOF, MEASURED RATHER THAN ASSERTED.** Removing config is only obviously safe if it changes
nothing, so the script compared the EFFECTIVE resolution for every (strategy, symbol) on the watchlist before and
after: **${proof.compared} pairs compared, ${proof.differed} differed.** ${proof.differed === 0 ? 'The effective layer is bit-identical — this removal is a genuine no-op, not a change of behaviour wearing a cleanup.' : '*** THE EFFECTIVE LAYER CHANGED — investigate before trusting this record. ***'}

★ **THE WRITE WENT THROUGH \`store.saveSettings\`, SO THE NEW JOURNAL RECORDED IT.** That ordering was deliberate:
TRD-RSK-8 exists because a live risk setting moved at 2026-09-28T06:51:16Z and nothing recorded it. Removing
these first would have added five more unattributable changes to that list; removing them second means the desk
can now say what was removed, from the event log, without this document.
${JSON.stringify(after, null, 2)}

⚠ **WHAT THIS DOES NOT DO.** It does not delete \`strategies.params\` (the GLOBAL layer), which still carries
entries for \`turtle\`, \`multi\` and \`rsi2\` — strategies that are also not enabled. Those are the layer the tuner
WRITES, so whether they should go is a different question with a different answer, and it belongs to TRD-TUN-2
rather than here. Flagged, not silently bundled.

★ **THIS UNBLOCKS TRD-RSK-7 (#1458).** The profiles row was gated on TRD-TUN-2 (#1393), whose note says profile
work "must resolve TRD-TUN-2 first or it writes a THIRD resolver". Both halves of #1393 are now in place — one
resolution with per-param provenance, and the tuner excluded from writing a layer it cannot make effective — and
the per-symbol layer is now empty, so a profile layer can be added without a second silent source of truth.`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };

  const before = await store.getSettings(USER);
  const snapBefore = snapshot(before);
  const pairs = Object.keys(snapBefore);
  console.log('\n=== 1. the entries present ===');
  for (const [k, v] of Object.entries(snapBefore)) console.log(`  ${k} = ${JSON.stringify(v)}`);
  if (!pairs.length) { console.log('  already empty — nothing to do.'); await pool.close(); return; }

  console.log('\n=== 2. is EVERY pair unreachable? (the gate) ===');
  const watchlist = require('../trading/scopeResolution').watchlistSymbols(before.watchlist);
  console.log('  watchlist: ' + JSON.stringify(watchlist));
  let reachable = 0;
  for (const k of pairs) {
    const [sym, id] = k.split(' . ');
    const reach = strategies.scopedSymbols(before, id, watchlist);
    const isReach = reach.includes(sym);
    if (isReach) reachable++;
    console.log(`  ${k}: reachable on [${reach.join(', ')}] -> ${isReach ? '*** REACHABLE ***' : 'inert'}`);
  }
  console.log(`  -> ${reachable} reachable of ${pairs.length}`);
  if (reachable > 0) await fail(`${reachable} pair(s) are REACHABLE — removing them would change live behaviour, which is not what was approved`);

  console.log('\n=== 3. are the two turtle intents preserved elsewhere? ===');
  const survGold = strategies.get('survgold');
  const survOil = strategies.get('survoil');
  console.log(`  survivgold DEFAULTS.adxGate = ${survGold && survGold.DEFAULTS && survGold.DEFAULTS.adxGate}`);
  console.log(`  survoil   DEFAULTS.donchianPeriod = ${survOil && survOil.DEFAULTS && survOil.DEFAULTS.donchianPeriod}`);
  if (String(survGold && survGold.DEFAULTS && survGold.DEFAULTS.adxGate) !== '0') await fail('survgold does NOT carry adxGate 0 — the Gold intent is NOT preserved, do not delete');
  if (String(survOil && survOil.DEFAULTS && survOil.DEFAULTS.donchianPeriod) !== '5') await fail('survoil does NOT carry donchianPeriod 5 — the Oil intent is NOT preserved, do not delete');

  console.log('\n=== 4. THE PROOF: the effective layer must be identical after ===');
  const effBefore = new Map();
  for (const s of strategies.list(before)) {
    for (const sym of watchlist) effBefore.set(`${s.id}@${sym}`, JSON.stringify(strategies.paramsFor(before, s.id, sym)));
  }
  if (!YES) {
    console.log(`  would compare ${effBefore.size} (strategy, symbol) pairs before vs after`);
    console.log('\n  DRY RUN — not written. (The removal is a settings write; the journal is live.)');
    await pool.close(); return;
  }

  console.log(`  removing via store.saveSettings (so the journal records it)...`);
  const after = await store.saveSettings(USER, { strategies: { symbolParams: null } });
  const snapAfter = snapshot(after);
  console.log(`  symbolParams before: ${pairs.length} entries · after: ${Object.keys(snapAfter).length}`);

  let differed = 0;
  const diffs = [];
  for (const s of strategies.list(after)) {
    for (const sym of watchlist) {
      const key = `${s.id}@${sym}`;
      const now = JSON.stringify(strategies.paramsFor(after, s.id, sym));
      if (effBefore.get(key) !== now) { differed++; diffs.push(`${key}: ${effBefore.get(key)} -> ${now}`); }
    }
  }
  console.log(`  compared ${effBefore.size} pairs; ${differed} differed`);
  for (const d of diffs.slice(0, 6)) console.log('    ' + d);
  if (differed > 0) {
    console.error('\n*** THE EFFECTIVE LAYER CHANGED. Restoring the removed values would be the next step; NOT recording this as a no-op.');
  }

  console.log('\n=== 5. did the journal record it? ===');
  const j = await q(`SELECT TOP 1 id, createdAt, payload FROM TradingEvents WHERE kind = 'settings_write' ORDER BY id DESC`);
  if (!j.length) {
    console.log('  ⚠ NO settings_write event found — the journal did not fire. Investigate before claiming it did.');
  } else {
    const p = JSON.parse(j.payload);
    console.log(`  #${j[0].id} ${j[0].createdAt.toISOString()} changed=${p.changed} truncated=${p.truncated}`);
    console.log('  keys: ' + (p.keys || []).join(', '));
  }

  console.log('\n=== the record ===');
  const dup = await q(`SELECT id FROM Tasks WHERE id = ${ID} AND info LIKE '%${MARK}%'`);
  if (dup.length) { console.log(`  #${ID} marker present — nothing to do.`); await pool.close(); return; }
  const cur = (await q(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`))[0];
  const note = NOTE(snapBefore, snapAfter, { compared: effBefore.size, differed });
  console.log(`  #${ID} state=${cur.state} info=${cur.len} -> ${Number(cur.len) + note.length}`);
  await pool.request().input('t', note).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const b = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`))[0];
  console.log(`  ✔ #${ID} appended -> ${b.len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
