const { getPool } = require('../config/db');
const sql = require('mssql');

async function getAllTasks() {
  const pool = await getPool();
  const result = await pool.request().query(`SELECT * FROM Tasks ORDER BY createdAt DESC`);
  return result.recordset;
}

async function getTaskById(id) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .query(`SELECT * FROM Tasks WHERE id = @id`);
  return result.recordset[0];
}

async function createTask(
  name,
  plannedStart,
  plannedEnd,
  info,
  priority,
  state,
  assignedToUserId,
  edictId
) {
  const pool = await getPool();
  await pool
    .request()
    .input('name', sql.NVarChar, name)
    .input('plannedStart', sql.DateTime, plannedStart)
    .input('plannedEnd', sql.DateTime, plannedEnd)
    .input('info', sql.NVarChar, info)
    .input('priority', sql.Int, priority)
    .input('state', sql.Int, state)
    .input('assignedToUserId', sql.Int, assignedToUserId)
    .input('edictId', sql.Int, edictId).query(`
            INSERT INTO Tasks
            (name, plannedStart, plannedEnd, info, priority, state, assignedToUserId, edictId, completedAt)
            VALUES
            (@name, @plannedStart, @plannedEnd, @info, @priority, @state, @assignedToUserId, @edictId,
             CASE WHEN @state = 3 THEN GETDATE() ELSE NULL END)
        `);
}

async function updateTask(
  id,
  name,
  plannedStart,
  plannedEnd,
  info,
  priority,
  state,
  assignedToUserId,
  edictId
) {
  const pool = await getPool();
  await pool
    .request()
    .input('id', sql.Int, id)
    .input('name', sql.NVarChar, name)
    .input('plannedStart', sql.DateTime, plannedStart)
    .input('plannedEnd', sql.DateTime, plannedEnd)
    .input('info', sql.NVarChar, info)
    .input('priority', sql.Int, priority)
    .input('state', sql.Int, state)
    .input('assignedToUserId', sql.Int, assignedToUserId)
    .input('edictId', sql.Int, edictId).query(`
            UPDATE Tasks
            SET
                name = @name,
                plannedStart = @plannedStart,
                plannedEnd = @plannedEnd,
                info = @info,
                priority = @priority,
                state = @state,
                assignedToUserId = @assignedToUserId,
                edictId = @edictId,
                completedAt = CASE WHEN @state = 3 THEN COALESCE(completedAt, GETDATE()) ELSE NULL END
            WHERE id = @id
        `);
}

async function deleteTask(id) {
  const pool = await getPool();
  await pool.request().input('id', sql.Int, id).query(`DELETE FROM Tasks WHERE id = @id`);
}

async function getTasksByEdict(edictId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('edictId', sql.Int, edictId)
    .query(`SELECT * FROM Tasks WHERE edictId = @edictId ORDER BY plannedStart`);
  return result.recordset;
}

// Completions grouped by month (for trends), plus overall totals
async function getCompletionTrends() {
  const pool = await getPool();
  const buckets = await pool.request().query(`
    SELECT CONVERT(varchar(7), completedAt, 120) AS month, COUNT(*) AS completed
    FROM Tasks
    WHERE completedAt IS NOT NULL
    GROUP BY CONVERT(varchar(7), completedAt, 120)
    ORDER BY month
  `);
  const totals = await pool.request().query(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN completedAt IS NOT NULL THEN 1 ELSE 0 END) AS totalCompleted
    FROM Tasks
  `);
  return {
    buckets: buckets.recordset,
    total: totals.recordset[0]?.total ?? 0,
    totalCompleted: totals.recordset[0]?.totalCompleted ?? 0,
  };
}

module.exports = {
  getAllTasks,
  getTaskById,
  createTask,
  updateTask,
  deleteTask,
  getTasksByEdict,
  getCompletionTrends,
};
