// shared/db.js — the single SQL Server connection pool for BOTH the Oswald
// dashboard and the fileserver (#73). Supersedes the near-duplicate
// config/db.js + fileserver/db.js, which had drifted (one reset the pool on
// failure so future calls could retry; the other didn't).
//
// Two modes:
//   1. DEFAULT (DB_DRIVER != 'msnodesqlv8') — mssql (tedious) over TCP + SQL auth.
//   2. LOCALDB (DB_DRIVER=msnodesqlv8) — mssql/msnodesqlv8 over ODBC Driver 18
//      to LocalDB `(localdb)\MSSQLLocalDB` with Windows auth. Chosen for machines
//      where no SQL Server *service* can run (e.g. Windows To Go) — LocalDB is
//      on-demand (no service) and connects via named pipes.

const { loadEnv } = require('./config');

// Load env BEFORE the driver decision below (models may require this file first).
loadEnv();

const sql = require(process.env.DB_DRIVER === 'msnodesqlv8' ? 'mssql/msnodesqlv8' : 'mssql');

// --- TRD-51 fix 2 (2026-09-14): AN EXPLICIT REQUEST TIMEOUT -------------------
//
// This file set `connectionTimeout: 60000` and NEVER set `requestTimeout`, so the
// mssql/tedious default applied to every single query:
//
//     tedious/lib/connection.js:59   const DEFAULT_CLIENT_REQUEST_TIMEOUT = 15 * 1000;
//     mssql/lib/tedious/connection-pool.js:42
//       cfg.options.requestTimeout = cfg.options.requestTimeout
//         ?? this.config.requestTimeout ?? this.config.timeout ?? 15000;
//
// That 15000 ms is not a guess - it is the exact error every aborted wake carried on
// 2026-09-14: `{"error":"Timeout: Request failed to complete in 15000ms","code":"ETIMEOUT"}`,
// 8 wakes from 09:37:45 to 13:05:38 SGT, plus 13 `where=wake_loop` timeouts.
//
// WHY 60s: the desk has a CHRONIC stall pattern and 15s sat ~3s above it. Hourly
// equity-tick stalls over 8s on 09-14: 04:00 -> 4 (worst 8.7s), 05:00 -> 5 (8.4s),
// 07:00 -> 9 (11.3s), 08:00 -> 17 (11.6s), 09:00 -> 23 (11.7s), 10:00 -> 16 (11.4s),
// 11:00 -> 18 (11.8s), 12:00 -> 17 (11.7s), 13:00 -> 13 (17.1s). So the desk stalls to
// ~17s with a 15s timeout - the timeout was firing on a stall, not on a hang. 60s
// matches `connectionTimeout` and gives ~3.5x headroom over the worst measured stall.
//
// WHAT THIS IS NOT: it is HEADROOM, not a cure. The cause of the stalls is still
// unproven (candidates: failing work against a broken bridge page, or synchronous
// CPU work blocking the loop). A larger timeout converts "aborted request" into "slow
// request" - it does not make the desk fast. Do not read a passing wake as a fixed desk.
//
// `requestTimeout: 0` means NO timeout in tedious, which would let a genuinely hung
// query block a wake forever - deliberately not used. Override with DB_REQUEST_TIMEOUT_MS.
const REQUEST_TIMEOUT_MS = (() => {
  const raw = process.env.DB_REQUEST_TIMEOUT_MS;
  if (raw == null || raw === '') return 60000;
  const n = parseInt(raw, 10);
  // A non-numeric or negative value must not silently become the 15s default again —
  // that is the bug this constant exists to fix.
  return Number.isFinite(n) && n >= 0 ? n : 60000;
})();

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
        requestTimeout: REQUEST_TIMEOUT_MS, // TRD-51: see the note above
      },
      connectionTimeout: 60000,
      requestTimeout: REQUEST_TIMEOUT_MS,
    };
  }

  // Default: direct TCP + SQL auth.
  return {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    // Connect directly to server:port. The SQLEXPRESS instance listens on the
    // static port DB_PORT; resolving the instance NAME requires the SQL Browser
    // service, which may not be running.
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    port: parseInt(process.env.DB_PORT, 10),
    options: {
      connectionTimeout: 60000,
      requestTimeout: REQUEST_TIMEOUT_MS, // TRD-51: tedious reads options.requestTimeout FIRST
      encrypt: false, // for local dev
      trustServerCertificate: true, // required for self-signed certs
    },
    connectionTimeout: 60000,
    requestTimeout: REQUEST_TIMEOUT_MS,
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

    // Await the pool connection and return it.
    return await poolPromise;
  } catch (err) {
    console.error('Database connection failed:', err);

    // Reset so future calls can retry.
    poolPromise = null;

    throw err;
  }
}

module.exports = { getPool, sql, dbConfig, buildDbConfig, REQUEST_TIMEOUT_MS };
