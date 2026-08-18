const express = require('express');
const router = express.Router();
const dbController = require('../controllers/dbController');
const authenticateToken = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/auth');

// List all tables — admin-only. The raw table browser exposes every row,
// including Users.passwordHash and ApiLogs, so gate it behind users.manage.
router.get('/tables', authenticateToken, requirePermission('users.manage'), dbController.getTables);

// Get all rows from a specific table (admin-only, same reason as above).
router.get('/:tableName', authenticateToken, requirePermission('users.manage'), dbController.getTableRows);

module.exports = router;
