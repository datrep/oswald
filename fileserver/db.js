// fileserver/db.js — standalone SQL Server pool for the fileserver service.
// Reads the same repo-root .env as the dashboard (DB_USER/DB_PASSWORD/DB_SERVER/
// DB_DATABASE/DB_PORT) so the fileserver is a self-contained service (ARCH 49)
// and can run inside the Docker image without the dashboard's module tree.
//
// Two modes (mirrors config/db.js):
//   1. DEFAULT (DB_DRIVER != 'msnodesqlv8') — mssql (tedious) over TCP + SQL auth.
//   2. LOCALDB (DB_DRIVER=msnodesqlv8) — mssql/msnodesqlv8 to LocalDB via ODBC
//      Driver 18, Windows auth.
const dotenv = require('dotenv');
const path = require('path');

// Load env BEFORE the driver decision below.
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const sql = require(process.env.DB_DRIVER === 'msnodesqlv8' ? 'mssql/msnodesqlv8' : 'mssql');

function buildDbConfig() {
  if (process.env.DB_DRIVER === 'msnodesqlv8') {
    const server = process.env.DB_SERVER || '(localdb)\\MSSQLLocalDB';
    const database = process.env.DB_DATABASE || 'DB_Oswald';
    return {
      connectionString:
        process.env.DB_CONNECTION_STRING ||
        `Driver={ODBC Driver 18 for SQL Server};Server=${server};Database=${database};Trusted_Connection=yes;`,
      options: {
        trustedConnection: true,
        connectionTimeout: 60000,
      },
      connectionTimeout: 60000,
    };
  }
  return {
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
}

const dbConfig = buildDbConfig();

let poolPromise = null;

async function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(dbConfig);
  }
  return await poolPromise;
}

module.exports = { getPool };
