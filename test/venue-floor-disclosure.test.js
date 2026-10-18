// test/venue-floor-disclosure.test.js — the venue's MINIMUM TRADE SIZE must reach the seat ON THE TICKET.
//
// THE DEFECT (measured 2026-09-28). `min size N <unit>` has been rendered since the venue floor was added — but
// into `--- VENUE COST OF CARRY ---`, roughly forty lines ABOVE the proposal, among six other facts, and attached
// to the SYMBOL. The line the seat actually votes on read `PROPOSED ACTION by quant: entry buy SGX size=risk-sized`,
// and the per-ticket geometry note — the one place that states what the rules DID to this proposal — omitted
// `venueFloor` entirely, though `risk.evaluate` has returned it since the same change.
//
// The observed failure: SGX proposed at 8.5363 Shares against a 20-Share floor, refused on `venue_minimum`, with
// the correct minimum printed in the cost section of that same prompt the whole time. The bundle's own refusal
// list even promises the chair that "the size is below the venue's own minimum tradable unit" can refuse it — so
// the seat is told the rule exists, told the symbol's minimum, and given no way to compare them.
//
// So this file pins TWO placements and, centrally, the ARITHMETIC: the risk the floor would force must equal the
// risk at the computed size scaled by min/size. That is the file's own discipline (see ticket-geometry-note) — a
// second derivation that happens to agree today is exactly how TRD-RSK-1 shipped a 4.86x error.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const agg = require('../trading/agent/aggregator');
const pb = require('../trading/agent/promptBuilder');

// The live SGX numbers off the 2026-09-28T03:22:25Z refusal.
const SGX = {
  size: 8.5363,
  stopDistance: 0.3390,
  effectiveStopDistance: 0.3390,
  sizeCalc: { equity: 4134.00 },
  venueFloor: { ok: true, reason: 'above_venue_minimum', detail: null, minUnits: 20, unitKind: 'Shares' },
};
const PROPOSAL = { symbol: 'SGX', price: 22.5655, direction: 'buy', type: 'entry' };
const note = (risk) => agg.ticketGeometryNote(risk, PROPOSAL, { risk: {} });

