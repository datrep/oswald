// trading/agent/trailEngage.js — TRD-TRL-9 (2026-10-08): WHEN to engage the post-entry trail.
//
// The policy is lock075_t15, the best exit configuration on record (temp/lock075-study.js; fresh-n re-checked
// 2026-10-08: dAdv lo90 +0.055, dFav lo90 +0.019 — both tails' 90% lower bounds positive):
//     on touch of +0.75R  ->  move the stop to the +0.75R level (the lock), and engage a trail 0.15R behind the
//     peak. The venue fires whichever of the two levels is tighter first — exactly the studied semantics
//     (at the touch the lock is tighter; once the peak is beyond +0.90R the trail takes over).
//
// ⚠ FLAG-GATED, OFF BY DEFAULT. `settings.risk.trailingStop.engageOnTouch.enabled !== true` -> this module does
// NOTHING: no price reads, no venue calls, no events. The first live engage is held for the owner walkthrough.
//
// ⚠ THE ENGAGE IS ONLY ALLOWED WHILE THE EXCURSION IS STILL BEYOND THE LOCK. A "touch" that has already receded
// below +0.75R cannot be acted on safely: writing the lock stop there would put the stop on the wrong side of the
// market and the venue would close at the CURRENT price — a different (and worse) outcome than the studied policy,
// which exits AT 0.75R when price returns to it. The window between touch and recede is the loop's cadence (60 s)
// plus the micro-wake cadence, so it is small; when it is missed anyway, the miss is RECORDED (`missed_window`)
// per trade, never silently turned into an arbitrary fill.
//
// ⚠ THE VENUE MINIMUM IS A REAL CONSTRAINT, CHECKED BEFORE ANY ENGAGE. On instruments with a small stop distance
// the 0.15R trail can sit below the venue's smallest expressible distance (Silver: 0.15R of a ~0.6 stop is 0.09,
// under the measured floor ~0.12) — `pipsForTarget` REFUSES (`below_venue_minimum_count`) and the decision comes
// back `engage: false` with that reason. The position keeps its stop; nothing is guessed.
'use strict';
const { pipsForTarget } = require('./trailingStop');

// The pure decision. `peakFavR` is the favourable excursion watermark the loop carries per trade (in R), so a
// touch that happened between ticks is not forgotten the moment price ticks back.
function decideEngage({ trade, price, peakFavR = null, settings }) {
  const cfg = (settings && settings.risk && settings.risk.trailingStop && settings.risk.trailingStop.engageOnTouch) || {};
  if (cfg.enabled !== true) return { engage: false, reason: 'disabled' };
  const lockR = Number(cfg.lockR) > 0 ? Number(cfg.lockR) : 0.75;
  const trailR = Number(cfg.trailR) > 0 ? Number(cfg.trailR) : 0.15;

  const entry = Number(trade && trade.openPrice);
  const stop = Number(trade && trade.stopPrice);
  const px = Number(price);
  const dir = trade && trade.direction === 'sell' ? 'sell' : 'buy';
  const dist = (() => {
    const d1 = Number(trade && trade.effectiveStopDistance);
    if (d1 > 0) return d1;
    const d2 = Number(trade && trade.stopDistance);
    if (d2 > 0) return d2;
    if (entry > 0 && stop > 0) return Math.abs(entry - stop);
    return null;
  })();
  if (!(entry > 0) || !(dist > 0) || !(px > 0)) return { engage: false, reason: 'unreadable_inputs' };

  const favR = dir === 'buy' ? (px - entry) / dist : (entry - px) / dist;
  const peak = Math.max(Number(peakFavR) || 0, favR);
  const base = { favR: +favR.toFixed(4), peakFavR: +peak.toFixed(4), lockR, trailR, stopDistance: +dist.toFixed(6) };
  if (!(peak >= lockR)) return { engage: false, reason: 'not_touched', ...base };
  if (!(favR >= lockR)) return { engage: false, reason: 'missed_window', ...base }; // touched, already receded

  const lockLevel = dir === 'buy' ? entry + lockR * dist : entry - lockR * dist;
  const trailDistance = trailR * dist;
  const improves = dir === 'buy' ? lockLevel > stop : lockLevel < stop;
  if (!improves) return { engage: false, reason: 'lock_not_tighter_than_stop', ...base, lockLevel: +lockLevel.toFixed(4), stop };

  const plan = pipsForTarget({ symbol: trade.symbol, distanceTarget: trailDistance });
  if (!plan.ok) return { engage: false, reason: `unstateable_${plan.reason}`, ...base, trailDistance: +trailDistance.toFixed(4) };

  return {
    engage: true, reason: 'touch', ...base,
    lockLevel: +lockLevel.toFixed(4), trailDistance: +trailDistance.toFixed(4),
    pips: plan.pips, expectedDistance: plan.expectedDistance,
  };
}

