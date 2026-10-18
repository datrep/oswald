// trading/lib/http.js — outbound HTTP helpers for agent modules.
// dashboardPost: call a dashboard API (self-signed cert tolerant, multi-base fallback).
// telegramAlert: send a watchdog/alert message via the Telegram bot (.env creds).
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { loadEnv } = require('../../shared/config');
const { getPool } = require('../../shared/db');

loadEnv();

function dashboardBases() {
  const bases = [];
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

function rawReq(method, url, payload, timeoutMs = 5000, token = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const body = payload == null ? null : JSON.stringify(payload);
    const req = mod.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 400, text });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function dashboardPost(apiPath, body, timeoutMs = 5000) {
  const token = await serviceToken();
  let lastErr;
  for (const base of dashboardBases()) {
    try {
      return await rawReq('POST', base + apiPath, body, timeoutMs, token);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('dashboard unreachable');
}

// Service-to-service JWT (userID 1, services.manage) minted from the shared
// secret + live Users.tokenVersion. Cached ~50 minutes (tokens expire in 1h).
let tokenCache = { at: 0, value: null };
async function serviceToken() {
  if (tokenCache.value && Date.now() - tokenCache.at < 50 * 60000) return tokenCache.value;
  const pool = await getPool();
  const r = await pool.request().query('SELECT tokenVersion FROM Users WHERE id = 1');
  const v = r.recordset[0]?.tokenVersion ?? 0;
  const value = jwt.sign(
    { userID: 1, roles: ['admin'], permissions: ['services.manage'], v },
    process.env.JWT_SECRET || 'JWT_key',
    { expiresIn: '1h' }
  );
  tokenCache = { at: Date.now(), value };
  return value;
}

// --- alert delivery must not fail silently ----------------------------------
// telegramAlert RETURNS a result instead of throwing, and every caller in this codebase
// discarded it inside a bare try/catch. So a revoked token, a wrong chat id, a rate limit or a
// missing credential produced no error, no log and no page: the desk paging into the void and
// reporting success. Found 2026-09-13 (TRD-40) while testing the new out-of-process
// supervisor; the pre-existing watchdog had the same hole.
//
// Failures are now recorded in TWO places, both independent of Telegram itself:
//   * trading/crash/alert-failures.log (append, capped) - durable, read by the supervisor
//   * console.error - lands in trading/server.err.log, which the supervisor ALREADY tails, so
//     a desk-side alert failure surfaces in the next supervisor message even though the
//     alert channel is what is broken.
const ALERT_FAIL_LOG = path.join(__dirname, '..', 'crash', 'alert-failures.log');
const ALERT_FAIL_KEEP = 200;
const ALERT_OK_FILE = path.join(__dirname, '..', 'crash', 'alert-last-ok.json');

// A successful send RESOLVES every earlier failure: the channel is proven good as of now, so
// what matters afterwards is only "failures since the last success" - the messages the
// operator does not know they missed.
function noteAlertOk(messageId) {
  try {
    fs.writeFileSync(ALERT_OK_FILE, JSON.stringify({ at: new Date().toISOString(), messageId: messageId == null ? null : messageId }), 'utf8');
  } catch { /* best effort */ }
}

function lastAlertOkAt() {
  try { return JSON.parse(fs.readFileSync(ALERT_OK_FILE, 'utf8')).at || null; } catch { return null; }
}

function noteAlertFailure(result, text) {
  const entry = {
    at: new Date().toISOString(),
    error: result.error || result.description || 'unknown',
    httpStatus: result.httpStatus == null ? null : result.httpStatus,
    sample: String(text || '').split('\n')[0].slice(0, 160),
  };
  try {
    console.error(`[alert] TELEGRAM DELIVERY FAILED: ${entry.error} — "${entry.sample}"`);
  } catch { /* ignore */ }
  try {
    fs.mkdirSync(path.dirname(ALERT_FAIL_LOG), { recursive: true });
    fs.appendFileSync(ALERT_FAIL_LOG, `${JSON.stringify(entry)}\n`, 'utf8');
    const lines = fs.readFileSync(ALERT_FAIL_LOG, 'utf8').split('\n').filter(Boolean);
    if (lines.length > ALERT_FAIL_KEEP) {
      fs.writeFileSync(ALERT_FAIL_LOG, `${lines.slice(-ALERT_FAIL_KEEP).join('\n')}\n`, 'utf8');
    }
  } catch { /* never let alert bookkeeping break the caller */ }
}

// Read back the recorded failures (the supervisor reports a backlog).
function alertFailures({ since } = {}) {
  try {
    const rows = fs.readFileSync(ALERT_FAIL_LOG, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    return since ? rows.filter((r) => r.at >= since) : rows;
  } catch { return []; }
}

async function telegramAlert(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    const r = { ok: false, error: 'telegram creds missing' };
    noteAlertFailure(r, text);
    return r;
  }
  try {
    const res = await rawReq('POST', `https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text }, 10000);
    const data = JSON.parse(res.text || '{}');
    const out = { ok: res.ok && !!data.ok, messageId: data.result?.message_id ?? null, description: data.description ?? null, httpStatus: res.status };
    if (out.ok) noteAlertOk(out.messageId);
    else noteAlertFailure(out, text);
    return out;
  } catch (e) {
    const r = { ok: false, error: String(e.message || e) };
    noteAlertFailure(r, text);
    return r;
  }
}

module.exports = { dashboardPost, telegramAlert, alertFailures, lastAlertOkAt, dashboardBases, rawReq, serviceToken };
