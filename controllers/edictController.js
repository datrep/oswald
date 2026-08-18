const {
  getAllEdicts: modelGetAllEdicts,
  getEdictById: modelGetEdictById,
  createEdict: modelCreateEdict,
  updateEdict: modelUpdateEdict,
  deleteEdict: modelDeleteEdict,
  getUnfinishedEdicts: modelGetUnfinishedEdicts,
  getCompletionTrends: modelGetCompletionTrends,
} = require('../models/edictModel');

const { NotFoundError, asyncHandler } = require('../utils/errors');
const { parsePagination } = require('../shared/pagination');

// GET all edicts
const getAllEdicts = asyncHandler(async (req, res) => {
  res.json(await modelGetAllEdicts(parsePagination(req.query)));
});

// GET edict by id
const getEdictById = asyncHandler(async (req, res) => {
  const edict = await modelGetEdictById(req.params.id);
  if (!edict) throw new NotFoundError('Edict not found');
  res.json(edict);
});

// CREATE edict
const createEdict = asyncHandler(async (req, res) => {
  const { name, plannedStart, plannedEnd, info, priority, state } = req.body;
  const insertedId = await modelCreateEdict(name, plannedStart, plannedEnd, info, priority, state);
  res.json({ success: true, message: 'Edict created successfully', id: insertedId });
});

// UPDATE edict
const updateEdict = asyncHandler(async (req, res) => {
  const { name, plannedStart, plannedEnd, info, priority, state } = req.body;
  await modelUpdateEdict(req.params.id, name, plannedStart, plannedEnd, info, priority, state);
  res.json({ success: true, message: 'Edict updated successfully' });
});

// DELETE edict
const deleteEdict = asyncHandler(async (req, res) => {
  await modelDeleteEdict(req.params.id);
  res.json({ success: true, message: 'Edict deleted successfully' });
});

// GET unfinished edicts (policies that have passed their end date but not archived)
const getUnfinishedEdicts = asyncHandler(async (req, res) => {
  res.json(await modelGetUnfinishedEdicts());
});

// GET completion trends (monthly completions + totals)
const getCompletionTrends = asyncHandler(async (req, res) => {
  res.json(await modelGetCompletionTrends());
});

module.exports = {
  getAllEdicts,
  getEdictById,
  createEdict,
  updateEdict,
  deleteEdict,
  getUnfinishedEdicts,
  getCompletionTrends,
};
