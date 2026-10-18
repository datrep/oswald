// trading/lib/pacing.js — human-like pacing for bridge actions (TRD-8).
// Every automation step gets a small randomized pause so the browser behaves
// like a person, not a bot. Budgets are tuned to stay fast (a full capture of
// N symbols stays under ~3s per symbol).
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sleep between minMs and maxMs (uniform).
function jitterDelay(minMs, maxMs) {
  const lo = Math.max(0, Number(minMs) || 0);
  const hi = Math.max(lo, Number(maxMs) || lo);
  return sleep(lo + Math.random() * (hi - lo));
}

// "Reading the screen" pause — 350-900ms, cheap.
function glance() {
  return jitterDelay(350, 900);
}

// "Typing / deciding" pause — 600-1600ms.
function ponder() {
  return jitterDelay(600, 1600);
}

module.exports = { sleep, jitterDelay, glance, ponder };
