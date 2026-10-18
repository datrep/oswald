'use strict';
// TRD-EXE-19 (2026-10-01) — the Soybeans sizing, A/B on LIVE data with ONLY `pointValue` flipped.
//
// The claim: `size = equity x riskPct / distance` treated one QUOTE unit as one unit of ACCOUNT currency, so a
// cents-quoted instrument sized 1/(pointValue x fx) too small. Soybeans computed 8.4641 against a 15-bushel
// venue floor and every entry was refused on `venue_minimum`.
//
// This runs the REAL `risk.evaluate` with the REAL settings and the REAL registry row, then repeats it with
// `instruments.resolve` wrapped so `pointValue` comes back as 1 — i.e. the pre-fix arithmetic — and prints both.
// Nothing is written. Run from the repo root:  node trading/scripts/repro/soybeans-sizing.js
'use strict';

const store = require('../../store');
const risk = require('../../agent/risk');
const instruments = require('../../agent/instruments');

const USER = Number(process.env.TRADING_USER_ID || 1);
const SYMBOL = process.env.SYM || 'Soybeans';

const n4 = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(4));

(async () => {
  const settings = await store.getSettings(USER);

  // What does the desk itself last said about this symbol? Prefer the desk's own numbers over invented ones.
  const events = await store.listEventsAll(USER, { kind: 'decision' }).catch(() => ({ rows: [] }));
  const mine = (events.rows || []).map((e) => e.payload).filter((p) => p && p.symbol === SYMBOL);
  const last = mine[0] || {};
  console.log(`=== last ${SYMBOL} decision on record ===`);
  console.log('  keys: ' + Object.keys(last).join(', '));
  console.log('  action=' + last.action + '  direction=' + last.direction + '  strategy=' + last.strategy);
  console.log('  stopDistance=' + last.stopDistance + '  effectiveStopDistance=' + last.effectiveStopDistance);

  const inst = await instruments.resolve(USER, { symbol: SYMBOL }).catch((e) => ({ error: e.message }));
  console.log('\n=== the registry row ===');
  console.log('  unitKind=' + inst.unitKind + '  unitAmount=' + inst.unitAmount +
    '  pointValue=' + inst.pointValue + '  leverage=' + inst.leverage +
    '  minUnits=' + (inst.venueFloor && inst.venueFloor.minUnits));

  // The desk's OWN last arithmetic, so the A/B below can be checked against a number it already produced.
  console.log('\n=== the desk\'s own sizeCalc from that decision ===');
  console.log('  ' + JSON.stringify(last.sizeCalc || null));

  const tick = await store.latestTick(USER, SYMBOL, 'plus500').catch(() => null);
  // `latestTick` returns the quote as bid/ask, not a mid. Prefer the mid of the two.
  const tickPrice = tick
    ? Number(tick.mid != null ? tick.mid
      : tick.bid != null && tick.ask != null ? (Number(tick.bid) + Number(tick.ask)) / 2
        : tick.price != null ? tick.price : tick.last)
    : null;
  console.log('\n=== latest tick ===');
  console.log('  ' + (tick ? JSON.stringify(tick).slice(0, 300) : '(none)'));

  const price = Number(process.env.PRICE || last.price || tickPrice || 0) || null;
  const atr = Number(process.env.ATR || (last.sizeCalc && last.sizeCalc.atr) || 0) || null;
  if (!price || !atr) {
    console.log('\n⚠ could not determine price/atr from the record — pass PRICE= and ATR= (env) and re-run.');
    console.log(`   (had price=${price}, atr=${atr}; the decision payload carried neither under those names)`);
    process.exit(0);
  }
  console.log(`\n=== running risk.evaluate with price=${price} atr14=${atr} ===`);

  const proposal = {
    symbol: SYMBOL, direction: 'sell', type: 'entry',
    strategy: last.strategy || 'survasoybeans',
    price, atr14: atr,
  };

  // ⚠ `pointValue` ARRIVES VIA `opts`, NOT FROM THE REGISTRY READ INSIDE `evaluate`. The aggregator resolves it
  // and threads it (that is the whole point of the 2026-10-01 sweep), so a repro that omits `opts` silently
  // exercises the `pointValue = 1` identity and proves nothing. That is what the first version of this script
  // did — it printed "contract scale 1.550000" (fx alone) on BOTH arms and showed a x1.00 difference.
  const livePointValue = Number(inst.pointValue);
  const resolvedPv = Number.isFinite(livePointValue) && livePointValue > 0 ? livePointValue : 1;
  console.log(`  pointValue threaded into opts: ${resolvedPv}  (fx comes from settings)`);

  const run = async (label, pv) => {
    const v = await risk.evaluate(USER, settings, proposal, [], [], { pointValue: pv });
    const f = v.venueFloor || {};
    console.log(`\n  --- ${label} ---`);
    console.log(`    veto            : ${v.veto ? 'YES' : '(none)'}`);
    console.log(`    vetoLine        : ${v.vetoLine || '(none)'}`);
    console.log(`    size            : ${n4(v.size)}`);
    console.log(`    impliedRiskPct  : ${n4(v.impliedRiskPct)}`);
    console.log(`    resolvedRiskPct : ${n4(v.sizeCalc && v.sizeCalc.resolvedRiskPct)}`);
    console.log(`    baseSize        : ${n4(v.sizeCalc && v.sizeCalc.baseSize)}`);
    console.log(`    notionalPct     : ${n4(v.sizeCalc && v.sizeCalc.notionalPct)}`);
    console.log(`    units string    : ${v.units}`);
    console.log(`    venueFloor      : ok=${f.ok} reason=${f.reason} minUnits=${f.minUnits} ${f.unitKind || ''}`);
    if (f.riskAtFloorPct != null) console.log(`    riskAtFloorPct  : ${n4(f.riskAtFloorPct)}% of equity`);
    console.log(`    boundBy         : ${v.boundBy || '(nothing bound)'}`);
    return v;
  };

  const after = await run('AFTER  — pointValue as the registry stores it', resolvedPv);
  const before = await run('BEFORE — pointValue forced to 1 (the pre-fix arithmetic)', 1);

  console.log('\n=== the difference ===');
  const ratio = before.size && after.size ? after.size / before.size : null;
  console.log(`  size ${n4(before.size)} -> ${n4(after.size)}   (x${ratio ? ratio.toFixed(2) : '—'})`);
  console.log(`  the venue floor is ${n4(after.venueFloor && after.venueFloor.minUnits)} ${(after.venueFloor && after.venueFloor.unitKind) || ''}`);
  console.log(`  BEFORE: ${before.veto ? 'VETOED on ' + before.veto : 'allowed'}`);
  console.log(`  AFTER : ${after.veto ? 'VETOED on ' + after.veto : 'allowed'}`);

  process.exit(0);
})().catch((e) => {
  console.error(String((e && e.stack) || e));
  process.exit(1);
});