test('★ below the floor, the note names the minimum, the ticket, and what the floor would COST', () => {
  const n = note(SGX);
  assert.match(n, /venue minimum 20 Shares against this ticket's 8\.5363/);
  assert.match(n, /BELOW the floor, so the venue cannot accept this size/);
  // ★ THE ARITHMETIC, CROSS-CHECKED rather than merely present: the risk at the floor is the risk at this size
  // scaled by min/size. If the note's two percentages ever stop satisfying this, one of them is wrong.
  const atSize = ((SGX.size * SGX.effectiveStopDistance) / SGX.sizeCalc.equity) * 100;      // 0.0700
  const atFloor = atSize * (SGX.venueFloor.minUnits / SGX.size);                             // 0.1640
  assert.match(n, new RegExp(`risk about ${atFloor.toFixed(4)}% of equity`), n);
  assert.match(n, new RegExp(`instead of the ${atSize.toFixed(4)}% this size carries`), n);
  // and the floor really is the binding constraint on this ticket
  assert.ok(SGX.venueFloor.minUnits / SGX.size > 2, 'the floor is ~2.34x this size — the reason it is untakeable');
});

test('a ticket that clears the floor says so, and makes NO claim about taking the minimum', () => {
  const n = note({ ...SGX, size: 21 });
  assert.match(n, /venue minimum 20 Shares against this ticket's 21/);
  assert.match(n, /the ticket clears the floor/);
  assert.ok(!/BELOW the floor/.test(n));
  assert.ok(!/minimum anyway/.test(n), 'there is nothing to warn about when the ticket already clears it');
});

test('an UNKNOWN or UNREADABLE minimum says the size was NOT checked — never that it passed', () => {
  const unknown = note({ ...SGX, venueFloor: { ok: true, reason: 'venue_minimum_unknown', minUnits: null } });
  assert.match(unknown, /venue minimum for this symbol is UNKNOWN, so this size was NOT checked against a floor/);
  const unreadable = note({ ...SGX, venueFloor: { ok: true, reason: 'registry_unavailable', minUnits: null } });
  assert.match(unreadable, /is UNREADABLE, so this size was NOT checked against a floor/);
  // ⚠ An absent floor is reported as absently-checked, never as satisfied — the TRD-43 lesson.
  assert.ok(!/clears the floor/.test(unknown + unreadable));
});

test('no venueFloor on the risk object adds no floor text and does not throw', () => {
  const n = note({ ...SGX, venueFloor: null });
  assert.ok(!/venue minimum/i.test(n), n);
  assert.match(n, /declared stop/);
});

// ── the second placement: the proposal line the seat votes on ────────────────────────────────────────
const SETTINGS = {
  risk: {
    riskPerTradePct: 2, maxEquityPerPositionPct: 80, exposureCapPct: 100, maxPositions: 10,
    maxNewTradesPerDay: 20, reentryCooldownBars: 0, maxAdversePct: 0.3, takeProfitOffsetPct: 5,
    maxCostShareOfR: 0.65, maxAdverseCostMultiple: 1.5,
  },
};

function bundleWith({ proposals, proposal, venueCostFacts = FACTS }) {
  return pb.buildBundle({
    userId: 1, trigger: 'test', now: new Date('2026-09-28T03:22:25Z'),
    session: { state: 'open', detail: 'test', scheduledEvents: [] },
    quantResult: { symbols: [{ symbol: 'SGX', venue: 'plus500' }, { symbol: 'Silver', venue: 'plus500' }] },
    openTrades: [], closedTrades: [], digest: null, alert: null, stale: false,
    pulse: null, meta: null, multi: null, congress: null, whitepaper: null,
    proposal, proposals, userInput: null, prevOutcomes: null, venueCostFacts, settings: SETTINGS,
    account: { equity: 4134, available: 3890, margin: 121, pnl: 8, source: 'plus500_demo' },
  });
}

const FACTS = {
  SGX: { symbol: 'SGX', minimumUnits: 20, unitKind: 'Shares', instrumentClass: 'spot' },
  Silver: { symbol: 'Silver', minimumUnits: 2.5, unitKind: 'Troy Ounces', instrumentClass: 'spot' },
};

test('★ the PROPOSAL line carries the venue minimum, not just the cost section 40 lines above it', () => {
  const text = bundleWith({ proposal: { type: 'entry', direction: 'buy', symbol: 'SGX', basis: 'donchian20 breakout up' }, proposals: [] });
  const line = text.split('\n').find((l) => /PROPOSED ACTION/.test(l));
  assert.ok(line, 'the proposal line must exist');
  assert.match(line, /size=risk-sized/);
  assert.match(line, /venue minimum 20 Shares/, `the seat votes on this line, so the floor must be on it: ${line}`);
});

test('every OTHER proposal in the cycle carries its own floor too', () => {
  const props = [
    { type: 'entry', direction: 'buy', symbol: 'SGX', basis: 'donchian20 breakout up' },
    { type: 'entry', direction: 'sell', symbol: 'Silver', basis: 'donchian20 breakout down' },
  ];
  const text = bundleWith({ proposal: props[0], proposals: props });
  const block = text.split('--- OTHER PROPOSALS THIS CYCLE (each voted separately) ---')[1] || '';
  assert.match(block, /SGX .*venue minimum 20 Shares/);
  assert.match(block, /Silver .*venue minimum 2\.5 Troy Ounces/);
});

test('an in-scope symbol with no minimum is reported UNKNOWN, so the gate cannot refuse it on size', () => {
  const text = bundleWith({
    proposal: { type: 'entry', direction: 'buy', symbol: 'SGX', basis: 'x' }, proposals: [],
    venueCostFacts: { SGX: { symbol: 'SGX', minimumUnits: null, unitKind: null, instrumentClass: 'spot' } },
  });
  const line = text.split('\n').find((l) => /PROPOSED ACTION/.test(l));
  assert.match(line, /venue minimum UNKNOWN — the gate cannot refuse this ticket on size/);
});

// ── the ACCEPTED floor (owner setting, 2026-09-28) ────────────────────────────────────────────────────
// The owner chose to accept SGX's floor rather than drop the symbol. The clamp is available only under
// `risk.acceptVenueFloor`, and the seat must be told the ticket is NOT the size the dial computed.
const fs = require('node:fs');
const pathMod = require('node:path');

const ACCEPTED = {
  ...SGX,
  size: 20,                       // <- raised to the floor by the clamp
  venueFloor: {
    ok: true, reason: 'below_venue_minimum', minUnits: 20, unitKind: 'Shares',
    accepted: true, acceptedSize: 20, intendedRiskPct: 0.0700, forcedRiskPct: 0.1640, multiple: 2.3429,
  },
};

test('★ an ACCEPTED floor is disclosed: the seat is told the ticket is not the size the dial computed', () => {
  const n = note(ACCEPTED);
  assert.match(n, /the venue floor was ACCEPTED by an owner setting/);
  assert.match(n, /RAISED to the venue's minimum 20 Shares/);
  assert.match(n, /carries 0\.1640% of equity instead of the 0\.0700% the dial computed/);
  assert.match(n, /2\.34x the intended risk/);
  assert.ok(!/BELOW the floor/.test(n), 'once accepted the ticket is no longer below the floor');
});

test('the accepted branch is reached BEFORE the below-floor branch, and no risk number is invented', () => {
  // Same object, accepted flag removed: it must fall back to the refusal-shaped wording.
  const notAccepted = { ...ACCEPTED, venueFloor: { ...ACCEPTED.venueFloor, accepted: false } };
  const n = note(notAccepted);
  assert.ok(!/ACCEPTED/.test(n), 'without the flag there is nothing to disclose');
  assert.match(n, /the ticket clears the floor/);
  // And with the percentages missing, the sentence drops the numbers rather than printing NaN.
  const noPct = note({ ...ACCEPTED, venueFloor: { ...ACCEPTED.venueFloor, intendedRiskPct: null, forcedRiskPct: null } });
  assert.match(noPct, /ACCEPTED by an owner setting/);
  assert.ok(!/NaN|undefined|null/.test(noPct), noPct);
});

test('★ STRUCTURAL PIN: the clamp is opt-in, and OFF by default', () => {
  // WHY STRUCTURAL RATHER THAN BEHAVIOURAL: `risk.evaluate` reads the pool on every path, so a behavioural
  // test needs a full DB stub. These pins are the cheap guard against the failure that MATTERS — someone
  // making the clamp unconditional, which would raise size on every instrument that has a floor.
  const riskSrc = fs.readFileSync(pathMod.join(__dirname, '..', 'trading', 'agent', 'risk.js'), 'utf8');
  // (a) the veto still exists, i.e. the default behaviour is unchanged
  assert.match(riskSrc, /veto\('venue_minimum'/, 'the refusal must survive behind the dial');
  // (b) the clamp is gated on the setting being exactly true
  assert.match(riskSrc, /risk\.acceptVenueFloor === true/, 'the gate must be an explicit === true');
  // (c) the clamp and the gate are in the same conditional — the clamp sits after the gate, before the veto
  const gateAt = riskSrc.indexOf('acceptFloor && Number.isFinite(minUnits)');
  const clampAt = riskSrc.indexOf('size = minUnits;');
  const vetoAt = riskSrc.indexOf(`veto('venue_minimum'`);
  assert.ok(gateAt > 0 && clampAt > gateAt, 'the clamp must be inside the gated branch');
  assert.ok(vetoAt > clampAt, 'the veto must be the ELSE path, after the clamp');
  // (d) the shipped default is false
  const { DEFAULT_SETTINGS } = require('../trading/store');
  assert.strictEqual(DEFAULT_SETTINGS.risk.acceptVenueFloor, false, 'the clamp must ship OFF');
  assert.strictEqual(DEFAULT_SETTINGS.risk.maxRiskPerTradePct === undefined, true, 'sanity: the dial lives on risk');
});
