const {
  createResource: modelCreateResource,
  getResourcesByEdict: modelGetResourcesByEdict,
  getResourcePathById,
  deleteResourceById: modelDeleteResourceById,
} = require('../models/resourceModel');
const path = require('path');
const fs = require('fs');

// POST /api/resources
async function createResource(req, res, next) {
  try {
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
  } catch (err) {
    next(err);
  }
}

// GET /api/resources/:edictId
async function getResourcesByEdict(req, res, next) {
  try {
    const { edictId } = req.params;
    const resources = await modelGetResourcesByEdict(edictId);
    res.json(resources);
  } catch (err) {
    next(err);
  }
}

// DELETE /api/resources/:id
async function deleteResourceById(req, res, next) {
  try {
    const { id } = req.params;

    // Get file path from DB
    const resource = await getResourcePathById(id);
    if (!resource) {
      return res.status(404).json({ error: 'Resource not found' });
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

    res.json({ message: 'Resource deleted successfully' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createResource,
  getResourcesByEdict,
  deleteResourceById,
};
