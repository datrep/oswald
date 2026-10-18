// trading/scripts/smoke.js — Trading Agent smoke suite (TRD-8).
// Boots trading/server.js on an isolated HTTP port with TRADING_SMOKE=1
// (wake loop + watchdog disabled, so no browser, no Telegram, no LLM) and
// checks the full API surface. Uses the shared SQL DB read-only-ish: writes
// are limited to harmless rows (one smoke event, one alert create+delete,
// a kill tier cycle that ends back at 'off').
//
//   node trading/scripts/smoke.js      (also wired into root `npm test`)

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const net = require('net');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const ROOT = path.join(__dirname, '..', '..'); // repo root (scripts/ -> trading/ -> root)
const TRADING_DIR = path.join(ROOT, 'trading');
// Default-settings constant (NOT live DB state): live `strategies.enabled` can
// legitimately be [] under audit mode (P0, 2026-09-10).
const { DEFAULT_SETTINGS } = require('../store');

let PORT = 0;
let child = null;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ---- tiny harness -----------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.error(`  ✗ ${name}${extra ? ` (${extra})` : ''}`);
  }
}

async function check(name, fn) {
  try { await fn(); } catch (err) { ok(name, false, err.message); }
}

function req(method, p, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1',
      port: PORT,
      method,
      path: p,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    r.setTimeout(8000, () => r.destroy(new Error('timeout')));
    if (payload) r.write(payload);
    r.end();
  });
}

// P1-12b (2026-09-10): the smoke suite runs as a DEDICATED sandbox user
// so its kill-tier cycles, settings writes and events never touch the live
// desk (user 1). Users.id is IDENTITY — the seed inserts without an id and
// resolves the real one dynamically.
let SMOKE_USER_ID = null;

async function seedSmokeUser() {
  const { getPool } = require(path.join(ROOT, 'shared', 'db'));
  const pool = await getPool();
  const exists = await pool.request().query(`SELECT id FROM Users WHERE username = 'trading_smoke'`);
  if (exists.recordset[0]) {
    SMOKE_USER_ID = Number(exists.recordset[0].id);
    await pool.request().query(`UPDATE Users SET isActive = 1, tokenVersion = 0 WHERE username = 'trading_smoke'`);
  } else {
    const r = await pool.request().query(`
      INSERT INTO Users (username, passwordHash, isActive, tokenVersion)
      OUTPUT INSERTED.id
      VALUES ('trading_smoke', 'smoke-sandbox-not-a-real-login', 1, 0)`);
    SMOKE_USER_ID = Number(r.recordset[0].id);
  }
}

async function currentTokenVersion() {
  const { getPool } = require(path.join(ROOT, 'shared', 'db'));
  const pool = await getPool();
  const r = await pool.request().query(`SELECT tokenVersion FROM Users WHERE id = ${SMOKE_USER_ID}`);
  return Number(r.recordset[0]?.tokenVersion) || 0;
}

