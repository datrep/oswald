const { getPool } = require('../config/db');
const sql = require('mssql');

async function getAllTasks({ limit, offset } = {}) {
  const pool = await getPool();
  const req = pool.request();
  let query = `SELECT * FROM Tasks ORDER BY createdAt DESC`;
  if (Number.isInteger(limit) && limit > 0) {
    req.input('limit', sql.Int, limit);
    req.input('offset', sql.Int, offset || 0);
    query += ` OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
  }
  const result = await req.query(query);
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
  // New tasks go to the end of the manual order (drag-to-reorder, task #26).
  const orderResult = await pool
    .request()
    .input('edictId', sql.Int, edictId)
    .query(`SELECT ISNULL(MAX(sortOrder), -1) + 1 AS nextOrder FROM Tasks WHERE edictId = @edictId`);
  const nextOrder = orderResult.recordset[0]?.nextOrder ?? 0;

  await pool
    .request()
    .input('name', sql.NVarChar, name)
    .input('plannedStart', sql.DateTime, plannedStart)
    .input('plannedEnd', sql.DateTime, plannedEnd)
    .input('info', sql.NVarChar, info)
    .input('priority', sql.Int, priority)
    .input('state', sql.Int, state)
    .input('assignedToUserId', sql.Int, assignedToUserId)
    .input('edictId', sql.Int, edictId)
    .input('sortOrder', sql.Int, nextOrder).query(`
            INSERT INTO Tasks
            (name, plannedStart, plannedEnd, info, priority, state, assignedToUserId, edictId, completedAt, sortOrder)
            VALUES
            (@name, @plannedStart, @plannedEnd, @info, @priority, @state, @assignedToUserId, @edictId,
             CASE WHEN @state = 3 THEN GETUTCDATE() ELSE NULL END, @sortOrder)
        `);
}

// Update ONLY the fields provided (partial update). `state` also drives
// completedAt (state 3 sets it once; any other state clears it).
const TASK_UPDATABLE = ['name', 'plannedStart', 'plannedEnd', 'info', 'priority', 'state', 'assignedToUserId', 'edictId'];

async function updateTask(id, fields) {
  const pool = await getPool();
  const req = pool.request().input('id', sql.Int, id);
  const sets = [];
  for (const key of TASK_UPDATABLE) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    const val = fields[key];
    if (val === undefined || val === null) {
      sets.push(`${key} = NULL`);
      continue;
    }
    const param = 'p_' + key;
    if (key === 'priority' || key === 'state' || key === 'assignedToUserId' || key === 'edictId') req.input(param, sql.Int, val);
    else if (key === 'plannedStart' || key === 'plannedEnd') req.input(param, sql.DateTime, val);
    else req.input(param, sql.NVarChar, val);
    sets.push(`${key} = @${param}`);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'state')) {
    sets.push(fields.state === 3 ? 'completedAt = COALESCE(completedAt, GETUTCDATE())' : 'completedAt = NULL');
  }
  if (!sets.length) return;
  await req.query(`UPDATE Tasks SET ${sets.join(', ')} WHERE id = @id`);
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
    .query(`SELECT * FROM Tasks WHERE edictId = @edictId ORDER BY sortOrder, plannedStart, id`);
  return result.recordset;
}

// Persist a manual ordering for tasks within an edict (drag-to-reorder, task #26).
// `orderedIds` is the full ordered list of task ids (already filtered to numeric ids).
// The WHERE edictId guard keeps updates scoped to this policy.
async function reorderTasks(edictId, orderedIds) {
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
        .query(`UPDATE Tasks SET sortOrder = @sortOrder WHERE id = @id AND edictId = @edictId`);
    }
    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
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
  reorderTasks,
};
