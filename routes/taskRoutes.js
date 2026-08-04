const express = require('express');
const router = express.Router();

const taskController = require('../controllers/taskController');
const authenticateToken = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/auth');

router.get('/', taskController.getAllTasks);
router.get('/trends', taskController.getCompletionTrends);
router.get('/:id', taskController.getTaskById);
router.post('/', authenticateToken, requirePermission('tasks.manage'), taskController.createTask);
router.put('/:id', authenticateToken, requirePermission('tasks.manage'), taskController.updateTask);
router.delete('/:id', authenticateToken, requirePermission('tasks.manage'), taskController.deleteTask);
router.get('/edict/:edictId', taskController.getTasksByEdict);

module.exports = router;
