// middlewares/imageValidation.js

function validateImageUpload(req, res, next) {
  const { title } = req.body;

  if (!title || typeof title !== "string" || title.trim() === "") {
    return res.status(400).json({ error: "Title is required and must be a non-empty string." });
  }

  if (!req.file) {
    return res.status(400).json({ error: "Image file is required." });
  }

  next(); // proceed to controller
}

module.exports = {
  validateImageUpload,
};

// middlewares/imageValidation.js