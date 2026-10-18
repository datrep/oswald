// scripts/record-2026-09-28-risk-ui-live-ready.js — registers the risk/UI/live-ready task set.
// Idempotent by name prefix. Dry by default:  node scripts/record-2026-09-28-risk-ui-live-ready.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const EDICT = 52;
const DOC = 'trading/docs/risk-and-ui-live-ready-2026-09-28.md';

// NOTE: no backticks anywhere in these strings on purpose — a backtick inside a JS template literal
// terminates it, and this file's payloads are long enough that the breakage is hard to spot.
const ROWS = [
  {
    name: 'TRD-RSK-6: Risk - one dial decides risk and the other is inert; the panel cannot say which',
    info: `★ REGISTERED 2026-09-28 on the owner's redirect ("risk and position sizing is a mess"). Full write-up: ${DOC} §1.

THE DEFECT, AND IT IS THE THING THE OWNER ACTUALLY HIT.
The sizing panel contains a control labelled "risk per trade" (#risk-riskpct). Dragging it repaints a note and DOES NOT CHANGE THE SIZE OF A TRADE. promptBuilder.js:185 carries effectiveRiskPct(settings), a function that exists only to answer WHICH OF TWO DIALS WINS:
    const binds = hasCap && rawCap < declared ? 'maxRiskPerTradePct' : 'riskPerTradePct';
returning { declared, maxRisk, effective, binds, inert: binds === 'maxRiskPerTradePct' }.
Both dials divide by the same stop distance. Live values: risk.riskPerTradePct = 1 (one PERCENT), risk.maxRiskPerTradePct = 0.07. The cap is 14x smaller, so it binds on every ticket and the declared dial is INERT. The code already knows — it computes an "inert" flag, and renderRiskBindNote() exists so the panel can say which dial is in charge, with a comment stating that without the repaint "dragging 'risk per trade' leaves a stale note claiming the reverse".
⇒ A panel that needs a helper function and an oninput repaint purely to explain its own two dials to its own operator. That is the "mess", and it is a WIRING fault, not a badly chosen number.

AND IT HAS ALREADY COST SOMETHING MEASURED. epoch.js:127 records that between 2026-09-25 and its correction the prompt stated size = equity x riskPerTradePct% / stop "while maxRiskPerTradePct (0.07%) always overrode it — so chair reasoning in that window is about a rule 28x larger than the one in force." The chairs reasoned about a number 28 times the one in force, and the record proves it.

WHAT "FIXED" MEANS — an owner decision, three shapes:
(a) DELETE the declared dial from the panel and keep the cap. Cheapest; loses the record of intent.
(b) KEEP both, make the retired one READ-ONLY and label it with what bound. Honest immediately.
(c) MAKE THE DECLARED DIAL THE ONE THAT BINDS and demote the cap to a hard ceiling that can only REFUSE a ticket, never silently resize it. The target shape.
RECOMMENDED: (b) now, (c) as the target. Recorded as fork 1 in ${DOC} §6.

⚠ WHY THIS IS NOT COSMETIC: it is the same defect class as the desk's other named inert controls (takeProfitAnchor gated on a restart; the TRD-VET-2 attribution). The desk is excellent at recording REFUSALS and poor at recording EFFECTS. A control whose relation to the engine is invisible is indistinguishable from a broken one.`,
  },
  {
    name: 'TRD-RSK-7: Risk - per-desk risk profiles, with the resolution reported on every decision',
    info: `★ REGISTERED 2026-09-28. The owner's ask, verbatim: "each with their own risk and position sizing". Design in ${DOC} §3-§4.

WHAT EXISTS TODAY: settings.risk is ONE FLAT GLOBAL OBJECT consulted by one sizing formula. It mixes sizing (riskPerTradePct inert / maxRiskPerTradePct binding / atrStopMultiple / maxEquityPerPositionPct), caps (maxPositions, maxNewTradesPerDay, exposureCapPct), halt (dailyLossHaltPct, initialEquity), micro-structure (reentryCooldownBars, exitTolerance, minRealisedRrPct), cost (maxCostShareOfR 0.65, maxAdverseCostMultiple 1.5 legacy), stop/TP geometry (maxAdversePct, takeProfitOffsetPct, takeProfitAnchor), correlation (correlationVeto), freshness (maxEntryTickAgeMin, maxAnchorAgeSec) and venue (acceptVenueFloor).
★ AND TWO MULTIPLIERS CHANGE THE SIZE FROM OUTSIDE settings.risk, INVISIBLY: runInFactorFor(strategy, settings) = 0.5 or 1, gated by a DESK-WIDE learning.parityValidated boolean (repro/parity-horizon.js: the first strategy to accept flips it for EVERY strategy); and sizeCalc.degradedFactor = 0.5 when the chair is budget-stopped (TRD-94). Realised size = equity x dial% / stopDist x runIn x degraded — and two of those four terms are invisible on the risk panel, one of them triggered by a BUDGET condition rather than a risk one.

★ THE FLATNESS HAS ALREADY FORCED A BAD DECISION. acceptVenueFloor's own comment records the bind: SGX's floor forces 0.1640% of equity against a 0.07% dial (2.34x) while every other symbol's floor sits at 0.11x-0.78x. The alternatives were accept the risk, drop the symbol, or raise a dial that has no per-symbol form. The desk chose "accept", fired it live, and had to revert it (#1455) once the floor turned out to have no venue provenance. OPTIONS WILL MAKE THIS WORSE: options cost is spread + theta rather than swap, so maxCostShareOfR and maxAdversePct do not transfer, and the floor is per-contract.

TARGET SHAPE (partial override, deep-merged):
    settings.risk.default                  <- today's object, becomes the fallback
    settings.risk.profiles.<deskId>        <- strategy today (survgold/survoil/survasilver/survasgx/congress), instrumentClass once options land
THREE RULES THE RESOLVER MUST HOLD, each learned from this desk's own failures:
1. REPORT THE RESOLUTION ON THE DECISION ROW — profileId, overrodeKeys[], and the effective values actually used. vetoCodes is the precedent: a machine-readable field beside the prose is what made attribution stop depending on wording.
2. A PROFILE THAT CHANGES NOTHING MUST BE ABLE TO SAY SO. binding.js already detects inert symbolParams (it warns when a binding names a symbol not on the watchlist). A resolver that silently does nothing is the TRD-RSK-6 defect with more knobs.
3. ⚠ DO NOT COLLIDE WITH TRD-TUN-2 (#1393). It records that strategies.list() resolves params[id] ?? p.def INLINE and never reads symbolParams, while the trading path uses paramsFor — TWO RESOLVERS, AND THE TUNER READS THE WRONG ONE. binding.js is explicit: "any profiles work must resolve TRD-TUN-2 first or it writes a THIRD resolver." ⇒ **TRD-TUN-2 IS A HARD PRECONDITION FOR THIS ROW.**

MAPPING (${DOC} §4): per-STRATEGY profiles are a real, immediately available win (cost share of R spans 5x: Gold 39.8% to Oil ~60%). The TRAILING STOP is a stop-geometry key, not a new system. NEWS is NOT a sizing fork — news changes why the desk enters, not how much, and roadmap-sequencing §3 warns that S3 must not ride another prompt-version change. OPTIONS is the one case the current architecture cannot express at all, and is the reason this row exists.

⚠ SCOPE PUSH-BACK: profiles give each capability its own NUMBERS without giving each its own ENGINE. If "each with their own risk" is meant to include separate loops/budgets/executors per capability, that is a much larger change and it collides with the evidence unit (TRD-EVD-2 #1394) that options is already blocked on.`,
  },
  {
    name: 'TRD-UIX-1: UI - the acknowledgement layer; every write control ends in a visible, persisted statement',
    info: `★ REGISTERED 2026-09-28 on the owner's report: "some of the buttons dont do what they are supposed to do, and the UI is generally bad".

★★ MEASURED FIRST, AND THE ANSWER WAS NOT THE EXPECTED ONE. New tool: trading/scripts/ui-control-audit.js (static). Result on the current markup, 295 id'd controls:
  bound (direct handler) 63 · hook-bound 3 · named-but-indirect 206 · **DEAD CLICKABLE: 0** · **BROKEN REFERENCES: 0**
⇒ THE BUTTONS ARE NOT UNWIRED. Every clickable control is bound to something. The defect is that some are bound to something INERT or INVISIBLE, which looks identical to broken from the operator's chair.
⚠ I HAD TO CORRECT THAT TOOL THREE TIMES BEFORE IT WAS WORTH READING, and every error was mine: (1) String.match returns only the FIRST id per line and this markup puts several controls on one line (button id="btn-wake" then button id="btn-wake-pause"), giving 11 false "broken reference" findings; (2) it only understood $('id').onclick, so it called tf-5m/tf-15m/tf-4h dead — they are bound by '#tab-prices [data-tf]' at app.js:3511; (3) it missed btn-test-sql/btn-test-model/btn-test-bridge, bound by an array loop at app.js:3770. A static "dead button" check is the easiest way to be WRONG about this codebase, and its "dead" claim is now made only when an id appears nowhere in the JS in any form.

WHY THIS ROW EXISTS — THE DESK'S OWN DOCUMENTS NAME THE CLASS:
- roadmap-sequencing-2026-09-28.md §4: takeProfitAnchor and the TRD-VET-2 attribution "will render and do nothing until a restart."
- UI_FLOW_AUDIT_2026-09-17.md §7: "the capture and the floor end with nothing visible. The desk's two most consequential failures are the two that end silently."
- risk.maxRiskPerTradePct is saved with the UI's off flag, so 0 renders as the word "off" — and per TRD-RSK-6 the panel can show an inert dial beside an off-looking dial while neither is what the desk uses.

★ THE PATTERN, IN ONE SENTENCE: THE DESK IS GOOD AT REFUSING AND BAD AT ACKNOWLEDGING. Refusals are recorded meticulously (vetoCodes, order_blocked, reanchor_skipped). What is missing is the other direction — a control a person pressed should end in a visible, PERSISTED statement of what it changed, or of why it changed nothing.

WHAT "DONE" MEANS: for every write control, either (a) the effect is visible and recorded, or (b) the control states why it had no effect (inert dial, gated on a restart, missing prerequisite). Start with the four named instances above. See ${DOC} §2 and §5 items 3-4.`,
  },
  {
    name: 'TRD-UIX-2: UI - a dynamic test layer for the dashboard; zero UI tests exist today',
    info: `★ REGISTERED 2026-09-28. The static half already landed as trading/scripts/ui-control-audit.js; this row is the DYNAMIC half.

★ THE GAP, QUOTED FROM THE DESK'S OWN AUDIT. UI_FLOW_AUDIT_2026-09-17.md §8: "83 test files, 844 tests — and zero cover the UI. Nothing under test/ touches trading/public/**, so every UI finding here is unpinned by construction: no test asserts that a panel renders, that a chip updates on a tier change, that the alerts table has rows, or that a control has a HANDLER." And its closing thesis: findings landed almost exclusively in the modules and surfaces with no pinning test — the UI is the largest such surface, and it produced the most findings.

WHAT THE STATIC CHECKER CANNOT DO, stated so this row is not confused with the work already done: it proves a control is wired to SOMETHING. It CANNOT prove the something is correct, that the panel refreshes, or that the write persisted. A control wired to a handler that does nothing is WIRED, and ui-control-audit.js will call it wired. That is exactly the TRD-UIX-1 class, so the static tool cannot find the defect the owner reported.

WHAT TO BUILD: drive each write flow and ASSERT THE TERMINAL STATE. The audit already lists the flows and their terminal states (§1 inventory): wake, pause/interval, kill tiers, capture, watchlist, trade submit, sync venue closes, alerts, backtest, tuner, budget, risk save. Precedents for the harness exist in the repo — test files already lift browser code with vm + a stubbed $ (see the equity-window tests) rather than requiring the live page.
⚠ THE HARNESS MUST NOT REQUIRE THE EXECUTOR OR THE CONNECTOR: requiring trading/agent/executor attaches to the desk's LIVE Chrome on :9224 (the unconfirmed.js header records that happening once and costing 31.6 s).
NOTE: ` + DOC + ` §5 item 6.`,
  },
  {
    name: 'TRD-LRD-1: Live-ready - the go-live definition, and the gate it implies',
    info: `★ REGISTERED 2026-09-28: the owner's deadline, verbatim — "i want it to be live ready by the end of next week."

PROPOSED DEFINITION (for the owner to accept or tighten — fork 3 in ${DOC} §6):
"Live ready = every control on the dashboard either changes what the desk does AND SAYS SO, or states why it changed nothing; the risk number the owner sets is the risk number the desk uses, and the panel says which number that is; and every open position's risk is expressible in R from the record alone."

⚠ THE THIRD CLAUSE IS THE ONE THAT MATTERS AND IS NOT CURRENTLY TRUE. TRD-ANC-1 measured Trades #1082 carrying 2.51x the intended risk (intended $2.88, realised $7.26) because the stop was posted at the decision price and the fill landed 66.9 s later. Exposure is bounded — exactly 1 of the 28 post-cap trades exceeds 1.6x — but the record cannot express it in R, which is what the clause asks for. THE OPEN QUESTION FOR THE OWNER: does go-live GATE on this clause, or is it a known-open item?

ORDER (${DOC} §5): 1) kill the two-dial ambiguity (TRD-RSK-6) · 2) risk profiles + a REPORTING resolver (TRD-RSK-7, blocked on TRD-TUN-2 #1393) · 3) the acknowledgement layer (TRD-UIX-1) · 4) close the silent-failure pair — capture and the floor · 5) TRD-OPT-2 (the Trades instrument-class columns, already exempt from the options gate) · 6) the dynamic UI test layer (TRD-UIX-2).
WHY RISK FIRST: the UI work depends on it. Fixing the acknowledgement layer while the risk panel still names the wrong binding dial would produce a cleaner panel that lies more legibly.

WHAT THIS ROW DELIBERATELY EXCLUDES, per roadmap-sequencing-2026-09-28.md: options TRADING logic (still blocked on the evidence unit TRD-EVD-2 #1394 — "a validated strategy exists", NOT TRD-26), news S3 (its own prompt version, its own measurement), and any change to the four docs' sequencing. Profiles are a PRECONDITION for options, never a reason to pull options forward.

STANDING MEASUREMENT TO CARRY: AI cost is NOT the constraint — total spend ran at 63.2% of totalDaily with the chair soft-stopped at 100.6% (754,436 / 750,000), reproducing TRD-94: the desk runs quant-only at 50% size while 36.8% of the budget sits unspent.`,
  },
];

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);

  console.log('\n=== precondition check ===');
  const tun = await q(`SELECT id, name, state FROM Tasks WHERE name LIKE 'TRD-TUN-2:%'`);
  console.log(tun.length ? `  TRD-TUN-2 = #${tun[0].id} state=${tun[0].state} (TRD-RSK-7's hard precondition)` : '  ⚠ TRD-TUN-2 NOT FOUND — TRD-RSK-7 cannot start');
  const tun2 = await q(`SELECT id, name, state FROM Tasks WHERE name LIKE 'TRD-TUN-1:%'`);
  if (tun2.length) console.log(`  TRD-TUN-1 = #${tun2[0].id} state=${tun2[0].state}`);
  const opt2 = await q(`SELECT id, name, state FROM Tasks WHERE name LIKE 'TRD-OPT-2:%'`);
  console.log(opt2.length ? `  TRD-OPT-2 already exists = #${opt2[0].id} state=${opt2[0].state} — NOT duplicated here` : '  TRD-OPT-2 not found as a row (referenced only from the roadmap doc)');

  console.log('\n=== the new rows ===');
  for (const row of ROWS) {
    const prefix = row.name.split(':')[0];
    const dup = await q(`SELECT id, state FROM Tasks WHERE name LIKE '${prefix}:%'`);
    if (dup.length) { console.log(`  ${prefix}  already present as #${dup[0].id} (state ${dup[0].state}) — skipped`); continue; }
    const len = Buffer.byteLength(row.name, 'utf8');
    if (len > 510) { console.error(`  ${prefix}  NAME TOO LONG (${len} bytes > nvarchar(510)) — refusing`); await pool.close(); process.exit(1); }
    if (/[^\x20-\x7E]/.test(row.name)) { console.error(`  ${prefix}  NAME IS NOT PURE ASCII — refusing`); await pool.close(); process.exit(1); }
    if (row.name.length > 255) { console.error(`  ${prefix}  name ${row.name.length} chars > 255 — refusing (nvarchar(510) is BYTES)`); await pool.close(); process.exit(1); }
    if (!YES) { console.log(`  ${prefix}  DRY RUN — would insert (name ${row.name.length} chars, info ${row.info.length} chars)`); continue; }
    const mx = (await q('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks'))[0];
    const anchor = (await q('SELECT TOP 1 plannedStart FROM Tasks WHERE id = 1456'))[0];
    const ins = await pool.request()
      .input('name', row.name).input('info', row.info)
      .input('plannedStart', anchor.plannedStart).input('sortOrder', Number(mx.m) + 1)
      .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
              OUTPUT INSERTED.id VALUES (@name, @info, @plannedStart, 1, 1, ${EDICT}, @sortOrder, SYSUTCDATETIME())`);
    const id = ins.recordset[0].id;
    const back = (await q(`SELECT state, active, sortOrder FROM Tasks WHERE id = ${id}`))[0];
    console.log(`  ✔ ${prefix}  created as #${id} state=${back.state} active=${back.active} sortOrder=${back.sortOrder} info=${row.info.length} chars`);
  }

  const s = await q(`SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = ${EDICT} GROUP BY state`);
  console.log(`\nedict ${EDICT} by state: ` + s.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
