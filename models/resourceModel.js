const { getPool } = require('../config/db');
const sql = require('mssql');

async function createResource(edictId, description, filePath) {
    const pool = await getPool();
    await pool.request()
        .input('edictId', sql.Int, edictId)
        .input('resourcePath', sql.NVarChar, filePath)
        .input('description', sql.NVarChar, description)
        .query(`
            INSERT INTO EdictResources (edictId, resourcePath, description)
            VALUES (@edictId, @resourcePath, @description);
        `);
}

async function getResourcesByEdict(edictId) {
    const pool = await getPool();
    const result = await pool.request()
        .input('edictId', sql.Int, edictId)
        .query(`
            SELECT id, edictId, resourcePath, description
            FROM EdictResources
            WHERE edictId = @edictId
        `);
    return result.recordset;
}

async function getResourcePathById(id) {
    const pool = await getPool();
    const result = await pool.request()
        .input('id', sql.Int, id)
        .query(`SELECT resourcePath FROM EdictResources WHERE id = @id`);
    return result.recordset[0];
}

async function deleteResourceById(id) {
    const pool = await getPool();
    await pool.request()
        .input('id', sql.Int, id)
        .query(`DELETE FROM EdictResources WHERE id = @id`);
}

module.exports = {
    createResource,
    getResourcesByEdict,
    getResourcePathById,
    deleteResourceById
};