const express = require('express');
const router = express.Router();
const authenticateToken = require('../middlewares/auth');
const applicationController = require('../controllers/jobApplicationController');

// Job Applications (MOD-1) — personal, owner-scoped. Any authenticated user
// manages their OWN applications.
router.get('/', authenticateToken, applicationController.list);
router.get('/stats', authenticateToken, applicationController.stats);
// literal segment BEFORE /:id so it isn't swallowed by the id param
router.get('/follow-ups', authenticateToken, applicationController.followUps);
router.get('/:id', authenticateToken, applicationController.getOne);
router.post('/', authenticateToken, applicationController.create);
router.put('/:id', authenticateToken, applicationController.update);
router.delete('/:id', authenticateToken, applicationController.remove);

module.exports = router;
