const express = require('express');
const router = express.Router();
const authenticateToken = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/auth');
const logController = require('../controllers/logController');

// GET /api/logs?source=dashboard|fileserver&limit=200 — admin only (#58).
// FUTURE SCOPE: add ?from&to time filters, ?path substring, and pagination when
// the log viewer UI lands; keep them here so the API stays backward-compatible.
router.get('/', authenticateToken, requirePermission('users.manage'), logController.getLogs);

module.exports = router;
