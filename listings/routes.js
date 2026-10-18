// listings/routes.js — REST API for the Listing Workbench (LST-4).
// Mounted at /api/listings (all owner-scoped, authenticateToken only).
'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { authenticateToken } = require('./auth');
const store = require('./store');
const { parseListingText } = require('./parser');

const router = express.Router();
router.use(authenticateToken);

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- value coercion helpers --------------------------------------------------
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
const B = (v) => v === true || v === 1 || v === '1' || v === 'true';

const intParam = (req, name) => {
  const n = Number(req.params[name]);
  return Number.isInteger(n) ? n : null;
};

function cleanListing(b) {
  return {
    listingNo: N(b.listingNo), title: S(b.title), description: S(b.description), category: S(b.category),
    condition: S(b.condition), sellingPrice: N(b.sellingPrice), status: S(b.status) || 'draft',
    carousellUrl: S(b.carousellUrl), images: b.images ?? null, likes: N(b.likes), wantCount: N(b.wantCount),
    capturedAt: D(b.capturedAt), other: S(b.other), dateSold: D(b.dateSold), notes: S(b.notes),
  };
}
const cleanInventory = (b) => ({
  itemName: S(b.itemName), category: S(b.category), partTypeSpec: S(b.partTypeSpec),
  quantity: N(b.quantity) ?? 0, condition: S(b.condition), location: S(b.location),
  dateAdded: D(b.dateAdded), valueCost: N(b.valueCost), notes: S(b.notes),
});
const cleanPrice = (b) => ({ componentName: S(b.componentName), currentPrice: N(b.currentPrice) });
const cleanLedger = (b) => ({
  date: D(b.date), type: S(b.type), description: S(b.description), category: S(b.category),
  qty: N(b.qty), amount: N(b.amount),
  payment: S(b.payment), ref: S(b.ref), notes: S(b.notes),
});
const cleanComp = (b) => ({
  listingId: N(b.listingId), title: S(b.title), competitorPrice: N(b.competitorPrice),
  specSummary: S(b.specSummary), condition: S(b.condition), category: S(b.category),
  deliveryFee: N(b.deliveryFee), likes: N(b.likes), wantCount: N(b.wantCount),
  sellerRating: N(b.sellerRating), sellerReviewCount: N(b.sellerReviewCount), sellerOrders: N(b.sellerOrders),
  sellerTenure: S(b.sellerTenure), isProfessionalSeller: B(b.isProfessionalSeller) ? true : null,
  sourceUrl: S(b.sourceUrl), seenAt: D(b.seenAt), notes: S(b.notes),
});
const cleanPartsToOrder = (b) => ({
  componentName: S(b.componentName), qty: N(b.qty) ?? 1, estCost: N(b.estCost),
  sourceUrl: S(b.sourceUrl), notes: S(b.notes),
});

// --- listings (with derived profit) -----------------------------------------
router.get('/listings', h(async (req, res) => {
  const rows = await store.listListings(req.user.userID, { status: req.query.status || null });
  const settings = await store.getCostSettings();
  res.json({ listings: rows.map((l) => ({ ...l, ...store.profitFor(l, settings) })) });
}));

router.get('/listings/:id', h(async (req, res) => {
  const id = intParam(req, 'id');
  if (id === null) return res.status(400).json({ error: 'Invalid id' });
  const l = await store.getListing(req.user.userID, id);
  if (!l) return res.status(404).json({ error: 'Listing not found' });
  const settings = await store.getCostSettings();
  const totalCost = (l.parts || []).reduce((s, p) => s + (Number(p.partCost) || 0), 0);
  res.json({ ...l, ...store.profitFor({ sellingPrice: l.sellingPrice, totalCost }, settings) });
}));

// ★★ LST-7: a stored condition must be one of the Lookups values.
//
// WHY: the column is an ENUM in intent and a free VARCHAR in fact, so anyone writing through the API could store
// anything — and the record shows it did: `InventoryItems.condition` carries "dusty.", "quite a bit of rust"
// and "dusty , unknown working" (x3), which are OBSERVATIONS typed into a field that means a chosen value.
// The UI offers a dropdown built from Lookups, so the path that bypassed it is every non-UI writer.
//
// THREE RULES, each of which is a way this could be got wrong:
//   * NULL / empty is ALLOWED. "Not yet decided" is a real state — 89 InventoryItems rows and 1 Listings row
//     are legitimately NULL — and a validator that refuses NULL would force a fabricated value.
//   * AN EMPTY LOOKUP FAILS OPEN. If the Lookups table is empty or the key is unknown, there is no enum to
//     enforce, and refusing every write would take the Workbench down rather than protect it.
//   * EXACT MATCH, INCLUDING THE EN DASH. `Used \u2013 working` uses U+2013; an ASCII-hyphen variant is a
//     DIFFERENT string and is refused, which is the point — the task records this field having carried two
//     spellings of the same value. The error names the allowed values verbatim so the caller can copy one.
async function lookupViolation(listKey, value, label) {
  if (value == null || String(value).trim() === '') return null;
  const allowed = await store.lookupValues(listKey);
  if (!allowed.length) return null;
  if (allowed.includes(String(value))) return null;
  return `${label} must be one of: ${allowed.map((v) => JSON.stringify(v)).join(', ')} — got ${JSON.stringify(String(value))}`;
}

