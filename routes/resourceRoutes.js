const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const resourceController = require('../controllers/resourceController');

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, path.join(__dirname, '..', 'public', 'resources')); 
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

router.post('/', upload.single('file'), resourceController.createResource);
router.delete('/:id', resourceController.deleteResourceById);
router.get('/edict/:edictId', resourceController.getResourcesByEdict);

module.exports = router;    
