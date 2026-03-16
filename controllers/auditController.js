const { createAuditLog, getAllAuditLogs, getAuditLogsByEdict, getAuditLogsByTask } = require('../models/auditModel');

// POST /api/audit
exports.createAuditLog = async (req, res) => {
    try {
        const { edictId, taskId, eventType, notes } = req.body;
        await createAuditLog(edictId, taskId, eventType, notes);
        res.json({ success: true, message: 'Audit log created' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create audit log', details: err.message });
    }
};

// GET /api/audit
exports.getAllAuditLogs = async (req, res) => {
    try {
        const auditLogs = await getAllAuditLogs();
        console.log(`Retrieved ${auditLogs.length} audit logs`);
        res.json(auditLogs);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch audit logs', details: err.message });
    }
};

// GET /api/audit/edict/:id
exports.getAuditLogsByEdict = async (req, res) => {
    try {
        const { id } = req.params;
        const auditLogs = await getAuditLogsByEdict(id);
        res.json(auditLogs);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch audit logs for edict', details: err.message });
    }
};

// GET /api/audit/task/:id
exports.getAuditLogsByTask = async (req, res) => {
    try {
        const { id } = req.params;
        const auditLogs = await getAuditLogsByTask(id);
        res.json(auditLogs);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch audit logs for task', details: err.message });
    }
};

// GET /api/audit/task/:id
// GET /api/audit/edict/:id
// GET /api/audit
// POST /api/audit
