// Oswald listings service — Listing Workbench (policy 51).
// Separate Express app, own port (HTTPS 8110 + localhost health 8111), shares
// the dashboard JWT secret + SQL Server DB (fileserver pattern). This is the
// skeleton; CRUD/import/UI land in LST-3..LST-6.
const express = require('express');
const path = require('path');
const https = require('https');

const { loadOrCreateCert } = require('../shared/tls');
const { getConfig } = require('./config');
const { authenticateToken } = require('./auth');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// --- dashboard login proxy (same idea as fileserver) -------------------------
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
      console.warn(`[listings] dashboard ${base} unreachable (${e.message || e}); trying next base`);
    }
  }
  throw lastErr;
}

// --- public bootstrap --------------------------------------------------------
app.get('/api/listings/config', (req, res) => {
  res.json({ service: 'listings', version: '0.1.0' });
});

// Login proxy — the UI is HTTPS, so it can't call the HTTP dashboard directly.
app.post('/api/listings/login', async (req, res, next) => {
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
    res.cookie('oswald_listings_token', body.token, {
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
app.get('/api/listings/me', authenticateToken, (req, res) => {
  res.json({ userID: req.user.userID, roles: req.user.roles, permissions: req.user.permissions });
});

// --- Listing Workbench API (LST-4) -------------------------------------------
app.use('/api/listings', require('./routes'));

// --- errors + start -----------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('[listings]', err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

const port = getConfig().port || 8110;
const host = getConfig().host || '0.0.0.0';

if (getConfig().tls?.enabled) {
  // Reuse the already-trusted fileserver cert (same SANs: 172.22.160.3 etc.).
  loadOrCreateCert({ certDir: path.join(__dirname, '..', 'fileserver', 'certs'), host: getConfig().tls?.host || '172.22.160.3' })
    .then((creds) => {
      https.createServer(creds, app).listen(port, host, () => {
        console.log(`[listings] Listing Workbench listening on https://${host}:${port}`);
      });
      const healthPort = getConfig().tls?.healthPort || 8111;
      require('http')
        .createServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
        })
        .listen(healthPort, '127.0.0.1', () => {
          console.log(`[listings] health endpoint on http://127.0.0.1:${healthPort}/healthz`);
        });
    })
    .catch((e) => {
      console.error('[listings] cert load failed', e);
      process.exit(1);
    });
} else {
  app.listen(port, host, () => {
    console.log(`[listings] Listening Workbench listening on http://${host}:${port}`);
  });
}
