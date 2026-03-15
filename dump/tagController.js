const tagModel = require("../models/tagModel");

// GET /tags/:imageId - Tags for specific image
async function getTagsByImageId(req, res) {
  const imageId = parseInt(req.params.imageId);
  console.log(`[TagController] Handling request: GET /tags/${imageId}`);

  if (isNaN(imageId)) {
    console.warn("[TagController] Invalid image ID:", req.params.imageId);
    return res.status(400).json({ error: "Invalid image ID." });
  }

  try {
    const tags = await tagModel.getTagsByImageId(imageId);
    console.log(`[TagController] Fetched ${tags.length} tags for image ID ${imageId}`);
    res.json(tags);
    
  } catch (err) {
    console.error(`[TagController] Error fetching tags for image ID ${imageId}:`, err);
    res.status(500).json({ error: "Failed to fetch image tags." });
  }
}


// GET /tags - All tags with their count
async function getAllTags(req, res) {
  try {
    console.log("[TagController] Handling request: GET /tags");
    const tags = await tagModel.getAllTags();
    console.log("[TagController] Tags fetched successfully");
    res.json(tags);
  } catch (err) {
    console.error("[TagController] Error fetching tags:", err);
    res.status(500).json({ error: "Failed to fetch tags." });
  }
}


module.exports = {
  getAllTags,
  getTagsByImageId,
};
