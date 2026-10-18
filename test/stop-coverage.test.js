// test/stop-coverage.test.js — TRD-43: a missing stop is not one fact.
//
// THE FINDING. 11 of the desk's 25 closed trades carry no `stopPrice`, so `rMultiple` returns
// null for them and every R-based metric silently reports a smaller population. "11 excluded" is
// not actionable. The question that IS actionable is whose position each one was — and the two
// answers have opposite implications:
//
//   origin='venue'  -> the desk never opened it (reconcile adopted it from Plus500), so there was
//                      never a desk-side level to record. Unmeasurable, not fixable, nobody's bug.
//   origin='agent'  -> the DESK opened it and recorded no risk. A control failure. The risk is
//   origin='manual'    UNKNOWN, not zero, and no R-based verdict covers the trade at all.
//
// The three tests that matter most:
//   1. `the day-one ledger reproduces 11 excluded / 6 defects / 5 mirrored` — the finding itself,
//      pinned against the real row shapes so the numbers cannot drift unnoticed.
//   2. `a null stop is NEVER read as a stop at zero` — the `Number(null) === 0` trap, which in
//      this module would turn an absent level into a risk denominator and produce a confident R.
//   3. `the all-time residue does NOT keep the desk amber forever` — the alert-fatigue guard. A
//      check that can never go green gets tuned out, which is the same failure as never alerting.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const sc = require('../trading/agent/stopCoverage');
const { REASON } = sc;

// Real row shapes, taken from the ledger on 2026-09-14 (Trades where closeAt IS NOT NULL).
function row(o) {
  return Object.assign({
    id: 0, symbol: 'X', origin: 'agent', status: 'closed',
    openPrice: 100, stopPrice: 98, closePrice: 101, grossPnl: 10, size: 1,
    openAt: '2026-09-10T00:00:00Z', closeAt: '2026-09-10T01:00:00Z',
    maePct: -0.5, strategyId: null,
  }, o);
}

// --- provenance -----------------------------------------------------------------
test('isDeskOpened: only the venue mirror is not the desk\'s own position', () => {
  assert.equal(sc.isDeskOpened('venue'), false);
  assert.equal(sc.isDeskOpened('agent'), true);
  assert.equal(sc.isDeskOpened('manual'), true);
  // The conservative default: an unattributed row is treated as OURS, so a row whose origin was
  // lost reading as a defect rather than passing as somebody else's position.
  assert.equal(sc.isDeskOpened(null), true);
  assert.equal(sc.isDeskOpened(undefined), true);
  assert.equal(sc.isDeskOpened(''), true);
  // A padded origin from an import must not smuggle a mirrored row into the defect list.
  assert.equal(sc.isDeskOpened(' venue '), false);
});

// --- classification -------------------------------------------------------------
test('classify: the five states are distinct', () => {
  assert.equal(sc.classify(row({ stopPrice: 98 })), REASON.MEASURED);
  assert.equal(sc.classify(row({ origin: 'agent', stopPrice: null })), REASON.MISSING);
  assert.equal(sc.classify(row({ origin: 'manual', stopPrice: null })), REASON.MISSING);
  assert.equal(sc.classify(row({ origin: 'venue', stopPrice: null })), REASON.MIRRORED);
  // A stop that EXISTS but sits at the fill: a populated field that still yields no R. Kept
  // separate so nobody goes looking for a missing value.
  assert.equal(sc.classify(row({ stopPrice: 100 })), REASON.ZERO);
  assert.equal(sc.classify(row({ status: 'open', closeAt: null })), REASON.NOT_CLOSED);
});

