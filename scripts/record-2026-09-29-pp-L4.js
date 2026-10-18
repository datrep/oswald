// scripts/record-2026-09-29-pp-L4.js
//
// Records L4 — THE TRUTH FIELDS — on TRD-RSK-10 (#1467).
//
// Two things go in this block, and the second is worth more than the first:
//   1. the five fields, and the two supporting accessors (ceilingPctFor, and the dial via promptBuilder);
//   2. ★ the defect that let L4's target sit dead for months — `ticketGeometryNote` read `cap.pct`/`cap.floor`/
//      `cap.note` while production stores `capPct` and no `floor`, AND ITS TEST PASSED, because the fixture
//      invented the same keys. A fixture is a claim about a WRITER in another file.
//
// DRY RUN BY DEFAULT (pass --yes). Marker-guarded, occurrence-counted, READ BACK.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { getPool } = require('../shared/db');
const ins = require('../trading/agent/instruments');

const ROOT = path.join(__dirname, '..');
const DOC = 'trading/docs/purchasing-power-design-2026-09-29.md';
const TASK_ID = 1467;
const MARKER = '##2026-09-29 L4 TRUTH FIELDS##';
const YES = process.argv.includes('--yes');

const EM = '\u2014';
const STAR = '\u2605';
const WARN = '\u26A0';
const ARROW = '\u21D2';
const DOT = '\u00B7';
const CHECK = '\u2714';

