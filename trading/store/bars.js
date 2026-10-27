// trading/store/bars.js — PriceBars repository + build-time validation (TRD-12).
// Structurally-invalid bars (high<low, open/close outside [low,high], non-
// positive prices) get flagged instead of silently poisoning quant/backtest.
'use strict';

const { getPool, sql } = require('../db');

const BAR_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

// ★ WHAT INTERVAL DID THIS ROW'S BAR ACTUALLY COME FROM? (design doc §4.1 — the interval-provenance defect)
//
// `capture.bankChartBars` mapped {900:'15m', 1800:'1h', 3600:'1h', 14400:'4h', 86400:'1d'} and FELL THROUGH
// to '1h' for anything unmapped, so a 30-MINUTE chart was stored as "1h" — two 30m bars merged into each
// bucket — and nothing on the row said so. Because `tfMap` mapped BOTH 1800 and 3600 to '1h', the stored
// `timeframe` ALONE cannot distinguish the two provenances. The larger half is the source: the capture's
// interval is whatever the last flow to navigate the tab left the chart on, and it can change BETWEEN
// SYMBOLS WITHIN ONE SWEEP — so a single sweep can write mixed provenance under one timeframe label.
//
// `PriceBars.sourceIntervalSec` (migration 043) is the sampling interval, in SECONDS, of the series the row
// was built FROM. With it recorded, `native` is DERIVED rather than asserted.
const TIMEFRAME_SECONDS = Object.freeze({ '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 });

// A bar's interval provenance. `native: null` means UNKNOWN — deliberately neither true nor false, so a
// consumer cannot read a missing record as a pass (§3: every fact carries its basis, and "not vouched for"
// is a finding rather than a gap).
function barIntervalProvenance(row) {
  const src = row && row.sourceIntervalSec != null ? Number(row.sourceIntervalSec) : null;
  const expected = TIMEFRAME_SECONDS[row && row.timeframe] ?? null;
  if (src == null || expected == null) {
    return { sourceIntervalSec: src, expectedIntervalSec: expected, native: null, aggregated: null };
  }
  const native = src === expected;
  return { sourceIntervalSec: src, expectedIntervalSec: expected, native, aggregated: !native };
}

// THE CALLER DECLARES; THIS FUNCTION DOES NOT SUBSTITUTE.
//
// An ABSENT key throws: that is how the silent `|| '1h'` is made loud, and it is the deleteOldTicks
// precedent (TRD-92 — "the caller resolves the window; this function does not guess one"). An explicit
// `null` is ACCEPTED and means "unknown", i.e. the chart's `layout.interval` could not be read at all.
// That is a recorded fact, not a forgotten one — TRD-111's lesson that `undefined` and `null` are not the
// same thing when the consequence is a silent substitution downstream.
function sourceIntervalOf(row) {
  if (!row || row.sourceIntervalSec === undefined) {
    throw new RangeError(
      `upsertProviderBars: ${row && row.symbol ? `${row.symbol} ` : ''}row has no sourceIntervalSec. Declare the `
      + 'interval the bars came FROM, in seconds, or pass null to record that it is unknown — this function '
      + 'will not assume 1h (that assumption is design-doc §4.1)');
  }
  if (row.sourceIntervalSec === null) return null;
  const n = Number(row.sourceIntervalSec);
  if (!Number.isFinite(n) || n <= 0) {
    throw new RangeError(
      `upsertProviderBars: sourceIntervalSec must be a positive number of seconds or null (got ${JSON.stringify(row.sourceIntervalSec)})`);
  }
  return Math.floor(n);
}

// TRD-92 (2026-09-21): THE CALLER RESOLVES THE WINDOW; THIS FUNCTION DOES NOT GUESS ONE.
//
// It used to read `Math.max(1, Number(days) || 7)`, which turned `0`, `'abc'`, `NaN` and `null` into a
// 7-day window with nothing recorded anywhere. That is the silent-substitution class this desk has now hit
// on three separate safety paths — TRD-109 (a chain that failed open), TRD-111 (`undefined` is not `null`
// when the consequence is a forced close), and the `Number(null) === 0` family the TRD-108 backfill caught
// inventing a perfect fill. Retention belongs in that list because it is evidence, not housekeeping: the
// 2026-09-19 excursion work and TRD-108's 21 level-derived autopsies both lost data to an ageing window.
//
// `agent/retention.resolveTickDays` is the one place a value is chosen, and it reports every substitution
// it makes. A caller that hands this function nonsense gets a RangeError, in the wake's own failing-step
// record — not a quiet 7 days.
async function deleteOldTicks(userId, days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d < 1) {
    throw new RangeError(
      `deleteOldTicks: the retention window must be a finite number of days >= 1 (got ${JSON.stringify(days)}); `
      + 'resolve it with agent/retention.resolveTickDays — this function will not substitute a default');
  }
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .input('days', sql.Int, Math.floor(d))
    .query(`DELETE FROM PriceTicks WHERE userId = @userId AND capturedAt < DATEADD(day, -@days, GETUTCDATE())`);
  return Number(r.rowsAffected?.[0]) || 0;
}

// How many rows are already past the cutoff — the prune's no-op test, and the number the batch floor in
// agent/tickArchive.planPrune is applied to.
async function countTicksBefore(userId, { before }) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .input('before', sql.DateTime2, new Date(before))
    .query(`SELECT COUNT(*) AS cnt FROM PriceTicks WHERE userId = @userId AND capturedAt < @before`);
  return Number(r.recordset[0]?.cnt) || 0;
}

