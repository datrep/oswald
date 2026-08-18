// controllers/ipController.js
// IP monitoring endpoints. NetworkHosts DB access lives in models/ipModel.js
// so this controller matches the route -> controller -> model split.
const ping = require('ping');
const model = require('../models/ipModel');

// GET /api/ips/check — ping enabled hosts from the DB
exports.checkIPs = async (req, res, next) => {
  try {
    const hosts = await model.getEnabledHosts();
    const results = await Promise.all(
      hosts.map(async (h) => {
        try {
          const r = await ping.promise.probe(h.ip, { timeout: 2 });
          return { label: h.label, ip: h.ip, alive: r.alive, time: r.time };
        } catch (e) {
          return { label: h.label, ip: h.ip, alive: false, error: e.message };
        }
      })
    );
    res.json({ ok: true, results });
  } catch (err) {
    next(err);
  }
};

// GET /api/ips/hosts
exports.getAllHosts = async (req, res, next) => {
  try {
    res.json(await model.getAllHosts());
  } catch (err) {
    next(err);
  }
};

// POST /api/ips/hosts
exports.createHost = async (req, res, next) => {
  try {
    const { label, ip, enabled = true, sortOrder = 0 } = req.body;
    if (!label || !ip) {
      return res.status(400).json({ error: 'label and ip are required' });
    }
    await model.createHost({ label, ip, enabled, sortOrder });
    res.json({ success: true, message: 'Host created' });
  } catch (err) {
    next(err);
  }
};

// PUT /api/ips/hosts/:id
exports.updateHost = async (req, res, next) => {
  try {
    const fields = {};
    for (const key of ['label', 'ip', 'enabled', 'sortOrder']) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) {
        fields[key] = req.body[key];
      }
    }
    if (!Object.keys(fields).length) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    await model.updateHost(req.params.id, fields);
    res.json({ success: true, message: 'Host updated' });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/ips/hosts/:id
exports.deleteHost = async (req, res, next) => {
  try {
    await model.deleteHost(req.params.id);
    res.json({ success: true, message: 'Host deleted' });
  } catch (err) {
    next(err);
  }
};
