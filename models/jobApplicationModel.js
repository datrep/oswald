// models/jobApplicationModel.js
// Job Applications module (MOD-1): the job tracker. Owner-scoped (userId).
//
// Status pipeline (manual): applied → screening → assessment → interview →
// offer → hired / rejected / withdrawn.
//
// FUTURE SCOPE: per-policy scoping, reminders/alerts, or richer funnel queries
// would extend this model without changing the table shape.

const { getPool } = require('../config/db');
const sql = require('mssql');

const STATUSES = ['applied', 'screening', 'assessment', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'];
const SOURCES = ['mycareersfuture', 'jobstreet', 'internsg', 'other'];

async function createApplication(userId, data) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('company', sql.NVarChar, data.company)
    .input('role', sql.NVarChar, data.role)
    .input('source', sql.NVarChar, data.source || 'other')
    .input('jobUrl', sql.NVarChar, data.jobUrl || null)
    .input('status', sql.NVarChar, data.status || 'applied')
    .input('appliedAt', sql.DateTime, data.appliedAt || null)
    .input('followUpAt', sql.DateTime, data.followUpAt || null)
    .input('salary', sql.NVarChar, data.salary || null)
    .input('location', sql.NVarChar, data.location || null)
    .input('notes', sql.NVarChar, data.notes || null)
    .input('contact', sql.NVarChar, data.contact || null)
    .input('resumePath', sql.NVarChar, data.resumePath || null)
    .input('tags', sql.NVarChar, data.tags || null).query(`
            INSERT INTO JobApplications (userId, company, role, source, jobUrl, status, appliedAt, followUpAt, salary, location, notes, contact, resumePath, tags)
            OUTPUT INSERTED.id
            VALUES (@userId, @company, @role, @source, @jobUrl, @status, @appliedAt, @followUpAt, @salary, @location, @notes, @contact, @resumePath, @tags)
        `);
  return result.recordset[0]?.id ?? null;
}

async function getApplicationsByUser(userId, { status, source, q } = {}) {
  const pool = await getPool();
  const req = pool.request().input('userId', sql.Int, userId);
  let where = 'WHERE userId = @userId';
  if (status) {
    req.input('status', sql.NVarChar, status);
    where += ' AND status = @status';
  }
  if (source) {
    req.input('source', sql.NVarChar, source);
    where += ' AND source = @source';
  }
  if (q) {
    req.input('q', sql.NVarChar, `%${q}%`);
    where += ' AND (company LIKE @q OR role LIKE @q OR location LIKE @q OR tags LIKE @q OR notes LIKE @q)';
  }
  const result = await req.query(`
            SELECT id, userId, company, role, source, jobUrl, status, appliedAt, followUpAt, salary, location, notes, contact, resumePath, tags, createdAt, updatedAt
            FROM JobApplications
            ${where}
            ORDER BY COALESCE(appliedAt, createdAt) DESC, id DESC
        `);
  return result.recordset;
}

async function getApplicationById(id, userId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .input('userId', sql.Int, userId)
    .query(`
            SELECT id, userId, company, role, source, jobUrl, status, appliedAt, followUpAt, salary, location, notes, contact, resumePath, tags, createdAt, updatedAt
            FROM JobApplications
            WHERE id = @id AND userId = @userId
        `);
  return result.recordset[0] || null;
}

async function updateApplication(id, userId, data) {
  const pool = await getPool();
  await pool
    .request()
    .input('id', sql.Int, id)
    .input('userId', sql.Int, userId)
    .input('company', sql.NVarChar, data.company)
    .input('role', sql.NVarChar, data.role)
    .input('source', sql.NVarChar, data.source || 'other')
    .input('jobUrl', sql.NVarChar, data.jobUrl || null)
    .input('status', sql.NVarChar, data.status || 'applied')
    .input('appliedAt', sql.DateTime, data.appliedAt || null)
    .input('followUpAt', sql.DateTime, data.followUpAt || null)
    .input('salary', sql.NVarChar, data.salary || null)
    .input('location', sql.NVarChar, data.location || null)
    .input('notes', sql.NVarChar, data.notes || null)
    .input('contact', sql.NVarChar, data.contact || null)
    .input('resumePath', sql.NVarChar, data.resumePath || null)
    .input('tags', sql.NVarChar, data.tags || null).query(`
            UPDATE JobApplications
            SET company = @company, role = @role, source = @source, jobUrl = @jobUrl, status = @status,
                appliedAt = @appliedAt, followUpAt = @followUpAt, salary = @salary, location = @location,
                notes = @notes, contact = @contact, resumePath = @resumePath, tags = @tags,
                updatedAt = GETUTCDATE()
            WHERE id = @id AND userId = @userId
        `);
}

async function deleteApplication(id, userId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('id', sql.Int, id)
    .input('userId', sql.Int, userId)
    .query(`DELETE FROM JobApplications WHERE id = @id AND userId = @userId`);
  return (result.rowsAffected && result.rowsAffected[0]) || 0;
}

// Dashboard sidebar follow-ups (MOD-2): applications whose followUpAt is overdue
// or due within the next `days` days (UTC). Sorted soonest-first.
async function getFollowUps(userId, days) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('days', sql.Int, days)
    .query(`
            SELECT id, company, role, status, source, followUpAt
            FROM JobApplications
            WHERE userId = @userId
              AND followUpAt IS NOT NULL
              AND followUpAt <= DATEADD(day, @days, GETUTCDATE())
            ORDER BY followUpAt ASC
        `);
  return result.recordset;
}

// Aggregate stats for the module panel + page stats strip.
async function getStats(userId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('userId', sql.Int, userId)
    .query(`
            SELECT status, COUNT(*) AS c
            FROM JobApplications
            WHERE userId = @userId
            GROUP BY status
        `);
  const byStatus = {};
  for (const r of result.recordset) byStatus[r.status] = r.c;
  const total = result.recordset.reduce((s, r) => s + r.c, 0);
  const weekStart = await pool
    .request()
    .input('userId', sql.Int, userId)
    .query(`
            SELECT COUNT(*) AS c FROM JobApplications
            WHERE userId = @userId AND appliedAt >= DATEADD(day, -6, CAST(GETUTCDATE() AS date))
        `);
  const active = ['applied', 'screening', 'assessment', 'interview', 'offer'];
  const interviews = (byStatus.interview || 0) + (byStatus.offer || 0) + (byStatus.hired || 0);
  const offers = (byStatus.offer || 0) + (byStatus.hired || 0);
  return {
    total,
    appliedThisWeek: weekStart.recordset[0]?.c ?? 0,
    active: active.reduce((s, k) => s + (byStatus[k] || 0), 0),
    interviews,
    offers,
    hired: byStatus.hired || 0,
    rejected: byStatus.rejected || 0,
    withdrawn: byStatus.withdrawn || 0,
    byStatus,
  };
}

module.exports = {
  STATUSES,
  SOURCES,
  createApplication,
  getApplicationsByUser,
  getApplicationById,
  updateApplication,
  deleteApplication,
  getFollowUps,
  getStats,
};
