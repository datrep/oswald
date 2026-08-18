// models/ipModel.js — data access for the NetworkHosts monitoring table.
// Extracted from controllers/ipController.js so IP endpoints follow the same
// route -> controller -> model split as every other domain.

const { getPool } = require('../config/db');
const sql = require('mssql');

async function getEnabledHosts() {
  const pool = await getPool();
  const result = await pool.request().query(
    `SELECT id, label, ip FROM NetworkHosts WHERE enabled = 1 ORDER BY sortOrder ASC, id ASC`
  );
  return result.recordset;
}

async function getAllHosts() {
  const pool = await getPool();
  const result = await pool.request().query(
    `SELECT id, label, ip, enabled, sortOrder FROM NetworkHosts ORDER BY sortOrder ASC, id ASC`
  );
  return result.recordset;
}

async function createHost({ label, ip, enabled = true, sortOrder = 0 }) {
  const pool = await getPool();
  await pool
    .request()
    .input('label', sql.NVarChar, label)
    .input('ip', sql.NVarChar, ip)
    .input('enabled', sql.Bit, enabled)
    .input('sortOrder', sql.Int, sortOrder)
    .query(`INSERT INTO NetworkHosts (label, ip, enabled, sortOrder) VALUES (@label, @ip, @enabled, @sortOrder)`);
}

const IP_UPDATABLE = ['label', 'ip', 'enabled', 'sortOrder'];

// Partial update: only the provided fields change. Returns false when nothing
// was provided so the controller can respond 400.
async function updateHost(id, fields) {
  const pool = await getPool();
  const req = pool.request().input('id', sql.Int, id);
  const sets = [];
  for (const key of IP_UPDATABLE) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    const val = fields[key];
    const param = 'p_' + key;
    if (key === 'enabled') req.input(param, sql.Bit, val);
    else if (key === 'sortOrder') req.input(param, sql.Int, val);
    else req.input(param, sql.NVarChar, val);
    sets.push(`${key} = @${param}`);
  }
  if (!sets.length) return false;
  await req.query(`UPDATE NetworkHosts SET ${sets.join(', ')} WHERE id = @id`);
  return true;
}

async function deleteHost(id) {
  const pool = await getPool();
  await pool.request().input('id', sql.Int, id).query(`DELETE FROM NetworkHosts WHERE id = @id`);
}

module.exports = { getEnabledHosts, getAllHosts, createHost, updateHost, deleteHost };
