// test/chair-account-context.test.js — TRD-LLM-2: the chair is told the account and the risk rules.
//
// THE DEFECT. Measured on the live bundle, the ONLY account line in the entire prompt was
// `Account: DEMO (paper).` — no equity, no free funds — and NO risk parameter appeared anywhere. Yet the same
// bundle instructs the seat to `VOTE` on `PROPOSED ACTION by quant: ... size=<N>`, a number derived from that
// unreported equity through a stop the seat also could not see, capped by a rule it could not read, and subject
// to a cost ceiling that can refuse the trade outright. `risk.evaluate` had every one of those values and none
// of them reached the prompt.
//
// WHY THIS IS A CORRECTNESS TEST AND NOT A FORMAT ONE. A seat that cannot see the cap cannot know the risk unit
// it is judging was TRUNCATED, so it reasons about a 2xATR stop that will never be placed and about a 1.5R
// target that is really 3.5R away. The owner hit exactly this: "does the LLM know the parameters of the risk and
// position sizing, and the current equity and available funds?" — it did not.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const pb = require('../trading/agent/promptBuilder');

const SETTINGS = {
  risk: {
    riskPerTradePct: 2, maxEquityPerPositionPct: 80, exposureCapPct: 100, maxPositions: 10,
    maxNewTradesPerDay: 20, reentryCooldownBars: 0, maxAdversePct: 0.3, takeProfitOffsetPct: 5,
    maxCostShareOfR: 0.65, maxAdverseCostMultiple: 1.5,
  },
};
const ACCOUNT = { equity: 4117.85, available: 3900.11, margin: 217.74, pnl: -12.4, source: 'plus500_demo' };

function bundle({ settings = SETTINGS, account = ACCOUNT } = {}) {
  return pb.buildBundle({
    userId: 1, trigger: 'test', now: new Date('2026-09-25T06:00:00Z'),
    session: { state: 'open', detail: 'test', scheduledEvents: [] },
    quantResult: { symbols: [] },
    openTrades: [], closedTrades: [], digest: null, proposal: null, alert: null, stale: false,
    pulse: null, meta: null, multi: null, congress: null, whitepaper: null, proposals: [],
    userInput: null, prevOutcomes: null, venueCostFacts: null, settings, account,
  });
}

const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

test('an unread equity is UNAVAILABLE, never a zero', () => {
  const lines = pb.accountLines(null).join('\n');
  assert.match(lines, /UNAVAILABLE/);
  assert.ok(!/0\.00/.test(lines), 'Number(null) === 0 is the coercion that must never reach a chair as "equity 0.00"');
  // And a partial strip must not fill the gaps with zeros either.
  const partial = pb.accountLines({ equity: 4117.85 }).join('\n');
  assert.match(partial, /equity 4117\.85/);
  assert.match(partial, /available n\/a/, 'an absent field is n/a, not 0.00');
});

test('the account strip renders the figures the seat needs, and a real zero is still a real number', () => {
  const lines = pb.accountLines(ACCOUNT).join('\n');
  assert.match(lines, /equity 4117\.85/);
  assert.match(lines, /available 3900\.11/);
  assert.match(lines, /margin 217\.74/);
  // equity 0 is a FACT if the venue reports it — only an ABSENCE is unavailable.
  assert.match(pb.accountLines({ equity: 0 }).join('\n'), /equity 0\.00/);
});

