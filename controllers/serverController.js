// controllers/serverController.js
// Manage the dashboard's start/stop-able side services (MCP filesystem server,
// Oswald Fileserver) through the generic utils/serverManager.js.
const serverManager = require('../utils/serverManager');
const { asyncHandler } = require('../utils/errors');

// GET /api/servers — status of every managed server.
const getAll = asyncHandler(async (req, res) => {
  res.json({ servers: await serverManager.statusAll() });
});

// GET /api/servers/:name
const getStatus = asyncHandler(async (req, res) => {
  res.json(await serverManager.statusOne(req.params.name));
});

// POST /api/servers/:name/start
const start = asyncHandler((req, res) => {
  res.json(serverManager.start(req.params.name));
});

// POST /api/servers/:name/stop
const stop = asyncHandler((req, res) => {
  res.json(serverManager.stop(req.params.name));
});

module.exports = { getAll, getStatus, start, stop };
