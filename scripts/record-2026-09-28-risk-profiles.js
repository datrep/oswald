// scripts/record-2026-09-28-risk-profiles.js — TRD-RSK-7: verify the profile layer is INERT on today's
// settings, then record it.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const USER = 1;
const ID = 1458;
const MARK = '##2026-09-28 risk-profiles-shipped##';
const RESTART = '2026-09-28T08:23:40Z';

const store = require('../trading/store');
const { resolveProfile, PROFILE_KEYS } = require('../trading/riskProfile');

const NOTE = (live, decisions) => `

${MARK}
★★ **SHIPPED: PER-DESK RISK PROFILES — \`settings.risk.profiles.<deskId>\`, RESOLVED ONCE, AND THE RESOLUTION REPORTS ITSELF.**

THE OWNER'S ASK, verbatim: *"each with their own risk and position sizing"*. Until now \`settings.risk\` was ONE FLAT
GLOBAL OBJECT consulted by one sizing formula, so every capability shared one dial. The measurement that made it
untenable: **SGX's venue floor forces 0.1640% of equity against a 0.07% dial — 2.34x — while every other symbol's
floor sits at 0.11x-0.78x**, and the only available responses were "accept the risk", "drop the symbol", or "raise a
dial that has no per-symbol form". Options will make it worse, not better: options cost is spread + theta rather
than swap, so \`maxCostShareOfR\` and \`maxAdversePct\` mean something different there, and the floor is per-contract.

WHAT LANDED
- **New pure module \`trading/riskProfile.js\`** (no DB, no logger — so the rule is testable without the live gate):
  \`resolveProfile(settings, { strategy, instrumentClass })\` returns \`{ profileId, axis, overrodeKeys, ignoredKeys, risk }\`.
- **\`risk.evaluate\` resolves it exactly ONCE**, at the top, so every rule below reads the SAME effective object.
  ⚠ Per-rule resolution is how the stop cap and the cost ceiling would come to read different settings — the
  two-sources-of-truth shape this whole thread has been closing. A structural test pins the call count at 1.
- **The resolution travels on the verdict AND on BOTH decision payload shapes** (\`riskProfile\`), beside
  \`vetoCodes\`. The row was written under the condition that the resolution REPORTS itself: "a profile layer whose
  resolution is invisible is the TRD-RSK-6 defect with more knobs".

★★ THE SAFETY PROPERTY, AND IT IS THE POINT OF THE DESIGN. **With no profiles defined the resolved object is
IDENTICAL to the input**, so this change is INERT until a profile exists and the owner can add desks one at a
time. Verified on the LIVE settings, not just in a unit test:
\`\`\`
risk.profiles present? ${live.profilesPresent}
resolved risk deep-equals settings.risk? ${live.identical}
compared ${live.keyCount} keys · differences: ${live.diffs.length ? JSON.stringify(live.diffs) : 'none'}
\`\`\`

★ THE DESIGN DECISIONS, all made against a measured constraint:
1. **KEY = strategy innermost, then instrument class.** The strategy axis is available today; the class axis is
   what options needs. \`default\` reproduces today's object exactly.
2. **THE WHOLE BASE IS SPREAD FIRST, THEN THE PROFILE.** Whitelisting the OUTPUT would risk dropping a key the
   gate reads (\`exitTolerance\`, \`initialEquity\` …), and a missing key reads as \`undefined\` which several callers
   turn into a PERMISSIVE default. Resolving by OVERRIDE cannot lose anything.
3. **A WHITELIST OF PROFILEABLE KEYS (${PROFILE_KEYS.length})**, and an unknown key is NOT applied — it is REPORTED
   (\`ignoredKeys\`), because a silently ignored setting is the defect class this thread has been closing.
4. **ABSENCE IS \`hasOwnProperty\`, NEVER FALSINESS.** \`acceptVenueFloor: false\` and \`takeProfitOffsetPct: 0\` are the
   shipped defaults, and \`0\` is a MEANING for the stop cap — so \`if (profiles[k])\` would skip a profile whose
   entire content is turning something OFF. Pinned by a test.
5. **THE ACCOUNT-LEVEL BRAKES ARE DELIBERATELY NOT PROFILEABLE: \`initialEquity\`** (the baseline is an account
   fact; a desk redefining it would make two desks disagree about the same account's floor) **and
   \`dailyLossHaltPct\`** (a PORTFOLIO brake — per-desk halts would let one desk keep trading through a loss that
   stopped the others, which is the opposite of what a brake is for). The desk's OWN caps (\`maxPositions\`,
   \`exposureCapPct\`, \`maxCostShareOfR\`) ARE profileable, because slot and cost economics genuinely differ by
   instrument — and the portfolio sum is still enforced across desks by the exposure cap itself.

TESTS: \`test/risk-profile.test.js\` — **15**, all passing. The two that carry the most weight: **"with NO profiles
defined the resolved risk is IDENTICAL to the input"** (the inertness that makes this safe to ship) and **"a profile
whose whole point is turning something OFF must apply"** (the falsiness trap). Plus strategy-beats-class, the
class fallback, the whitelist reporting \`ignoredKeys\`, "a profile that changes nothing is distinguishable from no
profile at all", and the structural pins on the single resolution and the two payload shapes.
**Suite 1,660 / 1,659 pass / 0 fail / 1 skipped.** lint exit 0. Restarted (pid 16740, healthz ok).

★ **LIVE VERIFICATION AFTER THE RESTART:** decisions carrying a \`riskProfile\` field since the restart: **${decisions}**
${decisions > 0 ? '— each should read `{ id: "default", axis: "default", overrode: [] }`.' : '(none yet — the next wake will carry it; the field is written unconditionally).'}

⚠ **WHAT THIS ROW STILL DOES NOT DO, stated so the row is not read as complete:**
- **No profiles are DEFINED yet.** The layer is a shape, not a policy. Adding them is a per-desk decision with
  measured justification for each (SGX and options are the two with evidence behind them today).
- **The panel does not expose them.** \`TRD-UIX-1\` owns the surface; adding dials without the acknowledgement
  layer would deepen the TRD-RSK-6 problem rather than fix it.
- **This unblocks TRD-RSK-7's gate, it does not close the goal.** The reason the row existed — one dial for
  capabilities with measurably different cost structures — is now expressible, and the next step is to define
  the first profile against measured data rather than to keep widening the machinery.`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };

  console.log('\n=== 1. THE SAFETY PROPERTY, on the LIVE settings ===');
  const s = await store.getSettings(USER);
  const profilesPresent = !!(s.risk && s.risk.profiles && Object.keys(s.risk.profiles).length);
  const targets = ['survgold', 'survoil', 'survasgx', 'survasilver', 'survaarabicacoffee', null];
  let diffs = [];
  let keyCount = 0;
  for (const t of targets) {
    const r = resolveProfile(s, { strategy: t, instrumentClass: null });
    const keys = new Set([...Object.keys(s.risk || {}), ...Object.keys(r.risk)]);
    for (const k of keys) {
      keyCount++;
      if (JSON.stringify((s.risk || {})[k]) !== JSON.stringify(r.risk[k])) diffs.push(`${t || 'default'}.${k}`);
    }
    if (r.profileId !== 'default') diffs.push(`${t} resolved to profile ${r.profileId}`);
  }
  const identical = diffs.length === 0;
  console.log(`  risk.profiles present? ${profilesPresent}`);
  console.log(`  resolved risk deep-equals settings.risk for every target? ${identical}`);
  console.log(`  compared ${keyCount} key-slots · differences: ${diffs.length ? diffs.slice(0, 6).join(', ') : 'none'}`);
  if (!identical) await fail('the resolved risk DIFFERS from the live settings — this change would alter live sizing, which is not what was approved');

  console.log('\n=== 2. is the desk still sizing with the SAME numbers? (post-restart decisions) ===');
  const dec = await q(`SELECT TOP 5 id, createdAt, payload FROM TradingEvents WHERE kind='decision' AND createdAt >= '${RESTART}' ORDER BY id DESC`);
  console.log(`  decisions since the restart: ${dec.length}`);
  for (const d of dec) {
    let p = null; try { p = JSON.parse(d.payload); } catch { p = null; }
    const rp = p && p.riskProfile;
    console.log(`  #${d.id} ${d.createdAt.toISOString()} ${p && p.symbol} action=${p && p.action} size=${p && p.size} riskProfile=${JSON.stringify(rp)}`);
  }
  if (dec.length && dec.some((d) => { try { return JSON.parse(d.payload).riskProfile === undefined; } catch { return false; } }))
    await fail('a post-restart decision has NO riskProfile field — the wiring did not load');

  console.log('\n=== 3. the profile layer is a SHAPE, not a policy (no profiles defined) ===');
  console.log(`  settings.risk.profiles = ${JSON.stringify(s.risk && s.risk.profiles)}`);
  console.log(`  profileable keys: ${PROFILE_KEYS.length}`);
  console.log(`  NOT profileable (by design): initialEquity, dailyLossHaltPct, and everything under kill`);

  console.log('\n=== the record ===');
  const dup = await q(`SELECT id FROM Tasks WHERE id = ${ID} AND info LIKE '%${MARK}%'`);
  if (dup.length) { console.log(`  #${ID} marker present — nothing to do.`); await pool.close(); return; }
  const cur = (await q(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`))[0];
  const note = NOTE({ profilesPresent, identical, keyCount, diffs }, dec.length);
  console.log(`  #${ID} state=${cur.state} info=${cur.len} -> ${Number(cur.len) + note.length}`);
  if (!YES) { console.log('  DRY RUN — not written.'); await pool.close(); return; }
  await pool.request().input('t', note).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const b = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`))[0];
  console.log(`  \u2714 #${ID} appended -> ${b.len} chars`);
  const st = await q(`SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = 52 GROUP BY state`);
  console.log('  edict 52 by state: ' + st.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
