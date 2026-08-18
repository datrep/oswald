const {
  getAllEdicts: modelGetAllEdicts,
  getEdictById: modelGetEdictById,
  getTasksByEdict: modelGetTasksByEdict,
  createEdict: modelCreateEdict,
  updateEdict: modelUpdateEdict,
  deleteEdict: modelDeleteEdict,
  getUnfinishedEdicts: modelGetUnfinishedEdicts,
  getCompletionTrends: modelGetCompletionTrends,
} = require('../models/edictModel');

const { NotFoundError } = require('../utils/errors');

// GET all edicts
async function getAllEdicts(req, res, next) {
  try {
    const edicts = await modelGetAllEdicts();
    res.json(edicts);
  } catch (err) {
    next(err);
  }
}

// GET edict by id
async function getEdictById(req, res, next) {
  try {
    const edict = await modelGetEdictById(req.params.id);
    if (!edict) {
      throw new NotFoundError('Edict not found');
    }
    res.json(edict);
  } catch (err) {
    next(err);
  }
}

// GET /api/tasks/edict/:edictId
async function getTasksByEdict(req, res, next) {
  try {
    const { edictId } = req.params;
    const tasks = await modelGetTasksByEdict(edictId);
    res.json(tasks);
  } catch (err) {
    next(err);
  }
}

// CREATE edict
async function createEdict(req, res, next) {
  const { name, plannedStart, plannedEnd, info, priority, state } = req.body;

  try {
    const insertedId = await modelCreateEdict(
      name,
      plannedStart,
      plannedEnd,
      info,
      priority,
      state
    );
    res.json({ success: true, message: 'Edict created successfully', id: insertedId });
  } catch (err) {
    next(err);
  }
}

// UPDATE edict
async function updateEdict(req, res, next) {
  const id = req.params.id;
  const { name, plannedStart, plannedEnd, info, priority, state } = req.body;

  try {
    await modelUpdateEdict(id, name, plannedStart, plannedEnd, info, priority, state);
    res.json({ success: true, message: 'Edict updated successfully' });
  } catch (err) {
    next(err);
  }
}

// DELETE edict
async function deleteEdict(req, res, next) {
  const id = req.params.id;

  try {
    await modelDeleteEdict(id);
    res.json({ success: true, message: 'Edict deleted successfully' });
  } catch (err) {
    next(err);
  }
}

// GET unfinished edicts (policies that have passed their end date but not archived)
async function getUnfinishedEdicts(req, res, next) {
  try {
    const unfinishedEdicts = await modelGetUnfinishedEdicts();
    res.json(unfinishedEdicts);
  } catch (err) {
    next(err);
  }
}

// GET completion trends (monthly completions + totals)
async function getCompletionTrends(req, res, next) {
  try {
    const trends = await modelGetCompletionTrends();
    res.json(trends);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAllEdicts,
  getEdictById,
  getTasksByEdict,
  createEdict,
  updateEdict,
  deleteEdict,
  getUnfinishedEdicts,
  getCompletionTrends,
};