// Paged read of the expiring rows, keyed by `id` (a stable cursor even while rows are being deleted
// underneath — `capturedAt` is not unique, and OFFSET paging skips rows when the set shrinks).
async function listTicksBefore(userId, { before, afterId = 0, limit = 5000 } = {}) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .input('before', sql.DateTime2, new Date(before))
    .input('afterId', sql.Int, Number(afterId) || 0)
    .input('limit', sql.Int, Math.min(Number(limit) || 5000, 20000))
    .query(`SELECT TOP (@limit) id, userId, venue, symbol, bid, ask, source, capturedAt
              FROM PriceTicks WHERE userId = @userId AND capturedAt < @before AND id > @afterId
              ORDER BY id ASC`);
  return r.recordset;
}

// TRD-92: the delete that COMPOSES WITH THE ARCHIVE. Bounded by the same cutoff AND by the largest id that
// actually made it into the file, so it cannot remove a row the export did not contain. Conservative in the
// safe direction: a row with an id above the boundary simply survives to the next prune.
async function deleteTicksThrough(userId, { before, maxId }) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .input('before', sql.DateTime2, new Date(before))
    .input('maxId', sql.Int, Number(maxId) || 0)
    .query(`DELETE FROM PriceTicks
             WHERE userId = @userId AND capturedAt < @before AND id <= @maxId AND id > 0`);
  return Number(r.rowsAffected?.[0]) || 0;
}

// 1h bars from the last 2 days of ticks (idempotent MERGE on the UQ key).
async function upsertHourlyBars(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .query(`WITH mids AS (
        SELECT symbol, venue,
               mid = ((ISNULL(bid, ask) + ISNULL(ask, bid)) / 2.0),
               capturedAt,
               bar = DATETIME2FROMPARTS(YEAR(capturedAt), MONTH(capturedAt), DAY(capturedAt), DATEPART(HOUR, capturedAt), 0, 0, 0, 0)
        FROM PriceTicks
        WHERE userId = @userId AND capturedAt >= DATEADD(day, -2, GETUTCDATE())
      ),
      rn AS (
        SELECT symbol, venue, bar, mid,
               ROW_NUMBER() OVER (PARTITION BY symbol, venue, bar ORDER BY capturedAt ASC) AS rnA,
               ROW_NUMBER() OVER (PARTITION BY symbol, venue, bar ORDER BY capturedAt DESC) AS rnD
        FROM mids
      ),
      bars AS (
        SELECT symbol, venue, bar,
               openPrice  = MAX(CASE WHEN rnA = 1 THEN mid END),
               closePrice = MAX(CASE WHEN rnD = 1 THEN mid END),
               high = MAX(mid), low = MIN(mid), ticks = COUNT(*)
        FROM rn GROUP BY symbol, venue, bar
      )
      MERGE PriceBars AS t
      USING bars AS s
      ON t.userId = @userId AND t.venue = s.venue AND t.symbol = s.symbol AND t.timeframe = '1h' AND t.barStart = s.bar
      WHEN MATCHED THEN UPDATE SET openPrice = s.openPrice, high = s.high, low = s.low, closePrice = s.closePrice, volume = s.ticks, sourceIntervalSec = 3600
      WHEN NOT MATCHED THEN INSERT (userId, venue, symbol, timeframe, barStart, openPrice, high, low, closePrice, volume, sourceIntervalSec)
      VALUES (@userId, s.venue, s.symbol, '1h', s.bar, s.openPrice, s.high, s.low, s.closePrice, s.ticks, 3600);`);
  return Number(r.rowsAffected?.[0]) || 0;
}

