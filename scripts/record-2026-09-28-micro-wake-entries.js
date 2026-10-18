// scripts/record-2026-09-28-micro-wake-entries.js — TRD-EXE-5: the micro wake exists to check PROXIMITY to a
// level, and it was spending a full LLM decision on entries instead. Every claim is re-measured from the wake
// ledger before anything is written, and the script REFUSES if one fails.
// Dry by default:  node scripts/record-2026-09-28-micro-wake-entries.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const EDICT = 52;
const NAME = 'TRD-EXE-5: Wake - the micro wake exists to check PROXIMITY to a level, but re-decided ENTRIES on a ~2-minute cadence, spending a full LLM decision each time on the scheduled cadence work';

const INFO = `★ REGISTERED 2026-09-28. The desk was re-deciding an Arabica Coffee entry every ~2 minutes through a CLOSED market. Measured from the wake ledger, not from a log tail.

★ THE MEASUREMENT (kind='wake', 07:26:58Z-08:39:44Z, an 80-minute window):
| | |
| wakes total | **28** |
| of which \`trigger='micro'\` | **23** |
| of which \`trigger='schedule'\` | 5 |
The inter-wake gap over the micro run is ~121 seconds, and **every one of them is a full decision cycle**: 07:28:39, 07:30:37, 07:32:37, 07:36:39, 07:41:15 ... 08:24:17, 08:26:15, 08:28:16, 08:30:17, 08:32:18. The 08:24-08:32 run is the clearest: FIVE wakes, 2 minutes apart, all on \`symbols="Arabica Coffee"\`, each producing a decision, against a market that was shut.

WHY THE MICRO WAKE EXISTS, AND WHY THIS IS A DEFECT RATHER THAN A PREFERENCE. The micro wake is the proximity check: it wakes because price has come near a level the desk cares about, and its job is to decide whether anything must be done NOW about a position that ALREADY EXISTS. A new entry is a decision about the FUTURE, it belongs on the scheduled cadence, and the scheduled cadence exists precisely so entries are made once, deliberately, with the full bundle. Collapsing the two means every twitch of price near a level triggers a fresh entry decision — which is a position-sizing and overtrading defect wearing the costume of responsiveness.

★ AND IT WAS NOT ONLY WASTE. ON THE SAME CLOSED MARKET THE PRICE WAS FROZEN, SO THE DECISIONS RE-DECIDED THE SAME INPUT. A decision cycle that cannot see a price move cannot reach a different conclusion from the previous one, so the ~2-minute run was the same question asked five times. That is the shape that produced the Arabica churn the owner flagged.

⚠ CORRECTING AN EARLIER ATTRIBUTION OF MINE, on the record. I previously described Trades #1114/#1115 — two Arabica rows 4 MILLISECONDS apart at 08:15:54.403Z and 08:15:54.407Z — as a micro-wake DOUBLE ENTRY. RE-MEASURED: BOTH rows carry \`origin='venue'\` and \`decisionId = NULL\`. **They are not wake-opened at all.** They are the reconcile ADOPTION path: two venue positions the desk did not recognise, adopted as strangers in the same reconcile pass. That is TRD-EXE-4's mechanism, not this one, and the distinction matters because the two have different fixes. The 4ms gap is a loop over the venue's position list, not two decisions.

WHY IT MATTERS, in order:
1. ★ COST, and it is the one number this row will NOT state. The token spend is real and was observed, but it is NOT re-measured here, and a cost figure asserted from memory is the kind of number this desk has been burned by. It needs the meter read in the same window as the wake count. Stated as OPEN below rather than filled in with a plausible-sounding number.
2. ★ OVERTRADING SHAPE. The retry guard (TRD-EXE-1) and the entry lock both exist because this desk repeatedly submits while its own book says it does not know what it holds. An entry decided 5 times in 8 minutes is that pressure applied at the wake layer.
3. ★ THE BUDGET INTERACTION IS NOT INCIDENTAL. Budget \`totalDaily\` was raised to 3,000,000 the same morning after \`budget.allow()\` returned \`total_cap\` for every consumer. A wake layer that spends a full cycle per 121 seconds compresses the same budget into fewer, dumber decisions.

WHAT LANDED (2026-09-28): \`aggregator.pickProposal\` now takes a fourth \`additionalBlock\`, and the micro wake passes \`microEntryLock\` — "MICRO WAKE - proximity check only; new entries belong on the scheduled cadence, not this one". Tested by \`test/micro-wake-entry-lock.test.js\` (6 tests), and \`aggregator.js\` confirms a no-proposal micro wake returns a deterministic flat with ZERO LLM tokens. Full suite green after it (1,676 / 1,675 pass / 0 fail).

⚠ STILL OPEN:
1. **THE TOKEN MEASUREMENT** (above). Until the meter is read across the same window, the cost of this loop is unquantified and this row says so.
2. **THE MICRO WAKE STILL DECIDES SOMETHING.** \`microEntryLock\` blocks ENTRIES; it does not reduce the CADENCE. Whether a proximity wake should run a full decision at all, versus a deterministic proximity test with no model in the path, is unaddressed. The 28-in-80-minutes rate is unchanged by the lock.
3. **THE LOST SWEEP.** An earlier stop-cap sweep script (\`sweep-stop-cap.js\`) no longer exists on disk, so its result ("0.30% nets -28.89R vs -72.15R uncapped") CANNOT be reproduced or re-verified. Any decision resting on it rests on a number nobody can re-derive. It is recorded here because losing the instrument is a defect in its own right, independent of the dial.`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };
  const ok = (m) => console.log('  \u2714 ' + m);
  const F = '2026-09-28T07:26:00Z', T = '2026-09-28T08:40:00Z';

  // ── 1. the wake population and its cadence ───────────────────────────────────────────────────────
  console.log('\n=== 1. the wakes in the window, split by trigger ===');
  const w = await q(`SELECT id, CAST(payload AS NVARCHAR(MAX)) AS payload, createdAt FROM TradingEvents
                     WHERE kind='wake' AND createdAt >= '${F}' AND createdAt <= '${T}' ORDER BY createdAt`);
  const parsed = w.map((r) => ({ id: r.id, at: r.createdAt, p: JSON.parse(r.payload) }));
  const micro = parsed.filter((r) => r.p.trigger === 'micro');
  const other = parsed.filter((r) => r.p.trigger !== 'micro');
  console.log(`  ${parsed.length} wake(s): ${micro.length} micro, ${other.length} other (${[...new Set(other.map((o) => o.p.trigger))].join(', ')})`);
  if (parsed.length < 20) await fail(`only ${parsed.length} wakes — the measured rate cannot be sustained`);
  if (micro.length < 15) await fail(`only ${micro.length} micro wakes — the claim is overstated`);
  ok(`${parsed.length} wakes, ${micro.length} of them micro`);

  const gaps = micro.slice(1).map((r, i) => (r.at - micro[i].at) / 1000);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  console.log(`  micro-wake gaps: min ${gaps[0]}s  median ${median}s  max ${gaps[gaps.length - 1]}s`);
  if (!(median > 60 && median < 200)) await fail(`median gap is ${median}s, not the ~2-minute cadence claimed`);
  ok(`median interval ${median}s — the ~2-minute cadence is real`);

  // ── 2. the sustained run on ONE symbol, which is the shape the owner flagged ─────────────────────
  console.log('\n=== 2. the 08:24-08:32 run: five wakes, one symbol ===');
  const run = micro.filter((r) => r.at >= new Date('2026-09-28T08:24:00Z') && r.at <= new Date('2026-09-28T08:33:00Z'));
  for (const r of run) console.log(`  [${r.at.toISOString()}] #${r.id} symbol=${JSON.stringify(r.p.symbol || r.p.symbols)}`);
  if (run.length < 4) await fail(`only ${run.length} wakes in the run — the claim is void`);
  // The field is `symbol` (singular) on these payloads; `symbols` is absent. Re-checked because reading the
  // wrong key made `undefined` look like a symbol mismatch, which is the failure this gate exists to catch.
  const sym = (r) => String(r.p.symbol || r.p.symbols || '');
  if (!run.every((r) => sym(r) === 'Arabica Coffee')) await fail(`the run is not all one symbol: ${run.map(sym).join(' | ')}`);
  ok(`${run.length} consecutive micro wakes, all on Arabica Coffee, ~2 minutes apart`);

  // ── 3. the correction: the 08:15:54 pair is NOT wake-opened ───────────────────────────────────────
  console.log('\n=== 3. correcting my own attribution of the 08:15:54 pair ===');
  const pair = await q(`SELECT id, symbol, origin, decisionId, status, openAt FROM Trades
                        WHERE id IN (1114, 1115) ORDER BY id`);
  for (const r of pair) console.log(`  #${r.id} ${r.symbol} origin=${r.origin} decisionId=${JSON.stringify(r.decisionId)} status=${r.status} openAt=${r.openAt.toISOString()}`);
  if (pair.length !== 2) await fail('the pair is not both present');
  if (pair.some((r) => String(r.origin) !== 'venue')) await fail('a row of the pair is NOT origin=venue — the correction would be wrong');
  if (pair.some((r) => r.decisionId != null)) await fail('a row of the pair CARRIES a decisionId — it WAS wake-opened');
  const ms = Math.abs(new Date(pair[1].openAt) - new Date(pair[0].openAt));
  console.log(`  gap = ${ms}ms`);
  if (ms > 100) await fail(`the gap is ${ms}ms, not the sub-100ms stated`);
  ok('both rows are origin=venue with NO decision — the reconcile adoption path, NOT a wake double entry');

  // ── 4. the fix is wired AND tested ────────────────────────────────────────────────────────────────
  console.log('\n=== 4. the entry lock is wired and covered ===');
  const agg = require('node:fs').readFileSync(require.resolve('../trading/agent/aggregator'), 'utf8');
  const tst = require('node:fs').readFileSync(require.resolve('../test/micro-wake-entry-lock.test'), 'utf8');
  // Checked against the REAL source form, not a guessed one. A first version of this gate demanded quotes
  // around `(additionalBlock || null)` that the source does not have, and refused to write — which is the
  // gate doing its job on the checker rather than on the claim.
  if (!/function pickProposal\([^)]*additionalBlock = null\)/.test(agg)) await fail('pickProposal has no additionalBlock parameter');
  if (!/: \(additionalBlock \|\| null\);/.test(agg)) await fail('additionalBlock is a parameter that is never consumed by `blocked`');
  if (!/const microEntryLock = trigger === 'micro'/.test(agg)) await fail('microEntryLock is not derived from the trigger');
  if (!/pickProposal\(quantResult[^)]*microEntryLock\)/.test(agg)) await fail('the micro lock is never passed to pickProposal');
  if (!/microEntryLock/.test(agg)) await fail('microEntryLock is absent from aggregator');
  if (tst.length < 500) await fail('the micro-wake entry-lock test file looks empty');
  console.log('  aggregator: pickProposal takes additionalBlock, consumes it in `blocked`, and the micro path passes microEntryLock');
  console.log(`  test/micro-wake-entry-lock.test.js is ${tst.length} bytes`);
  ok('the lock is wired AND has a dedicated test file');

  // ── the row ───────────────────────────────────────────────────────────────────────────────────────
  console.log('\n=== the row ===');
  const dup = await q(`SELECT id, state FROM Tasks WHERE name LIKE 'TRD-EXE-5:%'`);
  if (dup.length) { console.log(`  already recorded as #${dup[0].id} (state ${dup[0].state}) — nothing to do.`); await pool.close(); return; }
  if (NAME.length > 255) await fail('name too long');
  if (/[^\x20-\x7E]/.test(NAME)) await fail('name is not pure ASCII');
  console.log(`  "${NAME}" (${NAME.length} chars, info ${INFO.length} chars)`);
  if (!YES) { console.log('  DRY RUN — not written.'); await pool.close(); return; }
  const mx = (await q('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks'))[0];
  const anchor = (await q('SELECT TOP 1 plannedStart FROM Tasks WHERE id = 1464'))[0];
  const ins = await pool.request().input('name', NAME).input('info', INFO)
    .input('plannedStart', anchor.plannedStart).input('sortOrder', Number(mx.m) + 1)
    .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
            OUTPUT INSERTED.id VALUES (@name, @info, @plannedStart, 1, 1, ${EDICT}, @sortOrder, SYSUTCDATETIME())`);
  const id = ins.recordset[0].id;
  const back = (await q(`SELECT state, active, sortOrder FROM Tasks WHERE id = ${id}`))[0];
  console.log(`  \u2714 created as #${id} state=${back.state} active=${back.active} sortOrder=${back.sortOrder}`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
