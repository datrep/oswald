#!/usr/bin/env node
// trading/scripts/plus500-keepalive.js
//
// CONTINUITY 2026-10-12 — NEW FILE (pure addition; merges without conflict).
//
// SESSION KEEP-ALIVE by SOFT navigation.
//
// Why this exists: reading the DOM does not count as activity for Plus500, and
// even clicking the Instrument-Details buttons apparently is not enough — the
// session still dropped. What DOES register is a real route change. This script
// performs one round trip through the app's OWN navigation bar:
//
//     Trade  ->  Open Positions  ->  Trade
//
// Both hops are in-app (SPA) link clicks, NOT page loads. That is deliberate:
// the owner established that navigating via the app's buttons does not trigger
// the logout, whereas hard reloads / direct URL loads do.
//
// SAFETY — it clicks exactly two things, both addressed by stable data-testid:
//   NavigationBar.Button.openPositionsNav.Open
//   NavigationBar.Button.tradeNav.Open
// It never touches Buy/Sell, and it never touches the position "Close" buttons
// on the Open Positions screen. No goto(), no reload(), no browser.close().
//
// It finishes ON the Trade page so the tick reader and the details cycler always
// find their instrument table afterwards.
//
// Usage:
//   node trading/scripts/plus500-keepalive.js            # one round trip
//   node trading/scripts/plus500-keepalive.js --quiet    # for scheduled runs
// Scheduled: Windows Task Scheduler "Oswald plus500 keepalive", every 5 minutes.

const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..'); // trading/
const LOG_FILE = path.join(__dirname, 'plus500-keepalive.log');
const LOCK_FILE = path.join(__dirname, '.plus500-keepalive.lock');
const DETAILS_LOCK = path.join(__dirname, '.plus500-details.lock');
const LOCK_STALE_MS = 60 * 1000;
const DETAILS_BUSY_MS = 150 * 1000; // the details cycler holds its lock ~60s
const CDP_PORT = Number(process.env.PLUS500_CDP_PORT || 9224);
const HARD_TIMEOUT_MS = 90 * 1000;

const NAV = {
    openPositions: '[data-testid="NavigationBar.Button.openPositionsNav.Open"]',
    trade: '[data-testid="NavigationBar.Button.tradeNav.Open"]',
};

const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');

function log(line) {
    const flat = String(line).replace(/\s*\r?\n\s*/g, ' ');
    const stamped = `${new Date().toISOString()}  ${flat}`;
    try { fs.appendFileSync(LOG_FILE, stamped + '\n'); } catch { /* logging must never fail the run */ }
    if (!QUIET) console.log(stamped);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdpUp(port, timeoutMs = 800) {
    return new Promise((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port });
        const done = (v) => { try { s.destroy(); } catch { /* ignore */ } resolve(v); };
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
        s.setTimeout(timeoutMs, () => done(false));
    });
}

function lockFresh(file, withinMs) {
    try {
        return Date.now() - fs.statSync(file).mtimeMs < withinMs;
    } catch {
        return false;
    }
}

// Click without Playwright actionability: the window may be backgrounded, and a
// real mouse click at the element's centre is still more faithful than a DOM
// .click(). Falls back to a DOM click if dispatching fails.
async function softClick(page, selector, label) {
    try {
        await page.click(selector, { timeout: 5000, force: true });
        return { ok: true, how: 'mouse' };
    } catch (e) {
        const domClicked = await page.evaluate((s) => {
            const el = document.querySelector(s);
            if (!el) return false;
            el.click();
            return true;
        }, selector).catch(() => false);
        if (domClicked) return { ok: true, how: 'dom' };
        return { ok: false, why: String(e.message || e).replace(/\s*\n\s*/g, ' ').slice(0, 90) };
    }
}

async function waitForPath(page, want, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const p = await page.evaluate(() => location.pathname).catch(() => null);
        if (p && p.includes(want)) return p;
        await sleep(250);
    }
    return await page.evaluate(() => location.pathname).catch(() => null);
}

