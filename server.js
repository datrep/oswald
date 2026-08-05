const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const https = require('https');
const path = require('path');

const logger = require('./utils/logger'); // legacy request logger — superseded by apiLogger (#58)

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

const logRoutes = require('./routes/logRoutes');
const careerFileRoutes = require('./routes/careerFileRoutes');
const jobApplicationRoutes = require('./routes/jobApplicationRoutes');
const { apiLogger, archivePreviousSession } = require('./utils/apiLogger');
const { createApiLog } = require('./models/apiLogModel');

const authenticateToken = require('./middlewares/auth');
const { requirePermission } = require('./middlewares/auth');

const {
  globalErrorHandler,
  notFoundHandler,
  unhandledRejectionHandler,
} = require('./middlewares/errorHandler');
const mcpServer = require('./utils/mcpServer');
const { loadEnv, readDashboardSettings, writeDashboardSettings } = require('./shared/config');
const { loadOrCreateCert } = require('./shared/tls');
loadEnv();
const { getPool } = require('./config/db');

const app = express();
const port = process.env.PORT || 3000;

// NOTE: the legacy utils/logger was replaced by apiLogger (#58) below, which logs
// /api + /edicts requests to console, the active session file, and ApiLogs.
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
  res.json(readDashboardSettings());
});

// Admin-only: persist server settings (e.g. the resources storage directory).
app.put('/api/settings', authenticateToken, requirePermission('users.manage'), (req, res) => {
  const body = req.body || {};
  const settings = readDashboardSettings();
  if (typeof body.resourcesDir === 'string' && body.resourcesDir.trim()) {
    settings.resourcesDir = body.resourcesDir.trim();
  }
  writeDashboardSettings(settings);
  res.json(readDashboardSettings());
});

// Serve stored resources from the configured directory (default public/resources).
// Re-resolves the path on every request so a settings change takes effect without
// a restart — and /resources/... URLs keep working if storage moves outside public/.
app.use('/resources', (req, res, next) => {
  const dir = path.resolve(readDashboardSettings().resourcesDir || 'public/resources');
  express.static(dir)(req, res, next);
});

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  next();
});

// Internal API request log (#58): every /api and /edicts request is written to
// ApiLogs (keep-all) + the active session file, mirrored to console. The label
// [policy:services] distinguishes dashboard traffic from fileserver traffic.
app.use(
  apiLogger({
    source: 'dashboard',
    labelFor: () => 'policy:services',
    writeLog: createApiLog,
  })
);

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
app.use('/api/logs', logRoutes);
app.use('/api/career-files', careerFileRoutes);
app.use('/api/applications', jobApplicationRoutes);

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

  // Internal logging (#58): zip the previous session's active log file (dated)
  // and start a fresh one for this run. Best-effort, non-blocking.
  archivePreviousSession('dashboard');

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

  // HTTPS (task #60; refactored onto shared/tls #70): load the trusted
  // fileserver/certs pair, or generate a self-signed one if missing — the same
  // util the fileserver uses, so both services serve the one trusted cert.
  const httpsPort = Number(process.env.HTTPS_PORT || 8443);
  const certDir = path.join(__dirname, 'fileserver', 'certs');
  try {
    const creds = await loadOrCreateCert({ certDir, host: serverHost });
    const httpsServer = https
      .createServer(creds, app)
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
  } catch (err) {
    console.warn(`HTTPS disabled (${err.message})`);
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
