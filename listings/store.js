// listings/store.js — data access for the Listing Workbench (LST-4).
// All queries are owner-scoped (userId). Profit figures are DERIVED on read
// (never stored), so changing CostSettings immediately re-derives every listing.
'use strict';

const { getPool, sql } = require('./db');

const round2 = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round((v + Number.EPSILON) * 100) / 100;
};

// ---------------------------------------------------------------------------
// Profit derivation
// ---------------------------------------------------------------------------
// totalCost is summed in SQL; the fee/shipping layer comes from CostSettings.
function profitFor(listing, settings) {
  const price = Number(listing.sellingPrice) || 0;
  const totalCost = Number(listing.totalCost) || 0;
  const platformFee = round2((price * (Number(settings.platformFeePct) || 0)) / 100);
  const paymentFee = round2((price * (Number(settings.paymentFeePct) || 0)) / 100);
  const shipping = Number(settings.shippingCost) || 0;
  const grossMargin = round2(price - totalCost);
  const netProfit = round2(grossMargin - platformFee - paymentFee - shipping);
  return { totalCost: round2(totalCost), grossMargin, platformFee, paymentFee, shipping, netProfit };
}

// ---------------------------------------------------------------------------
// Listings + parts
// ---------------------------------------------------------------------------
async function listListings(userId, { status } = {}) {
  const pool = await getPool();
  const req = pool.request().input('userId', sql.Int, userId);
  let where = 'l.userId = @userId';
  if (status) {
    where += ' AND l.status = @status';
    req.input('status', sql.NVarChar(20), status);
  }
  const r = await req.query(`
    SELECT l.*,
      (SELECT SUM(p.partCost) FROM ListingParts p WHERE p.listingId = l.id) AS totalCost,
      (SELECT COUNT(*) FROM ListingParts p WHERE p.listingId = l.id) AS partCount
    FROM Listings l
    WHERE ${where}
    ORDER BY l.listingNo, l.id`);
  return r.recordset;
}

async function getListing(userId, id) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).input('id', sql.Int, id)
    .query('SELECT * FROM Listings WHERE id = @id AND userId = @userId');
  const listing = r.recordset[0] || null;
  if (!listing) return null;
  const pr = await pool.request().input('listingId', sql.Int, id)
    .query('SELECT * FROM ListingParts WHERE listingId = @listingId ORDER BY sortOrder, id');
  return { ...listing, parts: pr.recordset };
}

function applyListingInputs(req, data) {
  return req
    .input('listingNo', sql.Int, data.listingNo ?? null)
    .input('title', sql.NVarChar(255), data.title)
    .input('description', sql.NVarChar(sql.MAX), data.description ?? null)
    .input('category', sql.NVarChar(50), data.category ?? null)
    .input('condition', sql.NVarChar(50), data.condition ?? null)
    .input('sellingPrice', sql.Decimal(10, 2), data.sellingPrice ?? null)
    .input('status', sql.NVarChar(20), data.status || 'draft')
    .input('carousellUrl', sql.NVarChar(1000), data.carousellUrl ?? null)
    .input('images', sql.NVarChar(sql.MAX), data.images ? JSON.stringify(data.images) : null)
    .input('likes', sql.Int, data.likes ?? null)
    .input('wantCount', sql.Int, data.wantCount ?? null)
    .input('capturedAt', sql.DateTime2, data.capturedAt ?? null)
    .input('other', sql.NVarChar(sql.MAX), data.other ?? null)
    .input('dateSold', sql.DateTime2, data.dateSold ?? null)
    .input('notes', sql.NVarChar(sql.MAX), data.notes ?? null);
}

