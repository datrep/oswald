const { getPool } = require('../config/db');
const sql = require('mssql');

async function createAuditLog(edictId, taskId, eventType, notes) {
  const pool = await getPool();
  await pool
    .request()
    .input('edictId', sql.Int, edictId || null)
    .input('taskId', sql.Int, taskId || null)
    .input('eventType', sql.NVarChar, eventType)
    .input('notes', sql.NVarChar, notes || null).query(`
            INSERT INTO AuditLogs (edictId, taskId, eventType, notes)
            VALUES (@edictId, @taskId, @eventType, @notes);
        `);
}

async function getAllAuditLogs() {
  const pool = await getPool();
  const result = await pool.request().query(`SELECT * FROM AuditLogs ORDER BY createdAt DESC`);
  return result.recordset;
}

async function getAuditLogsByEdict(edictId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('id', sql.Int, edictId)
    .query(`SELECT * FROM AuditLogs WHERE edictId = @id ORDER BY createdAt DESC`);
  return result.recordset;
}

async function getAuditLogsByTask(taskId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('id', sql.Int, taskId)
    .query(`SELECT * FROM AuditLogs WHERE taskId = @id ORDER BY createdAt DESC`);
  return result.recordset;
}

module.exports = {
  createAuditLog,
  getAllAuditLogs,
  getAuditLogsByEdict,
  getAuditLogsByTask,
};
