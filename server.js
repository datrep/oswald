// server.js
// PURPOSE IS ENTRY POINT
// only server boot and endpoint mounting

// dependencies
const express = require("express");
const sql = require("mssql");
const dotenv = require("dotenv");

//utils 
// use morgan? cors?
const logger = require("./utils/logger"); // simple request logging middleware

// pre-forked routes
const dbRoutes = require('./routes/dbRoutes');

// OSWALD specific routes
const edictRoutes = require('./routes/edictRoutes');
const taskRoutes = require('./routes/taskRoutes');
const auditRoutes = require('./routes/audit');
const resourceRoutes = require('./routes/resourceRoutes'); // this is OSWALD file upload routes. not imageRoutes

// unused routes, likely used in future
//const imageRoutes = require("./routes/imageRoutes");
//const tagRoutes = require('./routes/tagRoutes');
//const userRoutes = require("./routes/userRoutes");


// Load environment variables from .env file
dotenv.config(); //init, look dbConfig.js

// Initialize database pool and start server
const { getPool } = require('./config/db');
(async () => {
  try {
    await getPool();
    console.log("Database pool initialized successfully");

    const app = express();
    const port = process.env.PORT || 3000; // check 3000 if startup fails, should be default in .env

    app.use(logger); // simple request logging middleware
      

    // Middleware
    app.use(express.json());
    app.use(express.static("public")); // CSS, JS, images, HTML
    app.use(express.static("public/pages")); // static chunks of the newer page layouts

    // Prevent browsers/clients from caching API responses so refreshed data always reflects the database.
    app.use('/api', (req, res, next) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      next();
    });

    // pre-forked routes
    app.use('/api/db', dbRoutes);

    // OSWALD specific routes
    app.use('/api/edicts', edictRoutes);
    app.use('/api/tasks', taskRoutes);
    app.use('/api/resources', resourceRoutes);
    app.use('/api/audit', auditRoutes);

    // unused routes, likely used in future
    //app.use("/images", imageRoutes);
    //app.use("/api/users", userRoutes);
    //app.use('/tags', tagRoutes);



    // Start server
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });

  } catch (err) {
    console.error("Failed to initialize database pool:", err);
    process.exit(1); // Exit if DB fails
  }
})();

// was wrong implmentation, not logger.logall(app)


// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Server is gracefully shutting down");
  await sql.close();
  console.log("Database connections closed");
  process.exit(0);
});

