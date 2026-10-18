// scripts/record-2026-09-27-llm-cost-ledger.js — TRD-LLM-1 (#1411): the money half of the LLM ledger.
// Dry by default:  node scripts/record-2026-09-27-llm-cost-ledger.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 llm-cost-ledger##';
const ID = 1411;

const ADD = `

${MARK}
★★★ **BUILT: the desk now records what a call COST, not only how many tokens it used. The question
"do the LLMs pay for themselves" is answerable from the record instead of by whoever does the converting.**

★★ **THE GAP, MEASURED.** \`JSON_VALUE(payload,'$.costUsd')\` is populated on **0 of 2,233** \`llm_usage\` rows.
There was no price anywhere in \`settings.budget\` (\`totalDaily\`, \`perConsumer\`, \`warnPct\`, \`boostUntil\` — no
rate). So every cost statement was a per-report conversion with a rate that lived in the report.

★★★ **AND THE PRICE IS IMPLEMENTABLE, WHICH THIS ROW DID NOT KNOW: the meter ALREADY records the cache split.**
TRD-107 kept it deliberately —

    {"consumer":"review","completionTokens":404,"promptTokens":739,
     "promptCacheHitTokens":512,"promptCacheMissTokens":227, ...}

— so the THREE-rate price this row's own estimate used (hit / miss / output) reads straight off stored rows. A
single blended $/M would have discarded the split the desk went to the trouble of preserving.

**WHAT SHIPPED** (\`trading/agent/budget.js\`, \`trading/store.js\`, \`trading/routes.js\`, \`test/llm-cost-ledger.test.js\`):

  · \`settings.budget.pricing = { inputHitPerM, inputMissPerM, outputPerM }\`, shipped **\`null\` ON PURPOSE**.
  · \`pricingOf(settings)\` / \`costOf(tokens, pricing)\` — pure, so a stored row can be re-priced.
  · \`record()\` prices the call **AT WRITE TIME** and stores \`costUsd\` **plus \`pricingUsed\`** — the rate that
    produced it — so a later rate change cannot rewrite what an earlier call cost, and the stored number stays
    RE-DERIVABLE (token x rate must return the row's own cost). Same discipline as the recorded policy epoch.
  · \`spend(userId,{since})\` — the money reader, which reports its own coverage.
  · \`breakevenRatePerM({gainUsd, tokens})\` — the desk-owned form of the answer: a rate, not a verdict.
  · \`GET /api/trading/llm/spend\` (declared \`diagnostic\` in \`test/ui-routes.test.js\`).

★★★ **AND NOBODY IS ALLOWED TO RENDER "UNPRICED" AS "FREE".** The defect class this codebase keeps paying for
is an absent value drawn as a zero, so the code writes NOTHING where it does not know:

    no price  -> payload has NO costUsd key at all, and carries \`unpriced: true\` (an explicit marker)
    price set -> payload carries costUsd AND pricingUsed

\`spend()\` therefore splits every call into exactly three buckets and **never folds them into one total**:
\`pricedCalls\` (contribute money), \`unpricedCalls\` (no rate configured — **NOT zero**), and \`preCostEraCalls\`
(written before the field existed — **NOT zero**). A single "spend" that swallowed the last two would report an
unpriced era as a cheap one, which is precisely the TRD-77 shape (a blank era rendered as a quiet one).

**VERIFIED LIVE** on the running desk: \`pricing: null\`, \`costUsd: 0\`, coverage **priced 0 / unpriced 0 /
pre-cost-era 500**, and **500 of 500 calls classified** — no call silently outside the accounting. The page is
saturated (\`fetched 500 / cap 500, truncated: true\`), reported rather than presented as a total. Spend over that
page: **949,847 tokens — chair 420,194 (44%), review 344,481 (36%), shadow 97,675, pulse 47,800, binding 38,538,
digest 1,159.** Tests: **8**, suite **1,533 / 1,532 pass / 0 fail / 1 skipped**.

★★★ **TWO ERRORS OF MINE, BOTH CAUGHT BY VERIFICATION RATHER THAN BY REVIEW, AND THE FIRST IS THE EXACT DEFECT
THIS ROW EXISTS TO FIX:**

  1. **\`Number(null) === 0\` MADE A MISSING RATE A *FREE* BUCKET.** My first \`pricingOf\` used
     \`Number(p.inputHitPerM)\` guarded by \`Number.isFinite(v) && v >= 0\`. **\`Number(null)\` is \`0\`, which passes
     both tests** — so \`inputHitPerM: null\` priced every cache HIT at zero, letting a half-configured price
     through and reporting the desk's cheapest tokens as costing nothing. Caught by **my own test**, which
     asserted that a half-configured price must return \`null\` and got \`{inputHitPerM: 0, ...}\` instead. Fixed by
     refusing null/''/boolean/object BEFORE coercing — the same treatment \`exitLevels.num()\` documents for
     \`Number(null) === 0\` turning a missing fill into a zero-price geometry, and the same shape as TRD-96's
     absent cap rendering as "0% used". **A guard that admits the absent value is not a guard.**

  2. **★★ THE BREAKEVEN RATE WAS WRONG BY A FACTOR OF 95.** My first route derived the gain from
     \`settings.risk.initialEquity\` and printed **1429.51** where the true figure is **~113.21**: \`initialEquity\`
     (2685.76) is a **RISK BASELINE for the daily-loss halt, NOT the account's opening balance** (4002.51). That
     put the breakeven rate at **$1504.99/M instead of $15.91/M**, and its whole story is "the LLM spend cannot
     possibly matter" — a conclusion built on a number that means something else. Caught by checking the
     endpoint against **this row's own published figure**.
     ⚠ **AND MY SECOND ATTEMPT WAS ALSO UNSAFE**: reaching for the equity curve instead assumes there is one such
     curve, and there are **TWO** (\`EquitySnapshots\` via \`listEquity\`, \`EquityTicks\` via \`listEquityTicks\`) which
     open at different values, while \`listEquity\` **silently clamps \`limit\` to 5000**. So the gain is now a
     **CALLER-SUPPLIED** \`?gainUsd=\` and its absence is STATED rather than guessed: *the desk records the tokens
     and the cost; it does not choose which equity series is "the" gain, because it holds two and they disagree.*
     Verified: \`?gainUsd=113.21\` returns the rate computed over the queried page, and the shape matches the
     hand figure this row published.

⚠ **WHAT IS DELIBERATELY NOT DONE: no default rate.** Shipping \`{inputHitPerM: 0.07, ...}\` as a default would be
an invented number, and it is the one value the desk does not own — the row itself says the DeepSeek-class list
is "an EXTERNAL rate, given only to size the answer". The shape is documented in \`store.js\` as an example and the
default stays \`null\`, so the desk reports **"unpriced"** until the owner sets a rate. **The owner's decision this
row was waiting on is therefore the RATE ITSELF** — everything downstream of it now works.
`;

(async () => {
  const pool = await getPool();
  const cur = await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`);
  if (!cur.recordset.length) { console.error(`#${ID} not found`); process.exit(1); }
  const c = cur.recordset[0];
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%'`);
  console.log(`#${ID} state=${c.state} info=${c.len}${dup.recordset.length ? '  [marker present]' : ` -> ${Number(c.len) + ADD.length}`}`);
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }
  if (dup.recordset.length) { console.log('marker present — nothing to do.'); await pool.close(); return; }
  await pool.request().input('t', ADD).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const back = await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`);
  console.log(`✔ #${ID} appended -> ${back.recordset[0].len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
