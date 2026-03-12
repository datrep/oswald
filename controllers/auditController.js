const sql = require('mssql');
const dbConfig = require('../dbConfig');

// Reusable pool
let pool;
async function getPool() {
    if (!pool) {
        pool = await sql.connect(dbConfig);
    }
    return pool;
}

// POST /api/audit
exports.createAuditLog = async (req, res) => {
    try {
        const pool = await getPool();
        const { edictId, taskId, eventType, notes } = req.body;

        await pool.request()
            .input('edictId', sql.Int, edictId || null)
            .input('taskId', sql.Int, taskId || null)
            .input('eventType', sql.NVarChar, eventType)
            .input('notes', sql.NVarChar, notes || null)
            .query(`
                INSERT INTO AuditLogs (edictId, taskId, eventType, notes)
                VALUES (@edictId, @taskId, @eventType, @notes);
            `);

        res.json({ success: true, message: 'Audit log created' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create audit log', details: err.message });
    }
};

// GET /api/audit
exports.getAllAuditLogs = async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .query(`SELECT * FROM AuditLogs ORDER BY createdAt DESC`);

        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch audit logs', details: err.message });
    }
};

// GET /api/audit/edict/:id
exports.getAuditLogsByEdict = async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await getPool();
        const result = await pool.request()
            .input('id', sql.Int, id)
            .query(`SELECT * FROM AuditLogs WHERE edictId = @id ORDER BY createdAt DESC`);

        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch audit logs for edict', details: err.message });
    }
};

// GET /api/audit/task/:id
exports.getAuditLogsByTask = async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await getPool();
        const result = await pool.request()
            .input('id', sql.Int, id)
            .query(`SELECT * FROM AuditLogs WHERE taskId = @id ORDER BY createdAt DESC`);

        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch audit logs for task', details: err.message });
    }
};