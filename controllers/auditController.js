const {
  createAuditLog,
  getAllAuditLogs,
  getAuditLogsByEdict,
  getAuditLogsByTask,
} = require('../models/auditModel');

// POST /api/audit-logs
exports.createAuditLog = async (req, res, next) => {
  try {
    const { edictId, taskId, eventType, notes } = req.body;
    await createAuditLog(edictId, taskId, eventType, notes);
    res.json({ success: true, message: 'Audit log created' });
  } catch (err) {
    next(err);
  }
};

// GET /api/audit-logs
exports.getAllAuditLogs = async (req, res, next) => {
  try {
    const auditLogs = await getAllAuditLogs();
    res.json(auditLogs);
  } catch (err) {
    next(err);
  }
};

// GET /api/audit-logs/edict/:id
exports.getAuditLogsByEdict = async (req, res, next) => {
  try {
    const { id } = req.params;
    const auditLogs = await getAuditLogsByEdict(id);
    res.json(auditLogs);
  } catch (err) {
    next(err);
  }
};

// GET /api/audit-logs/task/:id
exports.getAuditLogsByTask = async (req, res, next) => {
  try {
    const { id } = req.params;
    const auditLogs = await getAuditLogsByTask(id);
    res.json(auditLogs);
  } catch (err) {
    next(err);
  }
};
