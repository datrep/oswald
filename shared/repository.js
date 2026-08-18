// shared/repository.js — small table-backed repository.
//
// Owns the SQL + mssql typing for a table so models don't repeat
// getPool/request/input/query boilerplate. Keeping SQL in this one layer also
// means a future MSSQL -> Postgres switch only needs to change this file
// (plus shared/db.js), not the controllers or routes.
//
// Usage:
//   const repo = new Repository('Tasks');
//   await repo.all({ order: 'createdAt DESC', limit, offset });
//   await repo.byId(id);
//   await repo.create([{ column: 'name', param: 'name', type: sql.NVarChar, value }]);
//   await repo.update(id, [{ column, param, type, value }]);
//   await repo.remove(id);
//   await repo.transaction(async (tx) => { ... tx.request() ... });

const { getPool, sql } = require('./db');

class Repository {
  constructor(table, { idColumn = 'id' } = {}) {
    this.table = table;
    this.idColumn = idColumn;
  }

  // Run query text; `bind(req)` applies typed .input() calls.
  async query(queryText, bind) {
    const pool = await getPool();
    const req = pool.request();
    if (bind) bind(req);
    const result = await req.query(queryText);
    return result.recordset || [];
  }

  // Run query text and return the affected-row count (INSERT/UPDATE/DELETE).
  async execute(queryText, bind) {
    const pool = await getPool();
    const req = pool.request();
    if (bind) bind(req);
    const result = await req.query(queryText);
    return (result.rowsAffected && result.rowsAffected[0]) || 0;
  }

  async one(queryText, bind) {
    const rows = await this.query(queryText, bind);
    return rows[0] || null;
  }

  // SELECT with optional WHERE / ORDER / pagination.
  async all({ columns = '*', where = '', order = '', limit = null, offset = 0, bind } = {}) {
    let q = `SELECT ${columns} FROM ${this.table}`;
    if (where) q += ` WHERE ${where}`;
    if (order) q += ` ORDER BY ${order}`;
    const paginate = Number.isInteger(limit) && limit > 0;
    if (paginate) q += ` OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
    return this.query(q, (req) => {
      if (bind) bind(req);
      if (paginate) {
        req.input('offset', sql.Int, offset || 0);
        req.input('limit', sql.Int, limit);
      }
    });
  }

  byId(id) {
    return this.one(`SELECT * FROM ${this.table} WHERE ${this.idColumn} = @id`, (req) =>
      req.input('id', sql.Int, id)
    );
  }

  // fields: [{ column, param, type, value }]
  async create(fields) {
    const cols = fields.map((f) => f.column).join(', ');
    const params = fields.map((f) => `@${f.param}`).join(', ');
    const rows = await this.query(
      `INSERT INTO ${this.table} (${cols}) OUTPUT inserted.${this.idColumn} AS id VALUES (${params})`,
      (req) => fields.forEach((f) => req.input(f.param, f.type, f.value))
    );
    return rows[0]?.id ?? null;
  }

  // fields: [{ column, param, type, value }]
  async update(id, fields) {
    const sets = fields.map((f) => `${f.column} = @${f.param}`).join(', ');
    return this.execute(`UPDATE ${this.table} SET ${sets} WHERE ${this.idColumn} = @id`, (req) => {
      req.input('id', sql.Int, id);
      fields.forEach((f) => req.input(f.param, f.type, f.value));
    });
  }

  remove(id) {
    return this.execute(`DELETE FROM ${this.table} WHERE ${this.idColumn} = @id`, (req) =>
      req.input('id', sql.Int, id)
    );
  }

  // Run `fn(tx)` inside a transaction; commits on success, rolls back on error.
  async transaction(fn) {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }
}

module.exports = { Repository };
