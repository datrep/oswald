//AUDIT IS NOT WORKING, TODO:// 

// app.js wasnt supposed to be called to set up routes, routes have been ported to /routes
//find out why thats the case

// interactable with the database 
const express = require("express");
const sql = require("mssql");
const dotenv = require("dotenv");
const tagRoutes = require('./routes/tagRoutes');
const userRoutes = require("./routes/userRoutes");
const dbRoutes = require('./routes/dbRoutes');
const edictRoutes = require('./routes/edictRoutes');
const taskRoutes = require('./routes/taskRoutes');
const auditRoutes = require('./routes/audit');
const resourceRoutes = require('./routes/resourceRoutes');


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

// endpoint will be /api/db/tables
app.use('/api/db', dbRoutes);

// endpoint will be /api/edicts
app.use('/api/edicts', edictRoutes);

// endpoint will be /api/tasks
app.use('/api/tasks', taskRoutes);

app.use('/api/resources', resourceRoutes);


app.use('/api/audit', auditRoutes);

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