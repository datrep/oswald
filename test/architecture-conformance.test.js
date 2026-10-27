// test/architecture-conformance.test.js — 2026-10-27.
//
// MECHANICAL DRIFT DETECTION. This exists because a model writing code from a context window cannot see that it has
// already answered a question elsewhere: per-symbol facts ended up with SIX producers and five shapes, and the risk
// dials are read in ELEVEN modules. A wiki page describing a rule does not stop that. A test that fails the build
// does.
//
// ⚠ IT IS A RATCHET, NOT A BIG-BANG. Every invariant carries an explicit `KNOWN` list of the violations that exist
// TODAY. The test fails in two directions:
//   · a file appears that is not listed        -> NEW drift, fix the code or justify the entry
//   · a listed file no longer violates         -> the list must SHRINK, delete the entry
// That second direction is the point. An allowlist nobody prunes becomes the permission slip that outlives its
// reason, and the count of known violations is the honest measure of how far the cleanup has got.
//
// The scan is deliberately textual and crude. A real AST check would be better and is the eventual home for this
// (see docs/adr/0003-per-symbol-resolution.md), but a crude check that RUNS beats an elegant one that doesn't
// exist — and every rule below is a distinctive identifier, not a regex over prose.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'trading');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p, out); continue; }
    if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Comments must not be able to satisfy or violate a rule — several of these files DISCUSS the pattern at length,
