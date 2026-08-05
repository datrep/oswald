// models/policyModuleModel.js
// Policy module-attachment framework (PREREQ): which modules are attached to a
// policy, via the PolicyModules table.
//
// FUTURE SCOPE: new module types (e.g. 'certificates') only need to be added to
// MODULE_TYPES here + the frontend registry in policy.js — no schema change.

const { getPool } = require('../config/db');
const sql = require('mssql');

// Backend allowlist — the API rejects anything not listed here.
const MODULE_TYPES = ['jobs', 'career_files'];

async function getModulesByEdict(edictId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('edictId', sql.Int, edictId)
    .query(`
            SELECT id, edictId, moduleType, config, createdAt
            FROM PolicyModules
            WHERE edictId = @edictId
            ORDER BY id
        `);
  return result.recordset;
}

async function attachModule(edictId, moduleType) {
  const pool = await getPool();
  await pool
    .request()
    .input('edictId', sql.Int, edictId)
    .input('moduleType', sql.NVarChar, moduleType)
    .query(`INSERT INTO PolicyModules (edictId, moduleType) VALUES (@edictId, @moduleType)`);
}

async function detachModule(edictId, moduleType) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('edictId', sql.Int, edictId)
    .input('moduleType', sql.NVarChar, moduleType)
    .query(`DELETE FROM PolicyModules WHERE edictId = @edictId AND moduleType = @moduleType`);
  return (result.rowsAffected && result.rowsAffected[0]) || 0;
}

module.exports = { MODULE_TYPES, getModulesByEdict, attachModule, detachModule };