// --- TRD-RSK-9: the mirrored class splits in two ---------------------------------
test('deskClosed reads the desk\'s own close mark, and ONLY that mark', () => {
  assert.equal(sc.deskClosed({ closePriceSource: 'fill' }), true);
  // The venue closed this one, so the desk merely learned of it — that IS the mirrored residue.
  assert.equal(sc.deskClosed({ closePriceSource: 'venue_rate' }), false);
  // Absent is NOT "closed by the desk". The old rows predate the column, and treating a missing mark
  // as a positive would be the `Number(null) === 0` trap in a new place.
  assert.equal(sc.deskClosed({ closePriceSource: null }), false);
  assert.equal(sc.deskClosed({}), false);
  assert.equal(sc.deskClosed(null), false);
  // A NOTE IS NOT THE MARK. TRD-11's phantom-upgrade path rewrites `note`, so a classifier keyed on
  // it would be built on a field another branch overwrites underneath it.
  assert.equal(sc.deskClosed({ note: 'executor close' }), false);
});

test('THE MIRRORED CLASS SPLITS: untouched by the desk vs traded by it', () => {
  const untouched = row({ origin: 'venue', stopPrice: null });
  const venueClosed = row({ origin: 'venue', stopPrice: null, closePriceSource: 'venue_rate' });
  const traded = row({ origin: 'venue', stopPrice: null, closePriceSource: 'fill' });

  assert.equal(sc.classify(untouched), REASON.MIRRORED);
  assert.equal(sc.classify(venueClosed), REASON.MIRRORED, 'the venue closed it — the desk only watched');
  assert.equal(sc.classify(traded), REASON.MIRRORED_TRADED, 'the desk closed it, so the desk held it');

  // The residue stays out of the defect list; the traded row does not. This is the whole split.
  assert.equal(sc.DEFECTS.includes(REASON.MIRRORED), false);
  assert.equal(sc.DEFECTS.includes(REASON.MIRRORED_TRADED), true);
});

test('a LIVE mis-adoption is BAD — the desk held unmeasured risk it was acting on', () => {
  // The real pair, 2026-09-28. #1110 Sugar buy 11.9862 with stop 18.414, submitted 07:09:21Z into a
  // closed session, expired as `failed` at 07:40:36Z. #1111 Sugar, adopted 07:31:10Z as origin='venue'
  // with NO stop, closed by the DESK at 07:34:55Z. One position, two records.
  const all = sc.summarise([
    row({ id: 1110, origin: 'agent', stopPrice: 18.414, status: 'failed', closeAt: null, symbol: 'Sugar' }),
    row({ id: 1111, origin: 'venue', stopPrice: null, closePriceSource: 'fill', symbol: 'Sugar',
      openAt: '2026-09-28T07:31:10Z', closeAt: '2026-09-28T07:34:55Z', maePct: -0.6997 }),
  ]);

  assert.equal(all.mirrored_unmeasured, 0, 'it is not part of the untouchable residue any more');
  assert.equal(all.mirrored_traded, 1);
  assert.equal(all.defectCount, 1, 'the traded mirror is the defect — the desk-opened row still carries a stop');
  assert.deepEqual(all.defects.map((d) => d.id), [1111]);
  assert.equal(all.defects[0].origin, 'venue', 'the row still SAYS venue — that is why origin alone cannot decide this');
  assert.equal(all.defects[0].maePct, -0.6997, 'the hole keeps its recorded size');

  const v = sc.verdict(all, sc.summarise([]), { epoch: '2026-09-21T00:00:00Z' });
  assert.equal(v.status, 'bad', 'opened after the epoch, so this is live, not history');
  assert.match(v.detail, /NO declared risk/);
});

test('the pre-epoch traded residue is STATED, and still standing', () => {
  // Same row, moved before the epoch: no action clears it, so it must not gate the desk — but it must
  // not be silently absorbed into "the desk never placed them" either, which is now known to be false.
  const all = sc.summarise([
    row({ id: 1111, origin: 'venue', stopPrice: null, closePriceSource: 'fill', symbol: 'Sugar',
      openAt: '2026-09-08T07:31:10Z', closeAt: '2026-09-08T07:34:55Z' }),
  ]);
  const v = sc.verdict(all, sc.summarise([]), { epoch: '2026-09-21T00:00:00Z' });
  assert.equal(v.status, 'warn', 'pre-epoch, so historical');
  assert.equal(v.standing, true);
  assert.match(v.detail, /CLOSED itself/);
  assert.equal(/never placed them/.test(v.detail), false, 'it must not be described as untouched by the desk');
});

