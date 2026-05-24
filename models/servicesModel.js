const sql = require("mssql");
const dbConfig = require("../config/db");

async function getAllServices() {

    const pool = await sql.connect(dbConfig);

    const result = await pool.request()
        .query(`
            SELECT *
            FROM Services
            WHERE enabled = 1
            ORDER BY sortOrder ASC, name ASC
        `);

    return result.recordset;
}

module.exports = {
    getAllServices
};