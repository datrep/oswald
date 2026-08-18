const { getPool } = require('../config/db');
const sql = require('mssql');

async function getAllEdicts({ limit, offset } = {}) {
  const pool = await getPool();
  // Enrich with the comma-joined module types attached to each policy (MOD-2:
  // lets the dashboard show a live jobs-module status chip on policy rows).
  const req = pool.request();
  let query = `
            SELECT e.*,
                (SELECT STRING_AGG(moduleType, ',') WITHIN GROUP (ORDER BY moduleType) FROM PolicyModules pm WHERE pm.edictId = e.id) AS modules
            FROM Edicts e
            ORDER BY e.createdAt DESC
        `;
  if (Number.isInteger(limit) && limit > 0) {
    req.input('limit', sql.Int, limit);
    req.input('offset', sql.Int, offset || 0);
    query += ` OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
  }
  const result = await req.query(query);
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
            (name, plannedStart, plannedEnd, info, priority, state, completedAt)
            VALUES
            (@name, @plannedStart, @plannedEnd, @info, @priority, @state,
             CASE WHEN @state = 3 THEN GETUTCDATE() ELSE NULL END);
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
                state = @state,
                completedAt = CASE WHEN @state = 3 THEN COALESCE(completedAt, GETUTCDATE()) ELSE NULL END
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
            AND GETUTCDATE() > plannedEnd 
            AND state != 3
            ORDER BY plannedEnd ASC
        `);
  return result.recordset;
}

// Completions grouped by month (for trends), plus overall totals
async function getCompletionTrends() {
  const pool = await getPool();
  const buckets = await pool.request().query(`
    SELECT CONVERT(varchar(7), completedAt, 120) AS month, COUNT(*) AS completed
    FROM Edicts
    WHERE completedAt IS NOT NULL
    GROUP BY CONVERT(varchar(7), completedAt, 120)
    ORDER BY month
  `);
  const totals = await pool.request().query(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN completedAt IS NOT NULL THEN 1 ELSE 0 END) AS totalCompleted
    FROM Edicts
  `);
  return {
    buckets: buckets.recordset,
    total: totals.recordset[0]?.total ?? 0,
    totalCompleted: totals.recordset[0]?.totalCompleted ?? 0,
  };
}

module.exports = {
  getAllEdicts,
  getEdictById,
  getTasksByEdict,
  createEdict,
  updateEdict,
  deleteEdict,
  getUnfinishedEdicts,
  getCompletionTrends,
};
