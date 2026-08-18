const {
  createAuditLog: modelCreateAuditLog,
  getAllAuditLogs: modelGetAllAuditLogs,
  getAuditLogsByEdict: modelGetAuditLogsByEdict,
  getAuditLogsByTask: modelGetAuditLogsByTask,
} = require('../models/auditModel');
const { asyncHandler } = require('../utils/errors');

// POST /api/audit-logs
const createAuditLog = asyncHandler(async (req, res) => {
  const { edictId, taskId, eventType, notes } = req.body;
  await modelCreateAuditLog(edictId, taskId, eventType, notes);
  res.json({ success: true, message: 'Audit log created' });
});

// GET /api/audit-logs
const getAllAuditLogs = asyncHandler(async (req, res) => {
  res.json(await modelGetAllAuditLogs());
});

// GET /api/audit-logs/edict/:id
const getAuditLogsByEdict = asyncHandler(async (req, res) => {
  res.json(await modelGetAuditLogsByEdict(req.params.id));
});

// GET /api/audit-logs/task/:id
const getAuditLogsByTask = asyncHandler(async (req, res) => {
  res.json(await modelGetAuditLogsByTask(req.params.id));
});

module.exports = { createAuditLog, getAllAuditLogs, getAuditLogsByEdict, getAuditLogsByTask };
