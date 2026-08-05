// models/certificationModel.js
// Certificate Dashboard: owner-scoped certification records.
//
// Status lifecycle (manual): planned -> in_progress -> obtained -> expired.
//
// FUTURE SCOPE: credential verification, course progress, or expiry-pipeline
// automation would extend this model without changing the table shape.

const { getPool } = require('../config/db');
const sql = require('mssql');

const STATUSES = ['planned', 'in_progress', 'obtained', 'expired'];

async function createCertification(userId, data) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('name', sql.NVarChar, data.name)
    .input('issuer', sql.NVarChar, data.issuer || null)
    .input('status', sql.NVarChar, data.status || 'planned')
    .input('startAt', sql.DateTime, data.startAt || null)
    .input('obtainedAt', sql.DateTime, data.obtainedAt || null)
    .input('expiryAt', sql.DateTime, data.expiryAt || null)
    .input('credential', sql.NVarChar, data.credential || null)
    .input('careerFilePath', sql.NVarChar, data.careerFilePath || null)
    .input('studyLinks', sql.NVarChar, data.studyLinks || null)
    .input('notes', sql.NVarChar, data.notes || null)
    .input('tags', sql.NVarChar, data.tags || null).query(`
            INSERT INTO Certifications (userId, name, issuer, status, startAt, obtainedAt, expiryAt, credential, careerFilePath, studyLinks, notes, tags)
            OUTPUT INSERTED.id
            VALUES (@userId, @name, @issuer, @status, @startAt, @obtainedAt, @expiryAt, @credential, @careerFilePath, @studyLinks, @notes, @tags)
        `);
  return result.recordset[0]?.id ?? null;
}

async function getCertificationsByUser(userId, { status, q } = {}) {
  const pool = await getPool();
  const req = pool.request().input('userId', sql.Int, userId);
  let where = 'WHERE userId = @userId';
  if (status) {
    req.input('status', sql.NVarChar, status);
    where += ' AND status = @status';
  }
  if (q) {
    req.input('q', sql.NVarChar, `%${q}%`);
    where += ' AND (name LIKE @q OR issuer LIKE @q OR tags LIKE @q OR notes LIKE @q)';
  }
  const result = await req.query(`
            SELECT id, userId, name, issuer, status, startAt, obtainedAt, expiryAt, credential, careerFilePath, studyLinks, notes, tags, createdAt, updatedAt
            FROM Certifications
            ${where}
            ORDER BY COALESCE(expiryAt, startAt, createdAt) ASC, id DESC
        `);
  return result.recordset;
}

async function getCertificationById(id, userId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .input('userId', sql.Int, userId)
    .query(`
            SELECT id, userId, name, issuer, status, startAt, obtainedAt, expiryAt, credential, careerFilePath, studyLinks, notes, tags, createdAt, updatedAt
            FROM Certifications
            WHERE id = @id AND userId = @userId
        `);
  return result.recordset[0] || null;
}

async function updateCertification(id, userId, data) {
  const pool = await getPool();
  await pool
    .request()
    .input('id', sql.Int, id)
    .input('userId', sql.Int, userId)
    .input('name', sql.NVarChar, data.name)
    .input('issuer', sql.NVarChar, data.issuer || null)
    .input('status', sql.NVarChar, data.status || 'planned')
    .input('startAt', sql.DateTime, data.startAt || null)
    .input('obtainedAt', sql.DateTime, data.obtainedAt || null)
    .input('expiryAt', sql.DateTime, data.expiryAt || null)
    .input('credential', sql.NVarChar, data.credential || null)
    .input('careerFilePath', sql.NVarChar, data.careerFilePath || null)
    .input('studyLinks', sql.NVarChar, data.studyLinks || null)
    .input('notes', sql.NVarChar, data.notes || null)
    .input('tags', sql.NVarChar, data.tags || null).query(`
            UPDATE Certifications
            SET name = @name, issuer = @issuer, status = @status, startAt = @startAt,
                obtainedAt = @obtainedAt, expiryAt = @expiryAt, credential = @credential,
                careerFilePath = @careerFilePath, studyLinks = @studyLinks, notes = @notes,
                tags = @tags, updatedAt = GETUTCDATE()
            WHERE id = @id AND userId = @userId
        `);
}

async function deleteCertification(id, userId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .input('userId', sql.Int, userId)
    .query(`DELETE FROM Certifications WHERE id = @id AND userId = @userId`);
  return (result.rowsAffected && result.rowsAffected[0]) || 0;
}

// Aggregate stats for the module panel + page stats strip.
async function getStats(userId) {
  const pool = await getPool();
  const byStatus = {};
  const sres = await pool
    .request()
    .input('userId', sql.Int, userId)
    .query(`SELECT status, COUNT(*) AS c FROM Certifications WHERE userId = @userId GROUP BY status`);
  for (const r of sres.recordset) byStatus[r.status] = r.c;
  const total = sres.recordset.reduce((s, r) => s + r.c, 0);
  // Non-'expired' certs with an expiry within 90 days (or already past) — renewal watch.
  const eres = await pool
    .request()
    .input('userId', sql.Int, userId)
    .query(`
            SELECT COUNT(*) AS c FROM Certifications
            WHERE userId = @userId AND status != 'expired' AND expiryAt IS NOT NULL
              AND expiryAt <= DATEADD(day, 90, GETUTCDATE())
        `);
  return {
    total,
    obtained: byStatus.obtained || 0,
    inProgress: byStatus.in_progress || 0,
    planned: byStatus.planned || 0,
    expired: byStatus.expired || 0,
    expiringWithin90: eres.recordset[0]?.c ?? 0,
    byStatus,
  };
}

// Dashboard sidebar renewals: certs whose expiryAt is overdue or within the next
// `days` days (UTC). Sorted soonest-first.
async function getExpiries(userId, days) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('days', sql.Int, days)
    .query(`
            SELECT id, name, issuer, status, expiryAt
            FROM Certifications
            WHERE userId = @userId
              AND expiryAt IS NOT NULL
              AND expiryAt <= DATEADD(day, @days, GETUTCDATE())
            ORDER BY expiryAt ASC
        `);
  return result.recordset;
}

module.exports = {
  STATUSES,
  createCertification,
  getCertificationsByUser,
  getCertificationById,
  updateCertification,
  deleteCertification,
  getStats,
  getExpiries,
};
