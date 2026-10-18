// controllers/policyModuleController.js
// Policy module-attachment framework (PREREQ): read / attach / detach modules
// on a policy. Read is public (policy pages are public); attach/detach require
// policies.manage (mutating a policy's structure).

const model = require('../models/policyModuleModel');
const { NotFoundError, asyncHandler } = require('../utils/errors');

// GET /api/edicts/:id/modules — list modules attached to a policy.
const getModules = asyncHandler(async (req, res) => {
  const edictId = Number(req.params.id);
  if (!Number.isInteger(edictId)) return res.status(400).json({ error: 'Invalid policy id' });
  res.json(await model.getModulesByEdict(edictId));
});

// POST /api/edicts/:id/modules { moduleType } — attach a module (idempotent).
const attachModule = asyncHandler(async (req, res) => {
  const edictId = Number(req.params.id);
  const { moduleType } = req.body || {};
  if (!Number.isInteger(edictId)) return res.status(400).json({ error: 'Invalid policy id' });
  if (!model.MODULE_TYPES.includes(moduleType)) {
    return res.status(400).json({ error: `Unknown module type. Allowed: ${model.MODULE_TYPES.join(', ')}` });
  }
  const existing = await model.getModulesByEdict(edictId);
  if (existing.some((m) => m.moduleType === moduleType)) {
    return res.json({ success: true, alreadyAttached: true, modules: existing });
  }
  await model.attachModule(edictId, moduleType);
  const modules = await model.getModulesByEdict(edictId);
  res.json({ success: true, modules });
});

// DELETE /api/edicts/:id/modules/:type — detach a module.
const detachModule = asyncHandler(async (req, res) => {
  const edictId = Number(req.params.id);
  const { type } = req.params;
  if (!Number.isInteger(edictId)) return res.status(400).json({ error: 'Invalid policy id' });
  const removed = await model.detachModule(edictId, type);
  if (!removed) throw new NotFoundError('Module not attached to this policy');
  const modules = await model.getModulesByEdict(edictId);
  res.json({ success: true, modules });
});

module.exports = { getModules, attachModule, detachModule };
