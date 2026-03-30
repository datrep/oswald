// server.js
// PURPOSE IS ENTRY POINT
// only server boot and endpoint mounting

// dependencies
const express = require("express");
const sql = require("mssql");
const dotenv = require("dotenv");

// utils
// use morgan? cors?
const logger = require("./utils/logger"); // simple request logging middleware
const requestLogger = require("./middlewares/requestLogger");

// pre-forked routes
const dbRoutes = require('./routes/dbRoutes');

// OSWALD specific routes
const edictRoutes = require('./routes/edictRoutes');
const taskRoutes = require('./routes/taskRoutes');
const auditRoutes = require('./routes/audit');
const resourceRoutes = require('./routes/resourceRoutes'); // this is OSWALD file upload routes. not imageRoutes

// unused routes, likely used in future
// const imageRoutes = require("./routes/imageRoutes");
// const tagRoutes = require('./routes/tagRoutes');
// const userRoutes = require("./routes/userRoutes");

// Load environment variables from .env file
dotenv.config(); // init, look dbConfig.js

// Import DB pool
const { getPool } = require('./config/db');

// Initialize express app
const app = express();
const port = process.env.PORT || 3000;

// Middleware
// app.use(requestLogger); // verbose request logging middleware
app.use(logger); // simple request logging middleware
app.use(express.json());

// Serve static files
app.use(express.static("public"));        // CSS, JS, images, HTML
app.use(express.static("public/pages"));  // static chunks of the newer page layouts

// Legacy route for frontend data fetch without /api
app.use('/edicts', edictRoutes);

// Prevent browsers/clients from caching API responses
app.use('/api', (req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  next();
});

// Mount routes
// pre-forked routes
app.use('/api/db', dbRoutes);

// OSWALD specific routes
app.use('/api/edicts', edictRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/resources', resourceRoutes);
app.use('/api/audit', auditRoutes);

// Serve uploaded files (e.g., images, documents) from the resources directory
app.use("/resources", express.static("resources"));


// unused routes, likely used in Sfuture
// app.use("/images", imageRoutes);
// app.use("/api/users", userRoutes);
// app.use('/tags', tagRoutes);

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Server is gracefully shutting down");
  try {
    await sql.close();
    console.log("Database connections closed");
  } catch (err) {
    console.error("Error closing DB connections:", err);
  }
  process.exit(0);
});

// Start server after DB pool is ready
async function startServer() {
  try {
    console.log("Creating SQL connection pool...");
    await getPool();
    console.log("Database pool initialized successfully");

    app.listen(port, "10.244.10.3", () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (err) {
    console.error("Failed to initialize database pool:", err);
    process.exit(1); // Exit if DB fails
  }
}

// actually start
startServer();