router.post('/listings', h(async (req, res) => {
  const data = cleanListing(req.body || {});
  if (!data.title) return res.status(400).json({ error: 'title is required' });
  const bad = await lookupViolation('condition', data.condition, 'condition');
  if (bad) return res.status(400).json({ error: bad });
  const l = await store.createListing(req.user.userID, data, req.body.parts);
  res.status(201).json(l);
}));

router.put('/listings/:id', h(async (req, res) => {
  const id = intParam(req, 'id');
  if (id === null) return res.status(400).json({ error: 'Invalid id' });
  const data = cleanListing(req.body || {});
  if (!data.title) return res.status(400).json({ error: 'title is required' });
  const bad = await lookupViolation('condition', data.condition, 'condition');
  if (bad) return res.status(400).json({ error: bad });
  const l = await store.updateListing(req.user.userID, id, data, req.body.parts);
  if (!l) return res.status(404).json({ error: 'Listing not found' });
  res.json(l);
}));

router.delete('/listings/:id', h(async (req, res) => {
  const id = intParam(req, 'id');
  if (id === null) return res.status(400).json({ error: 'Invalid id' });
  const ok = await store.deleteListing(req.user.userID, id);
  res.status(ok ? 204 : 404).end();
}));

// --- hardware discovery (option 6) ------------------------------------------
// Runs the firmware script in discover-only mode on THIS machine and stores the
// resulting inventory JSON against the listing.
router.post('/listings/:id/discover', h(async (req, res) => {
  const id = intParam(req, 'id');
  if (id === null) return res.status(400).json({ error: 'Invalid id' });
  const l = await store.getListing(req.user.userID, id);
  if (!l) return res.status(404).json({ error: 'Listing not found' });

  const script = path.join(__dirname, '..', 'scripts', 'firmware', 'Update-Firmware.ps1');
  const tmp = path.join(os.tmpdir(), `oswald-discover-${Date.now()}-${id}.json`);

  await new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Component', 'consumer', '-DiscoverOnly', '-OutputPath', tmp,
    ], { windowsHide: true });
    let out = '', errOut = '';
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.stderr.on('data', (d) => { errOut += d.toString(); });
    ps.on('error', reject);
    ps.on('close', (code) => {
      if (code !== 0) reject(new Error((errOut || out || `PowerShell exited ${code}`).trim().slice(0, 600)));
      else resolve();
    });
  });

  let inventory = null;
  try {
    inventory = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  } catch (e) {
    throw new Error('Discovery ran but produced no readable inventory: ' + e.message);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }

  await store.setInventory(req.user.userID, id, JSON.stringify(inventory));
  res.json({ id, capturedAt: new Date().toISOString(), inventory });
}));

// --- generic single-table CRUD ----------------------------------------------
function crudRoutes(path, crud, spec, clean, required, listOverride) {
  router.get(path, h(async (req, res) =>
    res.json({ items: listOverride ? await listOverride(req.user.userID) : await crud.list(req.user.userID) })));
  router.post(path, h(async (req, res) => {
    const data = clean(req.body || {});
    const missing = required && required(data);
    if (missing) return res.status(400).json({ error: missing + ' is required' });
    const id = await crud.create(req.user.userID, data, spec);
    res.status(201).json({ id });
  }));
  router.put(`${path}/:id`, h(async (req, res) => {
    const id = intParam(req, 'id');
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const ok = await crud.update(req.user.userID, id, clean(req.body || {}), spec);
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'Not found' });
  }));
  router.delete(`${path}/:id`, h(async (req, res) => {
    const id = intParam(req, 'id');
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const ok = await crud.remove(req.user.userID, id);
    res.status(ok ? 204 : 404).end();
  }));
}

crudRoutes('/inventory', store.inventory, store.inventorySpec, cleanInventory, (d) => !d.itemName && 'itemName');
crudRoutes('/ledger', store.ledger, store.ledgerSpec, cleanLedger, null, store.listLedger);
crudRoutes('/comps', store.comps, store.compSpec, cleanComp, null);
crudRoutes('/parts-to-order', store.partsToOrder, store.partsToOrderSpec, cleanPartsToOrder, (d) => !d.componentName && 'componentName');

