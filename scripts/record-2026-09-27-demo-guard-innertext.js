// scripts/record-2026-09-27-demo-guard-innertext.js — the demo guard that stopped the desk for two days.
// Dry by default:  node scripts/record-2026-09-27-demo-guard-innertext.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 demo-guard-innertext##';
const NAME = 'TRD-GRD-7: Capture integrity — the demo guard read innerText for "switch to real money", which sits in a '
  + 'COLLAPSED account menu, so a healthy demo session read as real-money and not_demo stopped the desk ~2 days';

const INFO = `
${MARK}
★★★ **A TWO-DAY OUTAGE WITH A ONE-LINE CAUSE, AND THE SYMPTOM POINTED AT THE WRONG SUBSYSTEM.** The desk
stopped capturing prices and stopped placing orders on 2026-09-25 and did not recover. Every visible signal
said "the Plus500 session is signed out": \`watchdog_login_death\` every ~5 minutes, \`self_health\` = bad, and a
Health card reading **"Plus500 login: ok"** from a stale verdict. **The session was fine the whole time.**

**THE DEFECT.** \`plus500/webtrader.js\`:

    pageText(page, max) = document.body.innerText.slice(0, max)          // ~line 126
    const demo = text.toLowerCase().includes('switch to real money');     // ~line 191, in assertDemo

The demo marker is the literal string **\`switch to real money\`**, and it lives in the **account menu** —
\`connector/browser.js\` says so in its own comment: *"The demo marker lives on trade pages."* **\`innerText\`
OMITS hidden and unrendered elements**, so a **COLLAPSED** menu contributes nothing to it, while the same text
is fully present in \`textContent\`. On any page whose account menu was closed, the guard reported
**"demo marker NOT found"** on a page that is demonstrably a DEMO account.

**WHY THAT STOPPED THE DESK, not merely a check.** \`not_demo\` is **fail-closed at FOUR call sites**:
\`capture.js:579\` (tick capture), \`connector/browser.js:196\` (the order path), \`discoverer.js:107\`, and
\`routes.js:1428/1438\` (watchlist open). So one false negative stops price capture AND order placement.

★★★ **WHY THE SYMPTOM MISLED, WHICH IS THE PART WORTH REMEMBERING: THE ACCOUNT BANNER KEPT RENDERING.**
\`readAccount\` parses the visible header labels (\`Available\`, \`Equity\`, \`M. Margin\`, \`P/L\`), and those ARE
rendered text — so the desk kept returning a plausible balance (4,111.45) **while every other read was
refused**. A stale-but-plausible equity on the Health card, beside a refusal everywhere else, is
indistinguishable from a dead session by inspection. **It was diagnosed for two days as a login problem,
including a hypothesis about Plus500's one-login limit and a phone session, and none of that was the cause.**
The decisive evidence was the owner's screenshot: the account strip rendering S$4,111.45 Available/Equity
proves the session is signed in.

★ **THE FIX, AND WHY IT CANNOT WEAKEN THE GUARD.** \`assertDemo\` now searches \`pageTextIncludingHidden\` —
\`innerText\` concatenated with \`textContent\`. The safety argument is the one **already written into this
function** when an earlier fix widened the search from 5,000 characters to the whole body:

> *"This cannot weaken the guard: the marker only ever appears on a DEMO account, so searching more text can
> only ever find a real demo marker, never invent one. A real-money account still fails closed."*

**That argument holds verbatim for \`textContent\`** — it can only surface MORE of the SAME page's own text.
On a real-money account the menu offers *"switch to demo"*, so the demo-only string is still absent and the
guard still refuses. ⚠ \`textContent\` is a SUPERSET and is much noisier (scripts, styles, hidden nodes), so it
is used **only** for this one exact-string check; \`pageText\` is deliberately left as \`innerText\` for the
callers that parse layout or read rendered values.

★★ **ALSO FIXED IN PASSING, AND IT IS THE SAME DEFECT CLASS: THE HEALTH CARD RENDERED A STALE VERDICT AS A
CURRENT ONE.** \`trading/public/js/app.js\` shows the login chip straight from the watchdog's last opinion with
**no age at all**, while **two lines below it** the identical staleness was **already fixed for the wake line**:

> \`// F4: the age of the verdict this card is showing. It renders the newest 'wake' event REGARDLESS of age,\`
> \`// so without this the reason line is read as what the desk is doing now rather than what it did.\`

So the desk knows this failure mode, fixed it once on this card, and left it on the line beside it. That is
why "ok" was believed. **The card must render the verdict's age, and go visibly stale.**

⚠ **WHAT IS AND IS NOT PROVEN.** After the restart at 19:15:58Z: **\`not_demo\` fired every ~1.5 minutes
before and has fired ZERO times since**, no errors of any kind, and an account read succeeded at 19:16:02Z.
**TICKS ARE NOT YET PROVEN** — the market is closed until 21:00Z, so no ticks are expected regardless. The
decisive proof is the first \`plus500\` tick after the open, and until it arrives this row stays OPEN.

★ **AND THE PRE-FLIGHT GATE HAD THE SAME DISEASE, found by using it.** \`trading/scripts/pre-open-preflight.js\`
required \`plus500 tick is LIVE\` at every run — **but the venue only ticks while the market is OPEN**, and the
runbook schedules it at T-15min with the venue closed since Friday. **The check could not pass on a healthy
desk**, so the gate would have reported NOT CLEAR TO OPEN for the wrong reason. It now reads the market state
first: closed → the tick check is **NOT APPLICABLE** and the *account read* is the observable proof that the
bridge can be read; open → the tick is **REQUIRED**. Same for \`position_read_mode\`: \`rows_on_page\` is
unreachable on a genuinely flat book (the venue renders "You have no open positions"), so
\`flat_corroborated\` is now accepted. **A gate that always fails is a gate that gets ignored.**
`;

