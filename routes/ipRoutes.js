const express = require('express');
const router = express.Router();
const ipController = require('../controllers/ipController');
const authenticateToken = require('../middlewares/auth');

router.get('/check', authenticateToken, ipController.checkIPs);

module.exports = router;
