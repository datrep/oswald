// Oswald trading service — Trading Agent.
// Separate Express app, own port (HTTPS 8114 + localhost health 8115), shares the
// dashboard JWT secret + SQL Server DB (listings/fileserver/expenses pattern).
//
// Phase 0: boot self-check (migration present = hard requirement) + ping endpoint
// (DeepSeek key + migration + browser probe). The wake loop / Plus500 bridge
// arrive in later phases.
const express = require('express');
const path = require('path');
const https = require('https');
const fs = require('fs');

// TRD-40: record WHY this process dies, before anything else can throw. The desk stopped
// twice with server.err.log silent and nothing to read (2026-09-12T16:51:54Z and
// 2026-09-12T18:11:54Z); scripts/supervise.js reads what this writes. Must be first.
require('./lib/crash').install({ label: 'trading' });

const { loadOrCreateCert } = require('../shared/tls');
const { getConfig } = require('./config');
const { authenticateToken } = require('./auth');
const store = require('./store');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// ── 2026-10-06: CHANGE-DRIVEN bridge-state stream (owner: "change 5 s ping to 'when it changes state'").
// The live state machine used to poll bridge-state.json every 5 s from two mounted views. This is a
// same-origin SSE endpoint: FULL state on connect, on every STATE change (state|category|cause fingerprint
// watched on the file the observer rewrites), a 5-minute snapshot refresh (diagnostics), and a 25 s comment
// keepalive. Served from the same data the static file already exposes publicly — no new surface. ──
const STATE_FILE = path.join(__dirname, 'public', 'bridge-state.json');
const sseClients = new Set();
let sseLastFp = null;
const stateRaw = () => { try { return fs.readFileSync(STATE_FILE, 'utf8'); } catch { return null; } };
const stateCompact = (raw) => { try { return JSON.stringify(JSON.parse(raw)); } catch { return null; } };
const fpOf = (raw) => { try { const j = JSON.parse(raw); return `${j.state}|${j.category}|${j.cause}`; } catch { return null; } };
function ssePush(event, data) {
  for (const res of sseClients) { try { res.write(`event: ${event}\ndata: ${data}\n\n`); } catch { sseClients.delete(res); } }
}
app.get('/bridge-state-stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  const raw = stateRaw(); const c = raw && stateCompact(raw);
  if (c) { res.write(`event: state\ndata: ${c}\n\n`); if (fpOf(raw)) sseLastFp = fpOf(raw); }
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});
if (fs.existsSync(STATE_FILE)) {
  sseLastFp = fpOf(stateRaw());
  let sseDebounce = null;
  try {
    fs.watch(path.dirname(STATE_FILE), (_evt, fname) => {
      if (String(fname || '') !== 'bridge-state.json') return;
      clearTimeout(sseDebounce);
      sseDebounce = setTimeout(() => {
        const raw = stateRaw(); if (!raw) return;
        const fp = fpOf(raw);
        if (!fp || fp === sseLastFp) return;   // only STATE changes push (modifier-only churn stays quiet)
        sseLastFp = fp;
        const c = stateCompact(raw);
        if (c && sseClients.size) ssePush('state', c);
      }, 300);
    });
  } catch { /* best-effort; the 5-min snapshot still covers changes */ }
}
setInterval(() => {
  for (const res of sseClients) { try { res.write(': ka\n\n'); } catch { sseClients.delete(res); } }
}, 25000).unref();
setInterval(() => {
  if (!sseClients.size) return;
  const raw = stateRaw(); const c = raw && stateCompact(raw);
  if (c) { ssePush('snapshot', c); if (fpOf(raw)) sseLastFp = fpOf(raw); }
}, 5 * 60 * 1000).unref();

// --- dashboard login proxy (same idea as listings/expenses) -----------------
function dashboardBases() {
  const bases = [];
  const configured = String(getConfig().dashboardBase || '').replace(/\/+$/, '');
  if (configured) bases.push(configured);
  for (const local of [
    'https://172.22.160.3:8443',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'https://localhost:8443',
    'https://127.0.0.1:8443',
  ]) {
    if (!bases.includes(local)) bases.push(local);
  }
  return bases;
}

