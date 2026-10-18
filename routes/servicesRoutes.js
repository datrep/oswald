const express = require('express');

const router = express.Router();

const servicesController = require('../controllers/servicesController');
const authenticateToken = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/auth');

router.get('/', servicesController.getAllServices);
router.post('/', authenticateToken, requirePermission('services.manage'), servicesController.createService);
router.put('/:id', authenticateToken, requirePermission('services.manage'), servicesController.updateService);
router.delete('/:id', authenticateToken, requirePermission('services.manage'), servicesController.deleteService);

module.exports = router;
