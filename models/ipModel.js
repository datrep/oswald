// models/ipModel.js — data access for the NetworkHosts monitoring table.
// Extracted from controllers/ipController.js so IP endpoints follow the same
// route -> controller -> model split as every other domain.

const { Repository } = require('../shared/repository');
const { sql } = require('../shared/db');

const repo = new Repository('NetworkHosts');

async function getEnabledHosts() {
  return repo.all({
    columns: 'id, label, ip',
    where: 'enabled = 1',
    order: 'sortOrder ASC, id ASC',
  });
}

async function getAllHosts() {
  return repo.all({
    columns: 'id, label, ip, enabled, sortOrder',
    order: 'sortOrder ASC, id ASC',
  });
}

async function createHost({ label, ip, enabled = true, sortOrder = 0 }) {
  await repo.query(
    `INSERT INTO NetworkHosts (label, ip, enabled, sortOrder) VALUES (@label, @ip, @enabled, @sortOrder)`,
    (req) => req
      .input('label', sql.NVarChar, label)
      .input('ip', sql.NVarChar, ip)
      .input('enabled', sql.Bit, enabled)
      .input('sortOrder', sql.Int, sortOrder)
  );
}

const IP_UPDATABLE = ['label', 'ip', 'enabled', 'sortOrder'];

function ipType(key) {
  if (key === 'enabled') return sql.Bit;
  if (key === 'sortOrder') return sql.Int;
  return sql.NVarChar;
}

// Partial update: only the provided fields change. Returns false when nothing
// was provided so the controller can respond 400.
async function updateHost(id, fields) {
  const sets = [];
  const present = [];
  for (const key of IP_UPDATABLE) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    sets.push(`${key} = @p_${key}`);
    present.push(key);
  }
  if (!sets.length) return false;
  await repo.query(
    `UPDATE NetworkHosts SET ${sets.join(', ')} WHERE id = @id`,
    (req) => {
      req.input('id', sql.Int, id);
      for (const key of present) req.input(`p_${key}`, ipType(key), fields[key]);
    }
  );
  return true;
}

async function deleteHost(id) {
  return repo.remove(id);
}

module.exports = { getEnabledHosts, getAllHosts, createHost, updateHost, deleteHost };