test('the risk parameters that size and refuse a ticket are all stated', () => {
  const text = pb.riskParameterLines(SETTINGS).join('\n');
  assert.match(text, /size = equity x 2% \/ effective stop distance/);
  assert.match(text, /max 80% of equity per position/);
  assert.match(text, /Venue stop CAP: 0\.3%/);
  assert.match(text, /TRUNCATED/, 'the seat must know the risk unit is the capped distance');
  assert.match(text, /65\.0% of the risk unit/, 'the cost ceiling is what can refuse the ticket');
  assert.match(text, /1\.5x the instrument's round-trip cost/);
  assert.match(text, /pulled 5% of its own distance/, 'the take-profit offset is live at 5% and must be visible');
});

test('a cap of 0 reads as OFF, never as "0%" — the off dial must not look like a very tight one', () => {
  const off = pb.riskParameterLines({ risk: { ...SETTINGS.risk, maxAdversePct: 0 } }).join('\n');
  assert.match(off, /Venue stop CAP: OFF/);
  assert.ok(!/CAP: 0%/.test(off));
  // The ceiling must still resolve when only the legacy multiple is present.
  assert.match(pb.riskParameterLines({ risk: { maxAdverseCostMultiple: 2 } }).join('\n'), /50\.0% of the risk unit/);
});

test('the bundle carries the risk disclosure in the STABLE BLOCK and the live account in the VOLATILE block', () => {
  const text = bundle();
  assert.match(text, /--- RISK PARAMETERS \(what sizes a ticket, and what can refuse it\) ---/);
  assert.match(text, /--- ACCOUNT \(live\) ---/);
  assert.match(text, /equity 4117\.85/);
  assert.match(text, /Venue stop CAP: 0\.3%/);

  // ★ THE CACHE INVARIANT (S1, 2026-10-02; was TRD-78). The risk rules are byte-stable across wakes and now sit
  // EARLY, so a prefix cache can reuse them; the per-wake equity line is quarantined AFTER the stable block.
  // Measured, not asserted: two bundles differing in settings AND equity must still share everything up to the
  // risk block, and the live account line must sit after every stable section.
  const other = bundle({ settings: { risk: { ...SETTINGS.risk, maxAdversePct: 1.1, riskPerTradePct: 0.5 } }, account: { equity: 2222.22, available: 1, margin: 0, pnl: 99 } });
  const headEnd = text.indexOf('--- RISK PARAMETERS');
  assert.ok(headEnd > 100, 'the risk block must sit well past the constant head');
  assert.ok(commonPrefix(text, other) >= headEnd,
    `the common prefix is ${commonPrefix(text, other)} chars but the constant head ends at ${headEnd} —`
    + ' the stable block leaked a per-wake value into the cacheable prefix');

  // Non-vacuity: the risk blocks really do differ, so the prefix measurement above is not proving nothing.
  const otherRiskAt = other.indexOf('--- RISK PARAMETERS');
  assert.notStrictEqual(text.slice(headEnd), other.slice(otherRiskAt), 'the blocks must differ — otherwise this proves nothing');
  // And the divergence must occur BEFORE the live account line: the volatile block is genuinely outside.
  const acctAt = text.indexOf('--- ACCOUNT (live)');
  assert.ok(acctAt > text.indexOf('--- LAST 3 CLOSED TRADES'), 'the live account block opens the volatile region');
  assert.ok(commonPrefix(text, other) < acctAt, `the divergence (${commonPrefix(text, other)}) must occur before the live account line (${acctAt})`);
});

test('the stored object twin carries the same two facts, so a consumer cannot see a different picture', () => {
  const obj = pb.buildBundleObj({
    userId: 1, trigger: 'test', now: new Date('2026-09-25T06:00:00Z'),
    session: { state: 'open', detail: 'test' }, quantResult: { symbols: [] },
    openTrades: [], closedTrades: [], proposal: null, proposals: [], settings: SETTINGS, account: ACCOUNT,
  });
  assert.strictEqual(obj.account.equity, 4117.85);
  assert.strictEqual(obj.account.source, 'plus500_demo');
  assert.strictEqual(obj.riskParams.maxAdversePct, 0.3);
  assert.strictEqual(obj.riskParams.maxCostShareOfR, 0.65);
  assert.strictEqual(obj.riskParams.takeProfitOffsetPct, 5);
  // ⚠ The volatile keys must stay LAST (TRD-78(a)): the stored copy is evidence of what the cache had to work
  // with, so it must not OPEN with a per-wake value.
  const keys = Object.keys(obj);
  assert.strictEqual(keys[keys.length - 1], 'now');
  assert.strictEqual(keys[keys.length - 2], 'trigger');
  // An absent account is null on the object too — not a fabricated zero object.
  const bare = pb.buildBundleObj({
    userId: 1, trigger: 't', now: new Date(), session: { state: 'open' }, quantResult: { symbols: [] },
    openTrades: [], closedTrades: [], proposal: null, proposals: [], settings: null, account: null,
  });
  assert.strictEqual(bare.account, null);
  assert.strictEqual(bare.riskParams.maxAdversePct, null, 'absent settings must be null, not 0');
});
