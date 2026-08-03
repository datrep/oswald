const { getPool } = require('../config/db');
const sql = require('mssql');

async function getAllEdicts() {
  const pool = await getPool();
  const result = await pool.request().query(`SELECT * FROM Edicts ORDER BY createdAt DESC`);
  return result.recordset;
}

async function getEdictById(id) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .query(`SELECT * FROM Edicts WHERE id = @id`);
  return result.recordset[0];
}

async function getTasksByEdict(edictId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('edictId', sql.Int, edictId)
    .query(`SELECT * FROM Tasks WHERE edictId = @edictId ORDER BY plannedStart`);
  return result.recordset;
}

async function createEdict(name, plannedStart, plannedEnd, info, priority, state) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('name', sql.NVarChar, name)
    .input('plannedStart', sql.DateTime, plannedStart)
    .input('plannedEnd', sql.DateTime, plannedEnd)
    .input('info', sql.NVarChar, info)
    .input('priority', sql.Int, priority)
    .input('state', sql.Int, state).query(`
            INSERT INTO Edicts
            (name, plannedStart, plannedEnd, info, priority, state)
            VALUES
            (@name, @plannedStart, @plannedEnd, @info, @priority, @state);
            SELECT SCOPE_IDENTITY() AS id;
        `);

  // return the inserted id
  return result.recordset && result.recordset[0] ? result.recordset[0].id : null;
}

async function updateEdict(id, name, plannedStart, plannedEnd, info, priority, state) {
  const pool = await getPool();
  await pool
    .request()
    .input('id', sql.Int, id)
    .input('name', sql.NVarChar, name)
    .input('plannedStart', sql.DateTime, plannedStart)
    .input('plannedEnd', sql.DateTime, plannedEnd)
    .input('info', sql.NVarChar, info)
    .input('priority', sql.Int, priority)
    .input('state', sql.Int, state).query(`
            UPDATE Edicts
            SET
                name = @name,
                plannedStart = @plannedStart,
                plannedEnd = @plannedEnd,
                info = @info,
                priority = @priority,
                state = @state
            WHERE id = @id
        `);
}

async function deleteEdict(id) {
  const pool = await getPool();
  // delete resources first
  await pool
    .request()
    .input('id', sql.Int, id)
    .query(`DELETE FROM EdictResources WHERE edictId = @id`);
  // delete edict
  await pool.request().input('id', sql.Int, id).query(`DELETE FROM Edicts WHERE id = @id`);
}

async function getUnfinishedEdicts() {
  const pool = await getPool();
  const result = await pool.request().query(`
            SELECT * FROM Edicts 
            WHERE plannedEnd IS NOT NULL 
            AND GETDATE() > plannedEnd 
            AND state != 3
            ORDER BY plannedEnd ASC
        `);
  return result.recordset;
}

module.exports = {
  getAllEdicts,
  getEdictById,
  getTasksByEdict,
  createEdict,
  updateEdict,
  deleteEdict,
  getUnfinishedEdicts,
};
