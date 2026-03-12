// app.js wasnt supposed to be called to set up routes, routes have been ported to /routes
//find out why thats the case

// interactable with the database 
const express = require("express");
const sql = require("mssql");
const dotenv = require("dotenv");
const tagRoutes = require('./routes/tagRoutes');
const userRoutes = require("./routes/userRoutes");

const app = express();
const port = process.env.PORT || 3000;

const imageRoutes = require("./routes/imageRoutes");

app.use(express.json());
app.use(express.static("public"));

app.use((req, res, next) => {
  console.log(`[${req.method}] ${req.url}`);
  next();
});
// Mount image routes at /images
app.use("/images", imageRoutes
);
// Mount tag routes at /tags
app.use('/tags', tagRoutes);
app.use("/api/users", userRoutes);

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Server is gracefully shutting down");
  await sql.close();
  console.log("Database connections closed");
  process.exit(0);
});