// 1d bars from 1h bars (last 3 days of hourly data).
async function upsertDailyBars(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .query(`WITH hrs AS (
        SELECT symbol, venue,
               openPrice, high, low, closePrice, barStart,
               day = DATETIME2FROMPARTS(YEAR(barStart), MONTH(barStart), DAY(barStart), 0, 0, 0, 0, 0),
               ROW_NUMBER() OVER (PARTITION BY symbol, venue, DATETIME2FROMPARTS(YEAR(barStart), MONTH(barStart), DAY(barStart), 0, 0, 0, 0, 0) ORDER BY barStart ASC) AS rnA,
               ROW_NUMBER() OVER (PARTITION BY symbol, venue, DATETIME2FROMPARTS(YEAR(barStart), MONTH(barStart), DAY(barStart), 0, 0, 0, 0, 0) ORDER BY barStart DESC) AS rnD
        FROM PriceBars
        WHERE userId = @userId AND timeframe = '1h' AND barStart >= DATEADD(day, -3, GETUTCDATE()) AND flagged = 0
      ),
      bars AS (
        SELECT symbol, venue, day,
               openPrice  = MAX(CASE WHEN rnA = 1 THEN openPrice END),
               closePrice = MAX(CASE WHEN rnD = 1 THEN closePrice END),
               high = MAX(high), low = MIN(low), ticks = COUNT(*)
        FROM hrs GROUP BY symbol, venue, day
      )
      MERGE PriceBars AS t
      USING bars AS s
      ON t.userId = @userId AND t.venue = s.venue AND t.symbol = s.symbol AND t.timeframe = '1d' AND t.barStart = s.day
      WHEN MATCHED THEN UPDATE SET openPrice = s.openPrice, high = s.high, low = s.low, closePrice = s.closePrice, volume = s.ticks, sourceIntervalSec = 3600
      WHEN NOT MATCHED THEN INSERT (userId, venue, symbol, timeframe, barStart, openPrice, high, low, closePrice, volume, sourceIntervalSec)
      VALUES (@userId, s.venue, s.symbol, '1d', s.day, s.openPrice, s.high, s.low, s.closePrice, s.ticks, 3600);`);
  return Number(r.rowsAffected?.[0]) || 0;
}

// Aggregate lower-timeframe bars into a higher timeframe (TRD-9): used to
// derive 4h bars from 1h (Yahoo has no native 4h). Buckets align to the UTC
// timeframe grid. Scoped to one venue+symbol.
async function upsertAggBars(userId, { venue, symbol, fromTf = '1h', toTf = '4h', since = null }) {
  if (!BAR_TIMEFRAMES.includes(fromTf) || !BAR_TIMEFRAMES.includes(toTf)) {
    throw new Error(`upsertAggBars: invalid timeframes ${fromTf} -> ${toTf}`);
  }
  const hours = { '1m': 0.0167, '5m': 0.0834, '15m': 0.25, '1h': 1, '4h': 4, '1d': 24 }[fromTf];
  const bucketHours = { '1m': 0.0167, '5m': 0.0834, '15m': 0.25, '1h': 1, '4h': 4, '1d': 24 }[toTf];
  if (!(bucketHours > hours)) throw new Error(`upsertAggBars: ${toTf} must be larger than ${fromTf}`);
  // 043: an aggregated row's source interval is the SOURCE series' — a 1h->4h bar is not native to 4h, and
  // the column says so rather than leaving a reader to assume the bucket size is the sampling interval.
  const fromSec = TIMEFRAME_SECONDS[fromTf];
  const pool = await getPool();
  const bucketSql = `DATEADD(hour, -(DATEPART(hour, barStart) % ${bucketHours}),
        DATEADD(minute, -DATEPART(minute, barStart),
          DATEADD(second, -DATEPART(second, barStart),
            DATEADD(millisecond, -DATEPART(millisecond, barStart), barStart))))`;
  const req = pool.request()
    .input('userId', sql.Int, userId)
    .input('venue', sql.NVarChar(32), venue)
    .input('symbol', sql.NVarChar(64), symbol);
  const sinceSql = since ? ' AND barStart >= @since' : '';
  if (since) req.input('since', sql.DateTime2, new Date(since));
  const r = await req.query(`
    WITH hrs AS (
      SELECT symbol, venue, openPrice, high, low, closePrice, barStart, volume,
             bucket = ${bucketSql},
             ROW_NUMBER() OVER (PARTITION BY symbol, venue, ${bucketSql} ORDER BY barStart ASC) AS rnA,
             ROW_NUMBER() OVER (PARTITION BY symbol, venue, ${bucketSql} ORDER BY barStart DESC) AS rnD
      FROM PriceBars
      WHERE userId = @userId AND venue = @venue AND symbol = @symbol AND timeframe = '${fromTf}' AND flagged = 0${sinceSql}
    ),
    bars AS (
      SELECT symbol, venue, bucket,
             openPrice  = MAX(CASE WHEN rnA = 1 THEN openPrice END),
             closePrice = MAX(CASE WHEN rnD = 1 THEN closePrice END),
             high = MAX(high), low = MIN(low),
             -- 4.6/4.7-A (2026-10-03): a sum is only a sum when EVERY component is known. SUM() skips
             -- NULLs, so a mixed window would silently publish a PARTIAL volume as the real one.
             -- All-known -> the sum; anything unknown -> NULL (absence stays absent).
             volume = CASE WHEN COUNT(volume) = COUNT(*) THEN SUM(volume) END
      FROM hrs GROUP BY symbol, venue, bucket
    )
    MERGE PriceBars AS t
    USING bars AS s
      ON t.userId = @userId AND t.venue = s.venue AND t.symbol = s.symbol AND t.timeframe = '${toTf}' AND t.barStart = s.bucket
    WHEN MATCHED THEN UPDATE SET openPrice = s.openPrice, high = s.high, low = s.low, closePrice = s.closePrice, volume = s.volume, sourceIntervalSec = ${fromSec}
    WHEN NOT MATCHED THEN INSERT (userId, venue, symbol, timeframe, barStart, openPrice, high, low, closePrice, volume, sourceIntervalSec)
    VALUES (@userId, s.venue, s.symbol, '${toTf}', s.bucket, s.openPrice, s.high, s.low, s.closePrice, s.volume, ${fromSec});`);
  return Number(r.rowsAffected?.[0]) || 0;
}

