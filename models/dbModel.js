const { Repository } = require('../shared/repository');
const { sql } = require('../shared/db');
const { NotFoundError } = require('../utils/errors');

// Only repo.query() is used here (information_schema / dynamic-identifier queries).
const repo = new Repository('');

async function getTables() {
  const rows = await repo.query(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'`
  );
  return rows.map((row) => row.TABLE_NAME);
}

async function getTableRows(tableName) {
  // Validate table exists first
  const tableCheck = await repo.query(
    `SELECT TABLE_NAME
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_TYPE='BASE TABLE' AND TABLE_NAME=@tableName`,
    (req) => req.input('tableName', sql.NVarChar, tableName)
  );

  if (tableCheck.length === 0) {
    throw new NotFoundError(`Table '${tableName}' not found.`);
  }

  // Fetch rows safely (identifier validated against INFORMATION_SCHEMA above).
  return repo.query(`SELECT * FROM [${tableName}]`);
}

module.exports = {
  getTables,
  getTableRows,
};
