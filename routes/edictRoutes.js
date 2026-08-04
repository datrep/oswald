const express = require('express');
const router = express.Router();

const edictController = require('../controllers/edictController');
const { validateCreateEdict } = require('../middlewares/edictValidation');
const authenticateToken = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/auth');

router.get('/', edictController.getAllEdicts);
router.get('/unfinished', edictController.getUnfinishedEdicts);
router.get('/trends', edictController.getCompletionTrends);
router.get('/:id', edictController.getEdictById);
router.post('/', authenticateToken, requirePermission('policies.manage'), validateCreateEdict, edictController.createEdict);
router.put('/:id', authenticateToken, requirePermission('policies.manage'), edictController.updateEdict);
router.delete('/:id', authenticateToken, requirePermission('policies.manage'), edictController.deleteEdict);

module.exports = router;
