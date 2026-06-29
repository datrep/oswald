const express = require('express');
const router = express.Router();

const edictController = require('../controllers/edictController');
const { validateCreateEdict } = require('../middlewares/edictValidation');

router.get('/', edictController.getAllEdicts);
router.get('/unfinished', edictController.getUnfinishedEdicts);
router.get('/:id', edictController.getEdictById);
router.post('/', validateCreateEdict, edictController.createEdict);
router.put('/:id', edictController.updateEdict);
router.delete('/:id', edictController.deleteEdict);


module.exports = router;