// ---- boot -------------------------------------------------------------------
async function boot() {
  PORT = await findFreePort();
  child = spawn(process.execPath, [path.join(TRADING_DIR, 'server.js')], {
    cwd: TRADING_DIR,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TRADING_SMOKE: '1',
      TRADING_TLS: '0',
      TRADING_PORT: String(PORT),
      TRADING_HOST: '127.0.0.1',
    },
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  child.on('exit', () => { /* collected below */ });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`trading service exited early (code ${child.exitCode}):\n${out.slice(-800)}`);
    try {
      const r = await req('GET', '/api/trading/config');
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('trading service did not come up in 20s:\n' + out.slice(-800));
}

// ---- checks -----------------------------------------------------------------
// WHAT THIS SUITE CAN AND CANNOT TOUCH (TRD-93, corrected 2026-09-21).
//
// The smoke service shares the PRODUCTION DB, but it does NOT share the live desk's identity. Every
// authenticated call below is made with a token signed for the SANDBOX user (`trading_smoke`, resolved
// dynamically in seedSmokeUser because Users.id is IDENTITY — so nothing here can hard-code it), and its
// kill-tier cycles, settings writes and events land on that user's own rows. Verified against the event
// log: the 2026-09-18 kills that the TRD-93 finding read as "the live desk latched HARD" are userId 42,
// and the live desk (user 1) woke normally at 08:57:47Z inside the same window. The live waker is
// single-user (`waker.start(1)`), and this service boots with TRADING_SMOKE=1, which disables the wake
// loop AND the watchdog outright (server.js) — so a smoke run cannot schedule, wake, or stand down the
// real desk.
//
// The snapshot/restore below is therefore the SANDBOX's OWN blob, restored so a half-finished kill cycle
// cannot leave the sandbox latched for the next run. It is NOT a guard on the live desk and must not be
// described as one: that description is what made an already-fixed defect look live for eight days.
//
// The one destructive thing a test could still ask for is a SWEEP, which is why the hard-tier call below
// passes `autoClose: false` EXPLICITLY (TRD-111) — on a hard tier an omitted flag now means "close".
let restoreSettingsHook = null;

async function run() {
  await seedSmokeUser();
  const v = await currentTokenVersion();
  const token = jwt.sign({ userID: SMOKE_USER_ID, roles: ['admin'], permissions: ['services.manage', 'tasks.manage'], v }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const snap = await req('GET', '/api/trading/settings', { token });
  if (snap.status === 200 && snap.json) {
    restoreSettingsHook = () => req('PUT', '/api/trading/settings', { token, body: snap.json }).catch(() => {});
  }

  await check('config endpoint', async () => {
    const r = await req('GET', '/api/trading/config');
    ok('  config 200', r.status === 200);
    ok('  config shape', r.json && r.json.service === 'trading');
  });

  await check('ping', async () => {
    // F12 (2026-09-18): the self-check now has TWO answers. Without a token it is a liveness reply that
    // touches nothing (no SQL probe, no browser probe, no LLM call) — which is what a boot script needs and
    // what an unauthenticated LAN caller is allowed to learn. With a token it is the full self-check.
    const anon = await req('GET', '/api/trading/ping');
    ok('  ping 200 (no token)', anon.status === 200);
    ok('  anon answer is liveness only', anon.json && anon.json.checks && anon.json.checks.sql === 'unchecked');
    const r = await req('GET', '/api/trading/ping', { token });
    ok('  ping 200 (owner)', r.status === 200);
    ok('  sql check ok', r.json && r.json.checks && r.json.checks.sql && r.json.checks.sql.ok === true);
    ok('  checks shape', r.json && r.json.checks && 'deepseek' in r.json.checks && 'browser' in r.json.checks);
    const noPost = await req('POST', '/api/trading/ping/browser');
    ok('  POST /ping/browser no token -> 401', noPost.status === 401);
  });

  await check('auth', async () => {
    const noTok = await req('GET', '/api/trading/me');
    ok('  /me no token -> 401', noTok.status === 401);
    const badTok = await req('GET', '/api/trading/me', { token: 'garbage.token.here' });
    ok('  /me bad token -> 401', badTok.status === 401);
    const me = await req('GET', '/api/trading/me', { token });
    ok('  /me with token -> sandbox user', me.status === 200 && me.json.userID === SMOKE_USER_ID);
  });

  await check('settings', async () => {
    const g = await req('GET', '/api/trading/settings', { token });
    ok('  GET settings 200', g.status === 200);
    ok('  defaults merged (kill+risk+wake+watchdog)', g.json && g.json.kill && g.json.risk && g.json.wake && g.json.watchdog && g.json.watchdog.enabled !== undefined);
    ok('  deliberation config shape (TRD-9 H)', g.json && Array.isArray(g.json.deliberation?.quantPanel) && Array.isArray(g.json.deliberation?.chairs) && g.json.deliberation.chairs.length <= 3 && g.json.deliberation.chairs.every((c) => Number(c.weight) > 0));
    ok('  wake.paused is boolean', g.json && typeof g.json.wake.paused === 'boolean');
    const p = await req('PUT', '/api/trading/settings', { token, body: { smoke: { at: Date.now() } } });
    ok('  PUT settings 200', p.status === 200);
    ok('  PUT merged back', p.json && p.json.smoke && p.json.kill.tier !== undefined);
  });

  await check('events', async () => {
    const created = await req('POST', '/api/trading/events', { token, body: { kind: 'smoke_note', payload: { smoke: 1 } } });
    ok('  POST events 201', created.status === 201);
    const list = await req('GET', '/api/trading/events?limit=5', { token });
    ok('  GET events 200', list.status === 200 && Array.isArray(list.json.items));
    ok('  smoke event listed', list.json && list.json.items.some((e) => e.kind === 'smoke_note'));
  });

  await check('waker pause (TRD-9 H)', async () => {
    // NEVER clobber the user's pause setting — save + restore it.
    const before = await req('GET', '/api/trading/settings', { token });
    const wasPaused = !!(before.json && before.json.wake && before.json.wake.paused);
    try {
      const on = await req('POST', '/api/trading/wake/pause', { token, body: { paused: true } });
      ok('  pause -> 200 paused', on.status === 200 && on.json.paused === true);
      const st = await req('GET', '/api/trading/status', { token });
      ok('  status shows paused', st.status === 200 && st.json.paused === true);
    } finally {
      await req('POST', '/api/trading/wake/pause', { token, body: { paused: wasPaused } });
    }
  });

  await check('indicators unit (offline)', async () => {
    const ind = require(path.join(__dirname, '..', 'agent', 'indicators'));
    ok('  sma exact', ind.sma([1, 2, 3, 4, 5], 3) === 4);
    ok('  sma too short -> null', ind.sma([1, 2], 3) === null);
    ok('  ema exact', Math.abs(ind.ema([1, 2, 3], 3) - 2.25) < 1e-9);
    ok('  rsi all up = 100', ind.rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) === 100);
    ok('  rsi all down = 0', ind.rsi([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]) === 0);
    const bb = ind.bollinger([1, 2, 3, 4, 5], 5, 2);
    ok('  bollinger shape', bb && bb.upper > bb.mid && bb.mid > bb.lower && bb.bandwidth > 0);
    const mc = ind.macd(Array(40).fill(100), 12, 26, 9);
    ok('  macd constant = 0', mc && Math.abs(mc.macd) < 1e-9 && Math.abs(mc.signal) < 1e-9);
    const st = ind.stochastic(Array(20).fill(10), Array(20).fill(0), Array(20).fill(5), 14, 3);
    ok('  stoch constant = 50', st && st.k === 50 && st.d === 50);
    ok('  atr/adx/donchian still exported', typeof ind.atr === 'function' && typeof ind.adx === 'function' && typeof ind.donchian === 'function');
  });

  await check('kill switch cycle', async () => {
    // TRD-11: paper mode ignores the kill gate, so a wake under 'hard' would
    // run the full central AI (LLM, >8s smoke timeout). Temporarily disable
    // paper for this check and restore the user's setting afterwards.
    const orig = await req('GET', '/api/trading/settings', { token });
    const paperWas = !!(orig.json && orig.json.paper && orig.json.paper.enabled);
    if (paperWas) await req('PUT', '/api/trading/settings', { token, body: { paper: { enabled: false } } });
    try {
      const soft = await req('POST', '/api/trading/kill', { token, body: { tier: 'soft', reason: 'smoke', alert: false } });
      ok('  soft 200', soft.status === 200 && soft.json.kill && soft.json.kill.tier === 'soft');
      const bad = await req('POST', '/api/trading/kill', { token, body: { tier: 'nuke' } });
      ok('  invalid tier -> 400', bad.status === 400);
      // TRD-111 (2026-09-20): `autoClose: false` IS EXPLICIT ON PURPOSE. An omitted flag now means "close
      // the book" (only an explicit boolean false opts out), and a test must never ask the desk to sweep.
      // Relying on "the sandbox book happens to be empty" would be the implicit assumption this suite has
      // already been bitten by once.
      const wake = await req('POST', '/api/trading/kill', { token, body: { tier: 'hard', reason: 'smoke', alert: false, autoClose: false } });
      ok('  hard 200', wake.status === 200 && wake.json.kill.tier === 'hard');
      const w = await req('POST', '/api/trading/wake', { token, body: {} });
      ok('  wake under hard -> skipped', w.status === 200 && w.json.skipped === 'kill_switch_hard');
      const off = await req('POST', '/api/trading/kill', { token, body: { tier: 'off', reason: 'smoke' } });
      ok('  back to off', off.status === 200 && off.json.kill.tier === 'off');
    } finally {
      if (paperWas) await req('PUT', '/api/trading/settings', { token, body: { paper: { enabled: true } } });
    }
  });

  await check('ledgers', async () => {
    for (const p of ['/api/trading/trades', '/api/trading/prompts', '/api/trading/wakes', '/api/trading/backtests']) {
      const r = await req('GET', p, { token });
      ok(`  GET ${p} -> items`, r.status === 200 && Array.isArray(r.json.items));
    }
    const d = await req('GET', '/api/trading/digest', { token });
    ok('  digest 200', d.status === 200);
  });

  await check('bars', async () => {
    const okB = await req('GET', '/api/trading/bars?timeframe=1h&symbol=Bitcoin&venue=plus500&limit=5', { token });
    ok('  bars 1h 200 + items', okB.status === 200 && Array.isArray(okB.json.items));
    const badB = await req('GET', '/api/trading/bars?timeframe=zz', { token });
    ok('  bars bad timeframe falls back to 1h', badB.status === 200 && badB.json.timeframe === '1h');
  });

  await check('providers', async () => {
    const s = await req('GET', '/api/trading/providers/status', { token });
    ok('  status 200', s.status === 200);
    ok('  symbolMap present', s.json && s.json.symbolMap && typeof s.json.symbolMap === 'object');
    ok('  symbolMap has yahoo (TRD-9)', s.json && s.json.symbolMap.Bitcoin && s.json.symbolMap.Bitcoin.yahoo === 'BTC-USD');
    ok('  HK + SG + futures mappings present', s.json && s.json.symbolMap.Tencent?.yahoo === '0700.HK' && s.json.symbolMap['OCBC Bank']?.yahoo === 'O39.SI' && s.json.symbolMap.Gold?.yahoo === 'GC=F');
    const cov = await req('GET', '/api/trading/providers/coverage', { token });
    ok('  coverage 200 + items', cov.status === 200 && Array.isArray(cov.json.items));
    const unmapped = await req('POST', '/api/trading/providers/backfill', { token, body: { provider: 'yahoo', symbol: 'ZZ-BT', timeframe: '1h' } });
    ok('  yahoo backfill unmapped -> 400 (offline)', unmapped.status === 400);
  });

  await check('backtest validation', async () => {
    const noSym = await req('POST', '/api/trading/backtest', { token, body: { venue: 'binance' } });
    ok('  missing symbol -> 400', noSym.status === 400);
    const unmapped = await req('POST', '/api/trading/backtest', { token, body: { symbol: 'ZZ-BT', venue: 'binance', timeframe: '1h' } });
    ok('  unmapped provider symbol -> 400 (offline)', unmapped.status === 400);
    const unmappedY = await req('POST', '/api/trading/backtest', { token, body: { symbol: 'ZZ-BT', venue: 'yahoo', timeframe: '1h' } });
    ok('  unmapped yahoo symbol -> 400 (offline)', unmappedY.status === 400);
  });

  await check('watchlist', async () => {
    const wl = await req('GET', '/api/trading/watchlist', { token });
    ok('  GET watchlist 200', wl.status === 200 && Array.isArray(wl.json.symbols) && Array.isArray(wl.json.universe));
    ok('  mode present', wl.json && typeof wl.json.mode === 'string');
  });

  await check('alerts CRUD', async () => {
    const created = await req('POST', '/api/trading/alerts', { token, body: { symbol: 'ZZ-BT', venue: 'plus500', direction: 'above', threshold: 999999 } });
    ok('  create 201', created.status === 201 && Number.isInteger(created.json.id));
    const id = created.json.id;
    const upd = await req('PUT', `/api/trading/alerts/${id}`, { token, body: { threshold: 999998 } });
    ok('  update 200', upd.status === 200);
    const del = await req('DELETE', `/api/trading/alerts/${id}`, { token });
    ok('  delete 204', del.status === 204);
    const bad = await req('POST', '/api/trading/alerts', { token, body: { symbol: 'ZZ-BT', direction: 'sideways', threshold: 1 } });
    ok('  bad direction -> 400', bad.status === 400);
  });

  await check('strategies + meta (TRD-10)', async () => {
    const st = await req('GET', '/api/trading/strategies', { token });
    ok('  strategies 200 + items', st.status === 200 && Array.isArray(st.json.items));
    ok('  turtle + multi + meanrev + macd + rsi2 registered', st.json && st.json.items.some((s) => s.id === 'turtle' && s.params.length >= 4) && st.json.items.some((s) => s.id === 'multi') && st.json.items.some((s) => s.id === 'meanrev' && s.params.length >= 4) && st.json.items.some((s) => s.id === 'macd' && s.params.length >= 4) && st.json.items.some((s) => s.id === 'rsi2' && s.params.length >= 4));
    ok('  turtle enabled by default', Array.isArray(DEFAULT_SETTINGS.strategies?.enabled) && DEFAULT_SETTINGS.strategies.enabled.includes('turtle'));
    const m = await req('GET', '/api/trading/meta', { token });
    ok('  meta 200 + items array', m.status === 200 && Array.isArray(m.json.items) && 'latest' in m.json);
    const mu = await req('GET', '/api/trading/multi', { token });
    ok('  multi 200 + items array', mu.status === 200 && Array.isArray(mu.json.items) && 'latest' in mu.json);
    const g = await req('GET', '/api/trading/settings', { token });
    ok('  settings.strategies shape', g.json && Array.isArray(g.json.strategies?.enabled) && typeof g.json.strategies?.params === 'object');
  });

  await check('congress (TRD-11)', async () => {
    const st = await req('GET', '/api/trading/strategies', { token });
    ok('  congress registered + shadow params', st.json && st.json.items.some((s) => s.id === 'congress' && s.params.length >= 4));
    const c = await req('GET', '/api/trading/congress', { token });
    ok('  congress 200 + shape', c.status === 200 && 'latestPull' in c.json && 'latestSignal' in c.json);
    const bad = await req('POST', '/api/trading/providers/congress/pull', { token }, {});
    ok('  pull without token -> clean error', bad.status === 400 && /token/i.test(bad.json?.error || ''));
    const g = await req('GET', '/api/trading/settings', { token });
    ok('  settings.congress block', g.json && typeof g.json.congress === 'object');
    ok('  settings.account poller block', g.json && g.json.account && g.json.account.pollSeconds >= 1 && typeof g.json.account.enabled === 'boolean');
    ok('  settings.mirror block', g.json && g.json.mirror && g.json.mirror.pollSeconds >= 15 && typeof g.json.mirror.enabled === 'boolean');
  });

  await check('state tree + account + paper-open + sweep (TRD-11)', async () => {
    const st = await req('GET', '/api/trading/state', { token });
    ok('  state 200 + tree shape', st.status === 200 && st.json && typeof st.json.mode === 'string' && st.json.kill && st.json.waker && Array.isArray(st.json.positions.demo) && Array.isArray(st.json.errors));
    const ac = await req('GET', '/api/trading/account', { token });
    ok('  account 200 + items', ac.status === 200 && Array.isArray(ac.json.items) && 'latest' in ac.json);
    const po = await req('POST', '/api/trading/paper/open', { token }, { symbol: '', direction: 'buy' });
    ok('  paper/open missing symbol -> 400', po.status === 400);
    const sw = await req('POST', '/api/trading/backtest/sweep', { token }, { symbol: '', config: {} });
    ok('  sweep missing symbol -> 400', sw.status === 400);
  });

  await check('pulse + paper (TRD-11)', async () => {
    const g = await req('GET', '/api/trading/settings', { token });
    ok('  settings.pulse/central/paper blocks', g.json && g.json.pulse?.intervalHours > 0 && g.json.central?.thinking === true && g.json.paper?.initialCapital > 0);
    const p = await req('GET', '/api/trading/pulse', { token });
    ok('  pulse 200 + items array', p.status === 200 && Array.isArray(p.json.items) && 'latest' in p.json);
    const pa = await req('GET', '/api/trading/paper', { token });
    ok('  paper 200 + shape', pa.status === 200 && pa.json.equity && Array.isArray(pa.json.open) && Array.isArray(pa.json.closed) && typeof pa.json.enabled === 'boolean');
    // NOTE: no POST /paper/reset here — that would wipe the user's real ledger.
  });

  await check('bridge + watchdog + status', async () => {
    const b = await req('GET', '/api/trading/bridge', { token });
    ok('  bridge 200 (paused bool)', b.status === 200 && typeof b.json.paused === 'boolean');
    const r = await req('POST', '/api/trading/bridge/resume', { token, body: {} });
    ok('  bridge resume ok', r.status === 200 && r.json.ok === true);
    const s = await req('GET', '/api/trading/status', { token });
    ok('  status includes watchdog', s.status === 200 && s.json.watchdog && typeof s.json.watchdog === 'object');
    const wd = await req('GET', '/api/trading/watchdog', { token });
    ok('  watchdog 200 (login key)', wd.status === 200 && wd.json && 'login' in wd.json);
    const wdRun = await req('POST', '/api/trading/watchdog/run', { token, body: {} });
    ok('  watchdog/run 200 (smoke: disabled)', wdRun.status === 200 && wdRun.json && ('skipped' in wdRun.json || 'login' in wdRun.json));
  });

  await check('calendar', async () => {
    const c = await req('GET', '/api/trading/calendar?days=3', { token });
    ok('  calendar 200 + items', c.status === 200 && Array.isArray(c.json.items));
  });

  await check('pipeline + quarantine (TRD-12)', async () => {
    const p = await req('GET', '/api/trading/pipeline', { token });
    ok('  pipeline 200 + shape', p.status === 200 && p.json && 'running' in p.json && 'last' in p.json && 'bridge' in p.json);
    const q = await req('GET', '/api/trading/quarantine?limit=5', { token });
    ok('  quarantine 200 + items', q.status === 200 && Array.isArray(q.json.items));
    const rb = await req('POST', '/api/trading/bars/rebuild', { token }, {});
    ok('  bars/rebuild 200 + shape', rb.status === 200 && 'deletedFlagged' in rb.json && rb.json.rebuilt && typeof rb.json.rebuilt.hourly === 'number');
  });

  await check('phase 3: divergence + hrefmap + walk-forward (TRD-12)', async () => {
    const d = await req('GET', '/api/trading/divergence', { token });
    ok('  divergence 200 + shape', d.status === 200 && d.json && 'ok' in d.json);
    const hm = await req('GET', '/api/trading/bridge/hrefmap', { token });
    ok('  bridge/hrefmap 200 + shape', hm.status === 200 && hm.json && Array.isArray(hm.json.hrefs));
    const run = await req('POST', '/api/trading/backtest', { token, body: { symbol: 'Bitcoin', venue: 'plus500', timeframe: '1h', config: { walkForward: true, refreshData: false } } });
    const cleanNoData = run.status === 400 && /insufficient bars/i.test(run.json?.error || '');
    const shaped = run.status === 200 && run.json && run.json.benchmark && run.json.benchmark.pnlPct != null
      && run.json.walkForward && Array.isArray(run.json.walkForward.segments) && typeof run.json.walkForward.oosPnl === 'number';
    ok('  walk-forward + benchmark (shape when data available)', cleanNoData || shaped);
  });

  await check('logs envelope + window (design bible v1 Phase A)', async () => {
    const l = await req('GET', '/api/trading/logs?limit=5', { token });
    ok('  /logs 200 + shape', l.status === 200 && Array.isArray(l.json.items) && typeof l.json.total === 'number' && 'hasMore' in l.json && 'nextCursor' in l.json);
    const s = await req('GET', '/api/trading/state', { token });
    ok('  state.window present', s.status === 200 && s.json.window && 'lastAction' in s.json.window && 'lastError' in s.json.window && 'lastStateChange' in s.json.window);
    await req('POST', '/api/trading/events', { token, body: { kind: 'note', payload: { envelope_test: true, password: 'secret123' } } });
    const fl = await req('GET', '/api/trading/logs?action=note&limit=1', { token });
    const item = fl.json.items && fl.json.items[0];
    ok('  envelope + redaction on new events', item && item.stream === 'app' && item.actor === 'system' && item.action === 'note' && item.password === '[REDACTED]');
    const filtered = await req('GET', '/api/trading/logs?stream=err&limit=5', { token });
    ok('  /logs stream filter works', filtered.status === 200 && Array.isArray(filtered.json.items) && filtered.json.items.every((x) => x.stream === 'err'));
  });

  // In-process connector contract check (no venue, no network).
  await check('connector contract (fake impl)', async () => {
    const { getConnector, fake } = require('../connector');
    const conn = getConnector({}, { force: 'fake' });
    fake._reset({ equity: 10000 });
    fake._setQuote('Oil', 90.0, 90.2);
    const acct = await conn.getAccount();
    ok('  fake account equity', acct.equity === 10000);
    const fill = await conn.placeOrder({}, { symbol: 'Oil', direction: 'buy', size: 1 });
    ok('  fake placeOrder fill', !!fill.positionId && fill.price === 90.1);
    const pos = await conn.getPositions();
    ok('  fake positions 1 open', pos.items.length === 1 && pos.items[0].symbol === 'Oil');
    const cl = await conn.closeOrder({}, { plus500PositionId: fill.positionId, symbol: 'Oil' });
    ok('  fake closeOrder pnl', typeof cl.pnl === 'number');
    ok('  fake positions 0 after close', (await conn.getPositions()).items.length === 0);
  });
}

// ---- main -------------------------------------------------------------------
(async () => {
  try {
    await boot();
    console.log(`[trading-smoke] service up on 127.0.0.1:${PORT}`);
    await run();
  } catch (e) {
    failed++;
    failures.push('boot: ' + e.message);
  } finally {
    if (restoreSettingsHook) await restoreSettingsHook().catch(() => {});
    if (child && child.exitCode === null) {
      try { child.kill(); } catch { /* ignore */ }
    }
  }
  console.log(`\n[trading-smoke] ${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.error('  FAIL:', f);
    process.exit(1);
  }
})().catch((e) => { console.error('smoke crashed:', e); process.exit(1); });