// Per venue/symbol/timeframe coverage: bar count + first/last barStart.
async function barsCoverage(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .query(`SELECT venue, symbol, timeframe, COUNT(*) AS bars, MIN(barStart) AS fromBar, MAX(barStart) AS toBar
            FROM PriceBars WHERE userId = @userId AND flagged = 0
            GROUP BY venue, symbol, timeframe ORDER BY symbol, timeframe, venue`);
  return r.recordset;
}

async function listBars(userId, { timeframe = '1h', symbol = null, venue = null, limit = 200, includeFlagged = false } = {}) {
  const pool = await getPool();
  const tf = BAR_TIMEFRAMES.includes(timeframe) ? timeframe : '1h';
  const req = pool.request()
    .input('userId', sql.Int, userId)
    .input('timeframe', sql.NVarChar(8), tf)
    .input('limit', sql.Int, Math.min(Number(limit) || 200, 12000));
  let where = 'userId = @userId AND timeframe = @timeframe';
  if (!includeFlagged) where += ' AND flagged = 0';
  if (symbol) { where += ' AND symbol = @symbol'; req.input('symbol', sql.NVarChar(64), symbol); }
  if (venue) { where += ' AND venue = @venue'; req.input('venue', sql.NVarChar(32), venue); }
  const r = await req.query(`SELECT TOP (@limit) * FROM PriceBars WHERE ${where} ORDER BY barStart DESC`);
  return r.recordset.reverse();
}

// Structural sanity for a provider bar row -> reason string or null.
function barViolation(b) {
  const o = Number(b.openPrice), h = Number(b.high), l = Number(b.low), c = Number(b.closePrice);
  if (![o, h, l, c].every((v) => Number.isFinite(v))) return 'non_finite';
  if (h < l) return 'high_lt_low';
  const maxOC = Math.max(o, c), minOC = Math.min(o, c);
  if (h < maxOC) return 'high_below_ohlc';
  if (l > minOC) return 'low_above_ohlc';
  if (o <= 0 || h <= 0 || l <= 0 || c <= 0) return 'non_positive';
  return null;
}

