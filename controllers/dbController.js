const { getTables, getTableRows } = require('../models/dbModel');
const { asyncHandler } = require('../utils/errors');

// GET: api/db/tables
const getTablesHandler = asyncHandler(async (req, res) => {
  res.json(await getTables());
});

// GET: api/db/:tableName
const getTableRowsHandler = asyncHandler(async (req, res) => {
  res.json(await getTableRows(req.params.tableName));
});

module.exports = {
  getTableRows: getTableRowsHandler,
  getTables: getTablesHandler,
};
