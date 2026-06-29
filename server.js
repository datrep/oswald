const express = require("express");
const sql = require("mssql");
const dotenv = require("dotenv");
const cors = require("cors");

const logger = require("./utils/logger");
const requestLogger = require("./middlewares/requestLogger");

const dbRoutes = require('./routes/dbRoutes');

const edictRoutes = require('./routes/edictRoutes');
const taskRoutes = require('./routes/taskRoutes');
const auditRoutes = require('./routes/audit-logs');
const resourceRoutes = require('./routes/resourceRoutes');
const ipRoutes = require('./routes/ipRoutes');

const servicesRoutes = require("./routes/servicesRoutes");

dotenv.config();
const { getPool } = require('./config/db');

  const app = express();
  const port = process.env.PORT || 3000;

app.use(logger);
  app.use(express.json());

app.use(express.static("public"));
app.use(express.static("public/pages"));
app.use('/edicts', edictRoutes);

app.get("/api/settings", (req, res) => {
    const settings = require("./public/js/api/settings.json");
    res.json(settings);
});

app.use('/api', (req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  next();
});

app.use('/api/db', dbRoutes);
app.use('/api/edicts', edictRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/resources', resourceRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/ips', ipRoutes);
app.use("/resources", express.static("resources")); //??
app.use("/api/services", servicesRoutes);

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

console.info("if this was too fast, the DB server not found or shut down.");

async function startServer() {
  try {
    console.log("Creating SQL connection pool...");
    await getPool();
    console.log("Database pool initialized successfully");

    const serverHost = "0.0.0.0";
      app.listen(port, serverHost, () => {
    console.log(`Server running on ${serverHost}:${port}`);
  });
  } catch (err) {
    console.error("Failed to initialize database pool:", err);
    process.exit(1);
  }
}

const corsOptions = {
  origin: '172.22.160.*, http://localhost:3000',
  methods: 'GET,POST,PUT,DELETE',
  allowedHeaders: 'Content-Type,Authorization',
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
startServer();

