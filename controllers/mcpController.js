// controllers/mcpController.js
const mcpServer = require('../utils/mcpServer');

// GET /api/mcp/status
const getStatus = (req, res) => {
  res.json(mcpServer.status());
};

// POST /api/mcp/start
const start = (req, res) => {
  res.json(mcpServer.start());
};

// POST /api/mcp/stop
const stop = (req, res) => {
  res.json(mcpServer.stop());
};

module.exports = { getStatus, start, stop };