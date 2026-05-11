const express = require('express');
const router = express.Router();
const ipController = require('../controllers/ipController');

router.get('/check', ipController.checkIPs);

module.exports = router;
