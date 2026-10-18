// trading/store/ticks.js — PriceTicks repository + ingest validation (TRD-12).
// Every tick passes cheap checks (positive/finite, ask>=bid, sane spread);
// strict checks (12xMAD magnitude vs recent mids, 60s duplicate) quarantine
// outliers instead of silently poisoning bars. Quarantined rows are kept in
// QuarantinedTicks with a reason — an audit trail, never a silent drop.
'use strict';

const { getPool, sql } = require('../db');

const SPREAD_CAP_PCT = 20;    // ask-bid spread sanity bound
const MAD_MULT = 12;          // 12xMAD magnitude guard vs the recent-mid anchor
const DEDUPE_WINDOW_MS = 60000;
// 2026-09-11 (owner patch): stale-anchor re-anchor bounds (deadlock fix below).
const REANCHOR_MIN_AGE_MS = 3 * 3600 * 1000; // newest accepted tick older than this = starving, not protecting
const REANCHOR_MAX_DEV_PCT = 25;             // plausible regime-move bound; poison-scale misreads stay rejected
const CATCHUP_TOL_PCT = 3;                   // read consistent with the LATEST accepted tick (post-re-anchor roll-over)

function midOf(t) {
  const b = Number(t.bid), a = Number(t.ask);
  if (Number.isFinite(b) && Number.isFinite(a)) return (a + b) / 2;
  return Number.isFinite(b) ? b : Number.isFinite(a) ? a : null;
}

// Cheap per-row violations (no DB): returns a reason string or null.
function cheapViolation(t) {
  const b = t.bid == null ? null : Number(t.bid);
  const a = t.ask == null ? null : Number(t.ask);
  if ((b == null && a == null) || (b != null && !Number.isFinite(b)) || (a != null && !Number.isFinite(a))) return 'non_finite';
  if (b != null && b <= 0) return 'non_positive';
  if (a != null && a <= 0) return 'non_positive';
  if (b != null && a != null && a < b) return 'ask_lt_bid';
  if (b != null && a != null && b > 0 && (a - b) / b * 100 > SPREAD_CAP_PCT) return 'spread_too_wide';
  return null;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// One query: last 50 mids + the latest row per (symbol, venue) for every
// symbol in this batch (chunked parameterized IN clauses — no TVP needed).
async function recentContext(userId, ticks) {
  const keys = [...new Set(ticks.map((t) => `${t.venue}|${t.symbol}`))];
  const out = new Map();
  const CHUNK = 50;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const req = new sql.Request();
    req.input('userId', sql.Int, userId);
    const clauses = chunk.map((k, j) => {
      const [venue, symbol] = k.split('|');
      req.input(`v${j}`, sql.NVarChar(32), venue);
      req.input(`s${j}`, sql.NVarChar(64), symbol);
      return `(venue = @v${j} AND symbol = @s${j})`;
    });
    const r = await req.query(`
      SELECT venue, symbol, mid, bid, ask, capturedAt, rn FROM (
        SELECT venue, symbol,
               mid = ((ISNULL(bid, ask) + ISNULL(ask, bid)) / 2.0),
               bid, ask, capturedAt,
               ROW_NUMBER() OVER (PARTITION BY venue, symbol ORDER BY id DESC) AS rn
        FROM PriceTicks
        WHERE userId = @userId AND (${clauses.join(' OR ')})
      ) x WHERE rn <= 50 ORDER BY venue, symbol, rn DESC`);
    for (const row of r.recordset) {
      const key = `${row.venue}|${row.symbol}`;
      if (!out.has(key)) out.set(key, { mids: [], latest: null });
      const ctx = out.get(key);
      ctx.mids.push(Number(row.mid));
      // 2026-09-11 (owner patch): rn comes back as a STRING (tedious maps
      // ROW_NUMBER/BIGINT that way) — `row.rn === 1` was never true, so
      // ctx.latest stayed null for EVERY key: the dedupe check never fired and
      // the re-anchor guard saw an "Infinity-old" anchor (which let one bad
      // SGX read through on 2026-09-11 12:26Z). Cast before comparing.
      if (Number(row.rn) === 1) ctx.latest = { bid: row.bid, ask: row.ask, capturedAt: row.capturedAt };
    }
  }
  return out;
}

