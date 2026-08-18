const express = require('express');
const router = express.Router();
const ipController = require('../controllers/ipController');
const authenticateToken = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/auth');
const { validateHostCreate } = require('../middlewares/validators');

router.get('/check', authenticateToken, ipController.checkIPs);
router.get('/hosts', authenticateToken, ipController.getAllHosts);
router.post('/hosts', authenticateToken, requirePermission('monitoring.manage'), validateHostCreate, ipController.createHost);
router.put('/hosts/:id', authenticateToken, requirePermission('monitoring.manage'), ipController.updateHost);
router.delete('/hosts/:id', authenticateToken, requirePermission('monitoring.manage'), ipController.deleteHost);

module.exports = router;