// ---- TRD-GRD-1 (2026-09-23): BAR-SCALE REVIEW — observe mode, no write-path change -----------------
//
// WHAT THIS IS FOR. On 2026-09-22 a capture banked OIL'S chart under CHINA TELECOM: twelve 1h rows at
// 89.59-91.69 carrying Oil-scale volumes, and a 1d row welding two instruments together —
// `open 4.40, high 93.29, low 4.40, close 89.61` against a true price near 4.43. EVERY ONE of those rows
// passes `barViolation` directly above, because that predicate is purely ROW-INTERNAL: it can ask whether
// a row contradicts itself, never whether it contradicts the series it claims to belong to. A row that is
// internally consistent and about the WRONG INSTRUMENT is structurally invisible to it.
//
// So this predicate needs EXTERNAL context — the trailing level of the symbol+venue the row claims to be.
// It is deliberately OBSERVE-ONLY: it returns a verdict and changes nothing. There is no call site in the
// write path, and creating one is a separate, evidence-gated decision (see the criterion below).
//
// ★ THE TRAP, FIRST BECAUSE IT IS THE ENTIRE RISK. The reference is a median of STORED bars, and stored
// bars are precisely what was corrupted. If a symbol's history is majority-corrupt, the median IS the
// corruption — and this detector would then flag the CLEAN repair rows and defend the damage. A detector
// built on the median of the thing it audits can only ever be as right as that thing's majority. Binding
// consequences:
//   (1) the reference window MUST exclude the rows under review. The caller owns that; `trailingReference`
//       takes prior closes only, and the scan script is required to build them from OUTSIDE the window;
//   (2) no `suspect` verdict may DELETE or QUARANTINE anything until the false-positive rate has been
//       measured on this desk's own history — hence observe mode;
//   (3) a symbol without enough history is `unguarded`, NOT `ok` (the TRD-111 lesson: "not vouched for"
//       is a finding, and `undefined` is not `null`).
//
// PRE-REGISTERED PROMOTION CRITERION — recorded here, before the first run, so it cannot be moved later.
// This may move from observe to enforcing only when BOTH hold, measured across the retained PriceBars:
//   (a) >= 14 consecutive days of observation with a capture sweep each day;
//   (b) ZERO false positives on bars a human has confirmed legitimate — where "legitimate" is established
//       from the venue's own quote in PriceTicks at the same barStart, NOT from the bar and NOT from the
//       median (which is the circularity TRD-117 already caught in `maeSource='close'`).
// Until both hold, the output is a list to read, never a rule that acts.
//
// The widest a bar may move against its own trailing level without a different instrument being involved.
// 3x is NOT a volatility judgment: this desk's widest measured 5-minute travel is 0.82% (review-gate
// §4), so 3x leaves ~20x of headroom below the instrument-swap signature (China Telecom 89.61/4.43 = 20.2x).
const BAR_SCALE_MAX_RATIO = 3;
const BAR_SCALE_MIN_SAMPLES = 5;

// A trailing level from PRIOR closes, as { median, samples }. Median, not mean, so a minority of already
// corrupt rows cannot drag it — which is a real property, and exactly why the majority caveat above binds.
// `median: null` with a sample count is the honest "I looked and there was not enough" answer.
function trailingReference(priorCloses, { min = BAR_SCALE_MIN_SAMPLES } = {}) {
  const xs = (priorCloses || []).map(Number).filter((v) => Number.isFinite(v) && v > 0);
  if (xs.length < min) return { median: null, samples: xs.length };
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { median: m, samples: s.length };
}

// PURE. Returns a verdict object; never throws for data reasons and never mutates. Verdicts:
//   `ok`        — every price in the row is within `maxRatio` of the reference level.
//   `suspect`   — some price is beyond it. Carries field/value/reference/ratio so the LIST is actionable.
//   `unguarded` — no usable reference, or a price `barViolation` owns. NOT a pass (see caveat 3).
function barScaleReview(bar, reference, { maxRatio = BAR_SCALE_MAX_RATIO, min = BAR_SCALE_MIN_SAMPLES } = {}) {
  if (!bar) return { verdict: 'unguarded', reason: 'no_row' };
  const prices = ['openPrice', 'high', 'low', 'closePrice'].map((f) => ({ field: f, v: Number(bar[f]) }));
  if (!prices.every((p) => Number.isFinite(p.v) && p.v > 0)) {
    // A non-positive or absent price is `barViolation`'s finding. Say so rather than manufacturing a
    // second verdict for a defect that already has an owner.
    return { verdict: 'unguarded', reason: 'no_usable_price' };
  }
  const ref = reference && Number(reference.median) > 0 && Number.isFinite(Number(reference.median))
    ? { median: Number(reference.median), samples: Number(reference.samples) || 0 }
    : null;
  if (!ref || ref.samples < min) {
    return { verdict: 'unguarded', reason: 'no_history', samples: ref ? ref.samples : 0 };
  }
  let worst = null;
  for (const p of prices) {
    const ratio = p.v / ref.median;
    const dev = ratio >= 1 ? ratio : 1 / ratio;
    if (!worst || dev > worst.dev) worst = { field: p.field, value: p.v, ratio, dev };
  }
  return {
    verdict: worst.dev > maxRatio ? 'suspect' : 'ok',
    ...(worst.dev > maxRatio ? { reason: 'scale_out_of_range' } : {}),
    field: worst.field,
    value: worst.value,
    reference: ref.median,
    ratio: Number(worst.ratio.toFixed(4)),
    samples: ref.samples,
  };
}

