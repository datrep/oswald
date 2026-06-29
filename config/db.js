// db.js
// master SINGLETON connection pool for SQL 

const sql = require('mssql');
const db = require('../utils/db');

let poolPromise = null;


async function getPool() {
  try {
    if (!poolPromise) {
      console.log("Creating SQL connection pool...");
      poolPromise = sql.connect(db); // multiple requests to one promise, will share connection pool instance
    }
  

    // Await the pool connection and return it
    const pool = await poolPromise;
    return pool;

  } catch (err) {
    console.error("Database connection failed:", err);

    // Reset so future calls can retry
    poolPromise = null;

    throw err;
  }
}

module.exports = { getPool };



//model implementation

//const { getPool } = require('../config/db');

//const pool = await getPool();