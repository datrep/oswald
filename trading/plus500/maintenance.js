// trading/plus500/maintenance.js — TRD-46: reclaiming the shared bridge tab without killing it.
//
// THE PROBLEM. The desk drives ONE long-lived Plus500 SPA tab that is never reloaded. Measured
// 2026-09-14 at 1.3h uptime: 10 Chrome processes, 1,515 MB private / 1,646 MB working, of which ONE
// renderer held 875 MB (58%). A second sample ~4 minutes later read 1,509.8 MB — FLAT — so this is a
// burst-then-plateau shape, not a runaway.
//
// *** THE HYPOTHESIS THIS FILE WAS BUILT ON WAS WRONG, AND THE MEASUREMENT SAYS SO. ***
// The premise was "a reload reclaims the leak". It does not. Measured across the reload this module
// performs (2026-09-14 19:24Z, verified live):
//     before 1409 MB private / 1513 MB working, largest renderer  801 MB
//     after  1493 MB private / 1586 MB working, largest renderer  854 MB   (reloadMs 2763, settled)
//     +20 s  1458 MB private / 1561 MB working, largest renderer  851 MB
// The reload COMPLETED CORRECTLY — the tab stayed on /open-positions, it stayed logged in, the app
// re-painted — and the tree ended ABOVE where it started, because a same-origin reload reuses the
// renderer PROCESS and then re-bootstraps the SPA into it: the old allocations are not returned to the
// OS, they are joined by the fresh ones. So the honest status of TRD-46 is:
//   * the footprint PLATEAUS rather than grows (1,515 -> 1,509.8 -> 1,409 flat across hours), so there
//     is no runaway to arrest and no urgency attached to it;
//   * a page reload does not reclaim the renderer, so it is NOT the remedy;
//   * the only thing that would replace the renderer process is restarting Chrome — which drops the
//     bridge, the session feed's listener and every cached Page handle, i.e. a real outage, and is
//     therefore an owner decision rather than a maintenance convenience.
// What remains genuinely useful here is the MEASUREMENT (a number that stops the next investigation
// starting from scratch) and the LOCKING (if the tab is ever reloaded by anything, it must not be
// reloaded mid-ticket). The reload is kept because it is safe and a blank/stale SPA IS a real failure
// mode `webtrader.gotoPage` already reloads for — but it must not be described as a memory fix.
//
// WHY IT IS NOT A ONE-LINER. `browser.newPage()` returns the SHARED tab — the same page the 1s
// account poller reads, the mirror parks on /open-positions, the session feed has a response listener
// attached to, and a ticket flow may be mid-way through setting venue SL/TP on. Reloading that tab
// underneath any of them is the same class of mistake as the navigation race that killed an Oil entry
// ticket mid set-limits (order_rejected 6289, the reason pageLock.js exists at all). So the reload
// takes the SAME lock every other navigating flow takes, and the lock is what makes it coordinated
// rather than merely careful.
//
// WHAT A RELOAD DOES *NOT* DO, which is why it is the right primitive:
//   * it does not close the tab (closing it exits Chrome — see the 2026-09-12 gotcha in routes.js),
//   * it does not drop the session (cookies belong to the profile, not the document),
//   * it does not invalidate the Playwright Page handle the account poller caches, so its
//     `cachedPage` keeps working and it never has to re-acquire,
//   * it does not detach the session feed's response listener — listeners live on the Page, which
//     survives the reload — so the venue's own session registry re-populates by itself.
// `webtrader.gotoPage` already reloads once as a blank-page recovery, so reloading this tab is an
// established operation rather than a novel one.
//
// WHAT IT CANNOT COVER, stated rather than hidden: `sessionFeed.forceRefresh` and the alert routes in
// routes.js drive the shared page WITHOUT taking the lock, so a reload can still land in the middle of
// one of those. They are rare, non-trading, and re-runnable — forceRefresh is a fallback for a stale
// session on a symbol that still has an open position, and the alert routes are owner-triggered. The
// trade flow is the one that must never be interrupted, and that one is covered.
'use strict';

const browser = require('./browser');
const pageLock = require('./pageLock');
const store = require('../store');

const HOLDER = 'maintenance';

// Wait for the SPA to come back after a reload. NOT a fixed sleep: a reload that returns before the
// app has painted leaves the next reader looking at an empty document, which the desk would record as
// a data problem rather than a timing one. Same signal `gotoPage` uses (real body text), bounded.
async function settle(page, { maxMs = 20000 } = {}) {
  const t0 = Date.now();
  let chars = 0;
  while (Date.now() - t0 < maxMs) {
    chars = await page.evaluate(() => (document.body ? document.body.innerText.trim().length : 0)).catch(() => 0);
    if (chars >= 40) return { settled: true, bodyChars: chars, waitedMs: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { settled: false, bodyChars: chars, waitedMs: Date.now() - t0 };
}

// THE ACTION. Returns a report; never throws for a bridge condition (busy Chrome, a failed reload)
// because the caller is a maintenance endpoint and a thrown error would read as "the desk is broken"
// when the desk is fine and only the optional cleanup was skipped.
async function reloadSharedTab(userId, { reason = 'manual', waitMs = 180000, dryRun = false } = {}) {
  if (!(await browser.chromeAlive())) {
    return { ok: false, skipped: 'chrome_off', reason };
  }
  try {
    await pageLock.acquire(HOLDER, { waitMs });
  } catch (e) {
    // Someone is mid-trade. A reload is never worth interrupting one, so this is a SKIP and not a
    // queue: the owner can ask again, and a busy bridge is the correct answer to "may I reload now?".
    return { ok: false, skipped: 'bridge_busy', heldBy: pageLock.status().holder, reason, error: e.message };
  }
  const before = browser.profileMemoryMb();
  try {
    // `newPage()` is the shared Plus500 tab. Fetching it navigates nothing, so this is safe under the
    // lock; `page.close()` and `browser.disconnect()` are NOT, and neither is used.
    const page = await browser.newPage();
    const urlBefore = page.url();
    if (dryRun) {
      return { ok: true, dryRun: true, urlBefore, before, reason };
    }
    const t0 = Date.now();
    let reloadError = null;
    await page.reload({ timeout: 60000, waitUntil: 'domcontentloaded' }).catch((e) => { reloadError = e.message; });
    const landed = await settle(page);
    const after = browser.profileMemoryMb();
    const loggedIn = await require('./webtrader').isLoggedIn(page).catch(() => null);
    const report = {
      ok: !reloadError && landed.settled,
      reason,
      urlBefore,
      urlAfter: page.url(),
      reloadMs: Date.now() - t0,
      reloadError,
      ...landed,
      loggedIn,
      before,
      after,
      reclaimedMb: before && after ? before.privateMb - after.privateMb : null,
      at: new Date().toISOString(),
    };
    // Telemetry, so a future reader can see WHEN the tab was last reloaded and WHAT it recovered —
    // otherwise the plateau is unattributable and this gets re-investigated from scratch.
    await store.logEvent(userId, 'telemetry', { source: 'maintenance_reload', ...report }).catch(() => {});
    return report;
  } finally {
    pageLock.release(HOLDER);
  }
}

// Read-only: the current bridge memory, for a caller that only wants the number.
function memoryReport() {
  return { ...(browser.profileMemoryMb() || {}), port: browser.debugPort() };
}

module.exports = { reloadSharedTab, memoryReport, HOLDER };
