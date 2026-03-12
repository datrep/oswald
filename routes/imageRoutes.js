const express = require("express");
const router = express.Router();
const imageController = require("../controllers/imageController");
const imageValidation = require("../middlewares/imageValidation");
const imageModel = require("../models/imageModel");
const upload = require("../upload");

// GET all images
router.get("/", imageController.getImages);

// GET image by ID
router.get("/:id", imageController.getImageById);

// POST image (upload)
router.post(
  "/",
  upload.single("image"),
  imageValidation.validateImageUpload,
  async (req, res) => {
    try {
      console.log("📨 Upload request received");
      console.log("Body:", req.body);
      console.log("File:", req.file);

      const { title } = req.body;
      const filename = req.file.filename;
      const filePath = `images/${filename}`; // Relative path for client

      await imageModel.createImage(title, filePath, filename);

      res.status(201).json({
        message: "Image uploaded successfully.",
        image: { title, filename },
      });
    } catch (error) {
      console.error("Error uploading image:", error);
      res.status(500).json({ error: "Image upload failed." });
    }
  }
);

// PUT image (update)
router.put("/:id", imageController.updateImage);

// DELETE image
router.delete("/:id", imageController.deleteImage);

module.exports = router;
