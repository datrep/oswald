const express = require('express');
const router = express.Router();
const dbController = require('../controllers/dbController');

// List all tables
router.get('/tables', dbController.getTables);

// Get all rows from a specific table
router.get('/:tableName', dbController.getTableRows);

module.exports = router;