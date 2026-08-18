const {
  createResource: modelCreateResource,
  getResourcesByEdict: modelGetResourcesByEdict,
  getResourcePathById,
  getAllResources: modelGetAllResources,
  attachResource: modelAttachResource,
  deleteResourceById: modelDeleteResourceById,
  updateResource: modelUpdateResource,
  reorderResources: modelReorderResources,
} = require('../models/resourceModel');
const path = require('path');
const fs = require('fs');
const { NotFoundError, asyncHandler } = require('../utils/errors');
const { parsePagination } = require('../shared/pagination');

// POST /api/resources
const createResource = asyncHandler(async (req, res) => {
  const rawEdictId = req.body.edictId ?? req.body.edictID ?? req.body.edictid;
  const numericEdictId = Number(rawEdictId);
  const edictId = Number.isInteger(numericEdictId) ? numericEdictId : null;
  const description = req.body.description ?? '';

  if (edictId === null) {
    return res.status(400).json({ error: 'edictId is required' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Resource file is required' });
  }

  const filePath = path.resolve(req.file.path); // absolute path from multer
  const publicDir = path.resolve(__dirname, '../public');
  let storedPath = filePath;
  const publicDirLower = publicDir.toLowerCase();
  const filePathLower = filePath.toLowerCase();
  if (filePathLower.startsWith(publicDirLower)) {
    storedPath = path.relative(publicDir, filePath);
  }
  storedPath = storedPath.replace(/\\/g, '/');

  await modelCreateResource(edictId, description, storedPath);
  res.json({ success: true, message: 'Resource created' });
});

// GET /api/resources/:edictId
const getResourcesByEdict = asyncHandler(async (req, res) => {
  res.json(await modelGetResourcesByEdict(req.params.edictId));
});

// GET /api/resources — list ALL resources (optionally ?q=), for the attach picker.
const getAllResources = asyncHandler(async (req, res) => {
  const q = req.query.q ? String(req.query.q).trim() : null;
  res.json(await modelGetAllResources(q || null, parsePagination(req.query)));
});

// POST /api/resources/attach — attach an existing resourcePath to a policy.
const attachResource = asyncHandler(async (req, res) => {
  const rawEdictId = req.body.edictId ?? req.body.edictID ?? req.body.edictid;
  const numericEdictId = Number(rawEdictId);
  const edictId = Number.isInteger(numericEdictId) ? numericEdictId : null;
  const resourcePath = String(req.body.resourcePath || '').trim();
  const description = String(req.body.description ?? '').trim();

  if (edictId === null) return res.status(400).json({ error: 'edictId is required' });
  if (!resourcePath) return res.status(400).json({ error: 'resourcePath is required' });

  await modelAttachResource(edictId, description, resourcePath);
  res.json({ success: true, message: 'Resource attached' });
});

// DELETE /api/resources/:id
const deleteResourceById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Get file path from DB
  const resource = await getResourcePathById(id);
  if (!resource) {
    throw new NotFoundError('Resource not found');
  }

  const publicDir = path.resolve(__dirname, '../public');
  const normalizedResourcePath = (resource.resourcePath || '').replace(/\\/g, '/');
  let resourcePath = normalizedResourcePath;

  if (resourcePath.startsWith('public/')) {
    resourcePath = resourcePath.slice('public/'.length);
  }

  if (!path.isAbsolute(resourcePath)) {
    resourcePath = path.join(publicDir, resourcePath);
  }
  resourcePath = path.resolve(resourcePath);

  // Delete file from disk
  if (fs.existsSync(resourcePath)) fs.unlinkSync(resourcePath);

  // Delete DB record
  await modelDeleteResourceById(id);

  res.json({ success: true, message: 'Resource deleted successfully' });
});

// PUT /api/resources/:id — update a resource's description (file untouched).
const updateResource = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const description = String(req.body?.description ?? '').trim();
  await modelUpdateResource(id, description);
  res.json({ success: true, message: 'Resource updated' });
});

// PUT /api/resources/reorder — persist a manual ordering within a policy.
// Payload shape is validated by the shared reorder schema.
const reorderResources = asyncHandler(async (req, res) => {
  await modelReorderResources(req.body.edictId, req.body.orderedIds);
  res.json({ success: true, message: 'Resource order updated' });
});

module.exports = {
  createResource,
  getResourcesByEdict,
  getAllResources,
  attachResource,
  deleteResourceById,
  updateResource,
  reorderResources,
};
