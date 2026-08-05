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

// GET all tasks
async function getAllTasks(req, res, next) {
  try {
    const tasks = await modelGetAllTasks();
    res.json(tasks);
  } catch (err) {
    next(err);
  }
}

// GET task by id
async function getTaskById(req, res, next) {
  const id = req.params.id;

  try {
    const task = await modelGetTaskById(id);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json(task);
  } catch (err) {
    next(err);
  }
}

// CREATE task
async function createTask(req, res, next) {
  const {
    //NO ACTIVE, IT IS A COMPUTED FIELD BASED ON PLANNED START AND PLANNED END
    name,
    plannedStart,
    plannedEnd,
    info,
    priority,
    state,
    assignedToUserId,
    edictId,
  } = req.body;

  try {
    await modelCreateTask(
      name,
      plannedStart,
      plannedEnd,
      info,
      priority,
      state,
      assignedToUserId,
      edictId
    );
    res.json({ message: 'Task created successfully' });
  } catch (err) {
    next(err);
  }
}

// UPDATE task — partial: only fields present in the body are changed.
async function updateTask(req, res, next) {
  const id = req.params.id;
  const body = req.body || {};

  // Partial update: only fields present in the body are changed.
  // (Active is a computed field from plannedStart/plannedEnd — not updatable.)
  const updatable = ['name', 'plannedStart', 'plannedEnd', 'info', 'priority', 'state', 'assignedToUserId', 'edictId'];
  const fields = {};
  for (const key of updatable) {
    if (Object.prototype.hasOwnProperty.call(body, key)) fields[key] = body[key];
  }

  try {
    await modelUpdateTask(id, fields);
    res.json({ message: 'Task updated successfully' });
  } catch (err) {
    next(err);
  }
}

// DELETE task
async function deleteTask(req, res, next) {
  const id = req.params.id;

  try {
    await modelDeleteTask(id);
    res.json({ message: 'Task deleted successfully' });
  } catch (err) {
    next(err);
  }
}

// REORDER tasks within an edict (drag-to-reorder, task #26)
async function reorderTasks(req, res, next) {
  const { edictId, orderedIds } = req.body || {};
  const edict = Number.parseInt(edictId, 10);
  if (!Number.isFinite(edict)) {
    return res.status(400).json({ error: 'edictId must be a valid id' });
  }
  if (!Array.isArray(orderedIds) || !orderedIds.length) {
    return res.status(400).json({ error: 'orderedIds must be a non-empty array' });
  }
  const ids = orderedIds.map((x) => Number.parseInt(x, 10));
  if (ids.some((x) => !Number.isFinite(x))) {
    return res.status(400).json({ error: 'orderedIds must contain only numeric ids' });
  }

  try {
    await modelReorderTasks(edict, ids);
    res.json({ message: 'Task order updated' });
  } catch (err) {
    next(err);
  }
}

// GET /api/tasks/edict/:edictId
async function getTasksByEdict(req, res, next) {
  try {
    const { edictId } = req.params;
    const parsedEdictId = Number.parseInt(edictId, 10);

    if (!Number.isInteger(parsedEdictId)) {
      return res.status(400).json({ error: 'Invalid edictId. Expected an integer.' });
    }

    const tasks = await modelGetTasksByEdict(parsedEdictId);
    res.json(tasks);
  } catch (err) {
    next(err);
  }
}

// GET /api/tasks/trends
async function getCompletionTrends(req, res, next) {
  try {
    const trends = await modelGetCompletionTrends();
    res.json(trends);
  } catch (err) {
    next(err);
  }
}

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
