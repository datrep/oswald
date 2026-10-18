#!/usr/bin/env node
// trading/scripts/record-plus500-ticks.js
//
// CONTINUITY 2026-10-11 — NEW FILE (pure addition; merges without conflict).
//
// READ-ONLY Plus500 tick capture (2026-10-11 .. until the desk returns).
//
// Why this exists: the normal path (plus500/capture.js) *navigates* Plus500 with
// goto()/reload() to reach the instruments. The navigation rewrite that makes
// that reliable lives on the desk PC, and repeated hard session moves risk
// Plus500 logging the session out — which is the one thing the owner needs kept
// alive for four days of manual monitoring.
//
// This does the opposite. It attaches to the tab the owner ALREADY has open on
// their custom watchlist and reads the instrument table straight out of the DOM:
//
//   * no goto(), no reload(), no click(), no bringToFront(), no page change
//   * if the table is not on the current page it reports that and exits — it
//     never navigates to find one
//
// It reuses webtrader.readInstrumentTable(), the same proven reader the agent
// uses, so the selectors cannot drift from the app's.
//
// Provenance: ticks are written with source 'plus500_readonly' so they stay
// distinguishable from the app's own 'plus500_frontend' captures. Nothing
// filters on source, so this is safe.
//
// Usage:
//   node trading/scripts/record-plus500-ticks.js           # read + store
//   node trading/scripts/record-plus500-ticks.js --probe    # read only, print rows
//   node trading/scripts/record-plus500-ticks.js --quiet    # for scheduled runs
//
// Scheduled: Windows Task Scheduler "Oswald plus500 ticks".
// Log: trading/scripts/plus500-ticks.log

const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..'); // trading/

const LOG_FILE = path.join(__dirname, 'plus500-ticks.log');
const LOCK_FILE = path.join(__dirname, '.plus500-ticks.lock');
const LOCK_STALE_MS = 90 * 1000; // shorter than the 2-min schedule; the hard timeout below guarantees release
const HARD_TIMEOUT_MS = 60 * 1000; // a stuck run must never hold the lock or stack up
const READ_TIMEOUT_MS = 20 * 1000; // page.evaluate has NO default timeout
const CONNECT_TIMEOUT_MS = 10 * 1000;
const DB_TIMEOUT_MS = 20 * 1000;
const USER = Number(process.env.OSWALD_USER || 1);
const CDP_PORT = Number(process.env.PLUS500_CDP_PORT || 9224);

const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const PROBE = args.includes('--probe');

function log(line) {
    // Playwright errors carry multi-line call logs; collapse to one line so a
    // failure never breaks the one-line-per-run shape of this file.
    const flat = String(line).replace(/\s*\r?\n\s*/g, ' ');
    const stamped = `${new Date().toISOString()}  ${flat}`;
    try {
        fs.appendFileSync(LOG_FILE, stamped + '\n');
    } catch {
        /* logging must never fail the run */
    }
    if (!QUIET || PROBE) console.log(stamped);
}

// Is the CDP endpoint actually listening? Probing first turns "browser is gone"
// into a clean skip instead of a multi-line Playwright connection error — which
// matters because the browser dies whenever the machine reboots (2026-10-11).
function cdpUp(port, timeoutMs = 800) {
    return new Promise((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port });
        const done = (v) => {
            try { s.destroy(); } catch { /* ignore */ }
            resolve(v);
        };
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
        s.setTimeout(timeoutMs, () => done(false));
    });
}

// page.evaluate() and the mssql pool have no default timeout, so every await that
// can block on an external system is raced against a deadline. Without this a busy
// Plus500 tab hangs the run silently and holds the lock (observed live: the
// 08:34:34 run stalled with no log line until the process was killed).
function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