// --- prices (with purchase log -> weighted-average cost) ---------------------
router.get('/prices', h(async (req, res) => res.json({ items: await store.listPrices(req.user.userID) })));
router.get('/prices/:id', h(async (req, res) => {
  const id = intParam(req, 'id');
  if (id === null) return res.status(400).json({ error: 'Invalid id' });
  const p = await store.getPrice(req.user.userID, id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
}));
router.post('/prices', h(async (req, res) => {
  const data = cleanPrice(req.body || {});
  if (!data.componentName) return res.status(400).json({ error: 'componentName is required' });
  const p = await store.upsertPrice(req.user.userID, null, data, req.body.purchases);
  res.status(201).json(p);
}));
router.put('/prices/:id', h(async (req, res) => {
  const id = intParam(req, 'id');
  if (id === null) return res.status(400).json({ error: 'Invalid id' });
  const data = cleanPrice(req.body || {});
  if (!data.componentName) return res.status(400).json({ error: 'componentName is required' });
  const p = await store.upsertPrice(req.user.userID, id, data, req.body.purchases);
  res.json(p);
}));
router.delete('/prices/:id', h(async (req, res) => {
  const id = intParam(req, 'id');
  if (id === null) return res.status(400).json({ error: 'Invalid id' });
  const ok = await store.deletePrice(req.user.userID, id);
  res.status(ok ? 204 : 404).end();
}));

// --- ledger summary (must precede any /ledger/:id GET, though none exist) ----
router.get('/ledger/summary', h(async (req, res) => res.json(await store.ledgerSummary(req.user.userID))));

// --- lookups -----------------------------------------------------------------
router.get('/lookups', h(async (req, res) => res.json({ lookups: await store.listLookups() })));
router.post('/lookups', h(async (req, res) => {
  const listKey = S(req.body.listKey);
  const value = S(req.body.value);
  if (!listKey || !value) return res.status(400).json({ error: 'listKey and value are required' });
  const id = await store.addLookup(listKey, value);
  res.status(201).json({ id });
}));
router.delete('/lookups/:id', h(async (req, res) => {
  const id = intParam(req, 'id');
  if (id === null) return res.status(400).json({ error: 'Invalid id' });
  const ok = await store.deleteLookup(id);
  res.status(ok ? 204 : 404).end();
}));

// --- cost settings -----------------------------------------------------------
router.get('/cost-settings', h(async (req, res) => res.json(await store.getCostSettings())));
router.put('/cost-settings', h(async (req, res) => {
  const settings = await store.updateCostSettings({
    platformFeePct: N(req.body.platformFeePct) ?? 0,
    paymentFeePct: N(req.body.paymentFeePct) ?? 0,
    shippingCost: N(req.body.shippingCost) ?? 0,
    profitWarn: N(req.body.profitWarn) ?? 0,
    profitDanger: N(req.body.profitDanger) ?? -20,
  });
  res.json({ settings });
}));

// --- global recalc: re-derive profit for every non-sold / non-draft listing ---
router.post('/recalc', h(async (req, res) => {
  const rows = await store.listListings(req.user.userID);
  const settings = await store.getCostSettings();
  const affected = rows
    .filter((l) => l.status !== 'sold' && l.status !== 'draft')
    .map((l) => ({ id: l.id, listingNo: l.listingNo, title: l.title, status: l.status, ...store.profitFor(l, settings) }));
  const totalNet = store.round2(affected.reduce((s, l) => s + l.netProfit, 0));
  res.json({ settings, affectedCount: affected.length, totalNet, affected });
}));

// --- stats -------------------------------------------------------------------
router.get('/stats', h(async (req, res) => res.json(await store.stats(req.user.userID))));

// --- Carousell paste-parse (LST-6) -------------------------------------------
router.post('/parse', h(async (req, res) => {
  const text = S(req.body.text);
  if (!text) return res.status(400).json({ error: 'text is required' });
  const mode = req.body.mode === 'comp' ? 'comp' : 'listing';
  res.json(parseListingText(text, { mode }));
}));

// --- Carousell insights pull (LST-7) -----------------------------------------
// Spawns the Playwright puller (same pattern as /discover), stores the JSON
// snapshot and returns it. Blocks for the duration of the pull (~30-60s).
router.post('/insights/pull', h(async (req, res) => {
  const script = path.join(__dirname, 'scripts', 'pull-carousell-insights.js');
  const output = await new Promise((resolve, reject) => {
    const ps = spawn(process.execPath, [script], { windowsHide: true, cwd: path.join(__dirname, 'scripts') });
    let out = '', errOut = '';
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.stderr.on('data', (d) => { errOut += d.toString(); });
    ps.on('error', reject);
    ps.on('close', (code) => {
      if (code !== 0) reject(new Error((errOut || out || `puller exited ${code}`).trim().slice(0, 800)));
      else resolve(out.trim());
    });
  });
  let payload;
  try {
    payload = JSON.parse(output);
  } catch (e) {
    throw new Error('Puller returned non-JSON output: ' + output.slice(0, 400));
  }
  const saved = await store.saveInsights(req.user.userID, payload);
  res.json({ id: saved.id, capturedAt: saved.capturedAt, payload });
}));

router.get('/insights', h(async (req, res) => {
  res.json(await store.latestInsights(req.user.userID));
}));

module.exports = router;