test('a null stop is NEVER read as a stop at zero', () => {
  // `Number(null) === 0`, so a bare Number.isFinite guard would see a FINITE stop of 0, a risk
  // denominator of |100 - 0| x 1, and hand back a plausible R-multiple for a trade that has no
  // declared risk at all. The guard has to reject absence BEFORE coercing.
  const t = row({ stopPrice: null, origin: 'agent' });
  assert.equal(sc.stopDistance(t), null, 'an absent level must be null, not 0');
  assert.equal(sc.classify(t), REASON.MISSING, 'an absent level must not classify as measured');
  // Same trap on the OPEN side: a trade with no fill price has no measurable distance either.
  assert.equal(sc.stopDistance(row({ openPrice: null })), null);
  assert.equal(sc.classify(row({ openPrice: null, stopPrice: null })), REASON.MISSING);
  // A LITERAL zero stop is a different matter, and deliberately NOT special-cased here:
  // classification asks only whether a distance exists, and |100 - 0| is a distance. A stop of 0
  // is prevented one layer UP, at the point of writing, by `exitLevels.level` (asserted below) —
  // which is the only place that can stop it becoming a row in the first place.
  assert.equal(sc.classify(row({ stopPrice: 0 })), REASON.MEASURED);
});

// --- the finding -----------------------------------------------------------------
test('the day-one ledger reproduces 11 excluded / 6 defects / 5 mirrored', () => {
  // The 11 stopless closed trades, with their real origins. 5 adopted from the venue, 6 opened by
  // the desk before exitLevels existed (ids 3, 5, 6, 7, 9, 10 — the first stopped agent entry is
  // id 13, 2026-09-10 03:27).
  const mirrored = [1, 2, 4, 8, 15].map((id) => row({ id, origin: 'venue', stopPrice: null, symbol: 'Venue ' + id, openAt: '2026-09-08T10:27:53Z' }));
  const defects = [
    row({ id: 3, origin: 'manual', stopPrice: null, symbol: 'Gold', maePct: -1.0311, openAt: '2026-09-08T10:27:53Z' }),
    row({ id: 5, origin: 'agent', stopPrice: null, symbol: 'Bitcoin', openAt: '2026-09-08T10:30:36Z' }),
    row({ id: 6, origin: 'manual', stopPrice: null, symbol: 'Bitcoin', openAt: '2026-09-08T10:32:38Z' }),
    row({ id: 7, origin: 'manual', stopPrice: null, symbol: 'Bitcoin', openAt: '2026-09-08T10:33:46Z' }),
    row({ id: 9, origin: 'manual', stopPrice: null, symbol: 'Oil', maePct: 0.3904, openAt: '2026-09-09T08:46:37Z' }),
    row({ id: 10, origin: 'manual', stopPrice: null, symbol: 'Oil', openAt: '2026-09-09T11:53:11Z' }),
  ];
  const measured = Array.from({ length: 14 }, (_, i) => row({ id: 100 + i, stopPrice: 98, openAt: '2026-09-10T06:00:00Z' }));

  const s = sc.summarise([...measured, ...mirrored, ...defects]);
  assert.equal(s.closed, 25);
  assert.equal(s.measured, 14);
  assert.equal(s.mirrored_unmeasured, 5, 'venue-adopted rows are unmeasurable, never defects');
  assert.equal(s.missing_stop, 6, 'the 6 desk-opened rows ARE the defect');
  assert.equal(s.missing_stop + s.zero_distance + s.mirrored_unmeasured, 11, 'the 11-row gap');
  assert.equal(s.defectCount, 6);
  assert.equal(s.coveragePct, 56, '14 of 25');
  // The hole has a size: risk is unknown, but the worst ADVERSE excursion was recorded.
  assert.equal(s.worstAdversePct, -1.03);
  // Stated so nobody "helpfully" invents a level that was never recorded.
  assert.equal(s.backfillable, 0);
  // Every one of the six pre-dates the levels epoch, so the whole residue is historical — this is
  // the assertion that ties the fixture to the verdict the real ledger produces today.
  assert.equal(sc.verdict(s, s).status, 'warn');
});