// ---- TRD-GRD-3 (2026-09-24): THE INSTRUMENT SWAP — a detector, and why THIS one may act --------------
//
// WHAT HAPPENED. The `plus500_chart` capture sometimes banks the bars of the instrument the chart was
// still DISPLAYING under the symbol it was SWITCHING TO. 151 rows across SEVEN watchlist symbols were
// found that way on 2026-09-24, and it had already recurred after the 2026-09-23 TRD-GRD-1 cleanup
// (see trading/docs/instrument-swap-2026-09-24.md).
//
// WHY THIS PREDICATE IS DIFFERENT FROM `barScaleReview`, AND WHY THAT MATTERS FOR THE GATE ABOVE.
// `barScaleReview` is observe-only because of a CIRCULARITY: its reference is the median of stored bars,
// and stored bars are what got corrupted, so a majority-corrupt symbol would have it defend the damage.
// It also rests on a RATIO (3x) which is a volatility judgment. **Neither property applies here.**
//   * the matching signal is an EXACT identity — all four OHLC equal to another symbol's row at the same
//     venue/timeframe/timestamp. Measured 2026-09-24 across ALL FIVE venues and 212,000+ rows: the only
//     such pairs in the entire database are the known swaps. Zero false positives, not an estimate.
//   * the victim is chosen by the symbol's OWN TICKS (see `tickAgreesWithBar`), which are the RAW INPUT
//     to the bars and therefore independent of them. No median, no history, no ratio.
// So the GRD-2 promotion criterion — written for `barScaleReview`'s mechanism, in the block above — is
// not inherited by this one. That is a CLAIM, not an exemption, and it is recorded as one so it can be
// challenged: if a future reader holds that the criterion should cover every bar predicate, this block is
// the thing to argue with.
//
// ★ AND THE TICK COMPARISON IS DECISIVE WHERE A RATIO IS NOT. The tightest real pair is CK Hutchison vs
// Silver at 67-70 against 63-67 — about 1.1x, so no scale test can separate them. Their own ticks do.
//
// ★ COVERAGE, STATED BECAUSE IT LIMITS THE DETECTOR. PriceTicks are pruned, so ticks begin 2026-09-16
// 21:08. The 1h blocks of 09-02..09-17 (SGX/Silver/Gasoline) are therefore UNGUARDED by this method —
// which is why the manual correction used level adjudication there instead. But a LIVE occurrence is
// always guarded, because the hour it lands in has just been ticked. The detector is decisive exactly
// when it runs, and says `unguarded` rather than guessing when it is not.
const SWAP_VENUE_MAP = { plus500_chart: 'plus500' };
const SWAP_TICK_EPS = 0.005;   // absorbs intra-hour drift + tick pruning; NOT a price tolerance

// PURE. Two rows can only be an instrument swap if they are the SAME BAR under two symbols: same venue,
// timeframe and barStart, different symbols, all four OHLC equal. `high > low` excludes a flat bar, which
// is the one shape two unrelated illiquid instruments COULD legitimately share.
function isSwapCandidate(a, b) {
  if (!a || !b) return false;
  if (a.symbol === b.symbol) return false;
  if (a.venue !== b.venue || a.timeframe !== b.timeframe) return false;
  if (new Date(a.barStart).getTime() !== new Date(b.barStart).getTime()) return false;
  const h = Number(a.high), l = Number(a.low);
  if (!Number.isFinite(h) || !Number.isFinite(l) || !(h > l)) return false;
  for (const f of ['openPrice', 'high', 'low', 'closePrice']) {
    const x = Number(a[f]), y = Number(b[f]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x !== y) return false;
  }
  return true;
}

// PURE. Does a bar's price RANGE agree with the range its own ticks spanned that hour? Interval
// intersection, not a ratio: scale-free, and robust to the close-drift that `upsertHourlyBars`' partial
// re-aggregation introduces. Returns `agrees` | `disagrees` | `unguarded` — and `unguarded` is NOT a pass.
function tickAgreesWithBar(bar, mids, { eps = SWAP_TICK_EPS } = {}) {
  const xs = (mids || []).map(Number).filter((v) => Number.isFinite(v) && v > 0);
  const lo = Number(bar && bar.low), hi = Number(bar && bar.high);
  if (!xs.length) return 'unguarded';
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi <= 0) return 'unguarded';
  const tLo = Math.min(...xs), tHi = Math.max(...xs);
  const pad = (tHi - tLo) * eps + tHi * eps;
  return (lo - pad <= tHi) && (hi + pad >= tLo) ? 'agrees' : 'disagrees';
}

