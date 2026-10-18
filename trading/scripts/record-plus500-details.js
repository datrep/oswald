#!/usr/bin/env node
// trading/scripts/record-plus500-details.js
//
// CONTINUITY 2026-10-11 — NEW FILE (pure addition; merges without conflict).
//
// Cycles through every instrument in the open Plus500 watchlist, opens each one's
// "Instrument Details" panel and records the Live Statistics. Serves TWO purposes:
//
//   1. DATA — the details panel carries far more than the watchlist row: 5m/1h/1d
//      change, Low/High ranges per timeframe, unit amount, leverage, dynamic
//      spread, point value, initial/maintenance margin, expiry and overnight
//      funding rates. None of that is available from the public providers.
//
//   2. SESSION KEEP-ALIVE — Plus500 logs the session out on inactivity, and merely
//      READING the DOM does not count as activity. Cycling the instrument
//      selection is real interaction, so this is what keeps the session alive
//      while the owner monitors manually across four days.
//
// SAFETY — it clicks exactly one kind of control, verified before every click:
//   [data-testid="InstrumentRow.<id>.Button.Info"]  (the chevron in div.information)
// Each click is gated on: selector resolves to exactly one element, class contains
// "open-information", and the element is NOT inside any Buy/Sell control. It never
// clicks the trade buttons, never navigates, never reloads, and never calls
// browser.close() (which risks the live session on a connectOverCDP handle).
// The owner's original selection is restored when the cycle finishes.
//
// Usage:
//   node trading/scripts/record-plus500-details.js            # one full cycle
//   node trading/scripts/record-plus500-details.js --cycle 3   # 3 cycles
//   node trading/scripts/record-plus500-details.js --quiet     # for scheduled runs
//
// Records: trading/scripts/plus500-details.jsonl (one JSON object per instrument)
//          trading/scripts/plus500-details.log    (human-readable run log)
// Scheduled: Windows Task Scheduler "Oswald plus500 details".

const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..'); // trading/
const JSONL_FILE = path.join(__dirname, 'plus500-details.jsonl');
const LOG_FILE = path.join(__dirname, 'plus500-details.log');
const LOCK_FILE = path.join(__dirname, '.plus500-details.lock');
const LOCK_STALE_MS = 120 * 1000;
const CDP_PORT = Number(process.env.PLUS500_CDP_PORT || 9224);
const CLICK_TIMEOUT_MS = 8000;
const SYNC_TIMEOUT_MS = 6000;
const HARD_TIMEOUT_MS = 240 * 1000; // 10 instruments x several s, plus margin

const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const cyclesIdx = args.indexOf('--cycle');
const CYCLES = cyclesIdx >= 0 ? Math.max(1, Number(args[cyclesIdx + 1]) || 1) : 1;

function log(line) {
    // Playwright errors carry multi-line call logs; collapse to one line so a
    // failure never breaks the one-line-per-run shape of this file.
    const flat = String(line).replace(/\s*\r?\n\s*/g, ' ');
    const stamped = `${new Date().toISOString()}  ${flat}`;
    try { fs.appendFileSync(LOG_FILE, stamped + '\n'); } catch { /* logging must never fail the run */ }
    if (!QUIET) console.log(stamped);
}

// Probe the CDP endpoint before connecting: a missing browser is then a clean
// skip rather than a multi-line Playwright error. The browser dies whenever the
// machine reboots (observed 2026-10-11 — a power loss while the lid was shut).
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
    ]).finally(() => clearTimeout(timer));
}

// Read every recorded field off the details panel via its stable data-testid hooks.
const EXTRACT = `(() => {
  const clean = (s) => (s == null ? null : String(s).replace(/[\\u200e\\u200f\\u200b\\u00a0]/g, '').trim());
  const t = (id) => { const el = document.querySelector('[data-testid="' + id + '"]'); return el ? clean(el.textContent) : null; };
  const num = (v) => { const c = clean(v); if (c == null) return null; const m = c.replace(/,/g, '').match(/-?\\d+(?:\\.\\d+)?/); return m ? parseFloat(m[0]) : null; };
  const sel = (i, part) => 'sidebar.live-statistics.indicators.slider-' + i + '.' + part;
  return {
    name: t('InstrumentHeader.InstrumentName'),
    symbol: t('InstrumentHeader.Symbol'),
    currentSellRate: num(t('DetailsSidebar.live-statistics.current-rate.value')),
    // item-0/1/2 are the 5 Minutes / 1 Hour / 1 Day columns, in DOM order.
    change: {
      m5: num(t('DetailsSidebar.live-statistics.change.item-0.value')),
      h1: num(t('DetailsSidebar.live-statistics.change.item-1.value')),
      d1: num(t('DetailsSidebar.live-statistics.change.item-2.value')),
    },
    ranges: [0, 1, 2].map((i) => ({
      label: t(sel(i, 'label')),
      low: num(t(sel(i, 'low'))),
      high: num(t(sel(i, 'high'))),
    })),
    rates: {
      unitAmount: t('sidebar.rates-and-values.column-0.value'),
      unitAmountUnit: t('sidebar.rates-and-values.column-0.sub-value'),
      leverage: t('sidebar.rates-and-values.column-1.value'),
      dynamicSpread: num(t('sidebar.rates-and-values.column-2.value')),
      pointValue: t('DetailsSidebar.rates-and-values.exchange-multiplier.value'),
    },
    margin: {
      initial: t('DetailsSidebar.margin.initial.value'),
      maintenance: t('DetailsSidebar.margin.maintenance.value'),
    },
    expiry: t('DetailsSidebar.availability.expiry-date.value'),
    funding: {
      buy: t('DetailsSidebar.more-info.premium-buy.value'),
      sell: t('DetailsSidebar.more-info.premium-sell.value'),
      time: t('DetailsSidebar.more-info.premium-time.value'),
    },
  };
})()`;

