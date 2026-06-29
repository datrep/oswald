 const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const authenticateToken = require('../middlewares/auth');

router.post('/register', userController.registerUser);
router.post('/login', userController.loginUser);
router.put('/:userId', authenticateToken, userController.updateUser);
router.delete('/:userId', authenticateToken, userController.deleteUser);
router.get('/me', authenticateToken, userController.getUserInfo);

module.exports = router;