// ── THE LOOP ────────────────────────────────────────────────────────────────────────────────────────────────
// 60 s cadence. The ONLY venue-interacting branch is the engage itself; every other tick is reads from the desk's
// own tick store (the same source the near-stop cut gate uses) plus the bridge-state gate. Skip-class refusals
// are logged ONCE per (trade, reason) so a structurally-unengageable position cannot spam the event stream.
const ENGAGE_TICK_MS = 60 * 1000;
const skipLogged = new Set();

function startLoop(userId) {
  const peak = new Map(); // tradeId -> peak favourable excursion (R), the touch watermark
  let timer = null;
  const tick = async () => {
    try {
      const settings = await require('../store').getSettings(userId);
      const cfg = (settings.risk && settings.risk.trailingStop && settings.risk.trailingStop.engageOnTouch) || {};
      if (cfg.enabled !== true) return; // ⚠ the off-switch: nothing below runs
      if ((settings.kill || {}).tier === 'hard') return;
      if (settings.paper && settings.paper.enabled) return; // sim mode has no venue
      const waker = require('./waker');
      if (waker.status().inProgress) return; // the bridge is deciding — never contend with a wake
      const bs = (() => {
        try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'bridge-state.json'), 'utf8')); } catch { return null; }
      })();
      if (bs && bs.state && !['RESTING', 'OPERATIONAL'].includes(bs.state)) return;

      const store = require('../store');
      const ticks = require('../store/ticks');
      const trades = (await store.getOpenTrades(userId)).filter((t) => t.status === 'open' && t.plus500PositionId != null);
      for (const t of trades) {
        const tickRow = await store.latestTick(userId, t.symbol, t.venue).catch(() => null);
        const mid = tickRow ? ticks.midOf(tickRow) : null;
        const d = decideEngage({ trade: t, price: mid, peakFavR: peak.get(t.id) || 0, settings });
        if (d.peakFavR != null) peak.set(t.id, d.peakFavR);
        if (!d.engage) {
          if (['missed_window', 'unstateable_below_venue_minimum_count', 'unstateable_instrument_not_measured'].includes(d.reason)) {
            const key = `${t.id}:${d.reason}`;
            if (!skipLogged.has(key)) {
              skipLogged.add(key);
              await store.logEvent(userId, 'trail_engage_skipped', { tradeId: t.id, symbol: t.symbol, ...d }).catch(() => {});
            }
          }
          continue;
        }
        // FIRE — the only venue-interacting branch. pageLock + the shared tab; `commit: true` is the single write,
        // and setPositionTrail refuses to commit anything its pre-write verification cannot confirm.
        const pageLock = require('../plus500/pageLock');
        const browser = require('../plus500/browser');
        await pageLock.acquire('ticket', { waitMs: 60000 });
        const page = await browser.newPage();
        let out = null;
        try {
          out = await require('../plus500/webtrader').setPositionTrail(page, settings, t, {
            trailDistance: d.trailDistance, stopPrice: d.lockLevel, commit: true,
          });
        } finally {
          await page.keyboard.press('Escape').catch(() => {});
          await page.goto('https://app.plus500.com/open-positions', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
          pageLock.release('ticket');
        }
        await store.logEvent(userId, out && out.ok ? 'trail_engaged' : 'trail_engage_failed', {
          tradeId: t.id, symbol: t.symbol, decision: d, result: out,
        }).catch(() => {});
        const tg = require('../lib/http').telegramAlert;
        if (out && out.ok) {
          await tg(`OSWALD TRD-TRL-9 trail engaged (lock075_t15).\n#${t.id} ${t.symbol} ${t.direction}\nlock ${d.lockLevel} (${d.lockR}R), trail ${d.trailR}R (${d.pips} pips)\nread-back verified against the venue.`).catch(() => {});
        } else if (out && out.reason === 'committed_unverified') {
          await tg(`OSWALD trail engage COMMITTED BUT UNVERIFIED on #${t.id} ${t.symbol} — inspect the trail_engage_failed event.`).catch(() => {});
        }
      }
    } catch (e) {
      await require('../store').logEvent(userId, 'error', { where: 'trail_engage_loop', error: String(e.message || e).slice(0, 200) }).catch(() => {});
    }
  };
  if (timer) clearInterval(timer);
  timer = setInterval(tick, ENGAGE_TICK_MS);
  console.log('[trading] trail engage loop started (TRD-TRL-9; inert unless risk.trailingStop.engageOnTouch.enabled)');
}

module.exports = { decideEngage, startLoop };
