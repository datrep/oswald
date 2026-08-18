// models/jobApplicationModel.js
// Job Applications module (MOD-1): the job tracker. Owner-scoped (userId).
//
// Status pipeline (manual): applied → screening → assessment → interview →
// offer → hired / rejected / withdrawn.
//
// FUTURE SCOPE: per-policy scoping, reminders/alerts, or richer funnel queries
// would extend this model without changing the table shape.

const { Repository } = require('../shared/repository');
const { sql } = require('../shared/db');

const repo = new Repository('JobApplications');

const STATUSES = ['applied', 'screening', 'assessment', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'];
const SOURCES = ['mycareersfuture', 'jobstreet', 'internsg', 'other'];

const COLUMNS = 'id, userId, company, role, source, jobUrl, status, appliedAt, followUpAt, salary, location, notes, contact, resumePath, tags, createdAt, updatedAt';

async function createApplication(userId, data) {
  return repo.create([
    { column: 'userId', param: 'userId', type: sql.Int, value: userId },
    { column: 'company', param: 'company', type: sql.NVarChar, value: data.company },
    { column: 'role', param: 'role', type: sql.NVarChar, value: data.role },
    { column: 'source', param: 'source', type: sql.NVarChar, value: data.source || 'other' },
    { column: 'jobUrl', param: 'jobUrl', type: sql.NVarChar, value: data.jobUrl || null },
    { column: 'status', param: 'status', type: sql.NVarChar, value: data.status || 'applied' },
    { column: 'appliedAt', param: 'appliedAt', type: sql.DateTime, value: data.appliedAt || null },
    { column: 'followUpAt', param: 'followUpAt', type: sql.DateTime, value: data.followUpAt || null },
    { column: 'salary', param: 'salary', type: sql.NVarChar, value: data.salary || null },
    { column: 'location', param: 'location', type: sql.NVarChar, value: data.location || null },
    { column: 'notes', param: 'notes', type: sql.NVarChar, value: data.notes || null },
    { column: 'contact', param: 'contact', type: sql.NVarChar, value: data.contact || null },
    { column: 'resumePath', param: 'resumePath', type: sql.NVarChar, value: data.resumePath || null },
    { column: 'tags', param: 'tags', type: sql.NVarChar, value: data.tags || null },
  ]);
}

async function getApplicationsByUser(userId, { status, source, q } = {}) {
  let where = 'userId = @userId';
  const bind = (req) => {
    req.input('userId', sql.Int, userId);
    if (status) req.input('status', sql.NVarChar, status);
    if (source) req.input('source', sql.NVarChar, source);
    if (q) req.input('q', sql.NVarChar, `%${q}%`);
  };
  if (status) where += ' AND status = @status';
  if (source) where += ' AND source = @source';
  if (q) where += ' AND (company LIKE @q OR role LIKE @q OR location LIKE @q OR tags LIKE @q OR notes LIKE @q)';
  return repo.all({
    columns: COLUMNS,
    where,
    order: 'COALESCE(appliedAt, createdAt) DESC, id DESC',
    bind,
  });
}

async function getApplicationById(id, userId) {
  return repo.one(
    `SELECT ${COLUMNS} FROM JobApplications WHERE id = @id AND userId = @userId`,
    (req) => req.input('id', sql.Int, id).input('userId', sql.Int, userId)
  );
}

async function updateApplication(id, userId, data) {
  return repo.execute(
    `UPDATE JobApplications
     SET company = @company, role = @role, source = @source, jobUrl = @jobUrl, status = @status,
         appliedAt = @appliedAt, followUpAt = @followUpAt, salary = @salary, location = @location,
         notes = @notes, contact = @contact, resumePath = @resumePath, tags = @tags,
         updatedAt = GETUTCDATE()
     WHERE id = @id AND userId = @userId`,
    (req) => req
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
      .input('tags', sql.NVarChar, data.tags || null)
  );
}

async function deleteApplication(id, userId) {
  return repo.execute(
    `DELETE FROM JobApplications WHERE id = @id AND userId = @userId`,
    (req) => req.input('id', sql.Int, id).input('userId', sql.Int, userId)
  );
}

// Dashboard sidebar follow-ups (MOD-2): applications whose followUpAt is overdue
// or due within the next `days` days (UTC). Sorted soonest-first.
async function getFollowUps(userId, days) {
  return repo.query(
    `SELECT id, company, role, status, source, followUpAt
     FROM JobApplications
     WHERE userId = @userId
       AND followUpAt IS NOT NULL
       AND followUpAt <= DATEADD(day, @days, GETUTCDATE())
     ORDER BY followUpAt ASC`,
    (req) => req.input('userId', sql.Int, userId).input('days', sql.Int, days)
  );
}

// Aggregate stats for the module panel + page stats strip.
async function getStats(userId) {
  const result = await repo.query(
    `SELECT status, COUNT(*) AS c FROM JobApplications WHERE userId = @userId GROUP BY status`,
    (req) => req.input('userId', sql.Int, userId)
  );
  const byStatus = {};
  for (const r of result) byStatus[r.status] = r.c;
  const total = result.reduce((s, r) => s + r.c, 0);
  const weekStart = await repo.query(
    `SELECT COUNT(*) AS c FROM JobApplications
     WHERE userId = @userId AND appliedAt >= DATEADD(day, -6, CAST(GETUTCDATE() AS date))`,
    (req) => req.input('userId', sql.Int, userId)
  );
  const active = ['applied', 'screening', 'assessment', 'interview', 'offer'];
  const interviews = (byStatus.interview || 0) + (byStatus.offer || 0) + (byStatus.hired || 0);
  const offers = (byStatus.offer || 0) + (byStatus.hired || 0);
  return {
    total,
    appliedThisWeek: weekStart[0]?.c ?? 0,
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