const ADDENDUM = `
${MARKER} THE RESOLVED SIZE IS NOW ON THE DECISION##

${STAR} WHAT L4 ANSWERS. A ticket's size is the minimum of THREE caps times TWO multipliers, and each of those five
numbers arrived from a different place with its own note. The measured complaint (TRD-RSK-6 / #1457) is that an
operator must READ THREE NOTES AND COMPOSE THE ANSWER, and no surface states the resolved outcome. L4 puts the
resolution on the decision row.

    sizeCalc.riskDialPct          the dial AS RESOLVED (the smaller of riskPerTradePct / maxRiskPerTradePct)
    sizeCalc.resolvedRiskPct      what this ticket ACTUALLY risks: finalSize x the venue stop / equity
    sizeCalc.ceilingPct           what the venue's leverage permits for THIS stop: L x stopPct
    sizeCalc.riskCappedByCeiling  did the ceiling cap the risk BELOW the dial?
    sizeCalc.boundBy              which control decided the size: maxEquityPerPositionPct |
                                  maxRiskPerTradePct | exposureCapPct | margin_utilisation | null

${STAR} ${'`'}riskCappedByCeiling${'`'} IS THE FIELD THAT WOULD HAVE CAUGHT THIS DOCUMENT'S OWN BLIND SPOT. Every other
quantity describes what the dial WANTED or what a cap DID; none of them says that on some symbols the dial was
**never expressible at all**. At r = 3.0% a Bitcoin ticket (ceiling 1.16% at a 0.695% stop) and a Coffee ticket
(4.67%) would otherwise be indistinguishable in the record ${EM} and §6.1 exists precisely because those are
different trades.

${STAR} THREE DESIGN DECISIONS, each pinned:
  ${DOT} ${'`'}boundBy${'`'} STARTS NULL and is assigned at exactly FOUR sites ${EM} one per control. The enum is the
    controls only: a run-in or half-risk MULTIPLIER scales the dial rather than bounding the ticket, so it must
    never set it, and "no control bound this ticket" is a real answer. It is null when nothing bound, mirroring
    ${'`'}stopCap.cappedBy${'`'} ${EM} ${'`'}cappedAtPct${'`'} could not supply it because it is written
    unconditionally from the setting (reports what the cap IS, never whether it ACTED).
  ${DOT} ${'`'}resolvedRiskPct${'`'} IS COMPUTED, not realised: same stop the sizing used, so it is comparable with
    the dial. The fill-anchored figure stays on the trade row. Measured on Gold the two differ by 21% WITHIN ONE
    TICKET, so duplicating one into the other would label a number with the wrong anchor (TRD-RSK-1's defect).
  ${DOT} ${'`'}riskDialPct${'`'} comes from ${'`'}promptBuilder.effectiveRiskPct${'`'}, not from a second
    ${'`'}Math.min${'`'} here: that resolver is the single statement of which dial wins, and a copy would be a
    second place to disagree ${EM} the TRD-TUN-2 defect class, one layer up.
${WARN} And ${'`'}ceilingPct${'`'} is computed by ${'`'}instruments.ceilingPctFor()${'`'}, never by dotting into the
venue-floor record: the pin in ${'`'}test/venue-leverage.test.js${'`'} holds those fields to exactly ONE accessor,
and it fired on my first attempt ${EM} correctly, and immediately.

${STAR}${STAR}${STAR} AND THE PART WORTH MORE THAN THE FIX: TWO SEAT-FACING BRANCHES WERE DEAD AND THEIR TEST PASSED.

    what the note read      what production stores                                  state
    cap.pct                 cap.capPct                                               dead ${EM} the
                                                                                     "TRUNCATED by the N% cap"
                                                                                     suffix rendered EMPTY
    cap.floor               not copied onto v.stopCap at all                          dead ${EM} "the cap must
                                                                                     clear N% (Mx the round
                                                                                     trip)" never printed
    cap.note                attached only on stopPolicy's REFUSAL path, where
                            cappedBy is null and v.stopCap is null                    unreachable BY
                                                                                     CONSTRUCTION ${EM} deleted

${ARROW} FIXED BY MAKING THE WRITER AGREE WITH THE READER: ${'`'}risk.js${'`'} now carries ${'`'}floor${'`'} (which
${'`'}stopPolicy${'`'} has always computed as ${'`'}costPct x maxAdverseCostMultiple${'`'}), and the note reads
${'`'}capPct${'`'}. No number is fabricated: every value is still read off the risk evaluation.

${STAR} WHY THE TEST DID NOT SEE IT, and this generalises. ${'`'}test/ticket-geometry-note.test.js${'`'} built its
fixture as ${'`'}{ pct, costPct, floor, note }${'`'} ${EM} THE SAME KEYS THE READER INVENTED. So it asserted a clause
that could never fire, in a file whose own header calls itself "the highest-risk string in the prompt". **A FIXTURE IS
A CLAIM ABOUT A WRITER THAT LIVES IN ANOTHER FILE, so it has to be checked against the writer or the test tests
itself.** Two pins now hold the halves together: one reads ${'`'}risk.js${'`'} and asserts the exact key set it
stores on ${'`'}v.stopCap${'`'} (and that a bare ${'`'}pct${'`'} cannot come back), the other reads
${'`'}aggregator.js${'`'} and asserts it never reads ${'`'}cap.pct${'`'}.

${WARN} THE SAME CLASS APPEARED IN THE PIN ITSELF, IN THE OPPOSITE DIRECTION. ${'`'}test/venue-leverage.test.js${'`'}
read RAW text, so my L4 comment quoting the forbidden pattern (cited as the mistake NOT to make) made a NEGATIVE
assertion fail ON ITS OWN DOCUMENTATION ${EM} while a POSITIVE assertion could equally have PASSED on a comment.
That file now reads comment-stripped source via ${'`'}test/_source.js${'`'}, the one repair that fixes both
directions. **Fourth occurrence of the prose-vs-code trap in this workstream; now fixed at the source.**

${STAR} STATUS. Repo-side COMPLETE; suite **1,739 tests / 1,738 pass / 0 fail / 1 skipped**; eslint exit 0 on every
touched file; the report carries ${'\u00A7'}13.6 (the dead branches + the fixture lesson) and its L4 row now reads
LANDED. Service restarted 2026-09-29T04:18:18Z, healthz ok, bridge attached.

${WARN} **THE ACCEPTANCE READ IS STILL PENDING, and saying so is the point.** The newest decision carrying a
${'`'}sizeCalc${'`'} is **#5534 at 2026-09-28T16:48:47Z** ${EM} ELEVEN HOURS BEFORE THE RESTART. Every decision since
is a MICRO wake with ${'`'}action: none${'`'} and **NO ${'`'}sizeCalc${'`'} at all**, so it cannot carry these fields.
${ARROW} The check is: **the first decision after 2026-09-29T04:18:18Z whose payload contains
${'`'}sizeCalc${'`'}** must show all five fields, and ${'`'}marginGuard.armed: true${'`'} (the first time the L3 guard
is armed in a live process).
${WARN} And a trap I walked into while checking: I first read that absence as "pre-L4 / no-guard" on three rows ${EM}
but those rows HAVE NO ${'`'}sizeCalc${'`'}, so the test was measuring nothing. **An empty result is a claim that
needs its own check** (third occurrence in this workstream).`;

