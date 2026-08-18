// controllers/jobApplicationController.js
// Job Applications module (MOD-1): owner-scoped CRUD + stats. Any authenticated
// user manages their OWN applications (userId comes from the token).

const model = require('../models/jobApplicationModel');
const { NotFoundError } = require('../utils/errors');

function userIdOf(req) {
  return req.user.userID ?? req.user.id;
}

function pick(data) {
  // Only allow known fields; coerce empty strings to null.
  const clean = (v) => (v === undefined || v === null || v === '' ? null : v);
  return {
    company: clean(data?.company),
    role: clean(data?.role),
    source: model.SOURCES.includes(data?.source) ? data.source : 'other',
    jobUrl: clean(data?.jobUrl),
    status: model.STATUSES.includes(data?.status) ? data.status : 'applied',
    appliedAt: clean(data?.appliedAt),
    followUpAt: clean(data?.followUpAt),
    salary: clean(data?.salary),
    location: clean(data?.location),
    notes: clean(data?.notes),
    contact: clean(data?.contact),
    resumePath: clean(data?.resumePath),
    tags: clean(data?.tags),
  };
}

// GET /api/applications?status=&source=&q= — list the caller's applications.
async function list(req, res, next) {
  try {
    const apps = await model.getApplicationsByUser(userIdOf(req), {
      status: req.query.status || undefined,
      source: req.query.source || undefined,
      q: req.query.q || undefined,
    });
    res.json(apps);
  } catch (err) {
    next(err);
  }
}

// GET /api/applications/stats — aggregate counts for the caller.
async function stats(req, res, next) {
  try {
    res.json(await model.getStats(userIdOf(req)));
  } catch (err) {
    next(err);
  }
}

// GET /api/applications/follow-ups?days=7 — applications with a follow-up that is
// overdue or due within the next `days` days (owner-scoped). Registered BEFORE
// /:id in the router so the literal segment wins.
async function followUps(req, res, next) {
  try {
    let days = Number.parseInt(req.query.days, 10);
    if (!Number.isFinite(days) || days < 1) days = 7;
    if (days > 365) days = 365;
    res.json(await model.getFollowUps(userIdOf(req), days));
  } catch (err) {
    next(err);
  }
}

// POST /api/applications — create an application.
async function create(req, res, next) {
  try {
    const data = pick(req.body);
    if (!data.company || !data.role) {
      return res.status(400).json({ error: 'Company and role are required' });
    }
    const id = await model.createApplication(userIdOf(req), data);
    res.json({ success: true, id });
  } catch (err) {
    next(err);
  }
}

// GET /api/applications/:id — one application (owner only).
async function getOne(req, res, next) {
  try {
    const app = await model.getApplicationById(Number(req.params.id), userIdOf(req));
    if (!app) throw new NotFoundError('Application not found');
    res.json(app);
  } catch (err) {
    next(err);
  }
}

// PUT /api/applications/:id — update (owner only). Used by the edit form and
// by kanban drag (status change). Only fields present in the body are applied,
// so a partial update (e.g. just a status change) never blanks the others.
async function update(req, res, next) {
  try {
    const id = Number(req.params.id);
    const app = await model.getApplicationById(id, userIdOf(req));
    if (!app) throw new NotFoundError('Application not found');
    const data = pick(req.body);
    const body = req.body || {};
    const merged = { ...app };
    for (const key of Object.keys(data)) {
      if (Object.prototype.hasOwnProperty.call(body, key)) merged[key] = data[key];
    }
    await model.updateApplication(id, userIdOf(req), merged);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/applications/:id — remove (owner only).
async function remove(req, res, next) {
  try {
    const removed = await model.deleteApplication(Number(req.params.id), userIdOf(req));
    if (!removed) throw new NotFoundError('Application not found');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, stats, followUps, create, getOne, update, remove };
