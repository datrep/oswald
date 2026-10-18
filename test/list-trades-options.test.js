// test/list-trades-options.test.js — a filter that is accepted and thrown away is worse than no filter.
//
// ★ THE DEFECT. `listTrades(userId, { status: 'open' })` is the natural way to ask "is the book flat?" before
//   touching a running service. The function took `{ limit }` and ignored everything else, so it returned the
//   most recent rows REGARDLESS of status — and listed closed and rejected trades as live positions. It did
//   exactly that on this desk: a pre-restart check reported **20 open trades** against a book with **no open
//   rows at all**.
//
// ★ THIS IS THE THIRD INSTANCE OF ONE CLASS, which is why the fix rejects unknown keys rather than only
//   implementing `status`:
//     1. `/analytics/strategies?days=N` reached a `drift()` that hardcoded 30 days.
//     2. An omitted `minBars` in `resolveStructureVenue` silently selected the fallback (`x >= undefined` is false).
//     3. `listTrades` ignored every option but `limit`.
//   In all three, the caller believed it had controlled something. A fourth is prevented the same way each time:
//   make the absent/unknown case an ERROR instead of a default.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { listTrades } = require('../trading/store');

const codeOnly = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

test('★ an UNKNOWN option is rejected, not ignored — the defect class made impossible', async () => {
  // The validation runs BEFORE the pool is opened, so this needs no database and cannot pass by accident.
  await assert.rejects(() => listTrades(1, { status2: 'open' }), (e) => e instanceof RangeError && /status2/.test(e.message));
  await assert.rejects(() => listTrades(1, { symbol: 'Gold' }), RangeError);
  await assert.rejects(() => listTrades(1, { limit: 10, bogus: 1 }), RangeError);
});

test('the accepted set is explicit, so adding a filter is a deliberate act', () => {
  const src = codeOnly('trading/store.js');
  assert.match(src, /const LIST_TRADES_OPTS = \['limit', 'status'\];/,
    'the accepted options must be a named list — an inline check drifts as the function grows');
  // And the filter must actually reach SQL, not merely be validated.
  assert.match(src, /where \+= ' AND status = @status'/, 'status must filter the query');
});

test('★ status REALLY filters — proved against the database, not by reading the source', async () => {
  // `assert.match` above can only show the clause exists in the text. This asks the STORE for a status that
  // does not exist and requires zero rows: an ignored filter returns recent trades, so this fails loudly if the
  // clause is ever dropped again.
  const none = await listTrades(1, { status: 'no_such_status' });
  assert.deepStrictEqual(none, [], 'a status that cannot exist must return nothing — an ignored filter returns rows');

  const closed = await listTrades(1, { status: 'closed', limit: 5 });
  assert.ok(closed.length > 0, 'fixture: this desk has closed trades, so the query above is meaningful');
  assert.ok(closed.every((t) => t.status === 'closed'),
    'every returned row must carry the status asked for — a mix means the filter was not applied');
});
