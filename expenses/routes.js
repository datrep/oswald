// expenses/routes.js — REST API for the General Expense Sheet.
// Mounted at /api/expenses (all owner-scoped, authenticateToken only).
'use strict';

const express = require('express');
const { authenticateToken } = require('./auth');
const store = require('./store');

const router = express.Router();
router.use(authenticateToken);

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const S = (v) => (v === undefined || v === null || v === '' ? null : String(v));
const N = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const D = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const intParam = (req, name) => {
  const n = Number(req.params[name]);
  return Number.isInteger(n) ? n : null;
};

function cleanExpense(b) {
  const category = String(b.category || '').trim().toLowerCase();
  const platform = String(b.platform || '').trim().toLowerCase();
  return {
    category: store.CATEGORIES.includes(category) ? category : null,
    description: S(b.description),
    amount: N(b.amount),
    platform: store.PLATFORMS.includes(platform) ? platform : null,
    tags: S(b.tags),
    expenseDate: D(b.expenseDate),
  };
}

router.get('/', h(async (req, res) => {
  res.json({ items: await store.listExpenses(req.user.userID, { category: req.query.category || null, month: req.query.month || null }) });
}));

router.get('/stats', h(async (req, res) => {
  res.json(await store.stats(req.user.userID, { month: req.query.month || null }));
}));

router.post('/sync', h(async (req, res) => {
  const imported = await store.syncFromLedger(req.user.userID);
  res.json({ imported });
}));

router.post('/', h(async (req, res) => {
  const data = cleanExpense(req.body || {});
  if (!data.category) return res.status(400).json({ error: 'category is required (computer|investing|school|other)' });
  if (data.amount === null || data.amount === undefined) return res.status(400).json({ error: 'amount is required' });
  const id = await store.createExpense(req.user.userID, data);
  res.status(201).json({ id });
}));

router.put('/:id', h(async (req, res) => {
  const id = intParam(req, 'id');
  if (id === null) return res.status(400).json({ error: 'Invalid id' });
  const data = cleanExpense(req.body || {});
  if (!data.category) return res.status(400).json({ error: 'category is required' });
  if (data.amount === null || data.amount === undefined) return res.status(400).json({ error: 'amount is required' });
  const ok = await store.updateExpense(req.user.userID, id, data);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'Not found' });
}));

router.delete('/:id', h(async (req, res) => {
  const id = intParam(req, 'id');
  if (id === null) return res.status(400).json({ error: 'Invalid id' });
  const ok = await store.deleteExpense(req.user.userID, id);
  res.status(ok ? 204 : 404).end();
}));

module.exports = router;
