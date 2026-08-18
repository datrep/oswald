// models/taskModel.js — Tasks data access via the shared Repository (#ref).
// Reference implementation: custom SQL stays here; the getPool/request/input/
// query boilerplate lives in shared/repository.js.
const { Repository } = require('../shared/repository');
const { sql } = require('../shared/db');

const repo = new Repository('Tasks');

async function getAllTasks({ limit, offset } = {}) {
  return repo.all({ order: 'createdAt DESC', limit, offset });
}

async function getTaskById(id) {
  return repo.byId(id);
}

async function createTask(name, plannedStart, plannedEnd, info, priority, state, assignedToUserId, edictId) {
  // New tasks go to the end of the manual order (drag-to-reorder, task #26).
  const row = await repo.one(
    `SELECT ISNULL(MAX(sortOrder), -1) + 1 AS nextOrder FROM Tasks WHERE edictId = @edictId`,
    (req) => req.input('edictId', sql.Int, edictId)
  );
  const nextOrder = row?.nextOrder ?? 0;

  await repo.query(
    `INSERT INTO Tasks
       (name, plannedStart, plannedEnd, info, priority, state, assignedToUserId, edictId, completedAt, sortOrder)
     VALUES
       (@name, @plannedStart, @plannedEnd, @info, @priority, @state, @assignedToUserId, @edictId,
        CASE WHEN @state = 3 THEN GETUTCDATE() ELSE NULL END, @sortOrder)`,
    (req) => req
      .input('name', sql.NVarChar, name)
      .input('plannedStart', sql.DateTime, plannedStart)
      .input('plannedEnd', sql.DateTime, plannedEnd)
      .input('info', sql.NVarChar, info)
      .input('priority', sql.Int, priority)
      .input('state', sql.Int, state)
      .input('assignedToUserId', sql.Int, assignedToUserId)
      .input('edictId', sql.Int, edictId)
      .input('sortOrder', sql.Int, nextOrder)
  );
}

// Update ONLY the fields provided (partial update). `state` also drives
// completedAt (state 3 sets it once; any other state clears it).
const TASK_UPDATABLE = ['name', 'plannedStart', 'plannedEnd', 'info', 'priority', 'state', 'assignedToUserId', 'edictId'];

function taskType(key) {
  if (key === 'priority' || key === 'state' || key === 'assignedToUserId' || key === 'edictId') return sql.Int;
  if (key === 'plannedStart' || key === 'plannedEnd') return sql.DateTime;
  return sql.NVarChar;
}

async function updateTask(id, fields) {
  const sets = [];
  const present = [];
  for (const key of TASK_UPDATABLE) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    const val = fields[key];
    if (val === undefined || val === null) {
      sets.push(`${key} = NULL`);
      continue;
    }
    present.push(key);
    sets.push(`${key} = @p_${key}`);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'state')) {
    sets.push(fields.state === 3 ? 'completedAt = COALESCE(completedAt, GETUTCDATE())' : 'completedAt = NULL');
  }
  if (!sets.length) return;

  await repo.query(`UPDATE Tasks SET ${sets.join(', ')} WHERE id = @id`, (req) => {
    req.input('id', sql.Int, id);
    for (const key of present) req.input(`p_${key}`, taskType(key), fields[key]);
  });
}

async function deleteTask(id) {
  await repo.remove(id);
}

async function getTasksByEdict(edictId) {
  return repo.all({
    where: 'edictId = @edictId',
    order: 'sortOrder, plannedStart, id',
    bind: (req) => req.input('edictId', sql.Int, edictId),
  });
}

// Persist a manual ordering for tasks within an edict (drag-to-reorder, task #26).
// The WHERE edictId guard keeps updates scoped to this policy.
async function reorderTasks(edictId, orderedIds) {
  await repo.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .request()
        .input('id', sql.Int, orderedIds[i])
        .input('sortOrder', sql.Int, i)
        .input('edictId', sql.Int, edictId)
        .query(`UPDATE Tasks SET sortOrder = @sortOrder WHERE id = @id AND edictId = @edictId`);
    }
  });
}

// Completions grouped by month (for trends), plus overall totals.
async function getCompletionTrends() {
  const buckets = await repo.query(`
    SELECT CONVERT(varchar(7), completedAt, 120) AS month, COUNT(*) AS completed
    FROM Tasks
    WHERE completedAt IS NOT NULL
    GROUP BY CONVERT(varchar(7), completedAt, 120)
    ORDER BY month
  `);
  const totals = await repo.query(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN completedAt IS NOT NULL THEN 1 ELSE 0 END) AS totalCompleted
    FROM Tasks
  `);
  return {
    buckets,
    total: totals[0]?.total ?? 0,
    totalCompleted: totals[0]?.totalCompleted ?? 0,
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
