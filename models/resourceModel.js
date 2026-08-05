const { getPool } = require('../config/db');
const sql = require('mssql');

async function createResource(edictId, description, filePath) {
  const pool = await getPool();
  await pool
    .request()
    .input('edictId', sql.Int, edictId)
    .input('resourcePath', sql.NVarChar, filePath)
    .input('description', sql.NVarChar, description).query(`
            INSERT INTO EdictResources (edictId, resourcePath, description)
            VALUES (@edictId, @resourcePath, @description);
        `);
}

async function getResourcesByEdict(edictId) {
  const pool = await getPool();
  const result = await pool.request().input('edictId', sql.Int, edictId).query(`
            SELECT id, edictId, resourcePath, description
            FROM EdictResources
            WHERE edictId = @edictId
        `);
  return result.recordset;
}

async function getResourcePathById(id) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .query(`SELECT resourcePath FROM EdictResources WHERE id = @id`);
  return result.recordset[0];
}

// List every resource across all policies (with the owning policy name), optionally filtered.
async function getAllResources(search) {
  const pool = await getPool();
  const request = pool.request();
  let where = '';
  if (search) {
    where = 'WHERE r.resourcePath LIKE @q OR r.description LIKE @q';
    request.input('q', sql.NVarChar, `%${search}%`);
  }
  const result = await request.query(`
            SELECT r.id, r.edictId, r.resourcePath, r.description, e.name AS edictName
            FROM EdictResources r
            LEFT JOIN Edicts e ON e.id = r.edictId
            ${where}
            ORDER BY r.resourcePath ASC
        `);
  return result.recordset;
}

// Attach an EXISTING file (resourcePath already on disk, e.g. in public/resources)
// to a policy — used by the "pull from Oswald's /resources" picker.
// Returns the new row id.
async function attachResource(edictId, description, resourcePath) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('edictId', sql.Int, edictId)
    .input('resourcePath', sql.NVarChar, resourcePath)
    .input('description', sql.NVarChar, description).query(`
            INSERT INTO EdictResources (edictId, resourcePath, description)
            OUTPUT inserted.id
            VALUES (@edictId, @resourcePath, @description);
        `);
  return result.recordset[0] ? result.recordset[0].id : null;
}

async function deleteResourceById(id) {
  const pool = await getPool();
  await pool.request().input('id', sql.Int, id).query(`DELETE FROM EdictResources WHERE id = @id`);
}

module.exports = {
  createResource,
  getResourcesByEdict,
  getResourcePathById,
  getAllResources,
  attachResource,
  deleteResourceById,
};
