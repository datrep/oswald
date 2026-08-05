// fileserver/db.js — standalone SQL Server pool for the fileserver service.
// Reads the same repo-root .env as the dashboard (DB_USER/DB_PASSWORD/DB_SERVER/
// DB_DATABASE/DB_PORT) so the fileserver is a self-contained service (ARCH 49)
// and can run inside the Docker image without the dashboard's module tree.
const sql = require('mssql');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  // Direct server:port connection (matches config/db.js — the SQLEXPRESS
  // instance listens on the static port DB_PORT; SQL Browser isn't running).
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  port: parseInt(process.env.DB_PORT, 10),
  options: {
    connectionTimeout: 60000,
    encrypt: false,
    trustServerCertificate: true,
  },
  connectionTimeout: 60000,
};

let poolPromise = null;

async function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(dbConfig);
  }
  return await poolPromise;
}

module.exports = { getPool };
