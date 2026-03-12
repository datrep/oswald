const sql = require('mssql');
const dbConfig = require('../dbConfig');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Create a reusable connection pool
let pool;
async function getPool() {
    if (!pool) {
        pool = await sql.connect(dbConfig);
    }
    return pool;
}

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
exports.createResource = async (req, res) => {
    try {
        const pool = await getPool(); // <-- make sure pool is defined here
        const { edictId, description } = req.body;
        const filePath = req.file.path; // from multer

        const result = await pool.request()
            .input('edictId', sql.Int, edictId)
            .input('resourcePath', sql.NVarChar, filePath)
            .input('description', sql.NVarChar, description)
            .query(`
                INSERT INTO EdictResources (edictId, resourcePath, description)
                VALUES (@edictId, @resourcePath, @description);
            `);

        res.json({ success: true, message: 'Resource created' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create resource', details: err.message });
    }
};

// GET /api/resources/:edictId
exports.getResourcesByEdict = async (req, res) => {
    try {
        const { edictId } = req.params;
        const pool = await getPool();

        const result = await pool.request()
            .input('edictId', sql.Int, edictId)
            .query(`
                SELECT id, edictId, resourcePath, description
                FROM EdictResources
                WHERE edictId = @edictId
            `);

        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ 
            error: 'Failed to fetch resources', 
            details: err.message 
        });
    }
};


// DELETE /api/resources/:id
exports.deleteResourceById = async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await sql.connect(dbConfig);

        // Get file path from DB
        const resource = await pool.request()
            .input('id', sql.Int, id)
            .query(`SELECT resourcePath FROM EdictResources WHERE id = @id`);

        if (!resource.recordset[0]) {
            return res.status(404).json({ error: 'Resource not found' });
        }

        const resourcePath = path.join(__dirname, '../', resource.recordset[0].resourcePath);

        // Delete file from disk
        if (fs.existsSync(resourcePath)) fs.unlinkSync(resourcePath);

        // Delete DB record
        await pool.request()
            .input('id', sql.Int, id)
            .query(`DELETE FROM EdictResources WHERE id = @id`);

        res.json({ message: 'Resource deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete resource', details: err.message });
    }
};

// GET /api/resources/edict/:edictId
exports.getResourcesByEdict = async (req, res) => {
    try {
        const { edictId } = req.params;
        const pool = await getPool();

        const result = await pool.request()
            .input('edictId', sql.Int, edictId)
            .query(`SELECT * FROM EdictResources WHERE edictId = @edictId ORDER BY id`);

        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch resources', details: err.message });
    }
};
