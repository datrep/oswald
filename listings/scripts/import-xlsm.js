// listings/scripts/import-xlsm.js — LST-3.
// One-time import: reads Computer Inventory List.xlsm and seeds the Listing
// Workbench tables. Dependency-free zip + XML reader (xlsx/xlsm are zips).
//
// Usage: node listings/scripts/import-xlsm.js [path-to-xlsm]
// Default: D:\MEGASYNC\Computer Inventory List.xlsm
//
// Idempotent: clears the workbench tables (owner-scoped to oswald_admin) and
// re-inserts. CostSettings row 1 is left untouched.
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const { getPool, sql } = require('../db');

// ---------------------------------------------------------------------------
// Minimal zip reader (deflate/store only — all xlsx parts are one of these)
// ---------------------------------------------------------------------------
function zipEntries(buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip (no EOCD signature)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, compSize, uncompSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, e) {
  if (buf.readUInt32LE(e.localOff) !== 0x04034b50) throw new Error('Bad local header');
  const nameLen = buf.readUInt16LE(e.localOff + 26);
  const extraLen = buf.readUInt16LE(e.localOff + 28);
  const dataStart = e.localOff + 30 + nameLen + extraLen;
  const data = buf.slice(dataStart, dataStart + e.compSize);
  if (e.method === 0) return data;
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error('Unsupported compression method ' + e.method);
}

// ---------------------------------------------------------------------------
// XML helpers (regex-based, sufficient for spreadsheet XML)
// ---------------------------------------------------------------------------
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/\r/g, '');
}

function parseSharedStrings(xml) {
  const arr = [];
  if (!xml) return arr;
  const siRe = /<si[^>]*>[\s\S]*?<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let txt = '';
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(m[0]))) txt += t[1];
    arr.push(unescapeXml(txt));
  }
  return arr;
}

// Returns an array of rows; each row is { A1: val, B1: val, ... } (ref -> value).
function parseRows(xml, shared) {
  const rows = [];
  if (!xml) return rows;
  const clean = xml.replace(/\s+xmlns(:[a-zA-Z0-9]+)?="[^"]*"/g, '');
  const rowRe = /<row[^>]*>[\s\S]*?<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(clean))) {
    const row = {};
    const cRe = /<c[^>]*>[\s\S]*?<\/c>|<c[^>]*\/>/g;
    let cm;
    while ((cm = cRe.exec(rm[0]))) {
      const c = cm[0];
      const ref = (c.match(/\sr="([A-Z]+\d+)"/) || [])[1];
      const t = (c.match(/\st="(\w+)"/) || [])[1];
      let val = '';
      if (t === 's') {
        const vi = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        const idx = parseInt(vi, 10);
        val = (idx >= 0 && idx < shared.length) ? shared[idx] : `#s${vi}`;
      } else if (t === 'inlineStr') {
        const tr = c.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        val = tr ? tr[1] : '';
      } else {
        const vi = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        val = vi !== undefined ? vi : '';
      }
      if (ref) row[ref] = unescapeXml(val);
    }
    rows.push(row);
  }
  return rows;
}

// cell(rows, r, 'D') -> value of column D at 1-based row r ('' if absent).
function cell(rows, r, col) {
  const row = rows[r - 1];
  return (row && row[col + r]) !== undefined ? row[col + r] : '';
}

