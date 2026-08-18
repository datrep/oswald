const express = require('express');
const router = express.Router();

const taskController = require('../controllers/taskController');
const authenticateToken = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/auth');
const { validateTaskCreate, validateReorder } = require('../middlewares/validators');

router.get('/', taskController.getAllTasks);
router.get('/trends', taskController.getCompletionTrends);
router.get('/:id', taskController.getTaskById);
router.post('/', authenticateToken, requirePermission('tasks.manage'), validateTaskCreate, taskController.createTask);
router.put('/reorder', authenticateToken, requirePermission('tasks.manage'), validateReorder, taskController.reorderTasks);
router.put('/:id', authenticateToken, requirePermission('tasks.manage'), taskController.updateTask);
router.delete('/:id', authenticateToken, requirePermission('tasks.manage'), taskController.deleteTask);
router.get('/edict/:edictId', taskController.getTasksByEdict);

module.exports = router;
