// trading/agent/accountResets.js — 2026-10-26. ACCOUNT RESETS, RECORDED AS FACTS RATHER THAN INFERRED LATER.
//
// ⚠ WHY THIS EXISTS. The demo account was reset to 4,000 on 2026-10-16 (owner: "demo reset"). Nothing recorded
// it. The only trace was a step in `EquitySnapshots` — 2,632.98 at 12:06:10Z, exactly 4,000 at 12:21:54Z — which
// means every downstream number had to be reconstructed by eye. That cost two wrong readings in a row: a
// "+$45 over two weeks" that averaged across TWO account lives, and a post-reset window that swallowed two
// pre-reset option closes because the boundary was a guessed timestamp.
//
// ★ THE LEDGER IS THE EVENT TABLE, and the era is DERIVED from it rather than stored in settings. One
// `account_reset` row IS the boundary, the same convention `newsAggregator` (news_digest) and `calendar`
// (calendar_sync) already use for their clocks. That means:
//   · the record of what happened and the record used to filter are the same record, so they cannot disagree;
//   · a settings write is not needed, so recording a reset cannot itself breach the policy freeze;
//   · downtime is harmless — the detector is idempotent and catches up on the next tick.
//
// ⚠ WHAT IS DETECTABLE AND WHAT IS NOT, stated because half a detector that reads as whole is the failure this
// repo has already paid for. An UPWARD jump in equity cannot be caused by trading, so it is a reset with high
// confidence: measured, 2,632.98 -> 4,000 is +51.9% between two samples, against a desk whose worst real day
// moved ~3% of balance. A DOWNWARD reset looks exactly like a very bad day and is therefore NOT detected — the
// −22% sample on 2026-10-16 was the options losses, not a reset, and a rule loose enough to catch a downward
// reset would have called those losses one. If a reset downward ever happens it has to be stated by hand; the
// detector will not invent it.
'use strict';

const { getPool, sql } = require('../db');

const RESET_KIND = 'account_reset';
// A single-sample upward move this large cannot be trading. 10% is deliberately far above the desk's measured
// worst real session (~3% of balance) and far below the observed reset (+51.9%), so neither is a close call.
const DEFAULT_UP_JUMP_PCT = 10;

// ⚠ BOUNDED BY TIME, NOT BY ROW COUNT, AND THAT WAS A REAL BUG ON THE FIRST RUN. With `TOP (800)` the scan
// began after 2026-10-16 — 3,956 demo samples exist and 1,095 of them post-date the reset — so the detector
// returned "found 0" on a reset it was written specifically to find. A row cap silently defines a window that
// shrinks as the desk gets busier, which is the worst possible way to size a lookback.
async function recentSamples(userId, { sinceDays = 60, mode = 'demo' } = {}) {
  const pool = await getPool();
  const days = Number(sinceDays) > 0 ? Math.min(Number(sinceDays), 3650) : 60;
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('mode', sql.NVarChar(8), mode)
    .input('days', sql.Int, days)
    .query(`SELECT id, equity, capturedAt, source
              FROM EquitySnapshots
             WHERE userId = @userId AND mode = @mode
               AND capturedAt >= DATEADD(day, -@days, SYSUTCDATETIME())
             ORDER BY id DESC`);
  return r.recordset; // newest first
}