function dashboardReq(base, apiPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + apiPath);
    const mod = u.protocol === 'https:' ? https : require('http');
    const payload = JSON.stringify(body);
    const req = mod.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        rejectUnauthorized: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 400,
            body: text,
            json: async () => { try { return JSON.parse(text); } catch { return {}; } },
          });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(2500, () => req.destroy(new Error('timeout')));
    req.write(payload);
    req.end();
  });
}

async function dashboardPost(apiPath, body) {
  let lastErr;
  for (const base of dashboardBases()) {
    try {
      return await dashboardReq(base, apiPath, body);
    } catch (e) {
      lastErr = e;
      console.warn(`[trading] dashboard ${base} unreachable (${e.message || e}); trying next base`);
    }
  }
  throw lastErr;
}

// --- public bootstrap --------------------------------------------------------
app.get('/api/trading/config', (req, res) => {
  res.json({ service: 'trading', version: '0.1.0' });
});

// Login proxy — the UI is HTTPS, so it can't call the HTTP dashboard directly.
app.post('/api/trading/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const upstream = await dashboardPost('/api/users/login', { username, password });
    const body = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return res.status(upstream.status === 401 ? 401 : 500).json({ error: body.error || 'Login failed' });
    const tlsOn = !!getConfig().tls?.enabled;
    // Keep the session cookie in step with the login token lifetime
    // (SESSION_DAYS, default 30d) so the UI stays signed in across restarts.
    const sessionMs = (Number(process.env.SESSION_DAYS) || 30) * 24 * 60 * 60 * 1000;
    res.cookie('oswald_trading_token', body.token, {
      httpOnly: false,
      sameSite: 'lax',
      secure: tlsOn,
      maxAge: sessionMs,
    });
    return res.json({ token: body.token, roles: body.roles, permissions: body.permissions });
  } catch (e) {
    next(e);
  }
});

// Authenticated ping — proves the shared JWT + DB session check work end to end.
app.get('/api/trading/me', authenticateToken, (req, res) => {
  res.json({ userID: req.user.userID, roles: req.user.roles, permissions: req.user.permissions });
});

// --- Trading Agent API -------------------------------------------------------
app.use('/api/trading', require('./routes'));

