// controllers/serverController.js
// Manage the dashboard's start/stop-able side services (MCP filesystem server,
// Oswald Fileserver, + user-defined services) through utils/serverManager.js.
const serverManager = require('../utils/serverManager');
const { asyncHandler } = require('../utils/errors');

const bad = (fn) => asyncHandler(async (req, res) => {
  try { res.json(await fn(req, res)); } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/servers — status of every managed server.
const getAll = asyncHandler(async (req, res) => {
  res.json({ servers: await serverManager.statusAll() });
});

// GET /api/servers/:name
const getStatus = asyncHandler(async (req, res) => {
  res.json(await serverManager.statusOne(req.params.name));
});

// POST /api/servers/:name/start | stop | restart
const start = asyncHandler(async (req, res) => { res.json(await serverManager.start(req.params.name)); });
const stop = asyncHandler(async (req, res) => { res.json(await serverManager.stop(req.params.name)); });
const restart = asyncHandler(async (req, res) => { res.json(await serverManager.restart(req.params.name)); });

// POST /api/servers/:name/attach | detach — adopt / release a detached instance.
const attach = asyncHandler(async (req, res) => { res.json(await serverManager.attach(req.params.name)); });
const detach = asyncHandler(async (req, res) => { res.json(serverManager.detach(req.params.name)); });

// GET /api/servers/:name/log?lines= | POST .../log/clear
const getLog = asyncHandler(async (req, res) => {
  res.json(serverManager.readLog(req.params.name, req.query.lines));
});
const clearLog = asyncHandler(async (req, res) => { res.json(serverManager.clearLog(req.params.name)); });

// --- config registry (user-defined services) ---
const getConfig = asyncHandler(async (req, res) => { res.json({ definitions: serverManager.listDefinitions() }); });
const addConfig = bad((req, res) => serverManager.addDefinition(req.body || {}));
const updateConfig = bad((req, res) => serverManager.updateDefinition(req.params.name, req.body || {}));
const removeConfig = bad(async (req, res) => serverManager.removeDefinition(req.params.name));

module.exports = { getAll, getStatus, start, stop, restart, attach, detach, getLog, clearLog, getConfig, addConfig, updateConfig, removeConfig };
