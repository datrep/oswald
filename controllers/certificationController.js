// controllers/certificationController.js
// Certificate Dashboard: owner-scoped CRUD + stats + expiry alerts. Any
// authenticated user manages their OWN certifications (userId from the token).

const model = require('../models/certificationModel');
const { NotFoundError } = require('../utils/errors');

function userIdOf(req) {
  return req.user.userID ?? req.user.id;
}

function pick(data) {
  // Only allow known fields; coerce empty strings to null.
  const clean = (v) => (v === undefined || v === null || v === '' ? null : v);
  return {
    name: clean(data?.name),
    issuer: clean(data?.issuer),
    status: model.STATUSES.includes(data?.status) ? data.status : 'planned',
    startAt: clean(data?.startAt),
    obtainedAt: clean(data?.obtainedAt),
    expiryAt: clean(data?.expiryAt),
    credential: clean(data?.credential),
    careerFilePath: clean(data?.careerFilePath),
    studyLinks: clean(data?.studyLinks),
    notes: clean(data?.notes),
    tags: clean(data?.tags),
  };
}

// GET /api/certifications?status=&q= — list the caller's certifications.
async function list(req, res, next) {
  try {
    const certs = await model.getCertificationsByUser(userIdOf(req), {
      status: req.query.status || undefined,
      q: req.query.q || undefined,
    });
    res.json(certs);
  } catch (err) {
    next(err);
  }
}

// GET /api/certifications/stats — aggregate counts for the caller.
async function stats(req, res, next) {
  try {
    res.json(await model.getStats(userIdOf(req)));
  } catch (err) {
    next(err);
  }
}

// GET /api/certifications/expiries?days=90 — certs overdue or expiring within
// `days` days (owner-scoped). Registered BEFORE /:id so the literal wins.
async function expiries(req, res, next) {
  try {
    let days = Number.parseInt(req.query.days, 10);
    if (!Number.isFinite(days) || days < 1) days = 90;
    if (days > 3650) days = 3650;
    res.json(await model.getExpiries(userIdOf(req), days));
  } catch (err) {
    next(err);
  }
}

// POST /api/certifications — create.
async function create(req, res, next) {
  try {
    const data = pick(req.body);
    if (!data.name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const id = await model.createCertification(userIdOf(req), data);
    res.json({ success: true, id });
  } catch (err) {
    next(err);
  }
}

// GET /api/certifications/:id — one (owner only).
async function getOne(req, res, next) {
  try {
    const cert = await model.getCertificationById(Number(req.params.id), userIdOf(req));
    if (!cert) throw new NotFoundError('Certification not found');
    res.json(cert);
  } catch (err) {
    next(err);
  }
}

// PUT /api/certifications/:id — update (owner only). Only fields present in the
// body are applied, so a partial update never blanks the others.
async function update(req, res, next) {
  try {
    const id = Number(req.params.id);
    const cert = await model.getCertificationById(id, userIdOf(req));
    if (!cert) throw new NotFoundError('Certification not found');
    const data = pick(req.body);
    const body = req.body || {};
    const merged = { ...cert };
    for (const key of Object.keys(data)) {
      if (Object.prototype.hasOwnProperty.call(body, key)) merged[key] = data[key];
    }
    await model.updateCertification(id, userIdOf(req), merged);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/certifications/:id — remove (owner only).
async function remove(req, res, next) {
  try {
    const removed = await model.deleteCertification(Number(req.params.id), userIdOf(req));
    if (!removed) throw new NotFoundError('Certification not found');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, stats, expiries, create, getOne, update, remove };
