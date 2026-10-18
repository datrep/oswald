#!/usr/bin/env node
// trading/scripts/record-instruments.js
//
// CONTINUITY 2026-10-10 — NEW FILE (pure addition; merges without conflict).
// Reads only public provider APIs and writes PriceBars/PriceTicks. Delete it if
// the desk's own recording supersedes it.
//
// Continuity recorder — keeps PriceBars + PriceTicks current while the desk PC
// is unreachable (2026-10-10 .. 2026-10-15). Uses the agent's own providers, so
// no brokerage / Plus500 login is needed:
//
//   * bars  -> PriceBars : Yahoo public chart API (also fills the outage gap)
//   * ticks -> PriceTicks: Binance / OKX / Yahoo public REST
//
// Incremental and idempotent: backfillBars never re-downloads stored history,
// and ticks are appended snapshots. Safe to run on a short interval.
//
// Usage:
//   node trading/scripts/record-instruments.js                # bars + ticks
//   node trading/scripts/record-instruments.js --ticks-only
//   node trading/scripts/record-instruments.js --bars-only
//   node trading/scripts/record-instruments.js --quiet        # for scheduled runs
//
// Scheduled: Windows Task Scheduler "Oswald instrument recorder", every 10 min,
// end date 2026-10-15. Log: trading/scripts/recorder.log

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..'); // trading/
const store = require(path.join(ROOT, 'store.js'));
const providers = require(path.join(ROOT, 'agent', 'providers.js'));

const LOG_FILE = path.join(__dirname, 'recorder.log');
const LOCK_FILE = path.join(__dirname, '.recorder.lock');
const LOCK_STALE_MS = 20 * 60 * 1000; // a hung run must not block the schedule forever
const USER = Number(process.env.OSWALD_USER || 1);

const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const TICKS_ONLY = args.includes('--ticks-only');
const BARS_ONLY = args.includes('--bars-only');

function log(line) {
    const stamped = `${new Date().toISOString()}  ${line}`;
    try {
        fs.appendFileSync(LOG_FILE, stamped + '\n');
    } catch {
        /* logging must never fail the run */
    }
    if (!QUIET) console.log(stamped);
}

// Pick a backfill source per symbol: Yahoo first (longest history), then the exchanges.
function bestProvider(symbol) {
    const map = providers.SYMBOL_MAP[symbol] || {};
    if (map.yahoo) return 'yahoo';
    if (map.binance) return 'binance';
    if (map.okx) return 'okx';
    return null;
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

    try {
        // --- make sure the watchlist carries every mapped instrument -----------
        let settings = await store.getSettings(USER);
        const symbols = Object.keys(providers.SYMBOL_MAP).sort();
        const existing = (settings.watchlist && settings.watchlist.symbols) || [];
        if (existing.length !== symbols.length) {
            await store.saveSettings(USER, {
                watchlist: { ...(settings.watchlist || {}), symbols: symbols.map((symbol) => ({ symbol, venue: 'yahoo' })) },
            });
            settings = await store.getSettings(USER);
            log(`watchlist set to ${symbols.length} mapped instruments`);
        }

        let barTotal = 0;
        let barErrors = 0;

        if (!TICKS_ONLY) {
            const plan = providers.MULTI_TF_PLAN || [{ timeframe: '1h', rangeDays: 90 }];
            for (const symbol of symbols) {
                const provider = bestProvider(symbol);
                if (!provider) continue;
                for (const step of plan) {
                    try {
                        const r = await providers.backfillBars(USER, {
                            provider,
                            symbol,
                            timeframe: step.timeframe,
                            rangeDays: step.rangeDays,
                            limit: null, // full rangeDays window, not the 300-bar default
                        });
                        barTotal += Number(r.bars) || 0;
                    } catch (e) {
                        barErrors++;
                        if (!QUIET) log(`  bar error ${symbol}/${step.timeframe}: ${e.message}`);
                    }
                }
            }
        }

        let tickCount = 0;
        if (!BARS_ONLY) {
            try {
                const snap = await providers.snapshotAll(USER, settings, { force: true });
                tickCount = Number(snap.ticks) || 0;
            } catch (e) {
                log(`  tick error: ${e.message}`);
            }
        }

        const db = require(path.join(ROOT, 'db.js'));
        const pool = await db.getPool();
        const bars = (await pool.request().query('SELECT COUNT(*) AS n FROM PriceBars')).recordset[0].n;
        const ticks = (await pool.request().query('SELECT COUNT(*) AS n FROM PriceTicks')).recordset[0].n;

        log(`ok  symbols=${symbols.length}  bars+${barTotal}${barErrors ? ` errors=${barErrors}` : ''}  ticks+${tickCount}  totals: bars=${bars} ticks=${ticks}`);
        await require(path.join(ROOT, 'node_modules', 'mssql')).close();
    } finally {
        try {
            fs.unlinkSync(LOCK_FILE);
        } catch {
            /* ignore */
        }
    }
})().catch((e) => {
    log(`FAILED: ${e.message}`);
    process.exitCode = 1;
});
