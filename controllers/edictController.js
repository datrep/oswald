const { getAllEdicts: modelGetAllEdicts, getEdictById: modelGetEdictById, getTasksByEdict: modelGetTasksByEdict, createEdict: modelCreateEdict, updateEdict: modelUpdateEdict, deleteEdict: modelDeleteEdict, getUnfinishedEdicts: modelGetUnfinishedEdicts } = require('../models/edictModel');


// GET all edicts
async function getAllEdicts (req, res) {
    console.log("[API] GET /api/edicts triggered");
    try {
        const edicts = await modelGetAllEdicts();
        console.log(`Retrieved ${edicts.length} edicts`);
        res.json(edicts);
    } catch (err) {
        console.error("[API] GET /api/edicts failed", err);
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
        const insertedId = await modelCreateEdict(name, plannedStart, plannedEnd, info, priority, state);
        res.json({ message: "Edict created successfully", id: insertedId });
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

// GET unfinished edicts (policies that have passed their end date but not archived)
async function getUnfinishedEdicts(req, res) {
    console.log("[API] GET /api/edicts/unfinished triggered");
    try {
        const unfinishedEdicts = await modelGetUnfinishedEdicts();
        console.log(`Retrieved ${unfinishedEdicts.length} unfinished edicts`);
        res.json(unfinishedEdicts);
    } catch (err) {
        console.error("[API] GET /api/edicts/unfinished failed", err);
        res.status(500).json({ error: "Failed to fetch unfinished edicts" });
    }
};

module.exports = {
    getAllEdicts,
    getEdictById,
    getTasksByEdict,
    createEdict,
    updateEdict,
    deleteEdict,
    getUnfinishedEdicts
};

// GET /api/edicts
// GET /api/edicts/:id
// GET /api/tasks/edict/:edictId
// POST /api/edicts
// PUT /api/edicts/:id
// DELETE /api/edicts/:id
