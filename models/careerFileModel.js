// models/careerFileModel.js
// Career Files module (MOD-1): metadata for the user's career documents stored
// under /resources/career. All reads/writes are owner-scoped (userId).
//
// FUTURE SCOPE: tagging, expiry tracking for certs, or per-file versions would
// extend this model without touching the table shape.

const { getPool } = require('../config/db');
const sql = require('mssql');

async function createCareerFile(userId, fileName, filePath, kind, description) {
  const pool = await getPool();
  await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('fileName', sql.NVarChar, fileName)
    .input('filePath', sql.NVarChar, filePath)
    .input('kind', sql.NVarChar, kind || 'other')
    .input('description', sql.NVarChar, description || null)
    .query(`
            INSERT INTO CareerFiles (userId, fileName, filePath, kind, description)
            VALUES (@userId, @fileName, @filePath, @kind, @description)
        `);
}

async function getCareerFilesByUser(userId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('userId', sql.Int, userId)
    .query(`
            SELECT id, userId, fileName, filePath, kind, description, createdAt
            FROM CareerFiles
            WHERE userId = @userId
            ORDER BY id DESC
        `);
  return result.recordset;
}

async function getCareerFileById(id, userId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .input('userId', sql.Int, userId)
    .query(`
            SELECT id, userId, fileName, filePath, kind, description, createdAt
            FROM CareerFiles
            WHERE id = @id AND userId = @userId
        `);
  return result.recordset[0] || null;
}

async function deleteCareerFile(id, userId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .input('userId', sql.Int, userId)
    .query(`DELETE FROM CareerFiles WHERE id = @id AND userId = @userId`);
  return (result.rowsAffected && result.rowsAffected[0]) || 0;
}

module.exports = { createCareerFile, getCareerFilesByUser, getCareerFileById, deleteCareerFile };