// Pick the Plus500 tab. Preference: the watchlist page, then any Plus500 page.
// Never opens, focuses or navigates anything.
function pickPlus500Page(browser) {
    const pages = browser.contexts().flatMap((c) => c.pages().filter((p) => /^https?:/.test(p.url())));
    return (
        pages.find((p) => /app\.plus500\.com\/.*watchlist/i.test(p.url())) ||
        pages.find((p) => /app\.plus500\.com/i.test(p.url())) ||
        null
    );
}

(async () => {
    // --- single-instance guard -------------------------------------------------
    try {
        const st = fs.statSync(LOCK_FILE);
        if (Date.now() - st.mtimeMs < LOCK_STALE_MS) {
            log('skip: another run is in progress');
            return;
        }
        fs.unlinkSync(LOCK_FILE);
    } catch {
        /* no lock file — fine */
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));

    // Backstop: whatever blocks, the process exits and releases the lock.
    const watchdog = setTimeout(() => {
        log(`error: hard timeout after ${HARD_TIMEOUT_MS / 1000}s — exiting`);
        process.exit(1);
    }, HARD_TIMEOUT_MS);

    let browser = null;
    let store = null;
    try {
        if (!(await cdpUp(CDP_PORT))) {
            log(`skip: browser not reachable on :${CDP_PORT} (CDP down) — no capture this run`);
            return;
        }
        const { chromium } = require('playwright-core');
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: CONNECT_TIMEOUT_MS });

        const page = pickPlus500Page(browser);
        if (!page) {
            log('skip: no Plus500 tab open (nothing navigated — read-only)');
            return;
        }

        // Pure DOM read of the table already on screen. No navigation.
        // Required here (not at module scope) so the watchdog covers the load too:
        // the observed hang happened before the lock was even written.
        const webtrader = require(path.join(ROOT, 'plus500', 'webtrader.js'));
        const table = await withTimeout(webtrader.readInstrumentTable(page), READ_TIMEOUT_MS, 'table read');
        const rows = (table && table.rows) || [];
        if (!rows.length) {
            log(`skip: no instrument table on ${new URL(page.url()).pathname} (${table && table.error ? table.error : 'no rows'})`);
            return;
        }

        const usable = rows.filter((r) => r.name && r.sell != null && r.buy != null);
        if (PROBE) {
            log(`probe: ${usable.length}/${rows.length} rows readable from ${new URL(page.url()).pathname}`);
            for (const r of usable) log(`  ${r.name.padEnd(24)} bid=${r.sell} ask=${r.buy} change=${r.change}`);
            return;
        }
        if (!usable.length) {
            log(`skip: ${rows.length} rows but none carried a bid/ask`);
            return;
        }

        // bid = the price you sell at (.button-sell), ask = the price you buy at
        // (.button-buy) — the same mapping the app's own capture uses.
        const ticks = usable.map((r) => ({
            venue: 'plus500',
            symbol: r.name,
            bid: r.sell,
            ask: r.buy,
            source: 'plus500_readonly',
        }));

        store = require(path.join(ROOT, 'store.js'));
        const res = await withTimeout(store.addTicks(USER, ticks), DB_TIMEOUT_MS, 'db write');
        log(
            `ok  rows=${usable.length} inserted=${res.inserted} deduped=${res.deduped} ` +
                `quarantined=${res.quarantined} symbols=${ticks.map((t) => t.symbol).join(',')}`
        );
    } catch (e) {
        const msg = String((e && e.message) || e);
        log(`error: ${msg.slice(0, 200)}`);
    } finally {
        clearTimeout(watchdog);
        try {
            fs.unlinkSync(LOCK_FILE);
        } catch {
            /* already gone */
        }
        // Deliberately NOT browser.close(): on a connectOverCDP handle that risks
        // touching the owner's live session. Dropping the process closes the
        // socket and leaves the browser exactly as it was.
        if (store) {
            try {
                await require(path.join(ROOT, 'node_modules', 'mssql')).close();
            } catch {
                /* best effort */
            }
        }
        process.exit(0);
    }
})();
