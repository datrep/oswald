// middlewares/validators.js — shared Joi schemas for request payloads.
// Replaces the hand-rolled validation scattered across controllers, and shares
// the drag-to-reorder schema that was previously copy-pasted between the task
// and resource controllers.

const Joi = require('joi');

// --- Drag-to-reorder (tasks + resources share this) -------------------------
const reorderSchema = Joi.object({
  edictId: Joi.number().integer().required(),
  orderedIds: Joi.array().items(Joi.number().integer()).min(1).required(),
}).unknown(true);

function validateReorder(req, res, next) {
  const { error, value } = reorderSchema.validate(req.body || {});
  if (error) return res.status(400).json({ error: error.details[0].message });
  req.body = value; // normalized: edictId + orderedIds are now numbers
  next();
}

// --- Task create -------------------------------------------------------------
const taskCreateSchema = Joi.object({
  name: Joi.string().min(1).max(255).required(),
  plannedStart: Joi.date().iso().required(),
  plannedEnd: Joi.date().iso().min(Joi.ref('plannedStart')).allow(null),
  info: Joi.string().allow('', null),
  priority: Joi.number().integer().min(0).max(10).allow(null),
  state: Joi.number().integer().min(0).max(3).allow(null),
  assignedToUserId: Joi.number().integer().allow(null),
  edictId: Joi.number().integer().required(),
}).unknown(true);

function validateTaskCreate(req, res, next) {
  const { error, value } = taskCreateSchema.validate(req.body || {});
  if (error) return res.status(400).json({ error: error.details[0].message });
  req.body = value;
  next();
}

// --- Resource create / attach -------------------------------------------------
// The frontend historically sends the policy id as `edictID` (and older code
// tolerated `edictid`). Normalize all three casings to `edictId` so downstream
// code and the schema see a single field.
function normalizeResourceEdictId(req, res, next) {
  const b = req.body || {};
  if (b.edictId === undefined && b.edictID !== undefined) b.edictId = b.edictID;
  else if (b.edictId === undefined && b.edictid !== undefined) b.edictId = b.edictid;
  delete b.edictID;
  delete b.edictid;
  next();
}

const resourceCreateSchema = Joi.object({
  edictId: Joi.number().integer().required(),
  description: Joi.string().allow('', null),
}).unknown(true);

function validateResourceCreate(req, res, next) {
  const { error, value } = resourceCreateSchema.validate(req.body || {});
  if (error) return res.status(400).json({ error: error.details[0].message });
  req.body = value;
  next();
}

const resourceAttachSchema = Joi.object({
  edictId: Joi.number().integer().required(),
  resourcePath: Joi.string().trim().min(1).required(),
  description: Joi.string().allow('', null),
}).unknown(true);

function validateResourceAttach(req, res, next) {
  const { error, value } = resourceAttachSchema.validate(req.body || {});
  if (error) return res.status(400).json({ error: error.details[0].message });
  req.body = value;
  next();
}

// --- Users: login + register ---------------------------------------------------
const loginSchema = Joi.object({
  username: Joi.string().min(1).required(),
  password: Joi.string().min(1).required(),
}).unknown(true);

function validateLogin(req, res, next) {
  const { error } = loginSchema.validate(req.body || {});
  if (error) return res.status(400).json({ error: error.details[0].message });
  next();
}

const registerSchema = Joi.object({
  username: Joi.string().min(1).required(),
  password: Joi.string().min(1).required(),
}).unknown(true);

function validateRegister(req, res, next) {
  const { error } = registerSchema.validate(req.body || {});
  if (error) return res.status(400).json({ error: error.details[0].message });
  next();
}

// --- IP monitoring: host create -------------------------------------------------
const hostCreateSchema = Joi.object({
  label: Joi.string().min(1).required(),
  ip: Joi.string().min(1).required(),
  enabled: Joi.boolean().optional(),
  sortOrder: Joi.number().integer().optional(),
}).unknown(true);

function validateHostCreate(req, res, next) {
  const { error } = hostCreateSchema.validate(req.body || {});
  if (error) return res.status(400).json({ error: error.details[0].message });
  next();
}

// --- Certifications: create -------------------------------------------------------
const certificationCreateSchema = Joi.object({
  name: Joi.string().min(1).required(),
}).unknown(true);

function validateCertificationCreate(req, res, next) {
  const { error } = certificationCreateSchema.validate(req.body || {});
  if (error) return res.status(400).json({ error: error.details[0].message });
  next();
}

// --- Job applications: create -------------------------------------------------------
const applicationCreateSchema = Joi.object({
  company: Joi.string().min(1).required(),
  role: Joi.string().min(1).required(),
}).unknown(true);

function validateApplicationCreate(req, res, next) {
  const { error } = applicationCreateSchema.validate(req.body || {});
  if (error) return res.status(400).json({ error: error.details[0].message });
  next();
}

module.exports = {
  validateReorder,
  validateTaskCreate,
  normalizeResourceEdictId,
  validateResourceCreate,
  validateResourceAttach,
  validateLogin,
  validateRegister,
  validateHostCreate,
  validateCertificationCreate,
  validateApplicationCreate,
};
