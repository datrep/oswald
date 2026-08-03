const express = require('express');

const router = express.Router();

const servicesController = require('../controllers/servicesController');
const authenticateToken = require('../middlewares/auth');

router.get('/', servicesController.getAllServices);
router.post('/', authenticateToken, servicesController.createService);
router.put('/:id', authenticateToken, servicesController.updateService);
router.delete('/:id', authenticateToken, servicesController.deleteService);

module.exports = router;
