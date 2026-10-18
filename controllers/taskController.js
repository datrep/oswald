const {
  getAllTasks: modelGetAllTasks,
  getTaskById: modelGetTaskById,
  createTask: modelCreateTask,
  updateTask: modelUpdateTask,
  deleteTask: modelDeleteTask,
  getTasksByEdict: modelGetTasksByEdict,
  getCompletionTrends: modelGetCompletionTrends,
  reorderTasks: modelReorderTasks,
} = require('../models/taskModel');
const { NotFoundError, asyncHandler } = require('../utils/errors');
const { parsePagination } = require('../shared/pagination');

// GET all tasks
const getAllTasks = asyncHandler(async (req, res) => {
  res.json(await modelGetAllTasks(parsePagination(req.query)));
});

// GET task by id
const getTaskById = asyncHandler(async (req, res) => {
  const task = await modelGetTaskById(req.params.id);
  if (!task) throw new NotFoundError('Task not found');
  res.json(task);
});

// CREATE task
const createTask = asyncHandler(async (req, res) => {
  const { name, plannedStart, plannedEnd, info, priority, state, assignedToUserId, edictId } = req.body;
  await modelCreateTask(name, plannedStart, plannedEnd, info, priority, state, assignedToUserId, edictId);
  res.json({ success: true, message: 'Task created successfully' });
});

// UPDATE task — partial: only fields present in the body are changed.
const updateTask = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const updatable = ['name', 'plannedStart', 'plannedEnd', 'info', 'priority', 'state', 'assignedToUserId', 'edictId'];
  const fields = {};
  for (const key of updatable) {
    if (Object.prototype.hasOwnProperty.call(body, key)) fields[key] = body[key];
  }
  await modelUpdateTask(req.params.id, fields);
  res.json({ success: true, message: 'Task updated successfully' });
});

// DELETE task
const deleteTask = asyncHandler(async (req, res) => {
  await modelDeleteTask(req.params.id);
  res.json({ success: true, message: 'Task deleted successfully' });
});

// REORDER tasks within an edict (drag-to-reorder, task #26). Payload shape is
// validated by the shared reorder schema (middlewares/validators.js).
const reorderTasks = asyncHandler(async (req, res) => {
  await modelReorderTasks(req.body.edictId, req.body.orderedIds);
  res.json({ success: true, message: 'Task order updated' });
});

// GET /api/tasks/edict/:edictId
const getTasksByEdict = asyncHandler(async (req, res) => {
  const edictId = Number.parseInt(req.params.edictId, 10);
  if (!Number.isInteger(edictId)) {
    return res.status(400).json({ error: 'Invalid edictId. Expected an integer.' });
  }
  res.json(await modelGetTasksByEdict(edictId));
});

// GET /api/tasks/trends
const getCompletionTrends = asyncHandler(async (req, res) => {
  res.json(await modelGetCompletionTrends());
});

module.exports = {
  getAllTasks,
  getTaskById,
  createTask,
  updateTask,
  deleteTask,
  getTasksByEdict,
  getCompletionTrends,
  reorderTasks,
};