test('defects carry what is needed to act, and mirrored rows stay out of the defect list', () => {
  const s = sc.summarise([
    row({ id: 5, origin: 'agent', symbol: 'Bitcoin', stopPrice: null, size: 0.001, maePct: -0.39 }),
    row({ id: 1, origin: 'venue', symbol: 'SHEIN', stopPrice: null, maePct: -3.44 }),
  ]);
  assert.equal(s.defectCount, 1);
  assert.deepEqual(s.defects.map((d) => d.id), [5]);
  const [d] = s.defects;
  assert.equal(d.symbol, 'Bitcoin');
  assert.equal(d.origin, 'agent');
  assert.equal(d.reason, REASON.MISSING);
  assert.equal(d.maePct, -0.39);
  // The mirrored row's -3.44% adverse excursion must NOT leak into the defect summary: it belongs
  // to a position the desk never chose to take.
  assert.equal(s.worstAdversePct, -0.39);
});

// --- the verdict, and the alert-fatigue guard ------------------------------------
test('the level boundaries are refused, so the row cannot be created at all', () => {
  // (covered by the exitLevels test below; kept adjacent to the verdict tests because the two
  // halves — refuse the entry, attribute the residue — are the same fix)
  assert.equal(sc.LEVELS_EPOCH, '2026-09-10T00:00:00Z');
});

test('a desk-opened trade OPENED after the levels epoch is BAD', () => {
  // The live control failure: the order path could record a risk and did not. The risk is
  // unknown, not zero, and no R-based verdict covers the trade.
  const post = row({ origin: 'manual', stopPrice: null, symbol: 'Gold', openAt: '2026-09-12T02:00:00Z' });
  const all = sc.summarise([row({ stopPrice: 98 }), post]);
  const v = sc.verdict(all, sc.summarise([post]), { recentDays: 7 });
  assert.equal(v.status, 'bad');
  assert.match(v.detail, /NO declared risk/);
  assert.match(v.detail, /Gold \(manual\)/);
  assert.match(v.detail, /UNKNOWN, not zero/);
});

test('THE SAME DEFECT IS ONLY HISTORICAL IF IT WAS OPENED PRE-EPOCH', () => {
  // This is the discriminator the whole epoch exists for. Identical rows except for the entry
  // time must not produce the same verdict — otherwise the check either cries wolf about history
  // or lets a live failure hide as history.
  const shape = { origin: 'manual', stopPrice: null, symbol: 'Gold' };
  const before = row({ ...shape, openAt: '2026-09-09T10:00:00Z', closeAt: '2026-09-09T11:00:00Z' });
  const after = row({ ...shape, openAt: '2026-09-11T10:00:00Z', closeAt: '2026-09-11T11:00:00Z' });

  assert.equal(sc.verdict(sc.summarise([before]), sc.summarise([])).status, 'warn', 'pre-epoch entry');
  assert.equal(sc.verdict(sc.summarise([after]), sc.summarise([])).status, 'bad', 'post-epoch entry');

  // And the epoch is judged on the ENTRY, not the close: a position opened before the epoch and
  // closed long after it is still a pre-epoch entry.
  const straddling = row({ ...shape, openAt: '2026-09-09T10:00:00Z', closeAt: '2026-09-13T10:00:00Z' });
  assert.equal(sc.verdict(sc.summarise([straddling]), sc.summarise([straddling])).status, 'warn');
});

