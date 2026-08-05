const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const authenticateToken = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/auth');

router.post('/register', userController.registerUser);
router.post('/login', userController.loginUser);
router.put('/:userId', authenticateToken, userController.updateUser);
router.delete('/:userId', authenticateToken, userController.deleteUser);
router.get('/me', authenticateToken, userController.getUserInfo);
router.get('/', authenticateToken, requirePermission('users.manage'), userController.getAllUsers);
router.get('/roles', authenticateToken, requirePermission('users.manage'), userController.getRoles);
router.put('/:userId/role', authenticateToken, requirePermission('users.manage'), userController.assignUserRole);

module.exports = router;