(async () => {
    // --- single-instance guard -------------------------------------------------
    try {
        const st = fs.statSync(LOCK_FILE);
        if (Date.now() - st.mtimeMs < LOCK_STALE_MS) { log('skip: another run is in progress'); return; }
        fs.unlinkSync(LOCK_FILE);
    } catch { /* no lock file — fine */ }
    fs.writeFileSync(LOCK_FILE, String(process.pid));

    const watchdog = setTimeout(() => {
        log(`error: hard timeout after ${HARD_TIMEOUT_MS / 1000}s — exiting`);
        process.exit(1);
    }, HARD_TIMEOUT_MS);

    let browser = null;
    try {
        if (!(await cdpUp(CDP_PORT))) {
            log(`skip: browser not reachable on :${CDP_PORT} (CDP down) — no cycle this run`);
            return;
        }
        const { chromium } = require('playwright-core');
        browser = await withTimeout(
            chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 10000 }),
            15000, 'connect'
        );
        const pages = browser.contexts().flatMap((c) => c.pages().filter((p) => /^https?:/.test(p.url())));
        const page = pages.find((p) => /app\.plus500\.com\/.*watchlist/i.test(p.url()))
            || pages.find((p) => /app\.plus500\.com/i.test(p.url()));
        if (!page) { log('skip: no Plus500 tab open (nothing navigated — read-only attach)'); return; }

        // Snapshot the current selection so it can be restored afterwards.
        const rows = await withTimeout(page.evaluate(() => {
            return [...document.querySelectorAll('[class*="instrument-row"]')].map((r) => ({
                id: r.getAttribute('data-instrument-id'),
                name: (r.querySelector('[data-testid$=".DisplayName"]') || {}).textContent || null,
                selected: /(^|\s)selected(\s|$)/.test(r.className),
            }));
        }), SYNC_TIMEOUT_MS, 'row snapshot');
        if (!rows.length) { log('skip: no instrument rows on the current page'); return; }
        const originallySelected = (rows.find((r) => r.selected) || {}).id || null;

        log(`cycle start: ${rows.length} instruments, currently selected id=${originallySelected}`);

        for (let cycle = 1; cycle <= CYCLES; cycle++) {
            const captured = [];
            for (const row of rows) {
                const selector = `[data-testid="InstrumentRow.${row.id}.Button.Info"]`;
                // Verify this is the safe control before touching it.
                const guard = await page.evaluate((s) => {
                    const els = document.querySelectorAll(s);
                    const el = els[0];
                    return {
                        count: els.length,
                        cls: el ? String(el.className) : null,
                        insideTrade: el ? !!el.closest('[data-testid*="Button.Buy"],[data-testid*="Button.Sell"]') : null,
                    };
                }, selector).catch(() => ({ count: 0 }));
                if (guard.count !== 1 || !/open-information/.test(guard.cls || '') || guard.insideTrade) {
                    log(`  skip ${row.name}: target failed safety validation (${JSON.stringify(guard)})`);
                    continue;
                }

                await page.click(selector, { timeout: CLICK_TIMEOUT_MS });

                // Wait until BOTH the row is marked selected and the panel header
                // shows this instrument — clicking alone is not proof it landed.
                const deadline = Date.now() + SYNC_TIMEOUT_MS;
                let synced = false;
                while (Date.now() < deadline) {
                    const state = await page.evaluate((id) => {
                        const r = document.querySelector(`[data-testid="InstrumentRow.${id}"]`);
                        const hdr = document.querySelector('[data-testid="InstrumentHeader.InstrumentName"]');
                        return {
                            selected: r ? /(^|\s)selected(\s|$)/.test(r.className) : false,
                            panelName: hdr ? (hdr.textContent || '').trim() : null,
                        };
                    }, row.id).catch(() => ({ selected: false, panelName: null }));
                    if (state.selected && state.panelName && state.panelName === row.name) { synced = true; break; }
                    await sleep(200);
                }
                if (!synced) { log(`  warn ${row.name}: panel did not confirm the selection`); }

                const detail = await withTimeout(page.evaluate(EXTRACT), SYNC_TIMEOUT_MS, 'detail read').catch(() => null);
                if (!detail) { log(`  warn ${row.name}: detail panel read failed`); continue; }

                const record = { at: new Date().toISOString(), instrumentId: row.id, rowName: row.name, ...detail };
                if (!record.currentSellRate && detail.currentSellRate) record.currentSellRate = detail.currentSellRate;
                captured.push(record);
                try { fs.appendFileSync(JSONL_FILE, JSON.stringify(record) + '\n'); } catch { /* log first, fail soft */ }
            }

            log(`cycle ${cycle}/${CYCLES} done: ${captured.length}/${rows.length} instruments recorded`);
        }

        // Restore the owner's selection so the page is left as it was found.
        if (originallySelected) {
            const restore = `[data-testid="InstrumentRow.${originallySelected}.Button.Info"]`;
            await page.click(restore, { timeout: CLICK_TIMEOUT_MS }).catch(() => {});
            await sleep(600);
            const ok = await page.evaluate((id) => {
                const r = document.querySelector(`[data-testid="InstrumentRow.${id}"]`);
                return r ? /(^|\s)selected(\s|$)/.test(r.className) : false;
            }, originallySelected).catch(() => false);
            log(`restored selection to id=${originallySelected}: ${ok ? 'ok' : 'UNCONFIRMED'}`);
        }
    } catch (e) {
        log(`error: ${String((e && e.message) || e).slice(0, 200)}`);
    } finally {
        clearTimeout(watchdog);
        try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
        // Deliberately no browser.close() — see the header note.
        process.exit(0);
    }
})();