async function insertQuarantined(userId, rows) {
  if (!rows.length) return;
  const pool = await getPool();
  const table = new sql.Table('QuarantinedTicks');
  table.create = false;
  table.columns.add('userId', sql.Int, { nullable: false });
  table.columns.add('venue', sql.NVarChar(32), { nullable: false });
  table.columns.add('symbol', sql.NVarChar(64), { nullable: false });
  table.columns.add('bid', sql.Decimal(18, 6), { nullable: true });
  table.columns.add('ask', sql.Decimal(18, 6), { nullable: true });
  table.columns.add('source', sql.NVarChar(32), { nullable: true });
  table.columns.add('reason', sql.NVarChar(64), { nullable: false });
  table.columns.add('detail', sql.NVarChar(200), { nullable: true });
  table.columns.add('capturedAt', sql.DateTime2, { nullable: false });
  for (const q of rows) {
    table.rows.add(userId, q.venue, q.symbol, q.bid ?? null, q.ask ?? null, q.source || 'frontend', q.reason, q.detail ?? null, q.capturedAt || new Date());
  }
  await pool.request().bulk(table).catch(() => { /* quarantine is best-effort */ });
}

async function bulkInsert(userId, rows) {
  if (!rows.length) return;
  const pool = await getPool();
  const table = new sql.Table('PriceTicks');
  table.create = false;
  table.columns.add('userId', sql.Int, { nullable: false });
  table.columns.add('venue', sql.NVarChar(32), { nullable: false });
  table.columns.add('symbol', sql.NVarChar(64), { nullable: false });
  table.columns.add('bid', sql.Decimal(18, 6), { nullable: true });
  table.columns.add('ask', sql.Decimal(18, 6), { nullable: true });
  table.columns.add('source', sql.NVarChar(32), { nullable: false });
  table.columns.add('capturedAt', sql.DateTime2, { nullable: false });
  for (const t of rows) {
    table.rows.add(userId, t.venue, t.symbol, t.bid ?? null, t.ask ?? null, t.source || 'frontend', t.capturedAt || new Date());
  }
  await pool.request().bulk(table);
}

// Pure per-tick disposition (unit-tested in test/tick-reanchor.test.js):
// decide accept / dedupe / quarantine for ONE clean tick given its recent mid
// context. c = { mids: [...], latest: {bid, ask, capturedAt} } for the key.
function classifyTick(t, c, nowMs) {
  const mid = midOf(t);
  if (c && c.mids.length >= 3 && mid != null) {
    const med = median(c.mids);
    const mad = median(c.mids.map((v) => Math.abs(v - med)));
    // 2026-09-10: MAD is variance-relative — on a FLAT recent series
    // (mad == 0, e.g. a quiet overnight CFD) ANY price passes. Fall back
    // to a 2% absolute-deviation floor so cross-instrument misreads
    // (a Bitcoin price in the coffee row) are always quarantined.
    const floor = med > 0 ? med * 0.02 : 0;
    const limit = mad > 0 ? MAD_MULT * mad : floor;
    if (limit > 0 && Math.abs(mid - med) > limit) {
      // 2026-09-11 (owner patch): STALE-ANCHOR DEADLOCK FIX. The mid context
      // only refreshes from ACCEPTED ticks, so once the market trends past the
      // guard every next tick is rejected forever and the anchor can never
      // move (live: Silver blocked ~24h at ~64 vs anchor 67.3; Sany Heavy
      // Equipment blocked at ~9.45 vs anchor 10.0 since its Sep-8 sweep rows).
      // When the newest accepted tick is STALE (the desk is starving, not
      // protecting) and the move is a plausible regime shift
      // (<= REANCHOR_MAX_DEV_PCT), accept the tick and re-anchor. Fresh-anchor
      // deviations and poison-scale misreads (cross-instrument, ~10x off)
      // stay quarantined.
      const ageMs = c.latest && c.latest.capturedAt ? nowMs - new Date(c.latest.capturedAt).getTime() : Infinity;
      const devPct = med > 0 ? (Math.abs(mid - med) / med) * 100 : 0;
      if (ageMs >= REANCHOR_MIN_AGE_MS && devPct <= REANCHOR_MAX_DEV_PCT) {
        return { kind: 'accept', reanchor: { oldMid: med, newMid: mid, ageMin: Math.round(ageMs / 60000) } };
      }
      // 2026-09-11 (owner patch, part 2) — WINDOW CATCH-UP: right after a
      // re-anchor the 50-row median is still dominated by rows from the OLD
      // level, so the very next ticks get quarantined against it again (live:
      // Sany/Silver re-anchored 12:26Z; every 12:30Z tick rejected). If the
      // read is consistent with the newest ACCEPTED tick, the regime has
      // already been banked there — accept quietly until the window rolls over.
      const latestMid = c.latest ? (Number(c.latest.bid) + Number(c.latest.ask)) / 2 : null;
      const nearLatestPct = latestMid > 0 ? (Math.abs(mid - latestMid) / latestMid) * 100 : Infinity;
      if (nearLatestPct <= CATCHUP_TOL_PCT) {
        return { kind: 'accept', catchup: { median: med, mid, latestMid } };
      }
      return {
        kind: 'quarantine',
        reason: mad > 0 ? 'mad_magnitude' : 'flat_window_deviation',
        detail: `mid ${mid} vs median ${med} (${mad > 0 ? `${MAD_MULT}xMAD` : '2% flat-window floor'})`,
      };
    }
  }
  if (c && c.latest) {
    const same = Number(c.latest.bid) === Number(t.bid) && Number(c.latest.ask) === Number(t.ask);
    const ageMs = c.latest.capturedAt ? nowMs - new Date(c.latest.capturedAt).getTime() : Infinity;
    if (same && ageMs <= DEDUPE_WINDOW_MS) return { kind: 'dedupe' };
  }
  return { kind: 'accept' };
}

