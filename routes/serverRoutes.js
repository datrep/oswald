const express = require('express');
const router = express.Router();
const serverController = require('../controllers/serverController');
const authenticateToken = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/auth');

// Status is readable by any signed-in user; control + config require services.manage.
// NOTE: literal /config routes MUST come before /:name (otherwise GET /config
// is swallowed by GET /:name).
router.get('/', authenticateToken, serverController.getAll);
router.get('/config', authenticateToken, requirePermission('services.manage'), serverController.getConfig);
router.post('/config', authenticateToken, requirePermission('services.manage'), serverController.addConfig);
router.put('/config/:name', authenticateToken, requirePermission('services.manage'), serverController.updateConfig);
router.delete('/config/:name', authenticateToken, requirePermission('services.manage'), serverController.removeConfig);
router.get('/:name', authenticateToken, serverController.getStatus);
router.post('/:name/start', authenticateToken, requirePermission('services.manage'), serverController.start);
router.post('/:name/stop', authenticateToken, requirePermission('services.manage'), serverController.stop);
router.post('/:name/restart', authenticateToken, requirePermission('services.manage'), serverController.restart);
router.post('/:name/attach', authenticateToken, requirePermission('services.manage'), serverController.attach);
router.post('/:name/detach', authenticateToken, requirePermission('services.manage'), serverController.detach);
router.get('/:name/log', authenticateToken, requirePermission('services.manage'), serverController.getLog);
router.post('/:name/log/clear', authenticateToken, requirePermission('services.manage'), serverController.clearLog);

module.exports = router;
