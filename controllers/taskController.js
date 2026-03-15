const { getAllTasks: modelGetAllTasks, getTaskById: modelGetTaskById, createTask: modelCreateTask, updateTask: modelUpdateTask, deleteTask: modelDeleteTask, getTasksByEdict: modelGetTasksByEdict } = require('../models/taskModel');

// GET all tasks
async function getAllTasks(req, res) {
    try {
        const tasks = await modelGetAllTasks();
        res.json(tasks);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch tasks" });
    }
};


// GET task by id
async function getTaskById(req, res) {
    const id = req.params.id;

    try {
        const task = await modelGetTaskById(id);
        res.json(task);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch task" });
    }
};


// CREATE task
async function createTask(req, res) {
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
        await modelCreateTask(name, plannedStart, plannedEnd, info, priority, state, assignedToUserId, edictId);
        res.json({ message: "Task created successfully" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create task" });
    }
};


// UPDATE task
async function updateTask(req, res) {
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
        await modelUpdateTask(id, name, plannedStart, plannedEnd, info, priority, state, assignedToUserId, edictId);
        res.json({ message: "Task updated successfully" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to update task" });
    }
};


// DELETE task
async function deleteTask(req, res) {
    const id = req.params.id;

    try {
        await modelDeleteTask(id);
        res.json({ message: "Task deleted successfully" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete task" });
    }
};

// GET /api/tasks/edict/:edictId
async function getTasksByEdict(req, res) {
    try {
        const { edictId } = req.params;
        const parsedEdictId = Number.parseInt(edictId, 10);

        if (!Number.isInteger(parsedEdictId)) {
            return res.status(400).json({ error: 'Invalid edictId. Expected an integer.' });
        }

        const tasks = await modelGetTasksByEdict(parsedEdictId);
        res.json(tasks);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch tasks', details: err.message });
    }
};

module.exports = {
    getAllTasks,
    getTaskById,
    createTask,
    updateTask,
    deleteTask,
    getTasksByEdict
};