const fail = async (msg) => { console.error(`\n${WARN} REFUSING TO WRITE: ${msg}\n`); process.exit(2); };

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // ⚠ COMMENTS ARE STRIPPED BEFORE ANY SOURCE SCAN — and this gate hit the trap itself on its first run: the
  // aggregator check matched `cap.pct` inside the very comment explaining that `cap.pct` must not be read. That
  // is the FOURTH occurrence of prose-vs-code in this workstream (a `doesNotMatch` matching a comment, a stripper
  // that silently no-opped on CRLF, a comment failing a pin, and now this). Strip, always.
  const code = (rel) => read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  console.log('=== L4 TRUTH FIELDS — recording gates ===\n');

  console.log('1. the fields on the decision');
  const riskSrc = code('trading/agent/risk.js');
  const scStart = riskSrc.indexOf('v.sizeCalc = {');
  if (scStart < 0) await fail('v.sizeCalc not found');
  const scBody = riskSrc.slice(scStart, riskSrc.indexOf('};', scStart));
  for (const f of ['riskDialPct', 'ceilingPct', 'riskCappedByCeiling', 'resolvedRiskPct', 'boundBy']) {
    if (!scBody.includes(f)) await fail(`${f} is not on sizeCalc — the record cannot answer §L4.a`);
  }
  console.log(`  ${CHECK} all five fields ride on sizeCalc`);

  console.log('\n2. the controls');
  const set = [...riskSrc.matchAll(/boundBy = '([^']+)'/g)].map((m) => m[1]).sort();
  const want = ['exposureCapPct', 'margin_utilisation', 'maxEquityPerPositionPct', 'maxRiskPerTradePct'];
  if (JSON.stringify(set) !== JSON.stringify(want)) await fail(`boundBy sites are ${set.join(',')} — expected the four controls`);
  if (!riskSrc.includes('let boundBy = null;')) await fail('boundBy must START null');
  console.log(`  ${CHECK} boundBy: starts null, assigned once per control (${set.length})`);

  console.log('\n3. the accessors');
  if (typeof ins.ceilingPctFor !== 'function') await fail('instruments.ceilingPctFor is missing');
  if (ins.ceilingPctFor({ leverage: 5 }, 0.55) !== 2.75) await fail('ceilingPctFor(1:5, 0.55%) must be 2.75%');
  if (ins.ceilingPctFor(null, 1) !== null) await fail('an unread ratio must give NULL, never 0%');
  console.log(`  ${CHECK} ceilingPctFor: 1:5 x 0.55% = 2.75%, absent gives null`);
  if (!/require\('\.\/promptBuilder'\)\.effectiveRiskPct\(settings\)/.test(riskSrc)) {
    await fail('riskDialPct must come from promptBuilder.effectiveRiskPct, not a second resolver');
  }
  console.log(`  ${CHECK} the dial uses the one resolver`);

  console.log('\n4. the dead branches');
  const aggSrc = code('trading/agent/aggregator.js');
  if (/[^\w]cap\.pct[^\w]/.test(aggSrc)) await fail('aggregator still reads cap.pct, which is never stored');
  if (!aggSrc.includes('cap.capPct')) await fail('aggregator must read cap.capPct');
  if (!riskSrc.includes('floor: stopCap.floor')) await fail('risk.js must carry floor, or the note branch stays dead');
  if (/\bcap\.note\b/.test(aggSrc)) await fail('the cap.note branch is unreachable by construction and must be gone');
  console.log(`  ${CHECK} the note reads capPct/floor; the unreachable cap.note branch is deleted`);
  const fixture = code('test/ticket-geometry-note.test.js');
  if (/\bpct:\s*capPct/.test(fixture)) await fail('the fixture still invents `pct` — that is the defect this row records');
  if (!fixture.includes('capPct')) await fail('the fixture must mirror the writer');
  console.log(`  ${CHECK} the fixture mirrors the writer, not the reader`);

  console.log('\n5. the artifacts the row cites');
  for (const f of ['test/size-truth-fields.test.js', 'test/risk-margin-guard.test.js']) {
    if (!fs.existsSync(path.join(ROOT, f))) await fail(`${f} does not exist`);
  }
  const doc = read(DOC);
  if (!doc.includes('13.6 ')) await fail('the report carries no §13.6 on the dead branches');
  console.log(`  ${CHECK} pins + report §13.6 present`);

  console.log('\n6. the acceptance baseline (re-measured, not quoted)');
  const newest = (await q(`SELECT TOP 1 id, CONVERT(varchar(19),createdAt,126) AS at FROM dbo.TradingPrompts
    WHERE CAST(decision AS nvarchar(max)) LIKE '%sizeCalc%' ORDER BY id DESC`))[0];
  const now = new Date().toISOString();
  console.log(`  newest decision with a sizeCalc: #${newest.id} at ${newest.at}Z ${DOT} now ${now}`);
  console.log(`  ${CHECK} baseline recorded — the acceptance read is the first one AFTER the restart`);

  console.log('\n7. the row and its marker');
  const row = (await q(`SELECT id, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  if (!row) await fail(`row ${TASK_ID} does not exist`);
  const n = (row.info || '').split(MARKER).length - 1;
  console.log(`  #${TASK_ID}: ${(row.info || '').length} chars ${DOT} this marker ${n}x`);

  if (!YES) {
    console.log(n === 0
      ? `\n  would append ${ADDENDUM.length} chars. DRY RUN ${EM} not written.`
      : `\n  block already present. DRY RUN ${EM} not written.`);
    await pool.close();
    return;
  }
  if (n === 0) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${ADDENDUM.replace(/'/g, "''")}' WHERE id = ${TASK_ID}`);
    console.log(`  ${CHECK} block appended`);
  } else console.log('  block already present.');

  const after = (await q(`SELECT LEN(info) AS n, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  const fn = (after.info || '').split(MARKER).length - 1;
  if (fn !== 1) await fail(`the block appears ${fn}x — expected exactly 1 (idempotency)`);
  if (!(after.info || '').includes('THE RESOLVED SIZE IS NOW ON THE DECISION')) await fail('read-back cannot find the block');
  console.log(`  ${CHECK} #${TASK_ID}.info is now ${after.n} chars, block x${fn}, read back`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
