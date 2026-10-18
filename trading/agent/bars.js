// trading/agent/bars.js — price-bar maintenance + tick retention (TRD-4, TRD-92).
// 1h bars from ticks, 1d bars from 1h bars, then the tick prune — which ARCHIVES BEFORE IT DELETES.
//
// TRD-92 (2026-09-21). This file used to be the second of two hard-coded 7s (`{ tickDays = 7 }` here,
// `Math.max(1, Number(days) || 7)` in store/bars.js) and every caller passed nothing, so the retention
// window was not reachable from settings at all. It is now `retention.tickDays`, resolved once in
// `agent/retention.resolveTickDays`, and the prune is no longer destructive: the expiring rows are written
// to compressed JSONL first (see agent/tickArchive.js for the order and why it is that order).
//
// The three call sites — `wakePipeline.js` (every wake), `POST /bars/build`, `POST /bars/rebuild` — do not
// change, and none of them needs to know the window exists.
'use strict';

const store = require('../store');

// `settings` may be handed in (the wake already has it); when it is not, it is read here rather than
// defaulted, because "which settings" is the thing that must never be guessed. `tickDays` stays available
// as an explicit override for scripts and tests.
async function buildAll(userId, { tickDays, settings = null } = {}) {
  const hourly = await store.upsertHourlyBars(userId);
  const daily = await store.upsertDailyBars(userId);
  // TRD-GRD-3 (2026-09-24): the capture sometimes banks the PREVIOUSLY DISPLAYED instrument's bars under
  // the symbol it was switching to — 151 such rows were found across 7 watchlist symbols, and it had
  // recurred after the GRD-1 cleanup. This runs on the SAME pass that writes the bars, so a swapped row is
  // out of quant's view from the next read rather than at the next manual audit. It FLAGS (reversible,
  // evidence kept) and never deletes, and it reports `unguarded` instead of guessing when ticks are gone.
  const swaps = await store.flagSwappedBars(userId);
  const cfg = settings || await store.getSettings(userId);
  const retention = await require('./tickArchive').archiveAndPrune(userId, { settings: cfg, tickDays });
  await store.logEvent(userId, 'bars_built', {
    hourly, daily, swaps,
    ticksDeleted: retention.deleted,
    // The retention result travels on the EXISTING event rather than in a new kind, so every reader of
    // `bars_built` sees the window, the substitution if there was one, and the archive file if one was
    // written. A prune that refused to run must not look like a prune that ran and found nothing.
    retention,
  });
  return { hourly, daily, swaps, ticksDeleted: retention.deleted, retention };
}

module.exports = { buildAll };
