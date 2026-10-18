// scripts/record-2026-09-28-size-snap.js — TRD-EXE-3: the desk records the size it COMPUTED; the venue holds
// a size SNAPPED to its minimum increment. Every claim is re-measured (the min sizes are read from the live
// prompt, and the snapping arithmetic is recomputed) before anything is written.
// Dry by default:  node scripts/record-2026-09-28-size-snap.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const EDICT = 52;
const MARK = '##2026-09-28 size-snap##';
const NAME = 'TRD-EXE-3: Executor - the desk records the size it computed while the venue holds a size SNAPPED to its minimum increment, so every R is computed off a size that was never filled';

const INFO = `★ REGISTERED 2026-09-28 while checking a LEAD (venue position sizes vs the desk rows). The lead was real and the mechanism turned out to be clean.

★★ THE FINDING: THE DESK SUBMITS A FRACTIONAL SIZE THE VENUE CANNOT ACCEPT EXACTLY, AND THEN RECORDS ITS OWN NUMBER RATHER THAN THE FILLED ONE.
Measured on ALL THREE open positions (venue sizes from the newest \`position_pnl\`, desk sizes from \`Trades\`, minimum sizes from the live prompt's own per-symbol lines):
| desk row | symbol | desk size | venue size | venue min size | desk / min |
| #1107 | Gold | 0.1152 | **0.125** | 0.025 Troy Ounces | 4.608 -> 5 |
| #1108 | Silver | 7.8131 | **7.5** | 2.5 Troy Ounces | 3.125 -> 3 |
| #1099 | Bitcoin | 0.0025 | **0.003** | 0.001 Contracts | 2.5 -> 3 (half-up) |
**Every venue size is the desk size ROUNDED TO THE NEAREST MULTIPLE OF THAT SYMBOL'S MINIMUM TRADABLE INCREMENT** — and the fit is exact in all three cases, including Bitcoin's tie resolving upward.
★ AND THE DESK ALREADY KNOWS THE MINIMUM: the prompt tells the chair these exact minimums every wake ("Gold: min size 0.025 Troy Ounces", "Silver: min size 2.5 Troy Ounces", "Bitcoin: min size 0.001 Contracts"). The information needed to snap the size BEFORE submitting is already in hand; it is simply not used for the size it hands the venue.

WHY THIS MATTERS, in descending severity:
1. ★★ EVERY R MULTIPLE IS COMPUTED OFF A SIZE THAT WAS NEVER FILLED. Risk in currency is \`size x stopDist\`, so the desk UNDERSTATES Gold #1107's risk by 8.5% (0.1152 x 12.8251 = $1.4775 recorded, against $1.6031 actually held) and OVERSTATES Silver's by 4%. Every R, every expectancy bucket, every \`costShareOfR\` on those trades inherits the error. The stop-cap sweep itself \`(0.30% nets -28.89 vs -72.15 uncapped)\` is denominated in R.
2. ★★ \`matchVenuePosition\` CANNOT PAIR THE DESK'S OWN ROW WITH ITS OWN POSITION. \`unconfirmed.SIZE_TOLERANCE_PCT = 2\`, and the observed divergence is **+20.00% (Bitcoin), +8.51% (Gold), -4.01% (Silver)** — 3 of 3 exceed the tolerance. That is the recovery path TRD-52 depends on to resolve an unconfirmed submit against a venue position: it would refuse to match, expire the row, and (per TRD-EXE-1) leave the venue order unmanaged.
3. ★ AND THE EXACT IDENTIFIER IS ALREADY THERE, UNUSED FOR THIS. Every open row carries \`plus500PositionId\` and **all three match the venue's \`positionId\` exactly** (#1107 -> 1888438113, #1108 -> 1888438191, #1099 -> 1888427541). A size-within-2% heuristic is a strictly weaker identifier than an exact id the desk already stores. ⚠ For an UNCONFIRMED submit the id is unknown by construction, so size matching is genuinely needed there — which is precisely why the tolerance must reflect the REAL divergence, i.e. the minimum-increment rounding, and not 2%.

FIX, two parts and both are small:
(a) **SNAP THE SIZE BEFORE SUBMITTING** — round to the nearest multiple of the symbol's minimum increment, exactly as the venue does, and record the snapped value. The minimums are already resolved for the prompt; this reuses them. The risk consequence must be DISCLOSED the way the venue-floor path already discloses its exceedance (\`risk.js\` \`venueFloor\` map, \`aggregator.ticketGeometryNote\`), because snapping CHANGES the risk the owner's dial intended: Gold's 4.608 -> 5 is a **+8.5% risk increase**, not a rounding footnote.
(b) **RECORD WHAT WAS FILLED, NOT WHAT WAS COMPUTED** — where the venue reports a size, reconcile the row to it and say so when they differ, rather than keeping the computed value silently.
⚠ NEITHER PART IS A TUNING CHANGE, and (a) alone does not fix (2): snapping makes the SUBMIT match the venue, while (2) needs the MATCH rule to tolerate the increment.
⚠ THE INTERACTION WITH TRD-EXE-2: that row established that the "venue minimum" figures came from a third-party page (yahoo/CME/ICE/Bloomberg) and that SGX's 20-Share floor was disproved when the venue FILLED a size-10 order. **The snapping mechanism here is measured from the VENUE'S ACTUAL FILLED SIZES, not from a registry page** — so it is evidence the desk can trust even where the registry's numbers are suspect, and it is the strongest available confirmation that the minimum-increment concept is real.`;
  // ⚠ the two lines above are one template literal; the embedded newline is intentional.

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };
  const num = (s) => Number(s);

  // ── 1. the minimum increments, read from the LIVE PROMPT (what the desk itself believes) ─────────
  console.log('\n=== 1. the venue minimums, from the live prompt ===');
  const p = (await q(`SELECT TOP 1 id, bundle FROM TradingPrompts ORDER BY id DESC`))[0];
  const mins = {};
  for (const m of p.bundle.matchAll(/([A-Z][A-Za-z ]+): min size ([\d.]+) ([A-Za-z]+)/g)) {
    mins[m[1].trim()] = { min: Number(m[2]), unit: m[3] };
  }
  console.log('  prompt #' + p.id + ' states: ' + Object.entries(mins).map(([k, v]) => `${k}=${v.min} ${v.unit}`).join(' · '));
  if (!Object.keys(mins).length) await fail('no minimum sizes found in the prompt — the snapping claim has no basis');

  // ── 2. desk vs venue, and the snapping arithmetic ────────────────────────────────────────────────
  console.log('\n=== 2. desk size vs venue size, and whether the venue size is the nearest multiple ===');
  const desk = await q(`SELECT id, symbol, size, plus500PositionId FROM Trades WHERE status='open' ORDER BY id`);
  const venue = await q(`SELECT TOP 60 payload FROM TradingEvents WHERE kind='position_pnl' ORDER BY id DESC`);
  const latest = new Map();
  for (const v of venue) {
    let o; try { o = JSON.parse(v.payload); } catch { continue; }
    if (o.symbol && !latest.has(o.symbol)) latest.set(o.symbol, o);
  }
  const rows = [];
  for (const d of desk) {
    const v = latest.get(d.symbol);
    if (!v) continue;
    const mn = mins[d.symbol];
    const ds = num(d.size), vs = num(v.size);
    if (!mn) { console.log(`  #${d.id} ${d.symbol}: no minimum in the prompt — skipped`); continue; }
    const ratio = ds / mn.min;
    const snapped = Math.round(ratio) * mn.min;
    const snappedUp = Math.ceil(ratio) * mn.min;
    const delta = ((vs - ds) / ds) * 100;
    const fitsNearest = Math.abs(snapped - vs) < 1e-9;
    console.log(`  #${d.id} ${String(d.symbol).padEnd(16)} desk=${ds} venue=${vs} min=${mn.min}`);
    console.log(`      desk/min = ${ratio.toFixed(4)} -> nearest ${Math.round(ratio)} => ${snapped}   ceil => ${snappedUp}   venue=${vs}  ${fitsNearest ? '✔ FITS nearest' : '✘ does not fit nearest'}`);
    console.log(`      delta = ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%   ${Math.abs(delta) > 2 ? '⚠ EXCEEDS SIZE_TOLERANCE_PCT 2' : 'within tolerance'}`);
    console.log(`      desk plus500PositionId=${d.plus500PositionId}  venue positionId=${v.positionId}  ${String(d.plus500PositionId) === String(v.positionId) ? '✔ EXACT MATCH' : '✘ differ'}`);
    const isMultiple = Math.abs(ds / mn.min - Math.round(ds / mn.min)) < 1e-9;
    rows.push({ id: d.id, symbol: d.symbol, ds, vs, min: mn.min, delta, fitsNearest, idMatch: String(d.plus500PositionId) === String(v.positionId), isMultiple });
  }
  if (rows.length < 3) await fail(`only ${rows.length} open rows compared — expected 3`);
  if (!rows.every((r) => Math.abs(r.delta) > 2)) await fail('not every row exceeds the 2% tolerance — the claim is overstated');
  if (!rows.every((r) => r.fitsNearest)) await fail('the venue size is NOT the nearest multiple in every case — the mechanism claim is void');
  if (rows.some((r) => r.isMultiple)) await fail('a desk size IS already a multiple of the minimum — re-check the "not snapped" claim');
  if (!rows.every((r) => r.idMatch)) await fail('the venue id does not match in every case — the exact-identifier claim is void');
  console.log(`  \u2714 all ${rows.length} rows: venue size = nearest multiple, desk size is NOT a multiple, divergence > 2%, venue id matches exactly`);

  // ── 3. the tolerance constant ────────────────────────────────────────────────────────────────────
  console.log('\n=== 3. the tolerance the recovery path uses ===');
  const u = require('../trading/agent/unconfirmed');
  console.log(`  unconfirmed.SIZE_TOLERANCE_PCT = ${u.SIZE_TOLERANCE_PCT}`);
  if (Number(u.SIZE_TOLERANCE_PCT) !== 2) await fail(`tolerance is ${u.SIZE_TOLERANCE_PCT}, not 2 — the claim is void`);
  // prove the failure directly, using the module's own predicate
  for (const r of rows) {
    const ok = u.sizeMatches(r.ds, r.vs);
    console.log(`  sizeMatches(desk ${r.ds}, venue ${r.vs}) = ${ok}  ${ok ? '(would match)' : '<-- WOULD REFUSE TO MATCH'}`);
    if (ok) await fail(`sizeMatches returned true for ${r.symbol} — the recovery claim is void`);
  }
  console.log('  \u2714 the module\'s own predicate refuses every one of them');

  // ── 4. the row ───────────────────────────────────────────────────────────────────────────────────
  console.log('\n=== the row ===');
  const dup = await q(`SELECT id, state FROM Tasks WHERE name LIKE 'TRD-EXE-3:%'`);
  if (dup.length) { console.log(`  already recorded as #${dup[0].id} (state ${dup[0].state}) — nothing to do.`); await pool.close(); return; }
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
  console.log(`  ✔ created as #${id} state=${back.state} active=${back.active} sortOrder=${back.sortOrder}`);
  const st = await q(`SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = ${EDICT} GROUP BY state`);
  console.log('\nedict 52 by state: ' + st.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
