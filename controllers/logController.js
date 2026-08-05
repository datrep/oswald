// controllers/logController.js
// Serves the internal API log (#58) to admins. Both dashboard and fileserver
// write to ApiLogs; this endpoint lets you view the combined traffic and filter
// by service source.
const { getAllApiLogs } = require('../models/apiLogModel');

async function getLogs(req, res, next) {
  try {
    const logs = await getAllApiLogs({
      source: req.query.source || undefined,
      limit: req.query.limit || undefined,
    });
    res.json(logs);
  } catch (err) {
    next(err);
  }
}

module.exports = { getLogs };
