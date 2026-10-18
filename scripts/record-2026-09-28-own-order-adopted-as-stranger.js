// scripts/record-2026-09-28-own-order-adopted-as-stranger.js — TRD-EXE-4: the desk adopted ITS OWN queued
// order as a stranger, lost the stop with it, and expired its own submit as FAILED — one position, two
// records. Every claim below is re-measured against the live ledger and the module's own predicates, and the
// script REFUSES to write if any one of them fails.
// Dry by default:  node scripts/record-2026-09-28-own-order-adopted-as-stranger.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const EDICT = 52;
const MARK = '##2026-09-28 own-order-adopted-as-stranger##';
const NAME = 'TRD-EXE-4: Executor - the desk adopts its OWN queued order as a stranger when the venue size is off by more than 2%, losing the stop; then expires the same submit as FAILED';

const INFO = `★ REGISTERED 2026-09-28 while checking a LEAD (three post-epoch trades carry no stopPrice). The lead was real AND the mechanism was worse than a missing field: the desk is silently re-adopting its own positions and discarding the risk it computed for them.

★★ THE INCIDENT, IN FULL, FROM THE LEDGER — ONE POSITION, TWO RECORDS, AND THE STOP ON THE RECORD THAT WAS THROWN AWAY.
| time (Z) | event |
| 07:09:21.913 | \`order_attempt\` #106493 — Sugar **buy 11.9862**, \`stopPrice 18.414\`, \`takeProfitPrice 18.7074\`, \`intent open\` → \`ambiguous\` after 44.6s ("position row did not appear after submit") |
| 07:09:21.913 | \`order_unconfirmed\` #106494 — outcome unknown, awaiting reconcile. Row **Trades #1110**, \`origin agent\`, status \`unconfirmed\`, size 11.9862, stop 18.414 |
| 07:31:10.680 | \`phantom_fill\` #106906 — \`{"symbol":"Sugar","direction":"venue_only"}\` → **Trades #1111** created: size **15**, open 18.58, **stopPrice NULL**, \`origin venue\`, \`strategyId null\`, \`decisionId null\` |
| 07:34:55.300 | \`order_attempt\` #106970 — Sugar **sell size 15** \`intent close\` → \`ok:true\`. #1111 closed at 18.47 for **-2.13** |
| 07:34:55.313 | \`trade_closed\` #106971 — actor **\`system:executor\`** (the DESK closed it), \`closePriceSource 'fill'\` |
| 07:40:36.040 | \`order_unconfirmed_expired\` #107092 — **#1110 concluded FAILED**, "no venue position matched it within the window" |

★★ THE ROOT CAUSE IS ONE CONSTANT PLUS ONE UNCHECKED ASSUMPTION.
1. \`executor.reconcile\` recognises the desk's own queued order with \`matchVenuePosition\`, which is EXACT ON SIZE (\`unconfirmed.SIZE_TOLERANCE_PCT = 2\`).
2. The venue reported **15** against a submitted **11.9862** — **+25.1%**. Re-measured here with the module's own predicate: \`sizeMatches(11.9862, 15) === false\`. So the recovery path that EXISTS returned null, and the branch below it adopted the position as a stranger.
3. \`stopCoverage.isDeskOpened()\` then reads \`origin\` — **a field the adopting branch itself writes** — and concludes "the desk NEVER OPENED this position… structurally unmeasurable, NOT a control failure." The blame field is authored by the suspect path, so the defect certifies itself out of the defect list. That is why this was invisible for weeks, and why the stop-coverage check reads \`warn\`, not \`bad\`.

★ AND IT IS A RECURRENCE, NOT A NOVELTY. \`unconfirmed.js\` already documents the identical chain for Trades 1033/1034 ("the desk then met its own order as a stranger"), and TRD-52 was built to prevent it. The fix works — it recovered other rows — but it fails whenever the venue's size diverges by more than 2%, which is exactly the divergence TRD-EXE-3 measured independently (the venue SNAPS sizes to a minimum increment).

★ THE SAME MECHANISM, AGAIN, FOUR HOURS EARLIER IN THE SAME INSTRUMENT FAMILY. Five Arabica Coffee buys came back \`ambiguous\` (3.4676, 1.7338, 1.734, 1.7341, 1.2076 — sum 9.8771) and all five were expired as failed. At **08:15:54Z** — Arabica's session OPEN, when a queued order fills — reconcile created **#1114 (size 2)** and **#1115 (size 1)** as strangers with no stop. \`#1114\` was then closed BY THE VENUE: \`closeReasonLabel "stop-loss hit at the venue"\`, \`closeFillPrice 276.92\` — against the desk's own submitted stops of **276.974 / 277.3405**. **The venue held the desk's stop; the desk's row said none existed.** So these positions were NOT unbounded at the venue — the risk was UNMEASURED AND UNMANAGEABLE IN THE DESK, which is the sharper and less obvious defect. (Correcting an earlier reading of mine: "unbounded risk" was wrong.)

WHY THIS MATTERS, in descending severity:
1. ★★ THE DESK TRADES POSITIONS IT BELIEVES ARE NOT ITS OWN. 4 of the 5 mirrored rows carry the desk's own close. #1111 and #1115 are closed by \`system:executor\`; #15 and #1034 carry note "executor close". A position the desk closes is a position the desk MANAGED while its risk layer classified it as somebody else's.
2. ★★ THE POSITION REVIEW LOOP CANNOT SEE THEM. In the same window it reviewed #1108/#1112/#1113/#1099 and never #1111/#1115. So the desk's judgement layer was blind to exposure its execution layer was opening and closing.
3. ★ ONE SUBMIT BECOMES TWO ROWS WITH CONTRADICTORY VERDICTS — "failed" for the submit, "open" for the fill — so any count of trades, exposure, or risk taken from \`Trades\` is wrong in both directions at once.
4. ★ THE STOP IS LOST EVEN THOUGH IT EXISTS. The desk computed it, sent it, and the venue honoured it (#1114). Only the desk's own record has none, so no desk-side trailing, re-anchoring, or verification applies to it.

WHAT LANDED (2026-09-28), both halves deliberately conservative:
(a) \`unconfirmed.suspectedOwn(rows, venueItem)\` — reports a venue position in the SAME symbol and direction as an UNRESOLVED submit whose size is outside tolerance, with \`deltaPct\`, \`ratio\` and a symmetric \`beyondRatio\` bound (3x). It is EVIDENCE, NOT OWNERSHIP: widening the tolerance to claim the position would write our \`stopPrice\`/\`decisionId\` onto what might be the owner's manual trade in the same instrument, and attaching our stop to somebody else's exposure is a worse error than the one being fixed.
(b) \`executor.reconcile\` asks BEFORE it adopts and records \`order_adopt_suspect\` (warn) naming the unresolved tradeId, both sizes and the gap — so the assumption is auditable instead of invisible.
(c) \`stopCoverage\` splits the mirrored class: \`mirrored_traded\` (\`origin='venue'\` AND no stop AND \`closePriceSource='fill'\`, i.e. the DESK closed it) is a DEFECT; \`mirrored_unmeasured\` remains the residue for rows with no evidence the desk touched them. Tested on the desk's own close mark rather than the note, because TRD-11's phantom-upgrade path OVERWRITES \`note\`.

⚠ STILL OPEN, AND STATED RATHER THAN IMPLIED:
1. **THE SIZE ARITHMETIC IS NOT EXPLAINED.** 11.9862 sent vs 15 held (+25.1%); 1.2076 sent vs 2 held (+65.6%). Neither equals a single send nor the sum of the ambiguous sends. The entry PRICES corroborate ownership (Sugar 18.58 vs an intended ~18.56; Arabica 278.62 vs an intended ~278.4) but the SIZES do not. A unit-conversion factor was considered and NOT adopted as a claim: 11.9862 / 15 = 0.7991, which is suggestive of 0.8 and is recorded here only as an unverified lead.
2. **OWNERSHIP IS STILL A JUDGEMENT.** (a) surfaces the mismatch; it does not decide it. Whether such a position should be claimed (preserving the stop) or left as a stranger is a RISK DECISION for the owner, and it is the one place here where the safer-looking option is not obviously the safer one.
3. **THE COLUMN TEST UNDER-COUNTS BY DESIGN.** \`closePriceSource='fill'\` only exists on rows closed after the column was populated, so #15 and #1034 are still counted as untouched residue although their notes say "executor close". A rule that is knowably narrow was preferred to one keyed on free text another branch rewrites.
4. **THE STOP-COVERAGE CHECK NOW READS RED AND WILL STAY RED.** #1111/#1115 opened after \`LEVELS_EPOCH\`, so they are live defects by the module's existing rule, and no action can backfill a level on a closed row. NO NEW EPOCH WAS INVENTED TO SILENCE IT — dating the epoch to the moment of my own fix would be exactly the self-serving date this module warns against. The owner should decide the remediation.
5. **TRD-EXE-3 IS THE SAME ROOT AND IS STILL UNFIXED** (snap the size before submitting; record what was FILLED). Fixing it removes the size divergence that defeats the matcher, and this row becomes unreachable rather than merely reported.`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };
  const ok = (m) => console.log('  \u2714 ' + m);

  // ── 1. the two rows of the Sugar incident, from the ledger ───────────────────────────────────────
  console.log('\n=== 1. the incident rows (Trades 1110 vs 1111) ===');
  const t = await q(`SELECT id, symbol, size, openPrice, stopPrice, status, origin, strategyId, decisionId,
                            closePriceSource, plus500PositionId, openAt, closeAt, grossPnl
                     FROM Trades WHERE id IN (1110, 1111, 1115, 1114) ORDER BY id`);
  for (const r of t) {
    console.log(`  #${r.id} ${r.symbol} size=${r.size} stop=${JSON.stringify(r.stopPrice)} status=${r.status} origin=${r.origin} closeSrc=${JSON.stringify(r.closePriceSource)} posId=${r.plus500PositionId}`);
  }
  const T = (id) => t.find((r) => r.id === id);
  if (!T(1110) || !T(1111)) await fail('one of the two incident rows is missing — the claim has no basis');
  if (T(1110).status !== 'failed') await fail(`#1110 status is ${T(1110).status}, not 'failed' — the "expired as failed" claim is void`);
  if (T(1110).stopPrice == null) await fail('#1110 has no stop — the "the stop was lost" claim is void');
  if (T(1111).stopPrice != null) await fail('#1111 HAS a stop — the "adopted with no stop" claim is void');
  if (String(T(1111).origin) !== 'venue') await fail(`#1111 origin is ${T(1111).origin}, not 'venue'`);
  if (T(1111).strategyId != null || T(1111).decisionId != null) await fail('#1111 carries strategy/decision provenance — the "adopted as a stranger" claim is void');
  if (String(T(1111).closePriceSource) !== 'fill') await fail(`#1111 closePriceSource is ${T(1111).closePriceSource}, not 'fill' — the "the DESK closed it" claim is void`);
  ok('#1110 = the submit, with a stop, concluded failed; #1111 = the same position, origin venue, NO stop, closed by the desk');

  // ── 2. the size gap, proved with the module's OWN predicate ──────────────────────────────────────
  console.log('\n=== 2. the matcher, called on the real numbers ===');
  const u = require('../trading/agent/unconfirmed');
  const sent = Number(T(1110).size), held = Number(T(1111).size);
  const matches = u.sizeMatches(sent, held);
  console.log(`  sizeMatches(${sent}, ${held}) = ${matches}    delta = ${(((held - sent) / sent) * 100).toFixed(1)}%   tolerance = ${u.SIZE_TOLERANCE_PCT}%`);
  if (matches) await fail('the module WOULD have matched the pair — the root-cause claim is void');
  const sus = u.suspectedOwn([{ id: 1110, symbol: 'Sugar', direction: 'buy', size: sent }], { name: 'Sugar', direction: 'buy', size: held });
  if (!sus || sus.row.id !== 1110) await fail('suspectedOwn did not report the pair it was written for');
  ok(`the exact matcher refuses it, and suspectedOwn reports it (deltaPct ${sus.deltaPct}, ratio ${sus.ratio})`);

  // ── 3. the classification split ──────────────────────────────────────────────────────────────────
  console.log('\n=== 3. the classification, on the real row shapes ===');
  const sc = require('../trading/agent/stopCoverage');
  const cls = sc.classify(T(1111)), clsV = sc.classify(T(1114));
  console.log(`  classify(#1111) = ${cls}     classify(#1114) = ${clsV}   (the venue closed #1114)`);
  if (cls !== sc.REASON.MIRRORED_TRADED) await fail(`#1111 classifies as ${cls}, not mirrored_traded`);
  if (clsV !== sc.REASON.MIRRORED) await fail(`#1114 classifies as ${clsV}, not the untouched residue`);
  if (!sc.DEFECTS.includes(sc.REASON.MIRRORED_TRADED)) await fail('mirrored_traded is not a defect reason');
  if (sc.DEFECTS.includes(sc.REASON.MIRRORED)) await fail('mirrored_unmeasured has been made a defect — the residue claim is void');
  ok('a mirrored row the desk CLOSED is a defect; one the venue closed is still residue');

  // ── 4. the population, and the honest split of it ────────────────────────────────────────────────
  console.log('\n=== 4. the mirrored class since the levels epoch, split three ways ===');
  const m = await q(`SELECT id, symbol, closePriceSource, note FROM Trades
                     WHERE origin = 'venue' AND openAt >= '${sc.LEVELS_EPOCH}' ORDER BY id`);
  const byColumn = m.filter((r) => String(r.closePriceSource || '') === 'fill');
  const byNote = m.filter((r) => /executor close/.test(String(r.note || '')));
  console.log(`  ${m.length} mirrored row(s); ${byColumn.length} carry the desk's own close MARK ('fill'); ${byNote.length} carry the desk's close in the NOTE`);
  if (m.length !== 5) await fail(`expected 5 mirrored rows, found ${m.length} — the counts in the row text are stale`);
  if (byColumn.length !== 2) await fail(`expected 2 rows with closePriceSource='fill', found ${byColumn.length}`);
  if (byNote.length !== 4) await fail(`expected 4 rows whose note says the desk closed them, found ${byNote.length}`);
  ok('the measurement is current: 5 mirrored, 2 provable by column (4 by note)');

  // ── 5. the desk's live verdict on its own book ───────────────────────────────────────────────────
  console.log('\n=== 5. what the live stop-coverage report says now ===');
  try {
    const rep = await sc.report(1, { days: 90, recentDays: 7 });
    console.log(`  status = ${rep.verdict.status}${rep.verdict.standing ? ' (standing)' : ''}`);
    console.log(`  detail = ${rep.verdict.detail}`);
    console.log(`  all: measured=${rep.all.measured} mirrored=${rep.all.mirrored_unmeasured} traded=${rep.all.mirrored_traded} deskOpenedNoStop=${rep.all.missing_stop + rep.all.zero_distance} defects=${rep.all.defectCount}`);
    if (!rep.all.mirrored_traded) await fail('the live report shows zero mirrored_traded rows — the classification has no effect');
    ok(`the live report names ${rep.all.mirrored_traded} desk-traded mirror(s) as defects (status ${rep.verdict.status})`);
  } catch (e) { await fail(`stopCoverage.report threw: ${String(e.message || e)}`); }

  // ── 6. the wiring that makes a recurrence visible ────────────────────────────────────────────────
  console.log('\n=== 6. the instrumentation is wired, not just written ===');
  const exSrc = require('node:fs').readFileSync(require.resolve('../trading/agent/executor'), 'utf8');
  const logSrc = require('node:fs').readFileSync(require.resolve('../trading/agent/log'), 'utf8');
  const ask = exSrc.indexOf('suspectedOwn(unconfirmed, p)');
  const ev = exSrc.indexOf("'order_adopt_suspect'");
  const adopt = exSrc.indexOf("origin: 'venue'");
  if (!(ask > 0 && ev > 0)) await fail('the probe or its event is absent from executor');
  if (!(ask < adopt)) await fail('the row is written before the suspicion is evaluated');
  if (!/order_adopt_suspect: 'act'/.test(logSrc)) await fail('order_adopt_suspect is not registered in STREAM_BY_KIND');
  ok('reconcile asks before it adopts, logs order_adopt_suspect, and the kind is a registered act-stream event');

  // ── the row ──────────────────────────────────────────────────────────────────────────────────────
  console.log('\n=== the row ===');
  const dup = await q(`SELECT id, state FROM Tasks WHERE name LIKE 'TRD-EXE-4:%'`);
  if (dup.length) { console.log(`  already recorded as #${dup[0].id} (state ${dup[0].state}) — nothing to do.`); await pool.close(); return; }
  const exis = await q(`SELECT id, LEFT(name, 60) AS name FROM Tasks WHERE name LIKE 'TRD-EXE-%'`);
  console.log('  existing TRD-EXE rows: ' + (exis.map((r) => `#${r.id}`).join(', ') || '(none)'));
  if (NAME.length > 255) await fail('name too long');
  if (/[^\x20-\x7E]/.test(NAME)) await fail('name is not pure ASCII');
  console.log(`  "${NAME}" (${NAME.length} chars, info ${INFO.length} chars)`);
  if (!YES) { console.log('  DRY RUN — not written.'); await pool.close(); return; }
  const mx = (await q('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks'))[0];
  const anchor = (await q('SELECT TOP 1 plannedStart FROM Tasks WHERE id = 1456'))[0];
  const ins = await pool.request().input('name', NAME).input('info', INFO)
    .input('plannedStart', anchor.plannedStart).input('sortOrder', Number(mx.m) + 1)
    .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
            OUTPUT INSERTED.id VALUES (@name, @info, @plannedStart, 1, 1, ${EDICT}, @sortOrder, SYSUTCDATETIME())`);
  const id = ins.recordset[0].id;
  const back = (await q(`SELECT state, active, sortOrder FROM Tasks WHERE id = ${id}`))[0];
  console.log(`  \u2714 created as #${id} state=${back.state} active=${back.active} sortOrder=${back.sortOrder}`);
  const st = await q(`SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = ${EDICT} GROUP BY state`);
  console.log('  edict 52 now: ' + st.map((r) => `state ${r.state}: ${r.n}`).join(' · '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
