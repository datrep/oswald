const sql = require('mssql');
const dbConfig = require('../dbConfig');

let pool;
async function getPool() {
    if (!pool) {
        pool = await sql.connect(dbConfig);
    }
    return pool;
}

// GET all tasks
exports.getAllTasks = async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig);

        const result = await pool.request()
            .query(`SELECT * FROM Tasks ORDER BY createdAt DESC`);

        res.json(result.recordset);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch tasks" });
    }
};


// GET task by id
exports.getTaskById = async (req, res) => {

    const id = req.params.id;

    try {
        const pool = await sql.connect(dbConfig);

        const result = await pool.request()
            .input('id', sql.Int, id)
            .query(`SELECT * FROM Tasks WHERE id = @id`);

        res.json(result.recordset[0]);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch task" });
    }
};


// CREATE task
exports.createTask = async (req, res) => {

    const { //NO ACTIVE, IT IS A COMPUTED FIELD BASED ON PLANNED START AND PLANNED END
        name,
        plannedStart,
        plannedEnd,
        info,
        priority,
        state,
        assignedToUserId,
        edictId
    } = req.body;

    try {

        const pool = await sql.connect(dbConfig);

        await pool.request()
            .input('name', sql.NVarChar, name)
            .input('plannedStart', sql.DateTime, plannedStart)
            .input('plannedEnd', sql.DateTime, plannedEnd)
            .input('info', sql.NVarChar, info)
            .input('priority', sql.Int, priority)
            .input('state', sql.Int, state)
            .input('assignedToUserId', sql.Int, assignedToUserId)
            .input('edictId', sql.Int, edictId)

            .query(`
            INSERT INTO Tasks
            (name, plannedStart, plannedEnd, info, priority, state, assignedToUserId, edictId)
            VALUES
            (@name, @plannedStart, @plannedEnd, @info, @priority, @state, @assignedToUserId, @edictId)
            `)

        res.json({ message: "Task created successfully" });

    } catch (err) {

        console.error(err);
        res.status(500).json({ error: "Failed to create task" });

    }
};


// UPDATE task
exports.updateTask = async (req, res) => {

    const id = req.params.id;

    const { //NO ACTIVE, IT IS A COMPUTED FIELD BASED ON PLANNED START AND PLANNED END
        name,
        plannedStart,
        plannedEnd,
        info,
        priority,
        state,
        assignedToUserId,
        edictId
    } = req.body;

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
            .input('assignedToUserId', sql.Int, assignedToUserId)
            .input('edictId', sql.Int, edictId)

            .query(`
            UPDATE Tasks
            SET
                name = @name,
                plannedStart = @plannedStart,
                plannedEnd = @plannedEnd,
                info = @info,
                priority = @priority,
                state = @state,
                assignedToUserId = @assignedToUserId,
                edictId = @edictId
             WHERE id = @id
            `)      

        res.json({ message: "Task updated successfully" });

    } catch (err) {

        console.error(err);
        res.status(500).json({ error: "Failed to update task" });

    }
};


// DELETE task
exports.deleteTask = async (req, res) => {

    const id = req.params.id;

    try {

        const pool = await sql.connect(dbConfig);

        await pool.request()
            .input('id', sql.Int, id)
            .query(`DELETE FROM Tasks WHERE id = @id`);

        res.json({ message: "Task deleted successfully" });

    } catch (err) {

        console.error(err);
        res.status(500).json({ error: "Failed to delete task" });

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