const { getTables, getTableRows } = require('../models/dbModel');

// GET: api/db/tables
async function getTablesHandler(req, res) {
    try {
        const tables = await getTables();
        res.json(tables);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch table names', details: err.message });
    }
};

//  GET: api/db/tablename (i SHOULD put it as :tablename but not implememted as :tablename in the route)
async function getTableRowsHandler(req, res) {
    const { tableName } = req.params;

    try {
        const rows = await getTableRows(tableName);
        res.json(rows);
    } catch (err) {
        console.error(err);
        if (err.message.includes('not found')) {
            res.status(404).json({ error: err.message });
        } else {
            res.status(500).json({ error: 'Failed to fetch table rows', details: err.message });
        }
    }
};


module.exports = {
  getTableRows: getTableRowsHandler,
  getTables: getTablesHandler
};
