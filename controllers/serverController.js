// controllers/serverController.js
// Manage the dashboard's start/stop-able side services (MCP filesystem server,
// Oswald Fileserver) through the generic utils/serverManager.js.
const serverManager = require('../utils/serverManager');

// GET /api/servers — status of every managed server.
exports.getAll = async (req, res, next) => {
  try {
    res.json({ servers: await serverManager.statusAll() });
  } catch (err) {
    next(err);
  }
};

// GET /api/servers/:name
exports.getStatus = async (req, res, next) => {
  try {
    res.json(await serverManager.statusOne(req.params.name));
  } catch (err) {
    next(err);
  }
};

// POST /api/servers/:name/start
exports.start = (req, res, next) => {
  try {
    res.json(serverManager.start(req.params.name));
  } catch (err) {
    next(err);
  }
};

// POST /api/servers/:name/stop
exports.stop = (req, res, next) => {
  try {
    res.json(serverManager.stop(req.params.name));
  } catch (err) {
    next(err);
  }
};
