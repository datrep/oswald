'use strict';
const express = require('express');
const router = express.Router();
const pricingController = require('../controllers/pricingController');
const authenticateToken = require('../middlewares/auth');
const { requirePermission } = require('../middlewares/auth');

router.get('/', pricingController.getPricing);

// LLM usage metering from side services (e.g. the trading agent's chair).
router.post('/usage', authenticateToken, requirePermission('services.manage'), pricingController.recordUsage);

module.exports = router;
