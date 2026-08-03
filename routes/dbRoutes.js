const express = require('express');
const router = express.Router();
const dbController = require('../controllers/dbController');
const authenticateToken = require('../middlewares/auth');

// List all tables
router.get('/tables', authenticateToken, dbController.getTables);

// Get all rows from a specific table
router.get('/:tableName', authenticateToken, dbController.getTableRows);

module.exports = router;
