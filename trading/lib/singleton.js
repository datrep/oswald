'use strict';
// trading/lib/singleton.js — 2026-10-18 (night shift, feature `desk-singleton-guard`).
//
// WHY THIS EXISTS, MEASURED: two `trading\server.js` processes were alive at the same time. Windows allowed
// both to bind port 8114 because they had chosen DIFFERENT interfaces (one 127.0.0.1, one 0.0.0.0), so every
// `POST /capture` reached the STALE build while restarts looked successful — roughly forty minutes were spent
// measuring code that was not running. `restart-trading.ps1` reported "started pid N, healthz ok" because the
// health port was served by whichever process bound it first.
//
// THE PROBE: the health endpoint is the right question to ask, not the port. Only a desk serves `/healthz`,
// and its health listener is always bound to 127.0.0.1 — so a loopback GET answers "is a desk already
// serving?" without depending on which interface the other process chose. A bind attempt alone does not:
// that is exactly the check that silently passed twice.
//
// The probe answers { alive }, where alive requires BOTH a 200 status and an `ok` body — a random listener
// that happens to occupy the port must not be mistaken for a desk (it would block a legitimate boot).

const http = require('http');

function probeExistingDesk({ port = 8115, timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let req;
    try {
      req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => finish({ alive: res.statusCode === 200 && /^ok/.test(String(body)), statusCode: res.statusCode }));
        res.on('error', () => finish({ alive: false }));
      });
    } catch {
      finish({ alive: false });
      return;
    }
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } finish({ alive: false, timeout: true }); });
    req.on('error', () => finish({ alive: false }));
  });
}

module.exports = { probeExistingDesk };