test('the pre-epoch residue is warn, names the epoch, and is never silently absorbed', () => {
  // 11 unfixable historical rows must not read as a live failure, and must not vanish either: the
  // detail has to say WHAT the residue is and WHY it cannot be fixed, next to what IS measurable.
  const all = sc.summarise([
    ...Array.from({ length: 14 }, (_, i) => row({ id: i, stopPrice: 98 })),
    ...Array.from({ length: 5 }, (_, i) => row({ id: 50 + i, origin: 'venue', stopPrice: null, openAt: '2026-09-08T10:00:00Z' })),
    ...Array.from({ length: 6 }, (_, i) => row({ id: 60 + i, origin: 'manual', stopPrice: null, openAt: '2026-09-08T10:00:00Z' })),
  ]);
  const recentClean = sc.summarise([row({ id: 999, stopPrice: 98, openAt: '2026-09-13T10:00:00Z' })]);

  const v = sc.verdict(all, recentClean, { recentDays: 7 });
  assert.equal(v.status, 'warn', 'historical residue is context, not a live failure');
  assert.match(v.detail, /14 of 25 closed trade\(s\) measurable/);
  assert.match(v.detail, /5 mirrored from the venue/);
  assert.match(v.detail, /6 desk-opened before 2026-09-10/);
  assert.match(v.detail, /None opened in the last 7d/);
  // The residue must never be described as a measurement of zero risk.
  assert.equal(/zero risk/.test(v.detail), false);
});

test('full coverage is ok, and an empty ledger is not a failure', () => {
  const cleanRow = row({ stopPrice: 98, openAt: '2026-09-13T10:00:00Z' });
  const clean = sc.verdict(sc.summarise([cleanRow]), sc.summarise([cleanRow]));
  assert.equal(clean.status, 'ok');
  assert.match(clean.detail, /measurable in R/);

  const empty = sc.verdict(sc.summarise([]), sc.summarise([]));
  assert.equal(empty.status, 'ok');
  assert.equal(empty.detail, 'no closed trades in the window yet');
  // A zero-denominator must not print NaN% as if it were a measurement.
  assert.equal(sc.summarise([]).coveragePct, null);
});

test('summarise tolerates junk without inventing a verdict', () => {
  assert.equal(sc.summarise(null).closed, 0);
  assert.equal(sc.summarise(undefined).measured, 0);
  assert.equal(sc.classify(null), REASON.NOT_CLOSED);
  // Open rows are excluded from the denominator entirely — an open position has no close, and
  // counting it as "unmeasured" would overstate the hole.
  const s = sc.summarise([row({ stopPrice: null, status: 'open', closeAt: null }), row({ stopPrice: 98 })]);
  assert.equal(s.total, 2);
  assert.equal(s.closed, 1);
  assert.equal(s.coveragePct, 100);
  assert.equal(s.defectCount, 0);
});

// --- the inbound guard (same trap, one layer up) ----------------------------------
test('exitLevels.level refuses a degenerate level instead of storing it', () => {
  // This is the guard `executor.openTrade` applies before it places anything, and it lives in the
  // pure exitLevels module ON PURPOSE: requiring executor pulls in the browser connector, which
  // attaches to the desk's live Chrome on :9224, so a unit test that imported it would reach the
  // venue. The rule under test is the whole reason TRD-43 exists — a level that is FINITE but
  // zero is the dangerous one, because risk = |open - 0| x size reads as a real measurement.
  const { level } = require('../trading/agent/exitLevels');

  // Absent means absent — NOT zero, and not an error.
  for (const absent of [null, undefined, '']) {
    assert.deepEqual(level(absent), { ok: true, value: null }, `level(${JSON.stringify(absent)})`);
  }
  // Present and usable.
  assert.deepEqual(level(98), { ok: true, value: 98 });
  assert.deepEqual(level('4434.9868'), { ok: true, value: 4434.9868 });
  // Present and degenerate: refused, so openTrade returns level_must_be_positive_number and
  // nothing is sent to the venue.
  for (const bad of [0, -5, 'abc', NaN, {}, true]) {
    const r = level(bad);
    assert.equal(r.ok, false, `level(${JSON.stringify(bad)}) should be refused`);
    assert.equal(r.value, null);
  }
});