// Validated ingest: cheap checks on every row; strict checks (MAD magnitude +
// dedupe vs the latest stored row) for all rows in the batch. Returns
// { inserted, quarantined, deduped, reanchored }.
async function addTicks(userId, rows) {
  if (!rows.length) return { inserted: 0, quarantined: 0, deduped: 0, reanchored: [], catchup: 0 };
  const clean = [];
  const quarantined = [];
  for (const t of rows) {
    const reason = cheapViolation(t);
    if (reason) quarantined.push({ venue: t.venue, symbol: t.symbol, bid: t.bid ?? null, ask: t.ask ?? null, source: t.source || 'frontend', reason, capturedAt: t.capturedAt || new Date() });
    else clean.push(t);
  }

  const ctx = clean.length ? await recentContext(userId, clean).catch(() => new Map()) : new Map();
  const final = [];
  const reanchored = [];
  let deduped = 0;
  let caughtUp = 0;
  const nowMs = Date.now();
  for (const t of clean) {
    const d = classifyTick(t, ctx.get(`${t.venue}|${t.symbol}`), nowMs);
    if (d.kind === 'quarantine') {
      quarantined.push({ venue: t.venue, symbol: t.symbol, bid: t.bid ?? null, ask: t.ask ?? null, source: t.source || 'frontend', reason: d.reason, detail: d.detail, capturedAt: t.capturedAt || new Date() });
      continue;
    }
    if (d.kind === 'dedupe') { deduped++; continue; }
    if (d.catchup) caughtUp += 1;
    if (d.reanchor) reanchored.push({ venue: t.venue, symbol: t.symbol, ...d.reanchor });
    final.push(t);
  }

  await insertQuarantined(userId, quarantined);
  await bulkInsert(userId, final);
  return { inserted: final.length, quarantined: quarantined.length, deduped, reanchored, catchup: caughtUp };
}

// latest N ticks for a symbol, oldest -> newest (for indicator math)
async function getTicks(userId, symbol, venue, limit = 100) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('symbol', sql.NVarChar(64), symbol)
    .input('venue', sql.NVarChar(32), venue)
    .input('limit', sql.Int, Math.min(Number(limit) || 100, 500))
    .query(`SELECT TOP (@limit) * FROM PriceTicks
            WHERE userId = @userId AND symbol = @symbol AND venue = @venue
            ORDER BY capturedAt DESC`);
  return r.recordset.reverse();
}

