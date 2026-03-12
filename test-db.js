// test-db.js
require("dotenv").config();
const sql = require("mssql");
const config = require("./dbConfig");

sql.connect(config)
  .then(pool => {
    console.log("✅ Connected!");
    return pool.request().query("SELECT TOP 1 * FROM Books");
  })
  .then(result => {
    console.log("Data:", result.recordset);
    sql.close();
  })
  .catch(err => {
    console.error("❌ DB Error:", err);
  });
