const multer = require("multer");
const path = require("path");

// Middleware to handle file uploads using multer
// Define storage configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "public/images"); // Store files in public/images
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + path.extname(file.originalname);
    cb(null, uniqueSuffix); // e.g., 1754096228261.png
  },
});

// File filter to only allow image types
const fileFilter = function (req, file, cb) {
  const allowedTypes = /jpeg|jpg|png|gif/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed (jpeg, jpg, png, gif)"));
  }
};

// Export the multer middleware
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max, change this as needed
  fileFilter: fileFilter,
});

module.exports = upload;
// This code sets up multer to handle file uploads, specifically for images.
// It configures the storage location, file naming convention, and file type validation.
