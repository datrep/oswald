const express = require('express');
const router = express.Router();
const authenticateToken = require('../middlewares/auth');
const careerFileController = require('../controllers/careerFileController');

// Career Files (MOD-1) — personal, owner-scoped documents. Any authenticated
// user manages their OWN files (userId comes from the token).
router.get('/', authenticateToken, careerFileController.list);
router.post('/', authenticateToken, careerFileController.uploadSingle, careerFileController.create);
router.delete('/:id', authenticateToken, careerFileController.remove);

module.exports = router;
