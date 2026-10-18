// expenses/store.js — data access for the General Expense Sheet.
// All queries are owner-scoped (userId). `syncFromLedger` snapshots computer
// expenses from the Listing Workbench ledger (independent copies, never replaces).
'use strict';

const { getPool, sql } = require('./db');

const NV = (max) => sql.NVarChar(max);
const round2 = (n) => { const v = Number(n); return Number.isFinite(v) ? Math.round((v + Number.EPSILON) * 100) / 100 : 0; };

const CATEGORIES = ['computer', 'investing', 'school', 'other'];
const PLATFORMS = ['debit', 'credit'];

function monthBounds(month) {
  if (!month) return null;
  const m = String(month).match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]);
  return { start: new Date(Date.UTC(y, mo - 1, 1)), end: new Date(Date.UTC(y, mo, 1)) };
}

async function listExpenses(userId, { category = null, month = null } = {}) {
  const pool = await getPool();
  const req = pool.request().input('userId', sql.Int, userId);
  let where = 'e.userId = @userId';
  if (category) { where += ' AND e.category = @category'; req.input('category', NV(20), category); }
  const mb = monthBounds(month);
  if (mb) {
    where += ' AND e.expenseDate >= @ms AND e.expenseDate < @me';
    req.input('ms', sql.DateTime2, mb.start).input('me', sql.DateTime2, mb.end);
  }
  const r = await req.query(`SELECT * FROM Expenses e WHERE ${where} ORDER BY e.expenseDate DESC, e.id DESC`);
  return r.recordset;
}

async function createExpense(userId, data) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .input('category', NV(20), data.category)
    .input('description', NV(255), data.description ?? null)
    .input('amount', sql.Decimal(10, 2), round2(data.amount ?? 0))
    .input('platform', NV(20), data.platform ?? null)
    .input('tags', NV(255), data.tags ?? null)
    .input('expenseDate', sql.DateTime2, data.expenseDate ?? null)
    .query(`INSERT INTO Expenses (userId, category, description, amount, platform, tags, expenseDate)
            OUTPUT INSERTED.id
            VALUES (@userId, @category, @description, @amount, @platform, @tags, @expenseDate)`);
  return r.recordset[0].id;
}

async function updateExpense(userId, id, data) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).input('id', sql.Int, id)
    .input('category', NV(20), data.category)
    .input('description', NV(255), data.description ?? null)
    .input('amount', sql.Decimal(10, 2), round2(data.amount ?? 0))
    .input('platform', NV(20), data.platform ?? null)
    .input('tags', NV(255), data.tags ?? null)
    .input('expenseDate', sql.DateTime2, data.expenseDate ?? null)
    .query(`UPDATE Expenses SET category=@category, description=@description, amount=@amount,
              platform=@platform, tags=@tags, expenseDate=@expenseDate, updatedAt=GETUTCDATE()
            WHERE id=@id AND userId=@userId`);
  return r.rowsAffected[0] > 0;
}

async function deleteExpense(userId, id) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).input('id', sql.Int, id)
    .query('DELETE FROM Expenses WHERE id=@id AND userId=@userId');
  return r.rowsAffected[0] > 0;
}

// Copy computer-related ledger rows (purchase/expense) into Expenses as independent
// snapshots. Idempotent: rows already copied (sourceLedgerId set) are skipped.
async function syncFromLedger(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).query(`
    SELECT l.id, l.type, l.description, l.date, l.amount, l.category
    FROM LedgerEntries l
    WHERE l.userId = @userId AND l.type IN ('purchase','expense') AND l.amount IS NOT NULL AND l.amount <> 0
      AND NOT EXISTS (SELECT 1 FROM Expenses x WHERE x.userId = @userId AND x.sourceLedgerId = l.id)
    ORDER BY l.id`);
  let imported = 0;
  for (const row of r.recordset) {
    const tags = [row.type, row.category].filter(Boolean).join(',');
    await pool.request().input('userId', sql.Int, userId)
      .input('category', NV(20), 'computer')
      .input('description', NV(255), row.description || `${row.type} entry`)
      .input('amount', sql.Decimal(10, 2), Math.abs(Number(row.amount) || 0))
      .input('platform', NV(20), null)
      .input('tags', NV(255), tags || null)
      .input('expenseDate', sql.DateTime2, row.date ?? null)
      .input('sourceLedgerId', sql.Int, row.id)
      .query(`INSERT INTO Expenses (userId, category, description, amount, platform, tags, expenseDate, sourceLedgerId)
              VALUES (@userId, @category, @description, @amount, @platform, @tags, @expenseDate, @sourceLedgerId)`);
    imported++;
  }
  return imported;
}

async function stats(userId, { month = null } = {}) {
  const pool = await getPool();
  const req = pool.request().input('userId', sql.Int, userId);
  let where = 'userId = @userId';
  const mb = monthBounds(month);
  if (mb) {
    where += ' AND expenseDate >= @ms AND expenseDate < @me';
    req.input('ms', sql.DateTime2, mb.start).input('me', sql.DateTime2, mb.end);
  }
  const byCat = await req.query(`SELECT category, COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt FROM Expenses WHERE ${where} GROUP BY category ORDER BY category`);
  const agg = await req.query(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt FROM Expenses WHERE ${where}`);
  return { total: round2(agg.recordset[0].total), count: agg.recordset[0].cnt, byCategory: byCat.recordset };
}

module.exports = { CATEGORIES, PLATFORMS, listExpenses, createExpense, updateExpense, deleteExpense, syncFromLedger, stats };
