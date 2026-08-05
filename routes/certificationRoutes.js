const express = require('express');
const router = express.Router();
const authenticateToken = require('../middlewares/auth');
const certificationController = require('../controllers/certificationController');

// Certifications (Certificate Dashboard) — personal, owner-scoped. Any
// authenticated user manages their OWN certifications.
router.get('/', authenticateToken, certificationController.list);
router.get('/stats', authenticateToken, certificationController.stats);
// literal segments BEFORE /:id so they aren't swallowed by the id param
router.get('/expiries', authenticateToken, certificationController.expiries);
router.get('/:id', authenticateToken, certificationController.getOne);
router.post('/', authenticateToken, certificationController.create);
router.put('/:id', authenticateToken, certificationController.update);
router.delete('/:id', authenticateToken, certificationController.remove);

module.exports = router;
