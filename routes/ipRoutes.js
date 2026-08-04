const express = require('express');
const router = express.Router();
const ipController = require('../controllers/ipController');
const authenticateToken = require('../middlewares/auth');

router.get('/check', authenticateToken, ipController.checkIPs);
router.get('/hosts', authenticateToken, ipController.getAllHosts);
router.post('/hosts', authenticateToken, ipController.createHost);
router.put('/hosts/:id', authenticateToken, ipController.updateHost);
router.delete('/hosts/:id', authenticateToken, ipController.deleteHost);

module.exports = router;
