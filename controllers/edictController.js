const { getAllEdicts: modelGetAllEdicts, getEdictById: modelGetEdictById, getTasksByEdict: modelGetTasksByEdict, createEdict: modelCreateEdict, updateEdict: modelUpdateEdict, deleteEdict: modelDeleteEdict } = require('../models/edictModel');


// GET all edicts
async function getAllEdicts (req, res) {
    try {
        const edicts = await modelGetAllEdicts();
        res.json(edicts);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch edicts" });
    }
};


// GET edict by id
async function getEdictById(req, res) {
    const id = req.params.id;

    try {
        const edict = await modelGetEdictById(id);
        res.json(edict);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch edict" });
    }
};

// GET /api/tasks/edict/:edictId
async function getTasksByEdict(req, res) {
    try {
        const { edictId } = req.params;
        const tasks = await modelGetTasksByEdict(edictId);
        res.json(tasks);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch tasks', details: err.message });
    }
};


// CREATE edict
async function createEdict(req, res) {
    const { name, plannedStart, plannedEnd, info, priority, state } = req.body;

    try {
        await modelCreateEdict(name, plannedStart, plannedEnd, info, priority, state);
        res.json({ message: "Edict created successfully" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create edict" });
    }
};


// UPDATE edict
async function updateEdict(req, res)  {
    const id = req.params.id;
    const { name, plannedStart, plannedEnd, info, priority, state } = req.body;

    try {
        await modelUpdateEdict(id, name, plannedStart, plannedEnd, info, priority, state);
        res.json({ message: "Edict updated successfully" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to update edict" });
    }
};


// DELETE edict
async function  deleteEdict (req, res) {
    const id = req.params.id;

    try {
        await modelDeleteEdict(id);
        res.json({ message: "Edict deleted successfully" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete edict" });
    }
};

module.exports = {
    getAllEdicts,
    getEdictById,
    getTasksByEdict,
    createEdict,
    updateEdict,
    deleteEdict
};

