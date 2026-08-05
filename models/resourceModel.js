const { getPool } = require('../config/db');
const sql = require('mssql');

async function createResource(edictId, description, filePath) {
  const pool = await getPool();
  const order = await pool
    .request()
    .input('edictId', sql.Int, edictId)
    .query(`SELECT ISNULL(MAX(sortOrder), -1) + 1 AS nextOrder FROM EdictResources WHERE edictId = @edictId`);
  const nextOrder = order.recordset[0]?.nextOrder ?? 0;
  await pool
    .request()
    .input('edictId', sql.Int, edictId)
    .input('resourcePath', sql.NVarChar, filePath)
    .input('description', sql.NVarChar, description)
    .input('sortOrder', sql.Int, nextOrder).query(`
            INSERT INTO EdictResources (edictId, resourcePath, description, sortOrder)
            VALUES (@edictId, @resourcePath, @description, @sortOrder);
        `);
}

async function getResourcesByEdict(edictId) {
  const pool = await getPool();
  const result = await pool.request().input('edictId', sql.Int, edictId).query(`
            SELECT id, edictId, resourcePath, description, sortOrder
            FROM EdictResources
            WHERE edictId = @edictId
            ORDER BY sortOrder, id
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
  const order = await pool
    .request()
    .input('edictId', sql.Int, edictId)
    .query(`SELECT ISNULL(MAX(sortOrder), -1) + 1 AS nextOrder FROM EdictResources WHERE edictId = @edictId`);
  const nextOrder = order.recordset[0]?.nextOrder ?? 0;
  const result = await pool
    .request()
    .input('edictId', sql.Int, edictId)
    .input('resourcePath', sql.NVarChar, resourcePath)
    .input('description', sql.NVarChar, description)
    .input('sortOrder', sql.Int, nextOrder).query(`
            INSERT INTO EdictResources (edictId, resourcePath, description, sortOrder)
            OUTPUT inserted.id
            VALUES (@edictId, @resourcePath, @description, @sortOrder);
        `);
  return result.recordset[0] ? result.recordset[0].id : null;
}

// Persist a manual ordering for resources within an edict (drag-to-reorder).
async function reorderResources(edictId, orderedIds) {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    for (let i = 0; i < orderedIds.length; i++) {
      await transaction
        .request()
        .input('id', sql.Int, orderedIds[i])
        .input('sortOrder', sql.Int, i)
        .input('edictId', sql.Int, edictId)
        .query(`UPDATE EdictResources SET sortOrder = @sortOrder WHERE id = @id AND edictId = @edictId`);
    }
    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
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
  reorderResources,
};
