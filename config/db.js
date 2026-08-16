// config/db.js
// SQL Server connection config + master SINGLETON connection pool.
//
// Two modes:
//   1. DEFAULT (DB_DRIVER != 'msnodesqlv8') — mssql (tedious) over TCP with SQL
//      auth. Used by Docker (compose.yaml) and full SQL Server installs.
//   2. LOCALDB (DB_DRIVER=msnodesqlv8) — mssql/msnodesqlv8 over ODBC Driver 18
//      to LocalDB `(localdb)\MSSQLLocalDB` with Windows auth. Chosen for machines
//      where no SQL Server *service* can run (e.g. Windows To Go) — LocalDB is
//      on-demand (no service) and connects via named pipes.

const dotenv = require('dotenv');

// Load env BEFORE the driver decision below (models may require this file first).
dotenv.config();

const sql = require(process.env.DB_DRIVER === 'msnodesqlv8' ? 'mssql/msnodesqlv8' : 'mssql');

function buildDbConfig() {
  // LocalDB via msnodesqlv8 (ODBC Driver + Windows auth).
  if (process.env.DB_DRIVER === 'msnodesqlv8') {
    const server = process.env.DB_SERVER || '(localdb)\\MSSQLLocalDB';
    const database = process.env.DB_DATABASE || 'DB_Oswald';
    return {
      // Full ODBC connection string — the mssql/msnodesqlv8 wrapper only
      // supports a fixed driver name, so we hand it the exact string.
      connectionString:
        process.env.DB_CONNECTION_STRING ||
        `Driver={ODBC Driver 18 for SQL Server};Server=${server};Database=${database};Trusted_Connection=yes;`,
      options: {
        trustedConnection: true, // Windows auth — DB_USER/DB_PASSWORD unused
        connectionTimeout: 60000,
      },
      connectionTimeout: 60000,
    };
  }

  // Default: direct TCP + SQL auth.
  return {
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
}

const dbConfig = buildDbConfig();

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