// PURE. Which side of a candidate pair is the victim? The symbol whose bar contradicts ITS OWN ticks is
// the one whose row was banked under the wrong name; the other side is the legitimate source.
function swapVerdict(a, midsA, b, midsB) {
  const va = tickAgreesWithBar(a, midsA);
  const vb = tickAgreesWithBar(b, midsB);
  if (va === 'unguarded' || vb === 'unguarded') return { verdict: 'unguarded', reason: 'no_ticks_for_a_side' };
  if (va === 'agrees' && vb === 'disagrees') return { verdict: 'victim', victim: b.symbol, source: a.symbol };
  if (vb === 'agrees' && va === 'disagrees') return { verdict: 'victim', victim: a.symbol, source: b.symbol };
  // Both agree (not a swap) or BOTH disagree (each contradicts its own ticks — a different defect).
  // Neither is something this predicate may act on.
  return { verdict: 'ambiguous', reason: va === 'agrees' ? 'both_agree' : 'both_disagree' };
}

// Candidate pairs among rows quant can still see, newest first. Normally returns ZERO — one indexed query.
async function findSwapCandidates(userId, { sinceHours = 72 } = {}) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('since', sql.DateTime2, new Date(Date.now() - sinceHours * 3600e3))
    .query(`SELECT a.id AS a_id, a.symbol AS a_symbol, a.venue, a.timeframe, a.barStart,
                   a.openPrice AS a_open, a.high AS a_high, a.low AS a_low, a.closePrice AS a_close,
                   b.id AS b_id, b.symbol AS b_symbol
            FROM PriceBars a
            JOIN PriceBars b
              ON b.userId = a.userId AND b.venue = a.venue AND b.timeframe = a.timeframe
             AND b.barStart = a.barStart AND b.symbol > a.symbol
             AND b.openPrice = a.openPrice AND b.high = a.high
             AND b.low = a.low AND b.closePrice = a.closePrice
            WHERE a.userId = @userId AND a.flagged = 0 AND b.flagged = 0 AND a.barStart >= @since
            ORDER BY a.barStart DESC`);
  return r.recordset;
}

// The mid of each tick the hour contains, for one symbol. `plus500_chart` bars are ticked under `plus500`.
async function swapTickMids(userId, venue, symbol, barStart, timeframe) {
  const tickVenue = SWAP_VENUE_MAP[venue];
  if (!tickVenue) return null;   // unmapped venue -> unguarded, never guessed
  const from = new Date(barStart);
  const to = new Date(from.getTime() + (timeframe === '1d' ? 86400e3 : 3600e3));
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('venue', sql.NVarChar(32), tickVenue)
    .input('symbol', sql.NVarChar(64), symbol)
    .input('from', sql.DateTime2, from)
    .input('to', sql.DateTime2, to)
    .query(`SELECT (ISNULL(bid, ask) + ISNULL(ask, bid)) / 2.0 AS mid
            FROM PriceTicks WHERE userId = @userId AND venue = @venue AND symbol = @symbol
              AND capturedAt >= @from AND capturedAt < @to`);
  return r.recordset.map((x) => Number(x.mid));
}

// Adjudicate every candidate and FLAG the victims. Reversible and non-destructive: the flagged row stays
// and `listFlaggedBars` surfaces it. Returns a report for the `bars_built` event.
async function flagSwappedBars(userId, { sinceHours = 72, dryRun = false } = {}) {
  const candidates = await findSwapCandidates(userId, { sinceHours });
  const report = { candidates: candidates.length, flagged: 0, unguarded: 0, ambiguous: 0, pairs: [] };
  const victimIds = [];
  for (const c of candidates) {
    const a = { symbol: c.a_symbol, venue: c.venue, timeframe: c.timeframe, barStart: c.barStart, openPrice: c.a_open, high: c.a_high, low: c.a_low, closePrice: c.a_close };
    const b = { ...a, symbol: c.b_symbol };
    if (!isSwapCandidate(a, b)) continue;
    const [midsA, midsB] = [await swapTickMids(userId, c.venue, c.a_symbol, c.barStart, c.timeframe),
      await swapTickMids(userId, c.venue, c.b_symbol, c.barStart, c.timeframe)];
    const v = swapVerdict(a, midsA, b, midsB);
    if (v.verdict === 'victim') {
      victimIds.push(v.victim === c.a_symbol ? c.a_id : c.b_id);
      report.flagged++;
    } else if (v.verdict === 'unguarded') report.unguarded++;
    else report.ambiguous++;
    // Every outcome is reported, including the ones that act on nothing: "not vouched for" is a finding.
    report.pairs.push({ barStart: c.barStart, timeframe: c.timeframe, a: c.a_symbol, b: c.b_symbol, ...v });
  }
  if (!dryRun && victimIds.length) {
    const pool = await getPool();
    const r = await pool.request().query(
      `UPDATE PriceBars SET flagged = 1 WHERE userId = ${Number(userId)} AND id IN (${victimIds.map(Number).join(',')})`);
    report.rowsFlagged = Number(r.rowsAffected?.[0]) || 0;
  }
  return report;
}