async function replaceParts(tx, listingId, parts) {
  await tx.request().input('listingId', sql.Int, listingId).query('DELETE FROM ListingParts WHERE listingId = @listingId');
  const list = Array.isArray(parts) ? parts : [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i] || {};
    const partType = String(p.partType || '').trim().toLowerCase();
    if (!partType) continue;
    const partName = String(p.partName || '').trim();
    if (!partName && (p.partCost === null || p.partCost === undefined || p.partCost === '')) continue;
    await tx.request()
      .input('listingId', sql.Int, listingId)
      .input('partType', sql.NVarChar(20), partType)
      .input('partName', sql.NVarChar(255), partName || null)
      .input('partCost', sql.Decimal(10, 2), p.partCost ?? null)
      // ★ LST-15: the VALUATION DATE behind this cost, so a margin can state its vintage.
      //
      // ⚠ NULL IS THE DEFAULT AND IT MEANS "VINTAGE UNKNOWN" — it does NOT mean "valued today". The 108
      // existing rows are all NULL on purpose: `partName` is free text, not a reference to InventoryItems
      // (measured 6 of 108 matched by name), so back-filling a date from the July sheet would have put a
      // confident, wrong vintage on 94% of the sheet. Stamping `new Date()` here would be worse still — it
      // would date a July figure to today.
      //
      // A DATE MUST ARRIVE FROM THE CALLER, because only the caller knows when the figure was valued. When the
      // revaluation path lands it will stamp this from the sheet vintage in force at the time.
      .input('costAsOf', sql.Date, parseDateOnly(p.costAsOf))
      .input('sortOrder', sql.Int, i)
      .query('INSERT INTO ListingParts (listingId, partType, partName, partCost, costAsOf, sortOrder) VALUES (@listingId, @partType, @partName, @partCost, @costAsOf, @sortOrder)');
  }
}

