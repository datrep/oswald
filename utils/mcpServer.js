// utils/mcpServer.js
// Back-compat wrapper: the MCP filesystem server is now managed by the generic
// serverManager (utils/serverManager.js) so the dashboard can start/stop any
// registered side service (MCP, fileserver) the same way.
const serverManager = require('./serverManager');

module.exports = {
  start: () => serverManager.start('mcp'),
  stop: () => serverManager.stop('mcp'),
  status: () => serverManager.status('mcp'),
};
