// controllers/policyModuleController.js
// Policy module-attachment framework (PREREQ): read / attach / detach modules
// on a policy. Read is public (policy pages are public); attach/detach require
// policies.manage (mutating a policy's structure).

const model = require('../models/policyModuleModel');

// GET /api/edicts/:id/modules — list modules attached to a policy.
async function getModules(req, res, next) {
  try {
    const edictId = Number(req.params.id);
    if (!Number.isInteger(edictId)) return res.status(400).json({ error: 'Invalid policy id' });
    const modules = await model.getModulesByEdict(edictId);
    res.json(modules);
  } catch (err) {
    next(err);
  }
}

// POST /api/edicts/:id/modules { moduleType } — attach a module (idempotent).
async function attachModule(req, res, next) {
  try {
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
  } catch (err) {
    next(err);
  }
}

// DELETE /api/edicts/:id/modules/:type — detach a module.
async function detachModule(req, res, next) {
  try {
    const edictId = Number(req.params.id);
    const { type } = req.params;
    if (!Number.isInteger(edictId)) return res.status(400).json({ error: 'Invalid policy id' });
    const removed = await model.detachModule(edictId, type);
    if (!removed) return res.status(404).json({ error: 'Module not attached to this policy' });
    const modules = await model.getModulesByEdict(edictId);
    res.json({ success: true, modules });
  } catch (err) {
    next(err);
  }
}

module.exports = { getModules, attachModule, detachModule };
