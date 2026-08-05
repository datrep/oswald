const express = require('express');
const sql = require('mssql');
const dotenv = require('dotenv');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');

const logger = require('./utils/logger');

const dbRoutes = require('./routes/dbRoutes');

const edictRoutes = require('./routes/edictRoutes');
const taskRoutes = require('./routes/taskRoutes');
const auditRoutes = require('./routes/auditRoutes');
const resourceRoutes = require('./routes/resourceRoutes');
const ipRoutes = require('./routes/ipRoutes');

const servicesRoutes = require('./routes/servicesRoutes');

const userRoutes = require('./routes/userRoutes');

const mcpRoutes = require('./routes/mcpRoutes');

const serverRoutes = require('./routes/serverRoutes');

const authenticateToken = require('./middlewares/auth');
const { requirePermission } = require('./middlewares/auth');

const {
  globalErrorHandler,
  notFoundHandler,
  unhandledRejectionHandler,
} = require('./middlewares/errorHandler');
const mcpServer = require('./utils/mcpServer');
dotenv.config();
const { getPool } = require('./config/db');

const app = express();
const port = process.env.PORT || 3000;

// Server settings live in a small JSON file (served read-only via GET /api/settings,
// persisted via PUT /api/settings by admins). Kept out of require() so edits are
// picked up without a restart.
const SETTINGS_FILE = path.join(__dirname, 'public', 'js', 'api', 'settings.json');
function readSettingsFile() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

app.use(logger); //logger before all app.use

const corsOptions = {
  origin: function (origin, callback) {
    // Allow non-browser requests (no Origin header), localhost, and the LAN subnet
    // over both HTTP and HTTPS (the HTTPS listener is task #60).
    if (
      !origin ||
      origin === 'http://localhost:8080' ||
      /^https?:\/\/172\.22\.160\.\d+/.test(origin)
    ) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: 'GET,POST,PUT,DELETE',
  allowedHeaders: 'Content-Type,Authorization',
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));

app.use(express.json());

app.use(express.static('public'));
app.use(express.static('public/pages'));
app.use('/edicts', edictRoutes);

app.get('/api/settings', (req, res) => {
  res.json(readSettingsFile());
});

// Admin-only: persist server settings (e.g. the resources storage directory).
app.put('/api/settings', authenticateToken, requirePermission('users.manage'), (req, res) => {
  const body = req.body || {};
  const settings = readSettingsFile();
  if (typeof body.resourcesDir === 'string' && body.resourcesDir.trim()) {
    settings.resourcesDir = body.resourcesDir.trim();
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
  res.json(readSettingsFile());
});

// Serve stored resources from the configured directory (default public/resources).
// Re-resolves the path on every request so a settings change takes effect without
// a restart — and /resources/... URLs keep working if storage moves outside public/.
app.use('/resources', (req, res, next) => {
  const dir = path.resolve(readSettingsFile().resourcesDir || 'public/resources');
  express.static(dir)(req, res, next);
});

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  next();
});

// GET /api/health — lightweight, public status for the dashboard status strip.
// Returns server uptime, DB connectivity, MCP state, and host counts without
// pinging anything, so it stays fast enough to poll every few seconds.
app.get('/api/health', async (req, res) => {
  let db = false;
  let mcp = { running: false, pid: null };
  let hosts = { total: 0, enabled: 0 };

  try {
    const s = mcpServer.status();
    mcp = { running: !!s.running, pid: s.pid || null };
  } catch (err) {
    console.error('[health] mcp status failed:', err.message);
  }

  try {
    const pool = await getPool();
    await pool.request().query('SELECT 1');
    db = true;
    const r = await pool.request().query(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled FROM NetworkHosts'
    );
    const row = r.recordset[0];
    hosts = { total: row.total || 0, enabled: row.enabled || 0 };
  } catch (err) {
    console.error('[health] db check failed:', err.message);
  }

  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    db,
    mcp,
    hosts,
    checkedAt: new Date().toISOString(),
  });
});

app.use('/api/db', dbRoutes);
app.use('/api/edicts', edictRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/resources', resourceRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/ips', ipRoutes);
app.use('/api/services', servicesRoutes);
app.use('/api/users', userRoutes);
app.use('/api/mcp', mcpRoutes);
app.use('/api/servers', serverRoutes);

app.use(notFoundHandler);
app.use(globalErrorHandler);

// finally stop the server.
process.on('SIGINT', async () => {
  console.log('Server is gracefully shutting down');
  try {
    mcpServer.stop();
  } catch (err) {
    console.error('Error stopping MCP server:', err);
  }
  try {
    await sql.close();
    console.log('Database connections closed');
  } catch (err) {
    console.error('Error closing DB connections:', err);
  }
  process.exit(0);
});

process.on('unhandledRejection', unhandledRejectionHandler);

console.info('if this was too fast, the DB server not found or shut down.');

async function startServer() {
  const serverHost = process.env.SERVER_HOST || '0.0.0.0';
  const server = app.listen(port, serverHost, () => {
    console.log(`Server running on http://${serverHost}:${port}`);
  });

  // If the requested host isn't present on this machine, fall back to all interfaces.
  server.on('error', (err) => {
    if (err.code === 'EADDRNOTAVAIL') {
      console.error(
        `WARNING: cannot bind to ${serverHost} (${err.message}); falling back to 0.0.0.0`
      );
      app.listen(port, '0.0.0.0', () => {
        console.log(`Server running on http://0.0.0.0:${port}`);
      });
    } else {
      console.error('Server error:', err);
    }
  });

  // HTTPS (task #60): serve the same app over TLS on HTTPS_PORT (default 8443),
  // reusing the fileserver's self-signed cert (already added to the Root store;
  // its SANs cover 172.22.160.3 / localhost / 127.0.0.1). If the cert is missing
  // we just stay HTTP-only and log a warning.
  const httpsPort = Number(process.env.HTTPS_PORT || 8443);
  const certDir = path.join(__dirname, 'fileserver', 'certs');
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const httpsServer = https
      .createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
      .listen(httpsPort, serverHost, () => {
        console.log(`HTTPS running on https://${serverHost}:${httpsPort}`);
      });
    httpsServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`WARNING: HTTPS port ${httpsPort} is already in use; HTTPS disabled.`);
      } else {
        console.error('HTTPS server error:', err);
      }
    });
  } else {
    console.warn(
      `No TLS credentials found at ${certDir}; HTTPS disabled (install the fileserver cert to enable).`
    );
  }


  // Warm up the DB pool in the background (non-fatal): the server still serves
  // the frontend and /api/settings even if the database is unavailable.
  try {
    await getPool();
    console.log('Database pool initialized successfully');
  } catch (err) {
    console.error('WARNING: database pool failed to initialize:', err.message);
  }
}

startServer();
