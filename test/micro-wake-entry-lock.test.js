// test/micro-wake-entry-lock.test.js — 2026-09-28: "a micro wake is a proximity guard, not a trading opportunity."
//
// THE DEFECT. `microWake` exists to watch an OPEN position's stop/TP proximity on a ~2-minute cadence. It was
// running the FULL deliberation and proposing ENTRIES: measured 2026-09-28, Arabica Coffee was re-proposed as
// an entry every ~121 s for as long as the venue was shut — nine decisions from 07:32 to 08:35, all
// `action: entry`, `chairVote: offline`. A SHUT MARKET FREEZES THE LAST PRICE, which makes the same donchian
// breakout a permanent signal (`price 277.77` identical at 08:24, 08:26, 08:28, 08:30 and 08:32).
//
// ⚠ AND IT WAS THE FASTEST ROUTE TO THE BUDGET: every one of those wakes set `llmCalled: true`, so at ~8k
// tokens a call on a 2-minute cadence it is ~240k tokens/hour. The day's `budget.totalDaily` was raised the same
// day, and without this fix that headroom would have been spent on entries that cannot be placed.
//
// Structural, because `pickProposal` is module-local and requiring the aggregator drags in the whole engine.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const AGG = 'trading/agent/aggregator.js';

test('the micro-wake entry lock exists and names itself', () => {
  const src = code(AGG);
  assert.match(src, /const microEntryLock = trigger === 'micro'/, 'the lock must be driven by the TRIGGER');
  assert.match(src, /MICRO WAKE — proximity check only/, 'the reason must say what it is');
  assert.match(src, /pickProposal\(quantResult, sessionLock, killTier, bridgePaused, session\.detail, microEntryLock\)/,
    'and it must be PASSED to the picker — a computed lock nobody reads is the defect class this desk keeps finding');
});

test('★ an EXIT is still returned before the block check — a lock must not trap a position', () => {
  const src = code(AGG);
  const fn = src.indexOf('function pickProposal');
  const exits = src.indexOf('if (exits.length) return', fn);
  const blocked = src.indexOf('const blocked = bridgePaused', fn);
  assert.ok(fn > -1 && exits > -1 && blocked > -1);
  // This ordering is what makes the micro lock safe: the proximity case the 2-minute cadence EXISTS for is an
  // exit, so exits must be decided before any entry lock can refuse them.
  assert.ok(exits < blocked, 'the exit return must come BEFORE the block computation');
});

test('the lock can only ever refuse ENTRIES — asserted by BEHAVIOUR', () => {
  // ⚠ THIS PIN MOVED 2026-09-30, AND GOT STRONGER. The selector used to be inline in `aggregator.js`, where the
  // only thing a test could assert about it was its TEXT — and a text pin passes even when the expression is
  // dead code. TRD-TRL-1 defect 1(b) needed a pre-deliberation filter over the same list, so the rule moved to
  // `agent/deliberationScope.js`, which has no DB dependency and can therefore be REQUIRED. The invariant this
  // test defends is unchanged; the evidence for it is now execution rather than prose.
  const { deliberationSymbols } = require('../trading/agent/deliberationScope');
  const sym = (symbol, type) => ({ symbol, status: 'ok', signal: { type, direction: 'buy' } });
  const quant = { symbols: [sym('Gold', 'entry'), sym('Oil', 'exit'), sym('Bitcoin', 'entry')] };

  const open = deliberationSymbols(quant, { blocked: null }).map((s) => s.symbol);
  assert.deepStrictEqual(open, ['Oil', 'Gold', 'Bitcoin'], 'control: exits first, then entries');

  const refused = deliberationSymbols(quant, { blocked: 'session_closed' }).map((s) => s.symbol);
  assert.deepStrictEqual(refused, ['Oil'], 'a block must empty the ENTRY list and leave exits alone');

  // NON-VACUITY: the exit must survive BOTH readings, or the assertion above would also pass on a list that
  // was emptied outright.
  assert.ok(open.includes('Oil') && refused.includes('Oil'), 'exits are collected unconditionally');

  // And the aggregator must DELEGATE. An inline copy would satisfy every assertion above while reinstating the
  // drift this extraction exists to prevent.
  const src = code(AGG);
  assert.match(src, /deliberationSymbols\(quantResult, \{ blocked, suppressedExits \}\)/,
    'the aggregator must use the shared selector, not its own copy');
});

test('★ precedence is by SPECIFICITY — the micro lock is the least specific claim', () => {
  const src = code(AGG);
  // ⚠ Anchored on indexOf, NOT on a regex over the expression: my first attempt used `[^;]+` and gave up before
  // the last term, so the test failed on its own parsing rather than on the code. Ask about positions instead.
  const fn = src.indexOf('function pickProposal');
  const pause = src.indexOf('bridgePaused ?', fn);
  const sess = src.indexOf('sessionLock ?', fn);
  const kill = src.indexOf("killTier === 'soft'", fn);
  // ⚠ `(additionalBlock || null)` and NOT `additionalBlock`: the bare name also appears in the FUNCTION
  // SIGNATURE, which is earlier in the file, so the position test compared the signature against the
  // expression and failed. Match the USE.
  const micro = src.indexOf('(additionalBlock || null)', fn);
  assert.ok(fn > -1, 'pickProposal must exist');
  assert.ok(pause > -1 && sess > -1 && kill > -1 && micro > -1,
    `all four claims must appear (pause=${pause} session=${sess} kill=${kill} micro=${micro})`);
  assert.ok(pause < sess, 'a paused bridge outranks the session');
  assert.ok(sess < kill, 'a real session lock outranks the kill tier');
  assert.ok(kill < micro, 'and the micro lock is stated LAST, so it never masks a more specific reason');
});

test('★ the lock is NOT applied to scheduled or manual wakes', () => {
  const src = code(AGG);
  // A scheduled wake IS the trading opportunity; locking it too would stop the desk trading entirely, which is
  // a far larger intervention than the defect.
  assert.match(src, /trigger === 'micro'\s*\n?\s*\?/m, 'the condition must be exactly the micro trigger');
  assert.doesNotMatch(src, /microEntryLock = .*trigger !== 'micro'/);
});

test('★ reentryCooldownBars is NOT touched (the owner ruled it deliberate)', () => {
  // Owner, 2026-09-28: "reentryCooldownBars: 0 deliberate". A fix that quietly re-enables it would be
  // overruling a stated decision.
  const src = code(AGG);
  assert.doesNotMatch(src, /reentryCooldownBars\s*[:=]\s*[1-9]/, 'the fix must not set a cooldown value');
  const store = code('trading/store.js');
  assert.match(store, /reentryCooldownBars: 6/, 'the DEFAULT stays 6 — the live 0 is a deliberate override, not a default');
});
