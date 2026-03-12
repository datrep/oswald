 const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const authenticateToken = require('../middlewares/auth');

router.post('/register', userController.registerUser);
router.post('/login', userController.loginUser);
router.put('/edit', authenticateToken, userController.updateUser);
router.delete('/delete', authenticateToken, userController.deleteUser);
router.get('/me', authenticateToken, userController.getUserInfo);

module.exports = router;
