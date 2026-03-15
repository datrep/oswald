const sql = require("mssql");
const dbConfig = require("../utils/dbConfig");
const imageModel = require("../models/imageModel");
const fs = require("fs");
const path = require("path");

// GET /images
async function getImages(req, res) {
  try {
    console.log("[ImageController] GET /images");
    const images = await imageModel.getAllImages();
    res.json(images);
  } catch (err) {
    console.error("[ImageController][getImages] SQL Error:", err);
    res.status(500).json({ error: err.message });
  }
}

// POST /images
async function createImage(req, res) {
  try {
    const title = req.body.title;
    const filename = req.file.filename; // filename only
    const filepath = `images/${filename}`; // relative path inside public/images

    console.log("[ImageController] POST /images - creating image:", { title, filename, filepath });
    const newImage = await imageModel.createImage(title, filepath, filename);

    res.status(201).json({ message: "Image uploaded successfully", image: newImage });
  } catch (err) {
    console.error("[ImageController][createImage] Error uploading image:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
}

// GET /images/:id
async function getImageById(req, res) {
  const id = parseInt(req.params.id);
  console.log(`[ImageController] GET /images/${id}`);
  try {
    const image = await imageModel.getImageById(id);
    if (!image) {
      console.log(`[ImageController] Image ID ${id} not found`);
      return res.status(404).json({ message: "Image not found" });
    }
    res.json(image);
  } catch (err) {
    console.error(`[ImageController][getImageById] SQL Error for ID ${id}:`, err);
    res.status(500).json({ error: err.message });
  }
}

// PUT /images/:id
async function updateImage(req, res) {
  const { id } = req.params;
  const { title } = req.body; // only updating title

  console.log(`[ImageController] PUT /images/${id} - update title to: ${title}`);
  try {
    const updatedImage = await imageModel.updateImage(id, { title });
    if (!updatedImage) {
      return res.status(404).json({ message: "Image not found" });
    }
    res.json(updatedImage);
  } catch (err) {
    console.error(`[ImageController][updateImage] SQL Error for ID ${id}:`, err);
    res.status(500).json({ error: err.message });
  }
}

// DELETE /images/:id
async function deleteImage(req, res) {
  const id = parseInt(req.params.id);
  console.log(`[ImageController] DELETE /images/${id}`);

  try {
    const deleted = await imageModel.deleteImage(id);
    if (!deleted) {
      console.log(`[ImageController] Image ID ${id} not found for deletion`);
      return res.status(404).json({ message: "Image not found" });
    }

    // Optional: delete image file from disk here if you want

    res.json({ message: "Image deleted successfully." });
  } catch (err) {
    console.error(`[ImageController][deleteImage] SQL Error for ID ${id}:`, err);
    res.status(500).json({ error: "Failed to delete image." });
  }
}

module.exports = {
  getImages,
  createImage,
  updateImage,
  getImageById,
  deleteImage,
};
