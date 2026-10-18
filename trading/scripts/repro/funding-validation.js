// trading/scripts/repro/funding-validation.js — TRD-45 Phase 3.
//
// Does the venue's STATED overnight funding match what it actually CHARGED?
//
// The stated rates came from the instrument registry (Phase 1: Gold spot buy -0.0319%/night, sell
// -0.0120%/night). The charged amounts came from the venue's own "Actual adjustments", which
// `venueClose` reads on every position it closed and which — until migration 036 — were journalled
// into a `trade_closed` event and then lost, because `grossPnl` already has them subtracted.
//
// So this script does two things:
//   1. BACKFILL: pull `funding` out of the historical `trade_closed` events and write it onto the
//      Trades rows, with `fundingSource = 'venue_actual'`. Those rows are the only place a real charge
//      was ever recorded, and without them the check has nothing to check against.
//   2. VALIDATE: predict each charge from nights held x the stated per-side rate x notional, and
//      report the ratios, the verdicts, and the defects.
//
// A ratio far from 1 is NOT automatically a defect: the venue sets the rate per instrument PER DAY, so
// a prediction from a rate captured on a different day is expected to differ. The defects worth acting
// on are a sign mismatch, a charge over zero nights, and an order-of-magnitude gap. Everything else is
// accumulated as a BIAS — the number to correct the stated rate with.
//
// Usage (from the repo root):
//   node trading/scripts/repro/funding-validation.js            # dry run, report only
//   node trading/scripts/repro/funding-validation.js --apply     # backfill the columns, then report
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const { getPool, sql } = require('../../../shared/db');
const { fundingVariance } = require('../../agent/funding');
const { fundingMinuteUtc } = require('../../agent/time');
const { classifyName } = require('../../plus500/instrumentSpec');
const instr = require('../../agent/instruments');

const USER = Number(process.env.FUNDING_USER || 1);
const APPLY = process.argv.includes('--apply');
// The bridge box renders venue times in ITS local zone (established in Phase 0 and used by every other
// venue-time parser here). Stated once, so a wrong assumption is one number to change.
const VENUE_UTC_OFFSET_MIN = 480; // SGT = UTC+8
const DEFAULT_FUNDING_HOUR = 5;    // the venue's published time on the one chain captured

async function closedTrades(pool) {
  const r = await pool.request().input('userId', sql.Int, USER)
    .query(`SELECT id, symbol, direction, size, openPrice, closePrice, openAt, closeAt, grossPnl,
                   plus500PositionId, origin, strategyId, fundingCost, fundingSource, swapNights
            FROM Trades WHERE userId = @userId AND status = 'closed' ORDER BY id`);
  return r.recordset;
}

// The venue-charged funding, as journalled. `venue_actual` is the only usable provenance — an estimate
// cannot validate the rate it was computed from.
async function journalledFunding(pool) {
  const r = await pool.request().input('userId', sql.Int, USER)
    .query(`SELECT id, createdAt, payload FROM TradingEvents
            WHERE userId = @userId AND kind = 'trade_closed' ORDER BY id DESC`);
  const out = [];
  for (const row of r.recordset) {
    let p;
    try { p = JSON.parse(row.payload); } catch { continue; }
    if (!p || p.funding == null) continue;
    out.push({ eventId: row.id, at: row.createdAt, positionId: p.venuePositionId != null ? String(p.venuePositionId) : null, symbol: p.symbol || null, funding: p.funding, netPnl: p.netPnl });
  }
  return out;
}

function matchTrade(trades, j) {
  if (j.positionId) {
    const hit = trades.find((t) => t.plus500PositionId != null && String(t.plus500PositionId) === j.positionId);
    if (hit) return hit;
  }
  // Fallback: symbol + a close that is not before the open. Only used when the event carried no id.
  const cands = trades
    .filter((t) => String(t.symbol || '').trim() === String(j.symbol || '').trim())
    .filter((t) => t.closeAt && new Date(t.closeAt).getTime() <= new Date(j.at).getTime() + 3600000);
  return cands.sort((a, b) => new Date(b.closeAt) - new Date(a.closeAt))[0] || null;
}

