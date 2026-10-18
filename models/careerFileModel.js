// models/careerFileModel.js
// Career Files module (MOD-1): metadata for the user's career documents stored
// under /resources/career. All reads/writes are owner-scoped (userId).
//
// FUTURE SCOPE: tagging, expiry tracking for certs, or per-file versions would
// extend this model without touching the table shape.

const { Repository } = require('../shared/repository');
const { sql } = require('../shared/db');

const repo = new Repository('CareerFiles');

const COLUMNS = 'id, userId, fileName, filePath, kind, description, createdAt';

async function createCareerFile(userId, fileName, filePath, kind, description) {
  await repo.query(
    `INSERT INTO CareerFiles (userId, fileName, filePath, kind, description)
     VALUES (@userId, @fileName, @filePath, @kind, @description)`,
    (req) => req
      .input('userId', sql.Int, userId)
      .input('fileName', sql.NVarChar, fileName)
      .input('filePath', sql.NVarChar, filePath)
      .input('kind', sql.NVarChar, kind || 'other')
      .input('description', sql.NVarChar, description || null)
  );
}

async function getCareerFilesByUser(userId) {
  return repo.all({
    columns: COLUMNS,
    where: 'userId = @userId',
    order: 'id DESC',
    bind: (req) => req.input('userId', sql.Int, userId),
  });
}

async function getCareerFileById(id, userId) {
  return repo.one(
    `SELECT ${COLUMNS} FROM CareerFiles WHERE id = @id AND userId = @userId`,
    (req) => req.input('id', sql.Int, id).input('userId', sql.Int, userId)
  );
}

async function deleteCareerFile(id, userId) {
  return repo.execute(
    `DELETE FROM CareerFiles WHERE id = @id AND userId = @userId`,
    (req) => req.input('id', sql.Int, id).input('userId', sql.Int, userId)
  );
}

module.exports = { createCareerFile, getCareerFilesByUser, getCareerFileById, deleteCareerFile };
