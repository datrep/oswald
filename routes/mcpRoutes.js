const express = require('express');
const router = express.Router();
const mcpController = require('../controllers/mcpController');
const authenticateToken = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/auth');

router.get('/status', authenticateToken, mcpController.getStatus);
router.post('/start', authenticateToken, requirePermission('mcp.manage'), mcpController.start);
router.post('/stop', authenticateToken, requirePermission('mcp.manage'), mcpController.stop);

module.exports = router;