// --- errors + start -----------------------------------------------------------
// 4-arg signature required for Express to recognize this as the error handler.
app.use((err, req, res, _next) => {
  console.error('[trading]', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

const port = getConfig().port || 8114;
const host = getConfig().host || '0.0.0.0';

function startListeners() {
  if (getConfig().tls?.enabled) {
    // Reuse the already-trusted fileserver cert (same SANs: 172.22.160.3 etc.).
    loadOrCreateCert({ certDir: path.join(__dirname, '..', 'fileserver', 'certs'), host: getConfig().tls?.host || '172.22.160.3' })
      .then((creds) => {
        const httpsServer = https.createServer(creds, app);
        // 2026-10-18 (desk-singleton-guard): a bind failure must be NAMED, not a raw stack. Two desks once
        // coexisted on different interfaces and every capture reached the stale one; this line makes the
        // second boot say so instead of dying anonymously.
        httpsServer.on('error', (e) => {
          if (e && e.code === 'EADDRINUSE') {
            console.error(`[trading] REFUSING TO START: port ${port} on ${host} is already bound. If that is another desk, stop it first — two desks once served stale code (desk-singleton-guard).`);
            process.exit(3);
          }
          console.error('[trading] https server error', e);
          process.exit(3);
        });
        httpsServer.listen(port, host, () => {
          console.log(`[trading] Trading Agent listening on https://${host}:${port}`);
        });
        const healthPort = getConfig().tls?.healthPort || 8115;
        require('http')
          .createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
          })
          .listen(healthPort, '127.0.0.1', () => {
            console.log(`[trading] health endpoint on http://127.0.0.1:${healthPort}/healthz`);
          });
      })
      .catch((e) => {
        console.error('[trading] cert load failed', e);
        process.exit(1);
      });
  } else {
    app.listen(port, host, () => {
      console.log(`[trading] Trading Agent listening on http://${host}:${port}`);
    });
  }
}

// Boot self-check: migration 024 must be applied, else refuse to start
// (a trading agent with a broken memory must not run). DeepSeek key issues
// are logged and surfaced via /api/trading/ping (wake loop stays disabled).
store
  .schemaProbe()
  .then(async (ok) => {
    if (!ok) {
      console.error('[trading] FATAL: migration 024_trading_agent.sql not applied — TradingSettings table missing. Apply sql/migrations/024_trading_agent.sql and restart.');
      process.exit(1);
    }
    console.log('[trading] migration 024 verified (TradingSettings present)');
    // 2026-10-18 (desk-singleton-guard): refuse to boot when ANOTHER desk already answers the health
    // endpoint. Bind success is not the test — two processes with different interfaces both bind. See
    // trading/lib/singleton.js for the measured failure this prevents (stale build served every capture).
    const { probeExistingDesk } = require('./lib/singleton');
    const healthPort = getConfig().tls?.healthPort || 8115;
    const other = await probeExistingDesk({ port: healthPort });
    if (other.alive) {
      console.error(`[trading] REFUSING TO START: another desk already answers /healthz on 127.0.0.1:${healthPort}. Stop it first — two desks once served stale code (desk-singleton-guard).`);
      process.exit(3);
    }
    startListeners();

    // ─── CONTINUITY 2026-10-10 (laptop data-collection mode; see docs/10-ARCHITECTURE-NOTES.md) ───
    // The desk was unreachable, so the laptop ran the stack for data collection only: every agent loop
    // (wake, mirror, review, watchdog, discoverer) is skipped and the service only serves its API.
    // Unset TRADING_CAPTURE_ONLY to restore the normal loops. Inert unless the flag is set.
    if (process.env.TRADING_CAPTURE_ONLY === '1') {
      // Belt-and-braces with plus500/browser.js#newPage(), which is the authoritative sever: this keeps
      // the loop from even attempting while TRADING_PLUS500_DISABLED=1 denies every page handout.
      if (process.env.TRADING_PLUS500_DISABLED === '1') {
        console.log('[trading] TRADING_PLUS500_DISABLED=1 — Plus500 bridge severed (no agent loops running)');
        return;
      }
      const everyMs = (Number(process.env.TRADING_CAPTURE_MINUTES) || 5) * 60 * 1000;
      console.log(
        `[trading] TRADING_CAPTURE_ONLY=1 — agent loops disabled; capturing Plus500 ticks every ${everyMs / 60000}m`
      );
      let inFlight = false;
      const runCapture = async () => {
        // A cycle whose capture never settles must not stack up new attempts: pageLock is in-memory
        // and is only released when a call resolves.
        if (inFlight) {
          console.error('[trading] capture: previous attempt still outstanding — skipping this cycle');
          return;
        }
        inFlight = true;
        const t0 = Date.now();
        const stage = (m) => console.error(`[trading] capture stage: ${m} (+${Date.now() - t0}ms)`);
        try {
          stage('start');
          const settings = await require('./store').getSettings(1);
          stage(`settings loaded — ${(settings.watchlist?.symbols || []).length} symbols, mode=${settings.watchlist?.mode || 'dynamic'}`);
          // A hung capture must not stay silent: race it against a deadline so the run either reports a
          // result or reports that it stalled, every cycle.
          const deadlineMs = Number(process.env.TRADING_CAPTURE_TIMEOUT_MS) || 240000;
          const r = await Promise.race([
            require('./plus500/capture').captureOnce(1, settings),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`stalled (no result in ${deadlineMs}ms)`)), deadlineMs)),
          ]);
          console.log('[trading] capture:', JSON.stringify(r).slice(0, 300));
        } catch (e) {
          console.error('[trading] capture failed:', e.message || e);
        } finally {
          inFlight = false;
        }
      };
      runCapture();
      setInterval(runCapture, everyMs).unref();
      return;
    }

    if (process.env.TRADING_SMOKE === '1') {
      // Smoke run: no wake loop, no watchdog — the test drives the API only.
      console.log('[trading] TRADING_SMOKE=1 — wake loop + watchdog disabled');
      return;
    }
    // TRD-79 (2026-09-21): seed the DERIVED spread basis ONCE at boot, so every gate that reads a
    // symbol's cost basis — venue admission, the net-edge screen, the stop cap and the TRD-114 cost
    // ceiling — reads the SAME basis. Without this, a fresh process prices those gates off the curated
    // table alone until somebody happens to run a backtest, i.e. the live desk's cost model would be
    // whatever the last viewer's what-if left behind. It seeds NOTHING when the tick read fails (a
    // failed read is ignorance, not evidence of absence) and says so.
    require('./agent/instruments').seedDerivedSpreadBasis(1)
      .then((r) => console.log('[trading] TRD-79 derived spread basis —', r.error
        ? `NOT seeded: ${r.error}`
        : `${r.seeded} symbol(s) priced from ${r.rows} tick(s) over ${r.days}d at ${r.venue}; ${r.unverifiable.length} curated symbol(s) UNVERIFIABLE (labelled calibrated_table): ${r.unverifiable.join(', ') || 'none'}`))
      .catch((e) => console.error('[trading] TRD-79 derived spread seed failed:', e.message || e));
    // ⚠⚠ TRD-114 IS SEEDED ONLY WHEN THE OPERATOR HAS ASKED FOR IT. The measurement is unambiguous — the residual
    // beyond the touch is 0.0000% on Gold, Silver, Oil and Ethereum (n=21..37) — but applying it collapses Gold's
    // modelled round trip from 11.94 bps to 1.94 bps, and that number feeds venue admission, the net-edge screen,
    // the stop cap and the cost-per-R ceiling. A cost basis change of that size LOOSENS four gates at once, so it is
    // an owner decision (`risk.costBasis.useMeasuredSlippage`, default false, in DEFAULT_SETTINGS), not a boot-time
    // inference. Until it is switched on the flat placeholder stands and every run is labelled
    // `calibrated_placeholder` — wrong, but unchanged and stated.
    require('./store').getSettings(1)
      .then((s) => ((s.risk || {}).costBasis || {}).useMeasuredSlippage === true)
      .catch(() => false)
      .then((on) => (on
        ? require('./agent/instruments').seedDerivedSlipBasis(1)
          .then((r) => console.log('[trading] TRD-114 derived slippage basis —', r.error
            ? `NOT seeded: ${r.error}`
            : `${r.seeded} symbol(s) priced from ${r.fills} fill(s) over ${r.days}d; refused by name: `
              + `${Object.values(r.refused || {}).flat().join(', ') || 'none'}`))
          .catch((e) => console.error('[trading] TRD-114 slippage seed failed:', e.message || e))
        : console.log('[trading] TRD-114 measured slippage basis OFF (risk.costBasis.useMeasuredSlippage !== true) — '
          + 'the flat 0.05% placeholder still prices every symbol')));
    // TRD-1: wake loop (scheduled + alerts + midnight digest). Reads settings
    // each cycle; wake.enabled=false disables it without a restart.
    require('./agent/waker').start(1).catch((e) => {
      console.error('[trading] waker start failed:', e.message || e);
    });
    // TRD-8: zombie watchdog (Plus500 login-death + waker-stale Telegram paging).
    require('./agent/watchdog').start(1).catch((e) => {
      console.error('[trading] watchdog start failed:', e.message || e);
    });
    // TRD-11: Telegram concierge — the owner can ask the desk what's going on.
    require('./agent/concierge').start(1);
    // TRD-11: per-tick demo account strip poller (read-only, respects the pause).
    require('./agent/accountPoller').start(1);
    // TRD-11: Plus500 positions + alerts mirror (source of truth, read-only).
    require('./agent/mirrorPoller').start(1);
    // TRD-12: lightweight position-exit review loop (own cadence, one position
    // per cycle — deliberately NOT inside the full wake pipeline).
    require('./agent/review').startLoop(1);
    // TRD-TRL-9 (2026-10-08): the post-entry trail engage (lock075_t15). Own loop, flag-gated: while
    // settings.risk.trailingStop.engageOnTouch.enabled !== true it returns on its first line and nothing about
    // the desk's exits changes. See agent/trailEngage.js for the decision contract (incl. the venue-minimum
    // refusal on small-stop instruments) and webtrader.setPositionTrail for the write path.
    require('./agent/trailEngage').startLoop(1);
    // TRD-12: passive venue-session feed — one CDP listener on the bridge page
    // reads trading-session intervals out of the SPA's own long-poll traffic
    // (no clicks, no extra navigation).
    require('./plus500/sessionFeed').startTracking().catch((e) => {
      console.error('[trading] sessionFeed start failed:', e.message || e);
    });
    // AI watchlist discoverer (2026-09-10): 30-min checker that self-throttles
    // against settings.discover.intervalHours; skip gates live in the module.
    setInterval(() => {
      require('./store').getSettings(1)
        .then((settings) => require('./agent/discoverer').runDiscovery(1, settings))
        .catch((e) => console.error('[trading] discoverer check failed:', e.message || e));
    }, 30 * 60000).unref();
    // Self-health monitor (Phase 1 of implied goal, 2026-09-10): 15-min
    // self-inspection pass; self-throttles against settings.selfHealth.
    setInterval(() => {
      require('./store').getSettings(1)
        .then((settings) => require('./agent/selfHealth').run(1, settings))
        .catch((e) => console.error('[trading] selfHealth check failed:', e.message || e));
    }, 15 * 60000).unref();
    // Self-tuning (Phase 2 of implied goal, 2026-09-10): 6h checker that
    // self-throttles against settings.tuner.intervalHours; gates live in the
    // module (enabled, parity, kill, budget).
    setInterval(() => {
      require('./store').getSettings(1)
        .then((settings) => require('./agent/tuner').run(1, settings))
        .catch((e) => console.error('[trading] tuner check failed:', e.message || e));
    }, 6 * 3600000).unref();
    // News aggregator S1 (open-work §4.19, built 2026-10-03): feeds NewsItems from the owner's
    // SearXNG instance. Write-only — no consumer, nothing reaches a chair (S2/S3 stay gated).
    // 15-min ticks; the module self-throttles to settings.news.intervalHours (default 1h) and
    // records a news_digest event per cycle, failures included (the F1 dead-feed discipline).
    setInterval(() => {
      require('./store').getSettings(1)
        .then((settings) => require('./agent/newsAggregator').runOnce(1, settings))
        .catch((e) => console.error('[trading] news aggregator check failed:', e.message || e));
    }, 15 * 60000).unref();
    // Economic calendar sync (2026-10-25). `agent/calendar.importCalendar` had NO scheduled caller — only a
    // manual UI button — so `CorporateEvents` still held 2 rows from 2026-09-15/16 when this was written. A
    // `macro` row is CONTEXT for the chairs (`sessions.js`, revised 2026-09-15: information, not a lock), so
    // the five-week gap meant the chairs were told nothing about an approaching FOMC day, not that the desk
    // traded unlocked. 30-min ticks; the module self-throttles to settings.calendar.intervalHours (12h) via
    // its own `calendar_sync` event, and records EVERY attempt including failures.
    setInterval(() => {
      require('./store').getSettings(1)
        .then((settings) => require('./agent/calendar').syncScheduled(1, settings))
        .catch((e) => console.error('[trading] calendar sync failed:', e.message || e));
    }, 30 * 60000).unref();
    // Account-reset detector (2026-10-26). The demo account was reset to 4,000 on 2026-10-16 and NOTHING recorded
    // it — the only trace was a step in EquitySnapshots, so every reporting number had to guess the era boundary
    // and two of those guesses were wrong. One `account_reset` event IS the boundary; the era is derived from it,
    // so no settings write is needed and recording a reset cannot itself breach the freeze. Idempotent, so the
    // boot run catches up after downtime. Also runs the idempotent detect after boot rather than only on a timer:
    // a reset that happens while the process is down must be found on the way back up.
    const detectResets = () => require('./agent/accountResets').detectAndRecord(1)
      .then((r) => { if (r.inserted.length) console.log(`[trading] account reset recorded: ${r.inserted.map((x) => `${x.from} -> ${x.to} at ${x.at}`).join(', ')}`); })
      .catch((e) => console.error('[trading] account reset detect failed:', e.message || e));
    setTimeout(detectResets, 20000).unref();
    setInterval(detectResets, 30 * 60000).unref();
    // Economic-calendar CAPTURE (2026-10-26): the Dow Jones feed rendered inside the Plus500 SPA, swept into
    // CalendarEvents. SEPARATE from `calendar.syncScheduled` above, which imports FOMC dates from federalreserve.gov
    // into `CorporateEvents` — that one feeds the chairs' `scheduledEvents` context, this one is a write-only ledger
    // with no consumer. 3-hour tick: the feed spans about a week and is re-read idempotently via `rowHash`, so the
    // cadence only controls how quickly a newly published Actual is picked up. The module holds the page lock and
    // uses the ONE shared Plus500 tab (a second tab makes the venue sign one of them out).
    setInterval(() => {
      require('./store').getSettings(1)
        .then((settings) => require('./plus500/calendarCapture').runOnce(1, settings))
        .catch((e) => console.error('[trading] calendar capture failed:', e.message || e));
    }, 3 * 3600000).unref();
    // Premium-analyses capture (TRD-PRM-1 P1, built 2026-10-04): daily sweep of the Plus500 analyses
    // pages into the write-only ledger (AnalysesNotes + AnalysisLevels; NO consumer — brief §2 P1).
    // 6-h tick; the module self-throttles to once per ~20 h (ledger-based) and skips when the tab is
    // busy (tryAcquire('analyses') skip-class); it parks back on /open-positions in its finally.
    setInterval(() => {
      require('./store').getSettings(1)
        .then((settings) => require('./plus500/analysesCapture').runScheduled(1, settings))
        .catch((e) => console.error('[trading] analyses capture check failed:', e.message || e));
    }, 6 * 3600000).unref();
    // ★ 2026-10-27 — THE DAILY CONTRACT-SPEC REFRESH (funding rates + minimum size).
    //
    // `Instruments` is the ONLY lane for `fundingBuyPct`/`fundingSellPct`/`unitAmount`, and it was fed only by a manual
    // UI probe: measured today, 44 rows across 24 symbols with the newest at **2026-10-01, 26 days stale**. That
    // reaches the live path through `carryPctFor`, which prices overnight carry on held positions.
    //
    // ⚠ IT IS NOT FOR THE SPREAD. The spread is measured from `spreadSubmitPct`/`spreadSignalPct` and needs no probe.
    // ⚠ ONE SHARED TAB, ONE `ticket` LOCK: `instrumentRefresh` self-throttles to once per 23h AND refuses outside
    // 02:00-04:59Z, so a refresh cannot meet an active session. The module never throws, so this timer cannot be
    // killed by a browser hiccup.
    setInterval(() => {
      require('./store').getSettings(1)
        .then((settings) => require('./plus500/instrumentRefresh').runOnce(1, { settings }))
        .then((r) => { if (r && r.ok) console.log('[trading] instrument refresh —', JSON.stringify(r)); })
        .catch((e) => console.error('[trading] instrument refresh failed:', e.message || e));
    }, 3600000).unref();
    // ★ 2026-10-27 — CONSTRAINT RECONCILIATION, WEEKLY. Compares every assertion in the ledger against the current
    // registry snapshot and logs drift. READ-ONLY: it never writes a constraint, so a detector cannot become a
    // producer.
    //
    // ⚠ IT REPORTS DRIFT AND DELIBERATELY DOES NOT DATE IT. A change detected between two captures happened
    // SOMEWHERE in that interval; writing `effectiveFrom = <now>` would assert an instant we do not know. The honest
    // representation is a bounded interval the schema has nowhere to put, so the finding is named and the dating
    // question stays open rather than being guessed at.
    //
    // ⚠ AND A FAILED READ IS ITS OWN REASON (`read_failed`), never an empty finding set — "we could not look" and
    // "nothing moved" must not produce the same silence.
    // ★ 2026-10-26 — THE RECONCILE RUNS AT BOOT AS WELL AS WEEKLY.
    //
    // Weekly-only meant the first automatic run after any restart was seven days away, so a reconcile that had
    // BROKEN stayed invisible for a week — and its silence is indistinguishable from agreement. The boot run is
    // self-throttled inside the module (see `runOnBoot`), because every run appends an event and the crash guard
    // restarts dead children: unthrottled, a restart loop would be event spam.
    // ⚠ STILL BLOCKING ON NOTHING: read-only, never writes a constraint, catches its own failures.
    setTimeout(() => {
      require('./agent/constraintReconcile').runOnBoot(1)
        .then((r) => console.log('[trading] constraint reconcile (boot) —', r.ran ? `${r.why}: ${JSON.stringify(r.result && r.result.census || {})}` : `skipped (${r.why})`))
        .catch((e) => console.error('[trading] constraint reconcile (boot) failed:', e.message || e));
    }, 60 * 1000).unref();
    setInterval(() => {
      require('./agent/constraintReconcile').runOnce(1)
        .then((r) => console.log('[trading] constraint reconcile (weekly) —', r.reason, JSON.stringify(r.census || {})))
        .catch((e) => console.error('[trading] constraint reconcile (weekly) failed:', e.message || e));
    }, 7 * 24 * 3600000).unref();
    // ★ 2026-10-27 — THE LEDGER'S CONSUMER, HOURLY. Asks "what constraint applied at this trade, and was it
    // honoured?" for every closed trade in the window, and appends one `constraint_assessment` event per new one.
    //
    // ⚠ NO THROTTLE, UNLIKE THE RECONCILE ABOVE, AND THE REASON IS THE DEDUPE RATHER THAN CONFIDENCE. A run with
    // nothing new appends NOTHING (it returns `nothing_new` and logs no event), so a crash loop costs three queries
    // per boot, not a stream of rows. The reconcile needs `shouldRunOnBoot` because it appends a census event every
    // run whether or not anything changed.
    //
    // ⚠ AND `window.truncated` IS REPORTED, because an assessment pass that covered 200 of 247 must never read as
    // complete. See `constraintAudit.windowPlan`.
    const runConstraintAudit = (trigger) => require('./agent/constraintAudit').runOnce(1)
      .then((r) => console.log(`[trading] constraint audit (${trigger}) —`, r.reason,
        JSON.stringify(r.window || {}), JSON.stringify(r.byVerdict || {})))
      .catch((e) => console.error(`[trading] constraint audit (${trigger}) failed:`, e.message || e));
    setTimeout(() => runConstraintAudit('boot'), 150 * 1000).unref();
    setInterval(() => runConstraintAudit('hourly'), 3600000).unref();
    // TRD-26 fresh-data gate (2026-09-11): this workspace is NOT an always-
    // online server — the gate must survive downtime by itself. One catch-up
    // check shortly after boot, then a 30-min tick; BOTH run even when wakes
    // are paused/disabled or sessions are closed. The module self-throttles
    // to 6h via its own trd26_check event (and holds a concurrency guard), so
    // overlapping triggers never double-fire. Windows are earliest dates, not
    // deadlines: lateness only widens the fresh W4 — nothing is ever missed.
    setTimeout(() => {
      require('./store').getSettings(1)
        .then((settings) => require('./agent/trd26').checkAndFire(1, settings))
        .then((r) => console.log('[trading] TRD-26 gate: boot catch-up —', r && r.skipped ? r.skipped : `fired ${(r.fired || []).length} of ${(r.rows || []).length}`))
        .catch((e) => console.error('[trading] TRD-26 gate boot catch-up failed:', e.message || e));
    }, 60 * 1000).unref();
    setInterval(() => {
      require('./store').getSettings(1)
        .then((settings) => require('./agent/trd26').checkAndFire(1, settings))
        .then((r) => { if (r && Array.isArray(r.fired) && r.fired.length) console.log('[trading] TRD-26 gate: fired', r.fired.map((f) => `#${f.id} ${f.verdict}`).join('; ')); })
        .catch((e) => console.error('[trading] TRD-26 gate check failed:', e.message || e));
    }, 30 * 60000).unref();
  })
  .catch((e) => {
    console.error('[trading] FATAL: SQL unreachable during boot self-check:', e.message || e);
    process.exit(1);
  });
