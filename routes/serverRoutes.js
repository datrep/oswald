const express = require('express');
const router = express.Router();
const serverController = require('../controllers/serverController');
const authenticateToken = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/auth');

// Status is readable by any signed-in user; start/stop require services.manage.
router.get('/', authenticateToken, serverController.getAll);
router.get('/:name', authenticateToken, serverController.getStatus);
router.post('/:name/start', authenticateToken, requirePermission('services.manage'), serverController.start);
router.post('/:name/stop', authenticateToken, requirePermission('services.manage'), serverController.stop);

module.exports = router;
