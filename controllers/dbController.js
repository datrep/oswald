const sql = require('mssql');
const dbConfig = require('../dbConfig');


// GET: api/db/tables
exports.getTables = async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool.request()
            .query(`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'`);
        const tables = result.recordset.map(row => row.TABLE_NAME);
        res.json(tables);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch table names', details: err.message });
    }
};

//  GET: api/db/tablename (i SHOULD put it as :tablename but not implememted as :tablename in the route)
exports.getTableRows = async (req, res) => {
    const { tableName } = req.params;

    try {
        const pool = await sql.connect(dbConfig);

        // Validate table exists first
        const tableCheck = await pool.request()
            .input('tableName', sql.NVarChar, tableName)
            .query(`SELECT TABLE_NAME 
                    FROM INFORMATION_SCHEMA.TABLES 
                    WHERE TABLE_TYPE='BASE TABLE' AND TABLE_NAME=@tableName`);

        if (tableCheck.recordset.length === 0) {
            return res.status(404).json({ error: `Table '${tableName}' not found.` });
        }

        // Fetch rows safely
        const rows = await pool.request()
            .query(`SELECT * FROM [${tableName}]`); // safe now because we validated table name

        res.json(rows.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch table rows', details: err.message });
    }
};