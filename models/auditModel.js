// models/auditModel.js
const { Repository } = require('../shared/repository');
const { sql } = require('../shared/db');

const repo = new Repository('AuditLogs');

async function createAuditLog(edictId, taskId, eventType, notes) {
  await repo.query(
    `INSERT INTO AuditLogs (edictId, taskId, eventType, notes)
     VALUES (@edictId, @taskId, @eventType, @notes)`,
    (req) => req
      .input('edictId', sql.Int, edictId || null)
      .input('taskId', sql.Int, taskId || null)
      .input('eventType', sql.NVarChar, eventType)
      .input('notes', sql.NVarChar, notes || null)
  );
}

async function getAllAuditLogs() {
  return repo.all({ order: 'createdAt DESC' });
}

async function getAuditLogsByEdict(edictId) {
  return repo.all({
    where: 'edictId = @id',
    order: 'createdAt DESC',
    bind: (req) => req.input('id', sql.Int, edictId),
  });
}

async function getAuditLogsByTask(taskId) {
  return repo.all({
    where: 'taskId = @id',
    order: 'createdAt DESC',
    bind: (req) => req.input('id', sql.Int, taskId),
  });
}

module.exports = {
  createAuditLog,
  getAllAuditLogs,
  getAuditLogsByEdict,
  getAuditLogsByTask,
};
