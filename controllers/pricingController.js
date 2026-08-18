'use strict';
const pricing = require('../services/pricing');

// GET /api/pricing — peak/off-peak indicator + API usage stats.
const getPricing = (req, res) => {
  res.json(pricing.snapshot());
};

module.exports = { getPricing };