async function latestTick(userId, symbol, venue) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .input('symbol', sql.NVarChar(64), symbol)
    .input('venue', sql.NVarChar(32), venue)
    .query(`SELECT TOP (1) * FROM PriceTicks
            WHERE userId = @userId AND symbol = @symbol AND venue = @venue
            ORDER BY capturedAt DESC`);
  return r.recordset[0] || null;
}

// `until` bounds the window at the trade CLOSE. Without it the caller gets every
// tick from `since` to NOW, which for a closed trade means MFE/MAE/slippage were
// computed partly from price action after the position was already out — the
// learning loop then concludes "we exited too early" on a trade that never went
// our way. Bounded for all post-trade metric computation (2026-09-12).
// F32 (2026-09-18): the newest tick in the whole feed, in one row.
// `latestTick` above answers "how old is GOLD?" — which cannot tell a DEAD FEED from a QUIET SYMBOL, and
// the two need opposite responses. This answers the question the header actually asks: is the feed
// arriving at all? One indexed TOP(1) rather than a per-symbol loop, because this runs on the banner's
// poll and a health check must not be the heaviest query on the desk.
async function newestTick(userId, { venue = null } = {}) {
  const pool = await getPool();
  const req = pool.request().input('userId', sql.Int, userId);
  let where = 'userId = @userId';
  if (venue) { where += ' AND venue = @venue'; req.input('venue', sql.NVarChar(32), venue); }
  const r = await req.query(`SELECT TOP (1) * FROM PriceTicks WHERE ${where} ORDER BY capturedAt DESC`);
  return r.recordset[0] || null;
}

async function ticksSince(userId, symbol, venue, since, until) {
  const pool = await getPool();
  const req = pool.request().input('userId', sql.Int, userId)
    .input('symbol', sql.NVarChar(64), symbol)
    .input('venue', sql.NVarChar(32), venue)
    .input('since', sql.DateTime2, since);
  if (until) req.input('until', sql.DateTime2, until);
  const r = await req.query(`SELECT * FROM PriceTicks
            WHERE userId = @userId AND symbol = @symbol AND venue = @venue AND capturedAt >= @since
              ${until ? 'AND capturedAt <= @until' : ''}
            ORDER BY capturedAt ASC`);
  return r.recordset;
}

async function listQuarantined(userId, limit = 20) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .input('limit', sql.Int, Math.min(Number(limit) || 20, 200))
    .query(`SELECT TOP (@limit) * FROM QuarantinedTicks WHERE userId = @userId ORDER BY id DESC`);
  return r.recordset;
}

// TRD-79: the tick-history read behind the DERIVED spread basis.
//
// ⚠ IT DOES NOT FILTER `ask > bid`. That filter is the whole of the derivation's first guard and it
// lives in `agent/spreadDerivation.js`, where it is unit-testable without a database — a SQL-side
// filter would make the guard untestable AND hide the flat rows that explain a refusal. `source` and
// `venue` come back too, for the same reason: the census has to be able to say "this feed is
// single-sided" rather than "no rows".
//
// One symbol-agnostic query over a bounded window, because the seed is desk-wide (every symbol the
// cost model might be asked about) and a per-symbol loop would be ~90 round trips at boot. Ordered
// newest-first so a TOP bound truncates the OLDEST rows, and capped at 60k rows (~3.6 MB of the
// ~12k/7d the desk actually captures) so a runaway retention setting cannot turn boot into a stall.
async function spreadTicks(userId, { venue = null, days = 14, limit = 60000 } = {}) {
  const pool = await getPool();
  const req = pool.request()
    .input('userId', sql.Int, userId)
    .input('days', sql.Int, Math.max(1, Number(days) || 14))
    .input('limit', sql.Int, Math.min(Number(limit) || 60000, 200000));
  if (venue) req.input('venue', sql.NVarChar(32), venue);
  const r = await req.query(`SELECT TOP (@limit) symbol, venue, source, bid, ask, capturedAt
            FROM PriceTicks
            WHERE userId = @userId
              AND capturedAt > DATEADD(day, -@days, GETUTCDATE())
              ${venue ? 'AND venue = @venue' : ''}
            ORDER BY capturedAt DESC`);
  return r.recordset;
}

module.exports = { addTicks, getTicks, latestTick, newestTick, ticksSince, spreadTicks, listQuarantined, cheapViolation, midOf, classifyTick };
