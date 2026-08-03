// controllers/mcpController.js
const mcpServer = require('../utils/mcpServer');

// GET /api/mcp/status
exports.getStatus = (req, res) => {
  res.json(mcpServer.status());
};

// POST /api/mcp/start
exports.start = (req, res) => {
  res.json(mcpServer.start());
};

// POST /api/mcp/stop
exports.stop = (req, res) => {
  res.json(mcpServer.stop());
};
