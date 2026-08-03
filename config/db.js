// config/db.js
// SQL Server connection config + master SINGLETON connection pool.

const sql = require('mssql');
const dotenv = require('dotenv');

// Load env before reading process.env (models may require this file first).
dotenv.config();

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  // Connect directly to server:port. The SQLEXPRESS instance listens on the static
  // port DB_PORT (1433); resolving the instance NAME (localhost\SQLEXPRESS) requires
  // the SQL Browser service, which isn't running on this machine.
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  port: parseInt(process.env.DB_PORT, 10),
  options: {
    connectionTimeout: 60000, // Connection timeout in milliseconds
    encrypt: false, // for local dev
    trustServerCertificate: true, // required for self-signed certs
  },
  connectionTimeout: 60000, // Connection timeout in milliseconds
};

let poolPromise = null;

async function getPool() {
  try {
    if (!poolPromise) {
      console.log('Creating SQL connection pool...');
      // Multiple callers share the same promise -> one pool instance.
      poolPromise = sql.connect(dbConfig);
    }

    // Await the pool connection and return it
    return await poolPromise;
  } catch (err) {
    console.error('Database connection failed:', err);

    // Reset so future calls can retry
    poolPromise = null;

    throw err;
  }
}

module.exports = { getPool };
