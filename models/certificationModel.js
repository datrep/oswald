// models/certificationModel.js
// Certificate Dashboard: owner-scoped certification records.
//
// Status lifecycle (manual): planned -> in_progress -> obtained -> expired.
//
// FUTURE SCOPE: credential verification, course progress, or expiry-pipeline
// automation would extend this model without changing the table shape.

const { Repository } = require('../shared/repository');
const { sql } = require('../shared/db');

const repo = new Repository('Certifications');

const STATUSES = ['planned', 'in_progress', 'obtained', 'expired'];

// Explicit column list (id=15: no SELECT *).
const COLUMNS = 'id, userId, name, issuer, status, startAt, obtainedAt, expiryAt, credential, careerFilePath, studyLinks, notes, tags, createdAt, updatedAt';

async function createCertification(userId, data) {
  return repo.create([
    { column: 'userId', param: 'userId', type: sql.Int, value: userId },
    { column: 'name', param: 'name', type: sql.NVarChar, value: data.name },
    { column: 'issuer', param: 'issuer', type: sql.NVarChar, value: data.issuer || null },
    { column: 'status', param: 'status', type: sql.NVarChar, value: data.status || 'planned' },
    { column: 'startAt', param: 'startAt', type: sql.DateTime, value: data.startAt || null },
    { column: 'obtainedAt', param: 'obtainedAt', type: sql.DateTime, value: data.obtainedAt || null },
    { column: 'expiryAt', param: 'expiryAt', type: sql.DateTime, value: data.expiryAt || null },
    { column: 'credential', param: 'credential', type: sql.NVarChar, value: data.credential || null },
    { column: 'careerFilePath', param: 'careerFilePath', type: sql.NVarChar, value: data.careerFilePath || null },
    { column: 'studyLinks', param: 'studyLinks', type: sql.NVarChar, value: data.studyLinks || null },
    { column: 'notes', param: 'notes', type: sql.NVarChar, value: data.notes || null },
    { column: 'tags', param: 'tags', type: sql.NVarChar, value: data.tags || null },
  ]);
}

async function getCertificationsByUser(userId, { status, q } = {}) {
  let where = 'userId = @userId';
  const bind = (req) => {
    req.input('userId', sql.Int, userId);
    if (status) req.input('status', sql.NVarChar, status);
    if (q) req.input('q', sql.NVarChar, `%${q}%`);
  };
  if (status) where += ' AND status = @status';
  if (q) where += ' AND (name LIKE @q OR issuer LIKE @q OR tags LIKE @q OR notes LIKE @q)';
  return repo.all({
    columns: COLUMNS,
    where,
    order: 'COALESCE(expiryAt, startAt, createdAt) ASC, id DESC',
    bind,
  });
}

async function getCertificationById(id, userId) {
  return repo.one(
    `SELECT ${COLUMNS} FROM Certifications WHERE id = @id AND userId = @userId`,
    (req) => req.input('id', sql.Int, id).input('userId', sql.Int, userId)
  );
}

async function updateCertification(id, userId, data) {
  return repo.execute(
    `UPDATE Certifications
     SET name = @name, issuer = @issuer, status = @status, startAt = @startAt,
         obtainedAt = @obtainedAt, expiryAt = @expiryAt, credential = @credential,
         careerFilePath = @careerFilePath, studyLinks = @studyLinks, notes = @notes,
         tags = @tags, updatedAt = GETUTCDATE()
     WHERE id = @id AND userId = @userId`,
    (req) => req
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
      .input('tags', sql.NVarChar, data.tags || null)
  );
}

async function deleteCertification(id, userId) {
  return repo.execute(
    `DELETE FROM Certifications WHERE id = @id AND userId = @userId`,
    (req) => req.input('id', sql.Int, id).input('userId', sql.Int, userId)
  );
}

// Aggregate stats for the module panel + page stats strip.
async function getStats(userId) {
  const byStatus = {};
  const sres = await repo.query(
    `SELECT status, COUNT(*) AS c FROM Certifications WHERE userId = @userId GROUP BY status`,
    (req) => req.input('userId', sql.Int, userId)
  );
  for (const r of sres) byStatus[r.status] = r.c;
  const total = sres.reduce((s, r) => s + r.c, 0);
  // Non-'expired' certs with an expiry within 90 days (or already past) — renewal watch.
  const eres = await repo.query(
    `SELECT COUNT(*) AS c FROM Certifications
     WHERE userId = @userId AND status != 'expired' AND expiryAt IS NOT NULL
       AND expiryAt <= DATEADD(day, 90, GETUTCDATE())`,
    (req) => req.input('userId', sql.Int, userId)
  );
  return {
    total,
    obtained: byStatus.obtained || 0,
    inProgress: byStatus.in_progress || 0,
    planned: byStatus.planned || 0,
    expired: byStatus.expired || 0,
    expiringWithin90: eres[0]?.c ?? 0,
    byStatus,
  };
}

// Dashboard sidebar renewals: certs whose expiryAt is overdue or within the next
// `days` days (UTC). Sorted soonest-first.
async function getExpiries(userId, days) {
  return repo.query(
    `SELECT id, name, issuer, status, expiryAt
     FROM Certifications
     WHERE userId = @userId
       AND expiryAt IS NOT NULL
       AND expiryAt <= DATEADD(day, @days, GETUTCDATE())
     ORDER BY expiryAt ASC`,
    (req) => req.input('userId', sql.Int, userId).input('days', sql.Int, days)
  );
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
