const { getPool } = require('../config/db');
const sql = require('mssql');

async function getTables() {
    const pool = await getPool();
    const result = await pool.request()
        .query(`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'`);
    return result.recordset.map(row => row.TABLE_NAME);
}

async function getTableRows(tableName) {
    const pool = await getPool();

    // Validate table exists first
    const tableCheck = await pool.request()
        .input('tableName', sql.NVarChar, tableName)
        .query(`SELECT TABLE_NAME
                FROM INFORMATION_SCHEMA.TABLES
                WHERE TABLE_TYPE='BASE TABLE' AND TABLE_NAME=@tableName`);

    if (tableCheck.recordset.length === 0) {
        throw new Error(`Table '${tableName}' not found.`);
    }

    // Fetch rows safely
    const rows = await pool.request()
        .query(`SELECT * FROM [${tableName}]`); // safe now because we validated table name

    return rows.recordset;
}

module.exports = {
    getTables,
    getTableRows
};