(async () => {
  const pool = await getPool();
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%' OR name LIKE 'TRD-GRD-7:%'`);
  const mx = await pool.request().query('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks');
  const sortOrder = Number(mx.recordset[0].m) + 1;
  // ⚠⚠ `Tasks.name` IS `nvarchar(510)` = 255 CHARACTERS, and SQL Server reports `max_length` in BYTES. My first
  // name here was 258 chars and the INSERT was rejected with "String or binary data would be truncated" —
  // nothing written, but the failure was AVOIDABLE, and I had already built this exact guard earlier today
  // (temp/retitle-1422.js) and did not reuse it. Read the limit from the schema and check against it rather
  // than discovering it by hitting it. `info` is nvarchar(max) and unaffected.
  const meta = await pool.request().query(`
    SELECT c.max_length, t.name AS typ FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
    WHERE c.object_id = OBJECT_ID('dbo.Tasks') AND c.name = 'name'`);
  const LIMIT = meta.recordset[0].typ === 'nvarchar' ? meta.recordset[0].max_length / 2 : meta.recordset[0].max_length;
  console.log(`Tasks.name limit ${LIMIT} chars; candidate ${NAME.length} ${NAME.length <= LIMIT ? 'OK' : '*** TOO LONG ***'}`);
  if (NAME.length > LIMIT) { console.error(`refusing to write: ${NAME.length} > ${LIMIT}`); await pool.close(); process.exit(1); }
  console.log(`name ${NAME.length} chars, info ${INFO.length} chars, sortOrder ${sortOrder}`);
  console.log(NAME);
  if (dup.recordset.length) { console.log(`\nalready recorded as #${dup.recordset[0].id} — nothing to do.`); await pool.close(); return; }
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }
  // ⚠ `plannedStart` MUST be UTC or the computed `active` flag reads Inactive for 8 hours (edict-52 rule).
  const ins = await pool.request()
    .input('name', NAME).input('info', INFO).input('plannedStart', new Date()).input('sortOrder', sortOrder)
    .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
            OUTPUT INSERTED.id
            VALUES (@name, @info, @plannedStart, 1, 1, 52, @sortOrder, SYSUTCDATETIME())`);
  console.log(`\n✔ created TRD-GRD-7 as #${ins.recordset[0].id}`);
  const s = await pool.request().query('SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = 52 GROUP BY state');
  console.log('edict 52 by state: ' + s.recordset.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