// Excel 1900 date system serial -> ISO string (25569 = 1970-01-01).
function serialToDate(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(Math.round((n - 25569) * 86400000));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[,$*\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
const STATUS = { 'For Sale': 'for_sale', 'Sold': 'sold', 'Reserved': 'reserved', 'Draft': 'draft', 'Not listed': 'draft' };
const PART_COLS = [
  { name: 'D', cost: 'E', type: 'cpu' },
  { name: 'F', cost: 'G', type: 'gpu' },
  { name: 'H', cost: 'I', type: 'ram' },
  { name: 'J', cost: 'K', type: 'storage' },
  { name: 'L', cost: 'M', type: 'motherboard' },
  { name: 'N', cost: 'O', type: 'psu' },
  { name: 'P', cost: 'Q', type: 'optical' },
  { name: 'R', cost: 'S', type: 'case' },
];

function mapStatus(v) {
  const t = String(v).trim();
  return STATUS[t] || null;
}

async function main() {
  const file = process.argv[2] || 'D:\\MEGASYNC\\Computer Inventory List.xlsm';
  if (!fs.existsSync(file)) throw new Error('File not found: ' + file);
  const buf = fs.readFileSync(file);
  const entries = zipEntries(buf);
  const readStr = (name) => {
    const e = entries.get(name);
    return e ? readEntry(buf, e).toString('utf8') : null;
  };

  // Sheet order in workbook.xml maps 1:1 to xl/worksheets/sheetN.xml.
  const sheetNames = [...(readStr('xl/workbook.xml') || '').matchAll(/<sheet[^>]*name="([^"]+)"[^>]*>/g)].map((m) => m[1]);
  const shared = parseSharedStrings(readStr('xl/sharedStrings.xml'));
  const sheets = {};
  sheetNames.forEach((name, i) => {
    sheets[name] = parseRows(readStr(`xl/worksheets/sheet${i + 1}.xml`), shared);
  });

  const inv = sheets['Inventory'] || [];
  const comp = sheets['Completed Computer Components'] || [];
  const ledger = sheets['Ledger'] || [];
  const gpu = sheets['GPU UPGRADE LIST'] || [];
  const lists = sheets['Lists'] || [];
  const prices = sheets['PriceList'] || [];
  const config = sheets['Config'] || [];

  const pool = await getPool();
  const u = (await pool.request().query("SELECT id FROM Users WHERE username = 'oswald_admin'")).recordset[0];
  if (!u) throw new Error('oswald_admin not found');
  const userId = u.id;

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    // --- clear (idempotent) ---
    await tx.request().query('DELETE FROM ListingComps');
    await tx.request().query(`DELETE FROM Listings WHERE userId = ${userId}`); // cascades ListingParts
    await tx.request().query(`DELETE FROM InventoryItems WHERE userId = ${userId}`);
    await tx.request().query(`DELETE FROM LedgerEntries WHERE userId = ${userId}`);
    await tx.request().query(`DELETE FROM PartPrices WHERE userId = ${userId}`);
    await tx.request().query('DELETE FROM Lookups');
    await tx.request().query('DELETE FROM GpuUpgrades');

    const counts = { listings: 0, parts: 0, inventory: 0, ledger: 0, gpu: 0, prices: 0, lookups: 0 };

    // --- Inventory ---
    for (let r = 2; r <= inv.length; r++) {
      const itemName = String(cell(inv, r, 'A')).trim();
      const category = String(cell(inv, r, 'B')).trim();
      if (!itemName || !category) continue;
      await tx.request()
        .input('userId', sql.Int, userId)
        .input('itemName', sql.NVarChar(255), itemName)
        .input('category', sql.NVarChar(50), category)
        .input('partTypeSpec', sql.NVarChar(255), String(cell(inv, r, 'C')).trim() || null)
        .input('quantity', sql.Int, Math.round(num(cell(inv, r, 'D')) || 0))
        .input('condition', sql.NVarChar(50), String(cell(inv, r, 'E')).trim() || null)
        .input('location', sql.NVarChar(255), String(cell(inv, r, 'F')).trim() || null)
        .input('dateAdded', sql.DateTime2, serialToDate(cell(inv, r, 'G')) ? new Date(serialToDate(cell(inv, r, 'G'))) : null)
        .input('valueCost', sql.Decimal(10, 2), num(cell(inv, r, 'H')))
        .input('notes', sql.NVarChar(sql.MAX), String(cell(inv, r, 'I')).trim() || null)
        .query('INSERT INTO InventoryItems (userId, itemName, category, partTypeSpec, quantity, condition, location, dateAdded, valueCost, notes) VALUES (@userId, @itemName, @category, @partTypeSpec, @quantity, @condition, @location, @dateAdded, @valueCost, @notes)');
      counts.inventory++;
    }

    // --- Listings + ListingParts ---
    for (let r = 2; r <= comp.length; r++) {
      const title = String(cell(comp, r, 'B')).trim();
      const listingNo = parseInt(String(cell(comp, r, 'A')).trim(), 10);
      if (!title || !Number.isInteger(listingNo)) continue;
      const w = String(cell(comp, r, 'W')).trim();
      const v = String(cell(comp, r, 'V')).trim();
      const status = mapStatus(w) || mapStatus(v) || 'for_sale';
      const other = mapStatus(v) ? null : (v || null);
      const soldIso = serialToDate(cell(comp, r, 'X'));

      const ins = await tx.request()
        .input('userId', sql.Int, userId)
        .input('listingNo', sql.Int, listingNo)
        .input('title', sql.NVarChar(255), title)
        .input('sellingPrice', sql.Decimal(10, 2), num(cell(comp, r, 'C')))
        .input('status', sql.NVarChar(20), status)
        .input('dateSold', sql.DateTime2, soldIso ? new Date(soldIso) : null)
        .input('other', sql.NVarChar(sql.MAX), other)
        .query('INSERT INTO Listings (userId, listingNo, title, sellingPrice, status, dateSold, other) OUTPUT INSERTED.id VALUES (@userId, @listingNo, @title, @sellingPrice, @status, @dateSold, @other)');
      const listingId = ins.recordset[0].id;
      counts.listings++;

      let so = 0;
      for (const p of PART_COLS) {
        const partName = String(cell(comp, r, p.name)).trim();
        if (!partName || partName.toLowerCase() === 'none') continue;
        await tx.request()
          .input('listingId', sql.Int, listingId)
          .input('partType', sql.NVarChar(20), p.type)
          .input('partName', sql.NVarChar(255), partName)
          .input('partCost', sql.Decimal(10, 2), num(cell(comp, r, p.cost)))
          .input('sortOrder', sql.Int, so++)
          .query('INSERT INTO ListingParts (listingId, partType, partName, partCost, sortOrder) VALUES (@listingId, @partType, @partName, @partCost, @sortOrder)');
        counts.parts++;
      }
    }

    // --- Ledger ---
    for (let r = 2; r <= ledger.length; r++) {
      const type = String(cell(ledger, r, 'B')).trim();
      if (!type || !Number.isFinite(num(cell(ledger, r, 'A')))) continue;
      const iso = serialToDate(cell(ledger, r, 'A'));
      // unitAmount/balance are NOT stored (dropped in migration 019 — inferred on read).
      await tx.request()
        .input('userId', sql.Int, userId)
        .input('date', sql.DateTime2, iso ? new Date(iso) : null)
        .input('type', sql.NVarChar(20), type.toLowerCase())
        .input('description', sql.NVarChar(255), String(cell(ledger, r, 'C')).trim() || null)
        .input('category', sql.NVarChar(50), String(cell(ledger, r, 'D')).trim() || null)
        .input('qty', sql.Decimal(10, 2), num(cell(ledger, r, 'E')))
        .input('amount', sql.Decimal(10, 2), num(cell(ledger, r, 'G')))
        .input('payment', sql.NVarChar(50), String(cell(ledger, r, 'I')).trim() || null)
        .input('ref', sql.NVarChar(255), String(cell(ledger, r, 'J')).trim() || null)
        .input('notes', sql.NVarChar(sql.MAX), String(cell(ledger, r, 'K')).trim() || null)
        .query('INSERT INTO LedgerEntries (userId, date, type, description, category, qty, amount, payment, ref, notes) VALUES (@userId, @date, @type, @description, @category, @qty, @amount, @payment, @ref, @notes)');
      counts.ledger++;
    }

    // --- GPU UPGRADE LIST ---
    for (let r = 2; r <= gpu.length; r++) {
      const g = String(cell(gpu, r, 'A')).trim();
      if (!g) continue;
      await tx.request()
        .input('gpu', sql.NVarChar(255), g)
        .input('stockVram', sql.NVarChar(255), String(cell(gpu, r, 'B')).trim() || null)
        .input('maxVramUpgrade', sql.NVarChar(255), String(cell(gpu, r, 'C')).trim() || null)
        .input('feasibility', sql.NVarChar(sql.MAX), String(cell(gpu, r, 'D')).trim() || null)
        .input('otherMods', sql.NVarChar(sql.MAX), String(cell(gpu, r, 'E')).trim() || null)
        .input('sortOrder', sql.Int, r - 2)
        .query('INSERT INTO GpuUpgrades (gpu, stockVram, maxVramUpgrade, feasibility, otherMods, sortOrder) VALUES (@gpu, @stockVram, @maxVramUpgrade, @feasibility, @otherMods, @sortOrder)');
      counts.gpu++;
    }

    // --- PriceList ---
    for (let r = 2; r <= prices.length; r++) {
      const componentName = String(cell(prices, r, 'A')).trim();
      if (!componentName) continue;
      await tx.request()
        .input('userId', sql.Int, userId)
        .input('componentName', sql.NVarChar(255), componentName)
        .input('currentPrice', sql.Decimal(10, 2), num(cell(prices, r, 'B')))
        .query('INSERT INTO PartPrices (userId, componentName, currentPrice) VALUES (@userId, @componentName, @currentPrice)');
      counts.prices++;
    }

    // --- Lookups: Lists sheet (col A = category_inventory, col B = condition) ---
    // NOTE: the Lists sheet has NO header row — its two columns are parallel
    // lists starting at row 1, unlike Config (which has a header row).
    const lookup = async (listKey, rows, col, startRow = 2) => {
      let so = 0;
      for (let r = startRow; r <= rows.length; r++) {
        const val = String(cell(rows, r, col)).trim();
        if (!val) continue;
        await tx.request()
          .input('listKey', sql.NVarChar(50), listKey)
          .input('value', sql.NVarChar(255), val)
          .input('sortOrder', sql.Int, so++)
          .query('INSERT INTO Lookups (listKey, value, sortOrder) VALUES (@listKey, @value, @sortOrder)');
        counts.lookups++;
      }
    };
    await lookup('category_inventory', lists, 'A', 1);
    await lookup('condition', lists, 'B', 1);
    // The Inventory sheet uses "CASE" as a category, but the Excel Lists sheet
    // omits it — add it so the inventory category dropdown matches the data.
    await tx.request().input('listKey', sql.NVarChar(50), 'category_inventory').input('value', sql.NVarChar(255), 'CASE').input('sortOrder', sql.Int, 9)
      .query('INSERT INTO Lookups (listKey, value, sortOrder) VALUES (@listKey, @value, @sortOrder)');
    counts.lookups++;
    // Location list: distinct values from the Inventory sheet's F column.
    const locSet = new Map();
    for (let r = 2; r <= inv.length; r++) {
      const loc = String(cell(inv, r, 'F')).trim();
      if (loc && !locSet.has(loc)) locSet.set(loc, locSet.size);
    }
    for (const [loc, so] of locSet) {
      await tx.request().input('listKey', sql.NVarChar(50), 'location').input('value', sql.NVarChar(255), loc).input('sortOrder', sql.Int, so)
        .query('INSERT INTO Lookups (listKey, value, sortOrder) VALUES (@listKey, @value, @sortOrder)');
      counts.lookups++;
    }
    await lookup('type', config, 'A');
    await lookup('category_ledger', config, 'B');
    await lookup('payment', config, 'C');
    await lookup('status', config, 'D');
    // status list gains a Draft option (new state, not in the Excel).
    await tx.request().input('listKey', sql.NVarChar(50), 'status').input('value', sql.NVarChar(255), 'Draft').input('sortOrder', sql.Int, 0)
      .query('INSERT INTO Lookups (listKey, value, sortOrder) VALUES (@listKey, @value, @sortOrder)');
    counts.lookups++;

    await tx.commit();
    console.log('Import complete:');
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  } finally {
    await pool.close();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('IMPORT FAILED:', e.message); process.exit(1); });
