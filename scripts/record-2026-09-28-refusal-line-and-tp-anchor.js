// scripts/record-2026-09-28-refusal-line-and-tp-anchor.js
//   · #1418 TRD-RSK-2 — the refusal line led with a resize note the gate had PASSED
//   · #1412 TRD-TP-1  — route (2) shipped as a mechanism, default OFF, with the dial and the annotation
// Dry by default: node scripts/record-2026-09-28-refusal-line-and-tp-anchor.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const M1 = '##2026-09-28 refusal-line##';
const M2 = '##2026-09-28 route2-shipped##';

const RSK = `
${M1}
★★★ **THE REFUSAL LINE LED WITH A RESIZE NOTE THE GATE HAD PASSED. FIXED, AND IT WAS LIVE ON 14 ROWS.**

**WHAT WAS MEASURED.** \`reason\` was \`'risk veto: ' + risk.reasons.join('; ')\`, and \`reasons\` is ONE list holding
two kinds of sentence: what REFUSED the ticket, and what the gate DID to it on the way through (the stop cap, the
take-profit offset, each size cap). The stop-cap note is pushed while the ticket is still being ADMITTED, so it
came first almost every time:

    #100067  "risk veto: stop capped at 0.3% of price (declared 0.456%), venue cost ... "   vetoCodes: ["correlation"]
    #93902   "risk veto: stop capped at 0.3% of price (declared 0.701%), venue cost ... "   vetoCodes: null  (pre-codes)

**14 of the 17 recorded refusals read like that**, and the 3 newest prove the shape is wrong: their codes say
\`correlation\`, their prose leads with the **cap** — a resize the gate had explicitly PASSED. **This is the exact
misattribution this row was written to end** (its own author read "venue cost 0.1936% = 65% of R" as a
cost-ceiling breach when the correlation guard had fired), still live in the prose channel because the codes
arrived after it.

**WHAT SHIPPED.** \`veto()\` now records the refusal's own text in \`vetoReasons\` beside the code, and
\`risk.vetoLine(v)\` builds the line as: **the refusal first, the codes named right after the prefix, and the resize
notes last under an explicit \`— gate notes:\` heading.** Nothing is dropped — the notes are what explains the
ticket's shape — and the split is BY SOURCE, not by pattern-matching words.

    before:  risk veto: stop capped at 0.3% of price (declared 0.645%), venue cost 0.1728% = 57% of R; size capped…
    after:   risk veto: [correlation] |correlation| with Oil is 0.78, at or above the 0.7 rule — gate notes: stop capped…

⚠ **AND ONE SMALL THING THAT NEARLY BROKE SILENTLY:** the first version put the code before the colon
(\`risk veto [x]: …\`), which keeps the UI's \`/risk veto/i\` but **breaks \`routes.js\`'s \`/^risk veto:/i\`
classifier**, reclassifying every coded refusal without an error. The colon follows \`veto\` immediately; a test now
pins the prefix as a contract rather than as cosmetics. A legacy row with no \`vetoReasons\` still renders through
the old shape rather than reporting a refusal with no text.
`;

const TP = `
${M2}
★★★ **ROUTE (2) IS BUILT AND SHIPPED OFF, WITH THE DIAL AND THE ANNOTATION. THE SWITCH IS YOURS.**

**WHAT IT DOES.** \`entryLevels\` gains \`takeProfitAnchor\`: \`'declared'\` (the shipped default, today's behaviour —
1.5 x the 2xATR the strategy asked for) or \`'placed'\` — **1.5 x the stop the venue actually receives, so every
ticket carries the declared reward:risk instead of a wider one.**

**WHY IT MATTERS, from this row's own measurement.** Capping the stop while the target kept the DECLARED distance
did not merely shrink the stop — it MOVED THE TARGET: on Gold 1.5R becomes ~2.0R, on Oil 4.6-7.3R. Post-cap, 24 of
27 tickets carried more than the declared 1.5R, the tickets at 3.0R or wider touched their target **0 times in
10**, and on the 25 that ran past 1.6R the swing is **+0.46R per trade** (16% touched at their real target for
-0.2598R; 48% at a true 1.5R for +0.2000R).

**⚠ WHY IT SHIPS AS A SWITCH AND NOT AS THE NEW BEHAVIOUR, in the code rather than in a message:** these levels
belong to a **FROZEN forward-validation candidate** (TRD-29 — survgold/survoil declare \`params: []\` and their
§16.9 contract says any retuning VOIDS the candidate), and that forward track is the **only** reason those two
strategies are trusted. Silently retuning it is what the \`cappedBy\` annotation and the 5% offset's default-off
shipment both exist to prevent. \`risk.takeProfitAnchor\` is now on the **risk panel** (a labelled switch with the
measurement in its tooltip), so flipping it does not require editing JSON — the standard this row's sibling fix
applied to \`maxRiskPerTradePct\`.

**THE ANNOTATION, so the track stays separable:** \`entryLevels\` returns \`takeProfitAnchor\` and
\`takeProfitAnchorDist\`; the \`stop_capped\` event carries both and its note changes wording with the anchor; and
\`effectiveRR\` is the observable that moves — **under \`placed\` a capped ticket goes back to exactly 1.5.** An
absent \`tpAnchor\` means \`declared\` (historic rows).

★ **AND THE CHAIR IS TOLD WHICH ANCHOR IS IN FORCE.** \`riskParameterLines\` used to state one fact
unconditionally — "1.5x the DECLARED stop distance (not the capped one)" — and then warn that the cap leaves the
target further away and the ticket carrying MORE than 1.5R. **That warning describes the defect, so a seat reading
it under \`placed\` would be reasoning about a ticket that no longer exists.** The line is now chosen by the setting.

**WHAT IT DOES NOT TOUCH:** sizing, admissibility, and every gate. The stop the venue receives is identical under
both anchors (a test asserts it), because route (2) changes the TARGET only.

⚠ **AND THE OFFSET IS NOT SWITCHED OFF BY IT.** At k=1.5 the 5% offset moves expectancy from +0.1607R to +0.1259R,
i.e. it is the patch-for-the-wrong-dial this row says it is — but a silent change is the failure BOTH settings
guard against, so turning the anchor on leaves the offset exactly where you left it.

**TESTS:** \`test/tp-anchor.test.js\` (6) — including that the DEFAULT is unchanged, that an unrecognised value
falls back to \`declared\` rather than to the new behaviour (a typo must never retune a frozen candidate), and that
the stop is identical under both anchors. Suite: **1568 tests, 1567 pass, 0 fail, 1 skipped.**
`;

async function appendTo(pool, id, text, mark, label) {
  const cur = await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${id}`);
  if (!cur.recordset.length) { console.log(`  [${label}] #${id} NOT FOUND`); return; }
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${mark}%'`);
  const c = cur.recordset[0];
  console.log(`  [${label}] #${id} state=${c.state} info=${c.len}${dup.recordset.length ? '  [marker present]' : ` -> ${Number(c.len) + text.length}`}`);
  if (dup.recordset.length) { console.log('    marker present — nothing to do.'); return; }
  if (!YES) { console.log('    DRY RUN — not written.'); return; }
  await pool.request().input('t', text).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${id}`);
  const back = await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${id}`);
  console.log(`    ✔ appended -> ${back.recordset[0].len} chars`);
}

(async () => {
  const pool = await getPool();
  console.log('=== appends ===');
  await appendTo(pool, 1418, RSK, M1, 'TRD-RSK-2');
  await appendTo(pool, 1412, TP, M2, 'TRD-TP-1');
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
