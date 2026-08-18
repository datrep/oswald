const { Repository } = require('../shared/repository');
const { sql } = require('../shared/db');

const repo = new Repository('Edicts');

async function getAllEdicts({ limit, offset } = {}) {
  const paginate = Number.isInteger(limit) && limit > 0;
  let query = `
    SELECT e.*,
      (SELECT STRING_AGG(moduleType, ',') WITHIN GROUP (ORDER BY moduleType) FROM PolicyModules pm WHERE pm.edictId = e.id) AS modules
    FROM Edicts e
    ORDER BY e.createdAt DESC`;
  if (paginate) query += ` OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
  return repo.query(query, (req) => {
    if (paginate) {
      req.input('limit', sql.Int, limit);
      req.input('offset', sql.Int, offset || 0);
    }
  });
}

async function getEdictById(id) {
  return repo.one(`SELECT * FROM Edicts WHERE id = @id`, (req) => req.input('id', sql.Int, id));
}

async function getTasksByEdict(edictId) {
  return repo.query(
    `SELECT * FROM Tasks WHERE edictId = @edictId ORDER BY plannedStart`,
    (req) => req.input('edictId', sql.Int, edictId)
  );
}

async function createEdict(name, plannedStart, plannedEnd, info, priority, state) {
  const rows = await repo.query(
    `INSERT INTO Edicts (name, plannedStart, plannedEnd, info, priority, state, completedAt)
     OUTPUT inserted.id AS id
     VALUES (@name, @plannedStart, @plannedEnd, @info, @priority, @state,
             CASE WHEN @state = 3 THEN GETUTCDATE() ELSE NULL END)`,
    (req) => req
      .input('name', sql.NVarChar, name)
      .input('plannedStart', sql.DateTime, plannedStart)
      .input('plannedEnd', sql.DateTime, plannedEnd)
      .input('info', sql.NVarChar, info)
      .input('priority', sql.Int, priority)
      .input('state', sql.Int, state)
  );
  return rows[0]?.id ?? null;
}

async function updateEdict(id, name, plannedStart, plannedEnd, info, priority, state) {
  return repo.execute(
    `UPDATE Edicts
     SET name = @name, plannedStart = @plannedStart, plannedEnd = @plannedEnd,
         info = @info, priority = @priority, state = @state,
         completedAt = CASE WHEN @state = 3 THEN COALESCE(completedAt, GETUTCDATE()) ELSE NULL END
     WHERE id = @id`,
    (req) => req
      .input('id', sql.Int, id)
      .input('name', sql.NVarChar, name)
      .input('plannedStart', sql.DateTime, plannedStart)
      .input('plannedEnd', sql.DateTime, plannedEnd)
      .input('info', sql.NVarChar, info)
      .input('priority', sql.Int, priority)
      .input('state', sql.Int, state)
  );
}

async function deleteEdict(id) {
  // delete resources first
  await repo.query(`DELETE FROM EdictResources WHERE edictId = @id`, (req) => req.input('id', sql.Int, id));
  await repo.remove(id);
}

async function getUnfinishedEdicts() {
  return repo.all({
    where: 'plannedEnd IS NOT NULL AND GETUTCDATE() > plannedEnd AND state != 3',
    order: 'plannedEnd ASC',
  });
}

// Completions grouped by month (for trends), plus overall totals
async function getCompletionTrends() {
  const buckets = await repo.query(`
    SELECT CONVERT(varchar(7), completedAt, 120) AS month, COUNT(*) AS completed
    FROM Edicts
    WHERE completedAt IS NOT NULL
    GROUP BY CONVERT(varchar(7), completedAt, 120)
    ORDER BY month
  `);
  const totals = await repo.query(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN completedAt IS NOT NULL THEN 1 ELSE 0 END) AS totalCompleted
    FROM Edicts
  `);
  return {
    buckets,
    total: totals[0]?.total ?? 0,
    totalCompleted: totals[0]?.totalCompleted ?? 0,
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
