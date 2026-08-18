const {
  createAuditLog: modelCreateAuditLog,
  getAllAuditLogs: modelGetAllAuditLogs,
  getAuditLogsByEdict: modelGetAuditLogsByEdict,
  getAuditLogsByTask: modelGetAuditLogsByTask,
} = require('../models/auditModel');

// POST /api/audit-logs
async function createAuditLog(req, res, next) {
  try {
    const { edictId, taskId, eventType, notes } = req.body;
    await modelCreateAuditLog(edictId, taskId, eventType, notes);
    res.json({ success: true, message: 'Audit log created' });
  } catch (err) {
    next(err);
  }
}

// GET /api/audit-logs
async function getAllAuditLogs(req, res, next) {
  try {
    const auditLogs = await modelGetAllAuditLogs();
    res.json(auditLogs);
  } catch (err) {
    next(err);
  }
}

// GET /api/audit-logs/edict/:id
async function getAuditLogsByEdict(req, res, next) {
  try {
    const { id } = req.params;
    const auditLogs = await modelGetAuditLogsByEdict(id);
    res.json(auditLogs);
  } catch (err) {
    next(err);
  }
}

// GET /api/audit-logs/task/:id
async function getAuditLogsByTask(req, res, next) {
  try {
    const { id } = req.params;
    const auditLogs = await modelGetAuditLogsByTask(id);
    res.json(auditLogs);
  } catch (err) {
    next(err);
  }
}

module.exports = { createAuditLog, getAllAuditLogs, getAuditLogsByEdict, getAuditLogsByTask };