// PURE. Takes newest-first samples and returns the resets it can see, newest first. Extracted so the rule can be
// tested without a database — the same reason `blackSwanVerdict` and `fomcRows` are pure.
function findResets(samples, { upJumpPct = DEFAULT_UP_JUMP_PCT } = {}) {
  const out = [];
  const thr = Number(upJumpPct) > 0 ? Number(upJumpPct) : DEFAULT_UP_JUMP_PCT;
  // ⚠ SORTED HERE, NOT ASSUMED FROM THE CALLER. The first version reversed a "newest-first" input, which meant a
  // caller that handed over an ascending array produced a NEGATIVE jump and the detector silently found nothing —
  // the same class of defect as the row-count window above: a silent assumption about input shape that turns a
  // detector into a no-op. Sorting by time makes the function answer the same way whatever order it is given.
  const ts = (x) => {
    const d = x.capturedAt instanceof Date ? x.capturedAt : new Date(x.capturedAt);
    return Number.isNaN(d.getTime()) ? NaN : d.getTime();
  };
  const asc = (samples || [])
    .filter((x) => x && Number.isFinite(Number(x.equity)) && Number.isFinite(ts(x)))
    .sort((a, b) => ts(a) - ts(b) || Number(a.id) - Number(b.id));
  for (let i = 1; i < asc.length; i++) {
    const prev = asc[i - 1];
    const cur = asc[i];
    const from = Number(prev.equity);
    const to = Number(cur.equity);
    if (!(from > 0) || !(to > 0)) continue;      // a zero balance is not a reset, it is a missing read
    const pct = ((to - from) / from) * 100;
    if (pct < thr) continue;                      // downward moves are NOT resets — see the header
    out.push({
      at: cur.capturedAt instanceof Date ? cur.capturedAt.toISOString() : String(cur.capturedAt),
      prevAt: prev.capturedAt instanceof Date ? prev.capturedAt.toISOString() : String(prev.capturedAt),
      from, to, pct: +pct.toFixed(2),
      snapshotId: Number(cur.id), prevSnapshotId: Number(prev.id),
    });
  }
  return out.reverse();   // newest reset first
}

// Which resets have already been written? Deduped on `snapshotId` — the sample that CARRIES the new balance.
// Not on the timestamp: several snapshots can share a minute, and a re-detect must not write a second row for
// the same reset or the era derivation would move.
async function recordedSnapshotIds(userId) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`SELECT JSON_VALUE(payload,'$.snapshotId') AS sid
              FROM TradingEvents
             WHERE userId = @userId AND kind = '${RESET_KIND}'`);
  return new Set(r.recordset.map((x) => String(x.sid)).filter(Boolean));
}

// Idempotent. Records any reset not already in the ledger and returns what it wrote (usually []).
async function detectAndRecord(userId, { sinceDays = 60, upJumpPct = DEFAULT_UP_JUMP_PCT } = {}) {
  const samples = await recentSamples(userId, { sinceDays });
  const found = findResets(samples, { upJumpPct });
  if (!found.length) return { found: 0, inserted: [] };

  const seen = await recordedSnapshotIds(userId);
  const fresh = found.filter((r) => !seen.has(String(r.snapshotId)));
  if (!fresh.length) return { found: found.length, inserted: [] };

  const store = require('../store');
  const inserted = [];
  for (const r of fresh) {
    await store.logEvent(userId, RESET_KIND, {
      ...r,
      // The number the owner asked for: the balance the account was reset TO, and what it was before.
      balanceAfter: r.to,
      balanceBefore: r.from,
      detectedBy: `equity up ${r.pct}% between two consecutive samples (threshold ${upJumpPct}%)`,
      note: 'demo account reset — a new account life starts here; trades before this instant are a different era',
    }).catch(() => {});
    inserted.push(r);
  }
  return { found: found.length, inserted };
}

// The era the desk is currently in. `resetAt` null means no reset has ever been recorded — which is the honest
// answer before the detector has run, NOT "the beginning of time".
async function currentEra(userId) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`SELECT TOP 1 createdAt, payload FROM TradingEvents
             WHERE userId = @userId AND kind = '${RESET_KIND}'
             ORDER BY id DESC`);
  const row = r.recordset[0];
  if (!row) return { resetAt: null, balanceAfter: null, source: 'none_recorded' };
  let p = {};
  try { p = JSON.parse(row.payload || '{}'); } catch { p = {}; }
  return {
    resetAt: p.at || row.createdAt.toISOString(),
    balanceAfter: p.balanceAfter ?? null,
    balanceBefore: p.balanceBefore ?? null,
    snapshotId: p.snapshotId ?? null,
    source: 'account_reset_event',
  };
}

module.exports = { RESET_KIND, DEFAULT_UP_JUMP_PCT, findResets, recentSamples, detectAndRecord, currentEra, recordedSnapshotIds };