// Upsert provider bars (backfilled klines). Idempotent: clears the window
// first, then bulk-inserts. TRD-12: invalid bars are inserted with flagged=1
// instead of being dropped silently.
// 043: every row must DECLARE `sourceIntervalSec`, and the declaration is checked for ALL rows up front —
// including rows `barViolation` is about to discard, because making the check conditional on validity would
// let a caller omit provenance on exactly the rows most likely to need re-examination later.
async function upsertProviderBars(userId, rows) {
  if (!rows.length) return { upserted: 0, flagged: 0 };
  for (const b of rows) sourceIntervalOf(b);
  const pool = await getPool();
  const groups = new Map();
  let flaggedCount = 0;
  for (const b of rows) {
    if (barViolation(b)) { flaggedCount++; continue; }
    const key = `${b.venue}|${b.symbol}|${b.timeframe}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => new Date(a.barStart) - new Date(b.barStart));
    const from = list[0].barStart;
    const to = list[list.length - 1].barStart;
    await pool.request()
      .input('userId', sql.Int, userId)
      .input('venue', sql.NVarChar(32), list[0].venue)
      .input('symbol', sql.NVarChar(64), list[0].symbol)
      .input('timeframe', sql.NVarChar(8), list[0].timeframe)
      .input('from', sql.DateTime2, from)
      .input('to', sql.DateTime2, to)
      .query(`DELETE FROM PriceBars WHERE userId = @userId AND venue = @venue AND symbol = @symbol AND timeframe = @timeframe AND barStart BETWEEN @from AND @to`);
    const table = new sql.Table('PriceBars');
    table.create = false;
    table.columns.add('userId', sql.Int, { nullable: false });
    table.columns.add('venue', sql.NVarChar(32), { nullable: false });
    table.columns.add('symbol', sql.NVarChar(64), { nullable: false });
    table.columns.add('timeframe', sql.NVarChar(8), { nullable: false });
    table.columns.add('barStart', sql.DateTime2, { nullable: false });
    table.columns.add('openPrice', sql.Decimal(18, 6), { nullable: true });
    table.columns.add('high', sql.Decimal(18, 6), { nullable: true });
    table.columns.add('low', sql.Decimal(18, 6), { nullable: true });
    table.columns.add('closePrice', sql.Decimal(18, 6), { nullable: true });
    table.columns.add('volume', sql.Decimal(18, 6), { nullable: true });
    table.columns.add('flagged', sql.Bit, { nullable: false });
    // PER ROW, not per group: one sweep can carry two provenances under one timeframe label, and a column
    // flattened to the group's would hide exactly the fact it exists to record.
    table.columns.add('sourceIntervalSec', sql.Int, { nullable: true });
    for (const b of list) {
      table.rows.add(userId, b.venue, b.symbol, b.timeframe, b.barStart, b.openPrice ?? null, b.high ?? null, b.low ?? null, b.closePrice ?? null, b.volume ?? null, 0, sourceIntervalOf(b));
    }
    await pool.request().bulk(table);
  }
  return { upserted: rows.length - flaggedCount, flagged: flaggedCount };
}

// Flagged-bar hygiene: delete flagged rows (next build recreates them from
// validated ticks) and return how many were removed.
async function deleteFlaggedBars(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .query(`DELETE FROM PriceBars WHERE userId = @userId AND flagged = 1`);
  return Number(r.rowsAffected?.[0]) || 0;
}

async function listFlaggedBars(userId, limit = 100) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .input('limit', sql.Int, Math.min(Number(limit) || 100, 500))
    .query(`SELECT TOP (@limit) * FROM PriceBars WHERE userId = @userId AND flagged = 1 ORDER BY barStart DESC`);
  return r.recordset;
}

module.exports = { BAR_TIMEFRAMES, TIMEFRAME_SECONDS, BAR_SCALE_MAX_RATIO, BAR_SCALE_MIN_SAMPLES, barIntervalProvenance, sourceIntervalOf, trailingReference, barScaleReview, deleteOldTicks, countTicksBefore, listTicksBefore, deleteTicksThrough, upsertHourlyBars, upsertDailyBars, upsertAggBars, barsCoverage, listBars, upsertProviderBars, deleteFlaggedBars, listFlaggedBars, barViolation, isSwapCandidate, tickAgreesWithBar, swapVerdict, findSwapCandidates, flagSwappedBars, SWAP_TICK_EPS };
