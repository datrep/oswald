const express = require('express');
const router = express.Router();
const auditController = require('../controllers/auditController');

router.post('/', auditController.createAuditLog);
router.get('/', auditController.getAllAuditLogs);
router.get('/edict/:id', auditController.getAuditLogsByEdict);
router.get('/task/:id', auditController.getAuditLogsByTask);

module.exports = router;