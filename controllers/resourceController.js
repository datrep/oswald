const { createResource: modelCreateResource, getResourcesByEdict: modelGetResourcesByEdict, getResourcePathById, deleteResourceById: modelDeleteResourceById } = require('../models/resourceModel');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = './uploads'; // make sure this folder exists
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // avoid overwriting by prefixing timestamp
    cb(null, `${Date.now()}_${file.originalname}`);
  }
});

// Optional: only allow certain file types
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|pdf|txt|docx/;
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedTypes.test(ext)) {
    cb(null, true);
  } else {
    cb(new Error('File type not allowed'));
  }
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: fileFilter
}).single('file'); // 'file' is the form field name

// POST /api/resources
async function createResource(req, res) {
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

        const filePath = req.file.path; // from multer

        await modelCreateResource(edictId, description, filePath);
        res.json({ success: true, message: 'Resource created' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create resource', details: err.message });
    }
};

// GET /api/resources/:edictId
async function getResourcesByEdict(req, res) {
    try {
        const { edictId } = req.params;
        const resources = await modelGetResourcesByEdict(edictId);
        res.json(resources);
    } catch (err) {
        console.error(err);
        res.status(500).json({ 
            error: 'Failed to fetch resources', 
            details: err.message 
        });
    }
};


// DELETE /api/resources/:id
async function deleteResourceById(req, res) {
    try {
        const { id } = req.params;

        // Get file path from DB
        const resource = await getResourcePathById(id);
        if (!resource) {
            return res.status(404).json({ error: 'Resource not found' });
        }

        const resourcePath = path.join(__dirname, '../', resource.resourcePath);

        // Delete file from disk
        if (fs.existsSync(resourcePath)) fs.unlinkSync(resourcePath);

        // Delete DB record
        await modelDeleteResourceById(id);

        res.json({ message: 'Resource deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete resource', details: err.message });
    }
};

module.exports = {
    createResource,
    getResourcesByEdict,
    deleteResourceById
};

// POST /api/resources
// GET /api/resources/:edictId
// DELETE /api/resources/:id
