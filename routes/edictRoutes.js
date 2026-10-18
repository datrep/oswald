const express = require('express');
const router = express.Router();

const edictController = require('../controllers/edictController');
const policyModuleController = require('../controllers/policyModuleController');
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

// Module-attachment framework (PREREQ): read is public, mutations need policies.manage.
router.get('/:id/modules', policyModuleController.getModules);
router.post('/:id/modules', authenticateToken, requirePermission('policies.manage'), policyModuleController.attachModule);
router.delete('/:id/modules/:type', authenticateToken, requirePermission('policies.manage'), policyModuleController.detachModule);

module.exports = router;
