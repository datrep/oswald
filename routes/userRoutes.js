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
router.get('/sessions', authenticateToken, requirePermission('users.manage'), userController.getSessions);
router.get('/roles', authenticateToken, requirePermission('users.manage'), userController.getRoles);
router.post('/roles', authenticateToken, requirePermission('users.manage'), userController.createRole);
router.put('/roles/:roleId', authenticateToken, requirePermission('users.manage'), userController.updateRole);
router.delete('/roles/:roleId', authenticateToken, requirePermission('users.manage'), userController.deleteRole);
router.put('/:userId/role', authenticateToken, requirePermission('users.manage'), userController.assignUserRole);
router.put('/:userId/roles', authenticateToken, requirePermission('users.manage'), userController.setUserRoles);
router.put('/:userId/active', authenticateToken, requirePermission('users.manage'), userController.setUserActive);
router.put('/:userId/password', authenticateToken, requirePermission('users.manage'), userController.resetUserPassword);
router.get('/:userId/sessions', authenticateToken, requirePermission('users.manage'), userController.getUserSessions);

module.exports = router;