test('exitLevels.entryLevels REFUSES the exact shape that produced Trades 1033', () => {
  // Trades 1033 (2026-09-13T17:14:46Z, origin agent, Gold, buy, size 1, stopPrice NULL) reached the
  // venue flow with BOTH levels null. The old call site was `if (d.direction && atr && px) { ... }`
  // with stopPrice initialised to null, so a missing atr14 or price silently degraded to "place the
  // order with no stop" — and webtrader.placeOrder only issues a venue SL/TP when a level is
  // non-null, so the position would have had NO STOP AT ALL. A guard whose else-branch places the
  // order is not a guard.
  const { entryLevels } = require('../trading/agent/exitLevels');

  for (const [name, args] of [
    ['atr missing', { direction: 'buy', atr14: null, price: 4400 }],
    ['atr zero', { direction: 'buy', atr14: 0, price: 4400 }],
    ['price missing', { direction: 'buy', atr14: 50, price: null }],
    ['price zero', { direction: 'buy', atr14: 50, price: 0 }],
    ['direction missing', { direction: null, atr14: 50, price: 4400 }],
    ['direction nonsense', { direction: 'sideways', atr14: 50, price: 4400 }],
  ]) {
    const r = entryLevels(args);
    assert.equal(r.ok, false, `${name} must be refused`);
    assert.equal(r.stopPrice, null, `${name}: no stop may be invented`);
    assert.ok(r.reason, `${name}: a refusal must say why`);
  }

  // The happy path still produces both levels, so the refusal cannot swallow real entries.
  const good = entryLevels({ direction: 'buy', atr14: 50, price: 4400 });
  assert.equal(good.ok, true);
  assert.equal(good.stopPrice, 4300, '4400 - 2x50');
  assert.equal(good.takeProfitPrice, 4550, '4400 + 1.5 x 100');
  assert.equal(good.stopDist, 100);
  // An explicit stopDistance overrides the 2xATR default (this is the value risk.js sized against).
  assert.equal(entryLevels({ direction: 'sell', atr14: 50, price: 4400, stopDistance: 40 }).stopPrice, 4440);
  // A non-positive stopDistance falls back to 2xATR rather than producing a stop at the fill.
  assert.equal(entryLevels({ direction: 'buy', atr14: 50, price: 4400, stopDistance: 0 }).stopPrice, 4300);
});

test('the agent entry path no longer has a branch that places an order with null levels', () => {
  // Structural, and the reason it is a test: the defect was not a wrong number, it was an `else`
  // path that let an order through. Re-adding a nullable stop at that call site reintroduces it.
  const src = require('node:fs').readFileSync(require.resolve('../trading/agent/wakePipeline'), 'utf8');
  assert.equal(/let stopPrice = null/.test(src), false, 'the nullable levels branch is back');
  assert.match(src, /entryLevels\(/, 'the entry contract must be called');
  assert.match(src, /levels_unavailable/, 'the refusal must be recorded, not silently skipped');
});

test('stopCoverage.report is DB-backed only through store.listClosedTradesForStats', () => {
  // Structural: the module must not grow its own SQL (all judgement is in the pure functions).
  const src = require('node:fs').readFileSync(require.resolve('../trading/agent/stopCoverage'), 'utf8');
  assert.equal(/query\(/.test(src), false, 'no ad-hoc SQL in stopCoverage');
  assert.equal(/getPool/.test(src), false, 'no pool access in stopCoverage');
});
