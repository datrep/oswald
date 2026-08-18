const ping = require('ping');
const { getPool } = require('../config/db');
const sql = require('mssql');

// GET /api/ips/check — ping enabled hosts from the DB
async function getEnabledHosts() {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT id, label, ip FROM NetworkHosts WHERE enabled = 1 ORDER BY sortOrder ASC, id ASC
  `);
  return result.recordset;
}

exports.checkIPs = async (req, res, next) => {
  try {
    const hosts = await getEnabledHosts();
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
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT id, label, ip, enabled, sortOrder FROM NetworkHosts ORDER BY sortOrder ASC, id ASC
    `);
    res.json(result.recordset);
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
    const pool = await getPool();
    await pool
      .request()
      .input('label', sql.NVarChar, label)
      .input('ip', sql.NVarChar, ip)
      .input('enabled', sql.Bit, enabled)
      .input('sortOrder', sql.Int, sortOrder)
      .query(
        `INSERT INTO NetworkHosts (label, ip, enabled, sortOrder) VALUES (@label, @ip, @enabled, @sortOrder)`
      );
    res.json({ success: true, message: 'Host created' });
  } catch (err) {
    next(err);
  }
};

// PUT /api/ips/hosts/:id
exports.updateHost = async (req, res, next) => {
  try {
    const id = req.params.id;
    const { label, ip, enabled, sortOrder } = req.body;
    const pool = await getPool();
    const req2 = pool.request().input('id', sql.Int, id);
    const sets = [];
    if (label !== undefined) {
      req2.input('label', sql.NVarChar, label);
      sets.push('label = @label');
    }
    if (ip !== undefined) {
      req2.input('ip', sql.NVarChar, ip);
      sets.push('ip = @ip');
    }
    if (enabled !== undefined) {
      req2.input('enabled', sql.Bit, enabled);
      sets.push('enabled = @enabled');
    }
    if (sortOrder !== undefined) {
      req2.input('sortOrder', sql.Int, sortOrder);
      sets.push('sortOrder = @sortOrder');
    }
    if (!sets.length) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    await req2.query(`UPDATE NetworkHosts SET ${sets.join(', ')} WHERE id = @id`);
    res.json({ success: true, message: 'Host updated' });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/ips/hosts/:id
exports.deleteHost = async (req, res, next) => {
  try {
    const pool = await getPool();
    await pool
      .request()
      .input('id', sql.Int, req.params.id)
      .query(`DELETE FROM NetworkHosts WHERE id = @id`);
    res.json({ success: true, message: 'Host deleted' });
  } catch (err) {
    next(err);
  }
};
