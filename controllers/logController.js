// controllers/logController.js
// Serves the internal API log (#58) to admins. Both dashboard and fileserver
// write to ApiLogs; this endpoint lets you view the combined traffic and filter
// by service source.
const { getAllApiLogs } = require('../models/apiLogModel');
const { asyncHandler } = require('../utils/errors');

const getLogs = asyncHandler(async (req, res) => {
  res.json(await getAllApiLogs({
    source: req.query.source || undefined,
    limit: req.query.limit || undefined,
  }));
});

module.exports = { getLogs };