// Parse a date the caller supplied, or return null. An INVALID date is refused rather than coerced:
// `new Date('nonsense')` is an Invalid Date, and passing that to a sql.Date column would fail at the database
// instead of at the caller — the TRD-43 `level()` lesson (reject before coercing, never let a bad value reach
// the column). A bare `YYYY-MM-DD` is accepted as a calendar date, which is what a valuation vintage IS.
function parseDateOnly(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const d = new Date(`${s.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function createListing(userId, data, parts) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const ins = await applyListingInputs(tx.request().input('userId', sql.Int, userId), data)
      .query(`INSERT INTO Listings (userId, listingNo, title, description, category, condition, sellingPrice, status, carousellUrl, images, likes, wantCount, capturedAt, other, dateSold, notes)
              OUTPUT INSERTED.id
              VALUES (@userId, @listingNo, @title, @description, @category, @condition, @sellingPrice, @status, @carousellUrl, @images, @likes, @wantCount, @capturedAt, @other, @dateSold, @notes)`);
    const id = ins.recordset[0].id;
    await replaceParts(tx, id, parts);
    await tx.commit();
    return getListing(userId, id);
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
}

async function updateListing(userId, id, data, parts) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const upd = await applyListingInputs(tx.request().input('userId', sql.Int, userId).input('id', sql.Int, id), data)
      .query(`UPDATE Listings SET
        listingNo=@listingNo, title=@title, description=@description, category=@category, condition=@condition,
        sellingPrice=@sellingPrice, status=@status, carousellUrl=@carousellUrl, images=@images, likes=@likes,
        wantCount=@wantCount, capturedAt=@capturedAt, other=@other, dateSold=@dateSold, notes=@notes, updatedAt=GETUTCDATE()
        WHERE id=@id AND userId=@userId`);
    if (upd.rowsAffected[0] === 0) {
      await tx.rollback().catch(() => {});
      return null;
    }
    if (parts !== undefined) await replaceParts(tx, id, parts);
    await tx.commit();
    return getListing(userId, id);
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
}

async function deleteListing(userId, id) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    // Comps reference the listing with ON DELETE NO ACTION — remove them first.
    await tx.request().input('userId', sql.Int, userId).input('id', sql.Int, id)
      .query('DELETE FROM ListingComps WHERE listingId = @id AND userId = @userId');
    const r = await tx.request().input('userId', sql.Int, userId).input('id', sql.Int, id)
      .query('DELETE FROM Listings WHERE id = @id AND userId = @userId');
    await tx.commit();
    return r.rowsAffected[0] > 0;
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Generic single-table CRUD (owner-scoped, full-row update)
// ---------------------------------------------------------------------------
function makeCrud(table, idCol = 'id', { extraInputs } = {}) {
  const cols = (spec) => spec.map((c) => c[0]).join(', ');
  const vals = (spec) => spec.map((c) => '@' + c[0]).join(', ');
  const sets = (spec) => spec.filter((c) => c[0] !== 'userId').map((c) => `${c[0]}=@${c[0]}`).join(', ');

  return {
    async list(userId, orderBy = `${idCol} DESC`) {
      const pool = await getPool();
      const r = await pool.request().input('userId', sql.Int, userId)
        .query(`SELECT * FROM ${table} WHERE userId = @userId ORDER BY ${orderBy}`);
      return r.recordset;
    },
    async get(userId, id) {
      const pool = await getPool();
      const r = await pool.request().input('userId', sql.Int, userId).input('id', sql.Int, id)
        .query(`SELECT * FROM ${table} WHERE ${idCol} = @id AND userId = @userId`);
      return r.recordset[0] || null;
    },
    async create(userId, data, spec) {
      const pool = await getPool();
      const req = pool.request().input('userId', sql.Int, userId);
      for (const [col, type] of spec) req.input(col, type, data[col] ?? null);
      const r = await req.query(`INSERT INTO ${table} (userId, ${cols(spec)}) OUTPUT INSERTED.${idCol} VALUES (@userId, ${vals(spec)})`);
      return r.recordset[0][idCol];
    },
    async update(userId, id, data, spec) {
      const pool = await getPool();
      const req = pool.request().input('userId', sql.Int, userId).input('id', sql.Int, id);
      for (const [col, type] of spec) req.input(col, type, data[col] ?? null);
      const r = await req.query(`UPDATE ${table} SET ${sets(spec)} WHERE ${idCol} = @id AND userId = @userId`);
      return r.rowsAffected[0] > 0;
    },
    async remove(userId, id) {
      const pool = await getPool();
      const r = await pool.request().input('userId', sql.Int, userId).input('id', sql.Int, id)
        .query(`DELETE FROM ${table} WHERE ${idCol} = @id AND userId = @userId`);
      return r.rowsAffected[0] > 0;
    },
  };
}

const NV = (max) => sql.NVarChar(max);

const inventorySpec = [
  ['itemName', NV(255)], ['category', NV(50)], ['partTypeSpec', NV(255)], ['quantity', sql.Int],
  ['condition', NV(50)], ['location', NV(255)], ['dateAdded', sql.DateTime2], ['valueCost', sql.Decimal(10, 2)], ['notes', NV(sql.MAX)],
];
const priceSpec = [['componentName', NV(255)], ['currentPrice', sql.Decimal(10, 2)]];
const ledgerSpec = [
  ['date', sql.DateTime2], ['type', NV(20)], ['description', NV(255)], ['category', NV(50)],
  ['qty', sql.Decimal(10, 2)], ['amount', sql.Decimal(10, 2)],
  ['payment', NV(50)], ['ref', NV(255)], ['notes', NV(sql.MAX)],
];
const compSpec = [
  ['listingId', sql.Int], ['title', NV(255)], ['competitorPrice', sql.Decimal(10, 2)],
  ['specSummary', NV(sql.MAX)], ['condition', NV(50)], ['category', NV(50)], ['deliveryFee', sql.Decimal(10, 2)],
  ['likes', sql.Int], ['wantCount', sql.Int], ['sellerRating', sql.Decimal(3, 1)], ['sellerReviewCount', sql.Int],
  ['sellerOrders', sql.Int], ['sellerTenure', NV(50)], ['isProfessionalSeller', sql.Bit],
  ['sourceUrl', NV(1000)], ['seenAt', sql.DateTime2], ['notes', NV(sql.MAX)],
];
const partsToOrderSpec = [
  ['componentName', NV(255)], ['qty', sql.Int], ['estCost', sql.Decimal(10, 2)],
  ['sourceUrl', NV(1000)], ['notes', NV(sql.MAX)],
];

const inventory = makeCrud('InventoryItems');
const ledger = makeCrud('LedgerEntries');
const comps = makeCrud('ListingComps');
const partsToOrder = makeCrud('PartsToOrder');

// --- Ledger list with inferred unit + running balance ------------------------
// unitAmount and balance are NOT stored (dropped in migration 019). They are
// derived on read: unit = amount/qty, balance = chronological cumulative sum.
async function listLedger(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .query('SELECT * FROM LedgerEntries WHERE userId = @userId ORDER BY date, id');
  let bal = 0;
  for (const row of r.recordset) {
    const amount = Number(row.amount) || 0;
    const qty = Number(row.qty) || 0;
    row.unitAmount = qty > 0 ? Math.floor((amount / qty) * 100) / 100 : (amount !== 0 ? amount : null);
    bal = Math.floor((bal + amount) * 100) / 100;
    row.balance = bal;
  }
  return r.recordset;
}

// --- Part prices + purchases (weighted-average cost, floor 2dp) --------------
function weightedAverage(purchases) {
  const list = Array.isArray(purchases) ? purchases.filter((p) => (Number(p.qty) || 0) > 0) : [];
  const qty = list.reduce((s, p) => s + (Number(p.qty) || 0), 0);
  const cost = list.reduce((s, p) => s + (Number(p.qty) || 0) * (Number(p.unitPrice) || 0), 0);
  return qty > 0 ? Math.floor((cost / qty) * 100) / 100 : null;
}

async function listPrices(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).query(`
    SELECT p.*, (SELECT COUNT(*) FROM PartPurchases x WHERE x.partPriceId = p.id) AS purchaseCount
    FROM PartPrices p WHERE p.userId = @userId ORDER BY p.componentName`);
  return r.recordset;
}

async function getPrice(userId, id) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).input('id', sql.Int, id)
    .query('SELECT * FROM PartPrices WHERE id = @id AND userId = @userId');
  const price = r.recordset[0] || null;
  if (!price) return null;
  const pr = await pool.request().input('partPriceId', sql.Int, id)
    .query('SELECT * FROM PartPurchases WHERE partPriceId = @partPriceId ORDER BY id');
  return { ...price, purchases: pr.recordset };
}

async function upsertPrice(userId, id, data, purchases) {
  const pool = await getPool();
  const list = Array.isArray(purchases) ? purchases.filter((p) => (Number(p.qty) || 0) > 0) : [];
  const avg = weightedAverage(list);
  const currentPrice = avg !== null ? avg : (data.currentPrice ?? null);
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    let priceId = id;
    if (id) {
      await tx.request().input('userId', sql.Int, userId).input('id', sql.Int, id)
        .input('componentName', sql.NVarChar(255), data.componentName)
        .input('currentPrice', sql.Decimal(10, 2), currentPrice)
        .query('UPDATE PartPrices SET componentName=@componentName, currentPrice=@currentPrice WHERE id=@id AND userId=@userId');
    } else {
      const ins = await tx.request().input('userId', sql.Int, userId)
        .input('componentName', sql.NVarChar(255), data.componentName)
        .input('currentPrice', sql.Decimal(10, 2), currentPrice)
        .query('INSERT INTO PartPrices (userId, componentName, currentPrice) OUTPUT INSERTED.id VALUES (@userId, @componentName, @currentPrice)');
      priceId = ins.recordset[0].id;
    }
    await tx.request().input('partPriceId', sql.Int, priceId).query('DELETE FROM PartPurchases WHERE partPriceId = @partPriceId');
    for (const p of list) {
      await tx.request()
        .input('partPriceId', sql.Int, priceId)
        .input('qty', sql.Int, Math.round(Number(p.qty) || 1))
        .input('unitPrice', sql.Decimal(10, 2), Number(p.unitPrice) || 0)
        .query('INSERT INTO PartPurchases (partPriceId, qty, unitPrice) VALUES (@partPriceId, @qty, @unitPrice)');
    }
    await tx.commit();
    return getPrice(userId, priceId);
  } catch (e) { await tx.rollback().catch(() => {}); throw e; }
}

async function deletePrice(userId, id) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).input('id', sql.Int, id)
    .query('DELETE FROM PartPrices WHERE id = @id AND userId = @userId');
  return r.rowsAffected[0] > 0;
}

// ---------------------------------------------------------------------------
// Ledger summary + overall stats
// ---------------------------------------------------------------------------
async function ledgerSummary(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).query(`
    SELECT
      COALESCE(SUM(CASE WHEN type='sale' THEN amount END), 0) AS totalSales,
      COALESCE(SUM(CASE WHEN type='purchase' THEN amount END), 0) AS totalPurchases,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount END), 0) AS totalExpenses,
      COALESCE(SUM(CASE WHEN type='income' THEN amount END), 0) AS totalIncome,
      COALESCE(SUM(amount), 0) AS net
    FROM LedgerEntries WHERE userId = @userId`);
  return r.recordset[0];
}

async function stats(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).query(`
    SELECT
      (SELECT COUNT(*) FROM Listings WHERE userId=@userId) AS totalListings,
      (SELECT COUNT(*) FROM Listings WHERE userId=@userId AND status='for_sale') AS forSale,
      (SELECT COUNT(*) FROM Listings WHERE userId=@userId AND status='reserved') AS reserved,
      (SELECT COUNT(*) FROM Listings WHERE userId=@userId AND status='sold') AS sold,
      (SELECT COUNT(*) FROM Listings WHERE userId=@userId AND status='draft') AS draft,
      (SELECT COUNT(*) FROM InventoryItems WHERE userId=@userId) AS inventoryItems,
      (SELECT COUNT(*) FROM PartPrices WHERE userId=@userId) AS priceRows,
      (SELECT COUNT(*) FROM ListingComps WHERE userId=@userId) AS comps`);
  return r.recordset[0];
}

// ---------------------------------------------------------------------------
// Cost settings (single global row id=1)
// ---------------------------------------------------------------------------
async function getCostSettings() {
  const pool = await getPool();
  const r = await pool.request().query('SELECT * FROM CostSettings WHERE id = 1');
  return r.recordset[0] || null;
}

async function updateCostSettings(data) {
  const pool = await getPool();
  await pool.request()
    .input('platformFeePct', sql.Decimal(6, 2), data.platformFeePct ?? 0)
    .input('paymentFeePct', sql.Decimal(6, 2), data.paymentFeePct ?? 0)
    .input('shippingCost', sql.Decimal(10, 2), data.shippingCost ?? 0)
    .input('profitWarn', sql.Decimal(10, 2), data.profitWarn ?? 0)
    .input('profitDanger', sql.Decimal(10, 2), data.profitDanger ?? -20)
    .query('UPDATE CostSettings SET platformFeePct=@platformFeePct, paymentFeePct=@paymentFeePct, shippingCost=@shippingCost, profitWarn=@profitWarn, profitDanger=@profitDanger, updatedAt=GETUTCDATE() WHERE id = 1');
  return getCostSettings();
}

// ---------------------------------------------------------------------------
// Lookups (global, editable)
// ---------------------------------------------------------------------------
// ★ LST-15: THE COST VINTAGE PER LISTING, read from `vListingCostVintage`.
//
// The acceptance criterion is "every margin the Workbench prints carries the as-of date of the cost basis
// behind it", and the view is where that number lives — the listing's OLDEST part, because a margin is only
// as trustworthy as its stalest input.
//
// ⚠ `partsWithNoVintage` TRAVELS WITH THE DATE AND MUST BE RENDERED. Without it a caller cannot tell
// "all 8 parts are dated July" from "1 is dated and 7 are unknown", and the second case would print a
// confident vintage for a basis that is mostly unknown — which is the defect this whole row is about.
// `costAsOfLabel` says `vintage_unknown` rather than substituting a date, because it cannot know one.
async function listingCostVintage() {
  const pool = await getPool();
  const r = await pool.request().query('SELECT * FROM vListingCostVintage');
  return r.recordset;
}

async function listLookups() {
  const pool = await getPool();
  const r = await pool.request().query('SELECT * FROM Lookups ORDER BY listKey, sortOrder, id');
  const grouped = {};
  for (const row of r.recordset) {
    (grouped[row.listKey] = grouped[row.listKey] || []).push(row);
  }
  return grouped;
}

// ★★ LST-7: THE ALLOWED VALUES FOR ONE key, so a writer can CHECK instead of hoping.
//
// The enum for `condition` is New | Used – working | For parts | Unknown, and the stored value uses an
// **EN DASH (U+2013, code point 8211)** — `"Used \u2013 working"`, NOT an ASCII hyphen. That distinction is
// the reason this helper must return the values EXACTLY as stored rather than normalising them: a caller that
// helpfully converts the en dash to a hyphen produces a string that is NOT in the list and,
// before this change, would have been written anyway.
//
// Exported so validation and any future UI read ONE source. The alternative — a hardcoded array in the route —
// is a second copy of the enum that drifts the first time the owner edits the Lookups table, which is
// editable from the UI by design.
async function lookupValues(listKey) {
  const pool = await getPool();
  const r = await pool.request().input('k', sql.NVarChar(50), String(listKey))
    .query('SELECT value FROM Lookups WHERE listKey = @k ORDER BY sortOrder, id');
  return r.recordset.map((x) => String(x.value));
}

async function addLookup(listKey, value) {
  const pool = await getPool();
  const r = await pool.request().input('listKey', sql.NVarChar(50), listKey).input('value', sql.NVarChar(255), value)
    .query(`INSERT INTO Lookups (listKey, value, sortOrder) OUTPUT INSERTED.id
            SELECT @listKey, @value, COALESCE(MAX(sortOrder)+1, 0) FROM Lookups WHERE listKey=@listKey`);
  return r.recordset[0].id;
}

async function deleteLookup(id) {
  const pool = await getPool();
  const r = await pool.request().input('id', sql.Int, id).query('DELETE FROM Lookups WHERE id = @id');
  return r.rowsAffected[0] > 0;
}

// ---------------------------------------------------------------------------
// Carousell insights snapshots (LST-7)
// ---------------------------------------------------------------------------
async function saveInsights(userId, payload) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('payload', sql.NVarChar(sql.MAX), typeof payload === 'string' ? payload : JSON.stringify(payload))
    .query('INSERT INTO ListingInsights (userId, payload) OUTPUT INSERTED.id, INSERTED.capturedAt VALUES (@userId, @payload)');
  return r.recordset[0];
}

async function latestInsights(userId) {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId)
    .query('SELECT TOP 1 id, userId, capturedAt, payload FROM ListingInsights WHERE userId = @userId ORDER BY id DESC');
  const row = r.recordset[0] || null;
  if (row && row.payload) {
    try { row.payload = JSON.parse(row.payload); } catch { /* keep raw string */ }
  }
  return row;
}

module.exports = {
  round2, profitFor,
  listListings, getListing, createListing, updateListing, deleteListing,
  inventory, ledger, comps, listLedger, partsToOrder,
  inventorySpec, priceSpec, ledgerSpec, compSpec, partsToOrderSpec,
  listPrices, getPrice, upsertPrice, deletePrice, weightedAverage,
  ledgerSummary, stats, getCostSettings, updateCostSettings,
  listLookups, lookupValues, addLookup, deleteLookup,
  listingCostVintage,
  saveInsights, latestInsights,
};
