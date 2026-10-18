// controllers/certificationController.js
// Certificate Dashboard: owner-scoped CRUD + stats + expiry alerts. Any
// authenticated user manages their OWN certifications (userId from the token).

const model = require('../models/certificationModel');
const { NotFoundError, asyncHandler } = require('../utils/errors');

function userIdOf(req) {
  return req.user.userID;
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
const list = asyncHandler(async (req, res) => {
  res.json(await model.getCertificationsByUser(userIdOf(req), {
    status: req.query.status || undefined,
    q: req.query.q || undefined,
  }));
});

// GET /api/certifications/stats — aggregate counts for the caller.
const stats = asyncHandler(async (req, res) => {
  res.json(await model.getStats(userIdOf(req)));
});

// GET /api/certifications/expiries?days=90 — certs overdue or expiring within
// `days` days (owner-scoped). Registered BEFORE /:id so the literal wins.
const expiries = asyncHandler(async (req, res) => {
  let days = Number.parseInt(req.query.days, 10);
  if (!Number.isFinite(days) || days < 1) days = 90;
  if (days > 3650) days = 3650;
  res.json(await model.getExpiries(userIdOf(req), days));
});

// POST /api/certifications — create.
const create = asyncHandler(async (req, res) => {
  const data = pick(req.body);
  if (!data.name) {
    return res.status(400).json({ error: 'Name is required' });
  }
  const id = await model.createCertification(userIdOf(req), data);
  res.json({ success: true, id });
});

// GET /api/certifications/:id — one (owner only).
const getOne = asyncHandler(async (req, res) => {
  const cert = await model.getCertificationById(Number(req.params.id), userIdOf(req));
  if (!cert) throw new NotFoundError('Certification not found');
  res.json(cert);
});

// PUT /api/certifications/:id — update (owner only). Only fields present in the
// body are applied, so a partial update never blanks the others.
const update = asyncHandler(async (req, res) => {
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
});

// DELETE /api/certifications/:id — remove (owner only).
const remove = asyncHandler(async (req, res) => {
  const removed = await model.deleteCertification(Number(req.params.id), userIdOf(req));
  if (!removed) throw new NotFoundError('Certification not found');
  res.json({ success: true });
});

module.exports = { list, stats, expiries, create, getOne, update, remove };
