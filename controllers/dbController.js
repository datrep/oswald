const { getTables, getTableRows } = require('../models/dbModel');

// GET: api/db/tables
async function getTablesHandler(req, res, next) {
  try {
    const tables = await getTables();
    res.json(tables);
  } catch (err) {
    next(err);
  }
}

// GET: api/db/:tableName
async function getTableRowsHandler(req, res, next) {
  const { tableName } = req.params;

  try {
    const rows = await getTableRows(tableName);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getTableRows: getTableRowsHandler,
  getTables: getTablesHandler,
};