// and a scan that counts prose would be measuring the documentation.
//
// ⚠⚠ THE FIRST VERSION WAS ONE REGEX PAIR, AND IT SILENTLY DELETED 223 LINES OF `plus500/calendarCapture.js`. A URL
// glob inside a STRING — `/action/inter/*` — contains `/*`, so the block-comment regex opened there and closed at the
// next `*/`, which was on line 229. Everything between went with it, including `INSERT INTO CalendarEvents` on line
// 212. Invariant C then found no writer for that table, took its `continue` branch ("writer lives elsewhere"), and
// reported a PASS. Two silent failures stacked: a scanner that is not string-aware, and a test that reads an absent
// measurement as a clean result.
//
// So this walks the source instead of regexing it. Quotes and template literals are copied verbatim and comment
// markers are honoured only OUTSIDE them. A regex literal containing `//` remains a false positive, noted rather than
// solved — no rule below keys on an identifier distinctive enough to appear inside one.
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        out += src[i];
        if (src[i] === '\\') { out += src[i + 1] || ''; i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// ---------------------------------------------------------------------------------------------
// INVARIANT A — per-instrument FACTS have one producer: agent/instruments.js
//
// `instruments.resolve` / `venueCostFacts` are the authoritative readers of what is true about an instrument.
// Anywhere else that builds a per-symbol table of price/point/size facts is a second producer, and the two can
// disagree silently — which is exactly how the backtest ended up pricing against a basis the live desk never paid.
// ---------------------------------------------------------------------------------------------
const PER_SYMBOL_FACT_PATTERNS = [
  /pointValueBySymbol\s*\[/,        // building a symbol -> point-value table inline
  /costCfgFor\s*\(/,                // the backtest's own cost basis
  /instrumentCurrencyOf\s*\(/,      // quote-currency lookup by symbol
];

// ⚠ SCOPE: THE RUNTIME PATH ONLY. `scripts/repro/*` and `agent/lab/*` are research and analysis code, and a study
// that prices its own cost basis is doing its job — several of the repro scripts below legitimately rebuild a cost
// model to test it. The rule applies to modules ON the decision or ledger path: `trading/agent/**`,
// `trading/plus500/**` and `trading/*.js`, minus `lab/` and `scripts/`. Without that boundary the invariant fires
// on fifteen files instead of nine and becomes noise nobody reads, which is how an allowlist dies.
const IS_RUNTIME = (r) => !/^(scripts|agent\/lab)\//.test(r);

const INVARIANT_A_KNOWN = [
  // ⚠ THE ONE THAT MATTERS: `stopPolicy.adverseStopCap` calls `backtest.costCfgFor(symbol)` on the LIVE decision
  // path, so the live stop-cap floor is computed from the same static basis the backtest uses, with no cross-check
  // against the venue. Measured 2026-10-27: `InstrumentQuotes` has not been captured since 2026-10-01, so
  // `instruments.venueCostFacts` returns a NULL spread for every symbol and the live basis is unverifiable.
  'agent/stopPolicy.js',
  'agent/backtest.js',        // owns costCfgFor — the offline basis, read by the line above
  'agent/analytics.js',
  'agent/trd26.js',
  'agent/venueClose.js',      // funding clock looked up per symbol inline
  'agent/accountCurrency.js', // instrumentCurrencyOf — a fact that belongs on instruments.resolve
  'agent/aggregator.js',      // pointValueBySymbol built inline from the open book
  'agent/risk.js',            // reads pointValueBySymbol the aggregator built
  'routes.js',                // reads the same
];

test('A: per-instrument facts are not re-derived outside instruments.js', () => {
  const violating = [];
  for (const file of walk(ROOT)) {
    const r = rel(file);
    if (r === 'agent/instruments.js') continue;
    if (!IS_RUNTIME(r)) continue;
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    if (PER_SYMBOL_FACT_PATTERNS.some((re) => re.test(src))) violating.push(r);
  }
  const unknown = violating.filter((v) => !INVARIANT_A_KNOWN.includes(v));
  assert.deepStrictEqual(unknown, [],
    `NEW per-symbol fact producer(s): ${unknown.join(', ')}. Import the resolver from agent/instruments instead, `
    + 'or add the file to INVARIANT_A_KNOWN with a reason in docs/adr/0003-per-symbol-resolution.md.');

  const stale = INVARIANT_A_KNOWN.filter((k) => !violating.includes(k));
  assert.deepStrictEqual(stale, [],
    `These no longer violate the rule and must be REMOVED from INVARIANT_A_KNOWN: ${stale.join(', ')}. `
    + 'A ratchet that only ever grows is a permission slip.');
});

// ---------------------------------------------------------------------------------------------
// INVARIANT B — the latch is written in exactly one module
//
// `bridge.paused` / `pausedSince` / `lastFailAt` are one fact: whether the bridge is usable, and since when. Four
// modules contributed to the old behaviour — health decided and wrote, aggregator enforced, selfHealth printed the
// age, killswitch documented the alert rule — and because the field was rewritten elsewhere the panel reported a
// pause minutes old for one latched for hours.
// ---------------------------------------------------------------------------------------------
const LATCH_WRITE = /bridge\s*:\s*\{[^}]*paused\s*:/;
const INVARIANT_B_KNOWN = ['store.js']; // the DEFAULT_SETTINGS seed declares the shape; it does not write the latch

test('B: the bridge latch is written only by plus500/health.js', () => {
  const violating = [];
  for (const file of walk(ROOT)) {
    const r = rel(file);
    if (r === 'plus500/health.js') continue;
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    if (LATCH_WRITE.test(src)) violating.push(r);
  }
  const unknown = violating.filter((v) => !INVARIANT_B_KNOWN.includes(v));
  assert.deepStrictEqual(unknown, [],
    `NEW writer of the bridge latch: ${unknown.join(', ')}. Only plus500/health.js may write it — everything else `
    + 'reads it, or the start time and the last-failure time will drift apart again.');
  const stale = INVARIANT_B_KNOWN.filter((k) => !violating.includes(k));
  assert.deepStrictEqual(stale, [], `Remove from INVARIANT_B_KNOWN (no longer a violator): ${stale.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------
// INVARIANT C — every ledger write names its own dedupe key
//
// Three ledgers now insert append-only rows (NewsItems, CalendarEvents, AnalysesNotes). A re-capture must be
// idempotent, and the only thing that makes it so is a deterministic hash checked with NOT EXISTS. A new ledger
// that forgets the guard duplicates its whole table every cycle, which looks like "the feed is busy" rather than
// "the writer is wrong".
// ---------------------------------------------------------------------------------------------
// ⚠ THE MECHANISM IS PER ROLE, NOT ONE RULE FOR FIVE TABLES. This list used to hold three of the five that
// `AGENTS.md` §4 named, with nothing saying why the other two were absent — so a reader who trusted the doc and
// checked the test found a silent gap, and a reader who trusted the doc and did not check found a rule the code
// broke twice. Both omissions were real, and they are not the same defect:
//   · `FeatureEpochs` is idempotent by `MERGE` on its natural key, not by hash + NOT EXISTS;
//   · `TradingEvents` is an append-only EVENT LOG where repeats are legitimate (one boot event per boot), so its
//     guard is the CALLER's — `agent/constraintAudit.js` dedupes on tradeId + rulesVersion before it appends.
// Enumerating all five with their own mechanism is what stops the omission being silent again.
const LEDGERS = [
  { table: 'NewsItems', file: 'agent/newsAggregator.js', mechanism: 'hash_guard' },
  { table: 'CalendarEvents', file: 'plus500/calendarCapture.js', mechanism: 'hash_guard' },
  // ⚠ THE WRITER IS `store.js`, NOT `plus500/analysesCapture.js`. The capture module CALLS `insertAnalysesNote`; the
  // INSERT lives in the store. The old entry named the caller, the `continue` below forgave it, and the table has
  // never been checked. Same shape as the CalendarEvents miss: a wrong path plus a forgiving branch equals a pass.
  { table: 'AnalysesNotes', file: 'store.js', mechanism: 'hash_guard' },
  // The writer still owns idempotence here; only the syntax differs from the three above.
  { table: 'FeatureEpochs', file: '../scripts/sync-feature-epochs.js', mechanism: 'merge_on_key' },
  // Writer-side guard ABSENT ON PURPOSE. This entry asserts the ABSENCE, so the exemption is stated rather than
  // assumed — and so that adding a global hash guard here fails the build, because it would drop legitimate
  // repeats (a boot per boot) and the doc would then be wrong in the other direction.
  { table: 'TradingEvents', file: 'store.js', mechanism: 'caller_owned' },
];

// ⚠ EMPTY AS OF 2026-10-27, AND IT STAYED BECAUSE IT WILL BE NEEDED AGAIN. It held one entry — `AnalysesNotes` — for
// a few hours: a CAPTURE ledger that owed the writer-owned hash + NOT EXISTS guard and had neither (a plain
// `INSERT ... VALUES`, with no check in its caller; measured 163 rows over 34 distinct titles). It was listed rather
// than reclassified `caller_owned`, because relabelling a violated rule until the check passes is the move §6 exists
// to catch. Migration 054 added `rowHash` plus a FILTERED unique index — filtered so the 163 legacy rows, which all
// carry NULL, needed no rewrite: a migration that deleted duplicates to make the index fit would have broken §4 to
// enforce §4 — and `store.insertAnalysesNote` now hashes the observation and guards on it.
const HASH_GUARD_KNOWN = new Set();

// ⚠⚠ THE UNIT OF ASSERTION IS ONE STATEMENT, NOT ONE FILE, AND THE FIRST RUN OF THIS TEST IS WHY. `store.js` is
// 1,700 lines and appends TWO of these tables, so a file-level guard test reads one table's guard and reports it
// against the other — which it did: `TradingEvents` came back as "now guards with NOT EXISTS" because
// `insertAnalysesNote` had grown one sixty lines away. A guard is a property of the statement that appends the row.
//
// The statement ends at the delimiter of the literal holding it, because `stripComments` copies string literals
// verbatim. The floor is a safety net for a query written without one, not an expected path.
function statementOf(src, table) {
  const m = new RegExp(`(INSERT INTO|MERGE)\\s+${table}\\b`, 'i').exec(src);
  if (!m) return null;
  const rest = src.slice(m.index);
  const end = rest.search(/[`'"]/);
  if (end >= 40) return rest.slice(0, end);
  return rest.slice(0, 1500);
}

test('C: every append-only ledger names its own dedupe mechanism — and has it', () => {
  for (const { table, file, mechanism } of LEDGERS) {
    const p = path.join(ROOT, file);
    // ⚠ A MISSING WRITER IS A FAILURE, NOT A SKIP. The first version of this test `continue`d when the file was
    // absent, so renaming a writer silently retired its guard — an absent measurement reading as a clean result.
    assert.ok(fs.existsSync(p), `${file} is listed as the writer of ${table} and does not exist — update LEDGERS`);
    const stmt = statementOf(stripComments(fs.readFileSync(p, 'utf8')), table);
    assert.ok(stmt, `${file} does not write ${table} — LEDGERS is stale`);

    if (mechanism === 'hash_guard') {
      const guarded = /NOT EXISTS/i.test(stmt) && /itemHash|rowHash/.test(stmt);
      if (HASH_GUARD_KNOWN.has(table)) {
        assert.ok(!guarded,
          `${table} now HAS the guard — delete it from HASH_GUARD_KNOWN, or the debt count stops meaning anything`);
        continue;
      }
      assert.ok(/NOT EXISTS/i.test(stmt),
        `${file} appends ${table} without a NOT EXISTS guard — a re-run duplicates the table`);
      assert.ok(/itemHash|rowHash/.test(stmt),
        `${file} appends ${table} without a deterministic hash column — dedupe cannot be stable`);
    } else if (mechanism === 'merge_on_key') {
      assert.ok(/ON\s+t\.\w+\s*=\s*s\.\w+/i.test(stmt),
        `${file} MERGEs ${table} without a natural-key match — that is an insert wearing a MERGE`);
    } else if (mechanism === 'caller_owned') {
      assert.ok(!/NOT EXISTS/i.test(stmt),
        `${file} now guards ${table} with NOT EXISTS — legitimate repeats will be dropped. Update AGENTS.md §4 `
        + 'and this entry, or remove the guard.');
    } else {
      assert.fail(`unknown dedupe mechanism "${mechanism}" for ${table}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// INVARIANT D — the SQL TYPE HANDLES have one source: `trading/db.js`
//
// ⚠ WHY THIS EXISTS. `require('mssql')` from anywhere under `trading/` resolves to
// `trading/node_modules/mssql`, a DIFFERENT instance from the one the pool was built with, so passing its type
// classes (`sql.Int`) to `pool.request().input()` fails. `agent/waker.js` has documented the trap since it was
// found the hard way.
//
// Measured 2026-10-26: a new `lastRunAt()` reached for `require('mssql').Int`, threw on EVERY call, and the caller
// swallowed it — so the boot log reported "never_reconciled" beside three events that existed. A PLAUSIBLE wrong
// reason is worse than a loud failure: nothing looked broken. The rule is mechanical, so it is enforced
// mechanically rather than left to the next reader's memory.
// ---------------------------------------------------------------------------------------------
test('D: no library code under trading/ takes its own `mssql` handle — the pool owns the type classes', () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    const r = rel(file);
    // `scripts/` may open its own connection on purpose; `db.js` IS the source of the handle.
    if (r === 'db.js' || r.startsWith('scripts/')) continue;
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    if (/require\(\s*['"]mssql['"]\s*\)/.test(src)) offenders.push(r);
  }
  assert.deepStrictEqual(offenders, [],
    'these files require mssql directly and will get a different type-class instance than the pool: ' + offenders.join(', '));
});
