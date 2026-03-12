const sql = require('mssql');
const dbConfig = require('../dbConfig');


// GET all edicts
exports.getAllEdicts = async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig);

        const result = await pool.request()
            .query(`SELECT * FROM Edicts ORDER BY createdAt DESC`);

        res.json(result.recordset);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch edicts" });
    }
};


// GET edict by id
exports.getEdictById = async (req, res) => {
    const id = req.params.id;

    try {
        const pool = await sql.connect(dbConfig);

        const result = await pool.request()
            .input('id', sql.Int, id)
            .query(`SELECT * FROM Edicts WHERE id = @id`);

        res.json(result.recordset[0]);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch edict" });
    }
};

// GET /api/tasks/edict/:edictId
exports.getTasksByEdict = async (req, res) => {
    try {
        const { edictId } = req.params;
        const pool = await getPool();

        const result = await pool.request()
            .input('edictId', sql.Int, edictId)
            .query(`SELECT * FROM Tasks WHERE edictId = @edictId ORDER BY plannedStart`);

        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch tasks', details: err.message });
    }
};


// CREATE edict
exports.createEdict = async (req, res) => {

    const { name, plannedStart, plannedEnd, info, priority, state } = req.body;

    try {
        const pool = await sql.connect(dbConfig);

        await pool.request()
            .input('name', sql.NVarChar, name)
            .input('plannedStart', sql.DateTime, plannedStart)
            .input('plannedEnd', sql.DateTime, plannedEnd)
            .input('info', sql.NVarChar, info)
            .input('priority', sql.Int, priority)
            .input('state', sql.Int, state)
            .query(`
                INSERT INTO Edicts
                (name, plannedStart, plannedEnd, info, priority, state)
                VALUES
                (@name, @plannedStart, @plannedEnd, @info, @priority, @state)
            `);

        res.json({ message: "Edict created successfully" });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create edict" });
    }
};


// UPDATE edict
exports.updateEdict = async (req, res) => {

    const id = req.params.id;
    const { name, plannedStart, plannedEnd, info, priority, state } = req.body;

    try {
        const pool = await sql.connect(dbConfig);

        await pool.request()
            .input('id', sql.Int, id)
            .input('name', sql.NVarChar, name)
            .input('plannedStart', sql.DateTime, plannedStart)
            .input('plannedEnd', sql.DateTime, plannedEnd)
            .input('info', sql.NVarChar, info)
            .input('priority', sql.Int, priority)
            .input('state', sql.Int, state)
            .query(`
                UPDATE Edicts
                SET
                    name = @name,
                    plannedStart = @plannedStart,
                    plannedEnd = @plannedEnd,
                    info = @info,
                    priority = @priority,
                    state = @state
                WHERE id = @id
            `);

        res.json({ message: "Edict updated successfully" });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to update edict" });
    }
};


// DELETE edict
exports.deleteEdict = async (req, res) => {

    const id = req.params.id;

    try {

        const pool = await sql.connect(dbConfig);

        // delete resources first
        await pool.request()
            .input('id', sql.Int, id)
            .query(`DELETE FROM EdictResources WHERE edictId = @id`);

        // delete edict
        await pool.request()
            .input('id', sql.Int, id)
            .query(`DELETE FROM Edicts WHERE id = @id`);

        res.json({ message: "Edict deleted successfully" });

    } catch (err) {

        console.error(err);
        res.status(500).json({ error: "Failed to delete edict" });

    }
};

