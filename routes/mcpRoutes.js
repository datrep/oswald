const express = require('express');
const router = express.Router();
const mcpController = require('../controllers/mcpController');
const authenticateToken = require('../middlewares/auth');

router.get('/status', authenticateToken, mcpController.getStatus);
router.post('/start', authenticateToken, mcpController.start);
router.post('/stop', authenticateToken, mcpController.stop);

module.exports = router;
