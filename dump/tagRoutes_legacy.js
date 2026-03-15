const express = require("express");
const router = express.Router();
const tagController = require("../controllers/tagController");


// GET tags for a specific image
// This route will fetch tags associated with a specific image by its ID
router.get("/:imageId", tagController.getTagsByImageId); 


// Define routes for tags
// GET all tags with their count
// This route will fetch all tags and their associated image counts
router.get("/", tagController.getAllTags);



module.exports = router;
