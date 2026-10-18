'use strict';
const pricing = require('../services/pricing');

// GET /api/pricing — peak/off-peak indicator + API usage stats.
const getPricing = (req, res) => {
  res.json(pricing.snapshot());
};

// POST /api/pricing/usage — LLM client telemetry hook (trading agent metering).
// Body: { cacheHit, cacheMiss, output } token counts.
const recordUsage = (req, res) => {
  pricing.recordUsage(req.body || {});
  res.json({ ok: true, snapshot: pricing.snapshot() });
};

module.exports = { getPricing, recordUsage };