(async () => {
    try {
        const st = fs.statSync(LOCK_FILE);
        if (Date.now() - st.mtimeMs < LOCK_STALE_MS) { log('skip: another keepalive run is in progress'); return; }
        fs.unlinkSync(LOCK_FILE);
    } catch { /* no lock — fine */ }
    fs.writeFileSync(LOCK_FILE, String(process.pid));

    const watchdog = setTimeout(() => {
        log(`error: hard timeout after ${HARD_TIMEOUT_MS / 1000}s — exiting`);
        process.exit(1);
    }, HARD_TIMEOUT_MS);

    try {
        // Never collide with the details cycler: both drive the same page, and
        // the details cycle is mid-click sequence for ~60s at a time.
        if (lockFresh(DETAILS_LOCK, DETAILS_BUSY_MS)) {
            log('skip: details cycler is mid-cycle — not competing for the page');
            return;
        }
        if (!(await cdpUp(CDP_PORT))) {
            log(`skip: browser not reachable on :${CDP_PORT} (CDP down)`);
            return;
        }

        const { chromium } = require('playwright-core');
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 10000 });
        const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => /plus500/i.test(p.url()));
        const page = pages.find((p) => /\/trade|watchlist/i.test(p.url())) || pages[0];
        if (!page) { log('skip: no Plus500 tab open'); return; }

        const state = await page.evaluate(() => ({
            path: location.pathname,
            loggedOut: /you have been logged out|reconnect\?/i.test(document.body ? document.body.innerText : ''),
        })).catch(() => ({}));
        if (state.loggedOut) {
            log('skip: session shows the logged-out screen — needs a manual Reconnect (cannot be automated)');
            return;
        }

        const startPath = state.path || '?';

        // Hop 1: Trade -> Open Positions (soft, in-app).
        const h1 = await softClick(page, NAV.openPositions, 'open-positions');
        if (!h1.ok) { log(`warn: could not click Open Positions (${h1.why})`); return; }
        const afterHop1 = await waitForPath(page, 'open-positions', 8000);

        await sleep(3000); // let the route change fully register as activity

        // Hop 2: Open Positions -> Trade (soft, in-app).
        const h2 = await softClick(page, NAV.trade, 'trade');
        if (!h2.ok) { log(`warn: could not click Trade (${h2.why})`); return; }
        const afterHop2 = await waitForPath(page, '/trade', 8000);

        // Confirm we are home AND the instrument table is back, so the tick
        // reader and the details cycler are not left staring at a positions page.
        let rows = 0;
        for (let i = 0; i < 12; i++) {
            rows = await page.evaluate(() => document.querySelectorAll('[class*="instrument-row"]').length).catch(() => 0);
            if (rows > 0) break;
            await sleep(750);
        }

        // Report what actually matters. "routeChanged" alone is misleading: if the
        // browser was already sitting on Open Positions (which happens after Edge
        // restores its session), hop 1 is a legitimate no-op and the old check
        // logged routeChanged=false even though the round trip worked perfectly.
        // The assertion that counts is ending up home on the watchlist with rows.
        const endedHome = /\/trade/.test(afterHop2 || '') && rows > 0;
        const changed = afterHop1 !== startPath || afterHop2 !== afterHop1;
        log(
            `ok  ${startPath} -> ${afterHop1} -> ${afterHop2}  hops=2 clicks=${h1.how}/${h2.how} ` +
            `routeChanged=${changed} home=${endedHome} instrumentRows=${rows}`
        );
        if (!endedHome) {
            log('warn: did not finish on the Trade/watchlist page with rows — capture will skip until the watchlist is shown');
        }
    } catch (e) {
        log(`error: ${String((e && e.message) || e).replace(/\s*\n\s*/g, ' ').slice(0, 180)}`);
    } finally {
        clearTimeout(watchdog);
        try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
        process.exit(0);
    }
})();