(async () => {
  const pool = await getPool();
  const trades = await closedTrades(pool);
  const journal = await journalledFunding(pool);

  console.log(`closed trades: ${trades.length} · trade_closed events carrying funding: ${journal.length}`);
  console.log(`already carrying venue_actual funding: ${trades.filter((t) => t.fundingSource === 'venue_actual').length}`);
  console.log('');

  // --- 1. backfill -----------------------------------------------------------------
  const plan = [];
  for (const j of journal) {
    const t = matchTrade(trades, j);
    if (!t) { plan.push({ j, t: null }); continue; }
    if (t.fundingSource === 'venue_actual') continue; // idempotent
    plan.push({ j, t });
  }
  const unmatched = plan.filter((p) => !p.t);
  console.log(`=== backfill ${APPLY ? 'APPLY' : 'DRY RUN'} ===`);
  console.log(`rows to write: ${plan.length - unmatched.length} · events with no matching trade: ${unmatched.length}`);
  for (const u of unmatched.slice(0, 5)) console.log(`   unmatched: positionId=${u.j.positionId} symbol=${u.j.symbol} funding=${u.j.funding}`);
  if (APPLY) {
    let written = 0;
    for (const p of plan) {
      if (!p.t) continue;
      // TRD-49: the stored count is the venue's own clock count, not UTC midnights — it sits on the
      // same row as `fundingCost` (the venue's ACTUAL charge) and a midnight count would contradict a
      // correct charge. The venue default is used rather than a per-instrument lookup because this
      // path predates the registry read below; the validator re-scores from the instrument's own
      // published time whenever it has one, so a stale count here can never win over a known clock.
      const nights = p.t.openAt && p.t.closeAt ? require('../../agent/time').nightsFor(p.t.openAt, p.t.closeAt, require('../../agent/time').DEFAULT_FUNDING_MINUTE_UTC) : null;
      try {
        await pool.request()
          .input('id', sql.Int, p.t.id)
          .input('funding', sql.Decimal(18, 6), Number(p.j.funding))
          .input('nights', sql.Int, nights)
          .query(`UPDATE Trades SET fundingCost = @funding, fundingSource = 'venue_actual', swapNights = @nights, updatedAt = GETUTCDATE()
                  WHERE id = @id`);
        written += 1;
      } catch (e) {
        console.log(`   FAILED trade ${p.t.id}: ${e.message}`);
      }
    }
    console.log(`wrote ${written} row(s)`);
  }
  console.log('');

  // --- 2. validate ------------------------------------------------------------------
  const fresh = APPLY ? await closedTrades(pool) : trades;
  // The stated rate for each row's symbol and SIDE, from the registry. A symbol never captured gets
  // null, which makes the row untestable rather than silently predicted at zero.
  const facts = await instr.venueCostFacts(USER, {});
  // An OPTION is a different instrument class under the same underlying, and the venue states 0.0000%
  // funding on BOTH sides of every one — so a trade whose symbol is option-shaped gets an explicit
  // rate of 0, which `fundingCheck` treats as a check ("free, and it was free") rather than a skip.
  const underlyingOf = (t) => {
    const cls = classifyName(t.symbol);
    return { cls, key: cls.underlying || t.symbol };
  };
  const rateFor = (t) => {
    const { cls, key } = underlyingOf(t);
    if (cls.instrumentClass === 'option') return 0;
    return instr.carryPctFor(facts[key] || null, t.direction);
  };
  // The venue's funding CLOCK TIME, per instrument. Falls back to 05:00 venue-local for symbols whose
  // page has not been captured — flagged in the output, because a fallback is an assumption and the
  // points of this exercise is to stop carrying those silently.
  const fundingMinuteFor = (t) => {
    const { key } = underlyingOf(t);
    const f = facts[key] || null;
    const parsed = f ? require('../../agent/funding').parseFundingTimeLocal(f.fundingTime) : null;
    const hour = parsed ? parsed.hour : DEFAULT_FUNDING_HOUR;
    return fundingMinuteUtc({ hourLocal: hour, minuteLocal: parsed ? parsed.minute : 0, utcOffsetMinutes: VENUE_UTC_OFFSET_MIN });
  };
  const testable = fresh.filter((t) => t.fundingSource === 'venue_actual');
  const report = fundingVariance(testable, { rateFor, fundingMinuteFor });

  const withTime = testable.filter((t) => { const { key } = underlyingOf(t); const f = facts[key]; return f && require('../../agent/funding').parseFundingTimeLocal(f.fundingTime); }).length;
  console.log('=== VALIDATION: stated rate vs charged amount ===');
  console.log(`funding clock time: venue-local hour from the registry where captured, else ${DEFAULT_FUNDING_HOUR}:00 (${withTime}/${testable.length} rows used a captured time)`);
  console.log(`rows with a venue-measured charge: ${report.rows} · comparable: ${report.comparable} · bias (median ratio): ${report.bias}`);
  console.log('verdicts:', JSON.stringify(report.byVerdict));
  console.log('');
  console.log('| trade | symbol | dir | nights | notional | stated rate/night | predicted | charged | actual/pred | verdict |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const c of report.checks) {
    console.log(`| ${c.tradeId} | ${c.symbol} | ${c.direction} | ${c.nights} | ${c.notional == null ? '' : c.notional.toFixed(2)} | ${c.ratePct == null ? 'n/a' : c.ratePct + '%'} | ${round(c.predictedCost)} | ${round(c.actualCost)} | ${c.ratio == null ? '' : c.ratio.toFixed(3)} | ${c.verdict}${c.reason ? ` — ${c.reason}` : ''} |`);
  }
  console.log('');
  if (report.defects.length) {
    console.log('DEFECTS (sign / convention / magnitude only — a moved rate is not a defect):');
    for (const d of report.defects) console.log(`   #${d.tradeId} ${d.verdict}: ${d.reason}`);
  } else {
    console.log('DEFECTS: none. No sign inversion, no charge over zero nights, nothing order-of-magnitude out.');
  }
  // Which symbols CAN be tested is itself the finding: the registry only knows the Gold chain, so
  // every non-Gold charge is recorded and unrunnable.
  const bySymbol = {};
  for (const c of testable) bySymbol[c.symbol] = (bySymbol[c.symbol] || 0) + 1;
  const withoutRate = Object.keys(bySymbol).filter((s) => !facts[classifyName(s).underlying || s]);
  console.log('');
  console.log(`symbols with a charge on file: ${Object.keys(bySymbol).join(', ')}`);
  if (withoutRate.length) console.log(`NO stated rate captured for: ${withoutRate.join(', ')} — their charges are recorded but unrunnable until the venue page is captured`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });

function round(n) { return n == null ? '' : Math.round(Number(n) * 10000) / 10000; }
