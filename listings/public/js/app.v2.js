// listings/public/js/app.v2.js — Listing Workbench UI (feedback batch).
import { api } from './api.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n === null || n === undefined || n === '' ? '—' : 'S$' + Number(n).toFixed(2));
const num = (v) => { if (v === '' || v === null || v === undefined) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

const STATUS_OPTIONS = [['draft', 'Draft'], ['for_sale', 'For Sale'], ['reserved', 'Reserved'], ['sold', 'Sold']];
const STATUS_LABEL = Object.fromEntries(STATUS_OPTIONS.map(([k, l]) => [k, l]));
const STATUS_CHIP = { for_sale: 'green', reserved: 'amber', draft: 'blue', sold: 'gray' };
// Ledger types are stored LOWERCASE per spec (sale|purchase|expense|income) —
// the old Lookups-backed dropdown stored Title Case and broke the summary.
const TYPE_OPTIONS = [['sale', 'Sale'], ['purchase', 'Purchase'], ['expense', 'Expense'], ['income', 'Income']];
const TYPE_LABEL = Object.fromEntries(TYPE_OPTIONS.map(([k, l]) => [k, l]));
const PART_TYPES = ['cpu', 'gpu', 'ram', 'storage', 'motherboard', 'psu', 'optical', 'case', 'other'];

let lookups = {};
let settings = { platformFeePct: 0, paymentFeePct: 0, shippingCost: 0, profitWarn: 0, profitDanger: -20 };
let currentTab = 'listings';
let editing = null; // { kind, id }
let saveHandler = null;
let pasteMode = null;

const state = { listings: [], inventory: [], prices: [], ledger: [], comps: [] };
const ui = {
  listings: { q: '', sortKey: 'listingNo', sortDir: 'asc' },
  inventory: { q: '', sortKey: 'itemName', sortDir: 'asc', view: 'table' },
  prices: { q: '', sortKey: 'componentName', sortDir: 'asc', view: 'table' },
  ledger: { q: '', sortKey: 'date', sortDir: 'desc' },
  comps: { q: '', sortKey: 'title', sortDir: 'asc' },
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2400);
}
function lookupOptions(key, selected) {
  const vals = (lookups[key] || []).map((o) => o.value);
  return `<option value="">—</option>` + vals.map((v) => `<option value="${esc(v)}" ${selected === v ? 'selected' : ''}>${esc(v)}</option>`).join('');
}
function profitColor(v) {
  const n = Number(v) || 0;
  const green = Number(settings.profitWarn) || 0;
  const red = Number(settings.profitDanger) ?? -20;
  let t;
  if (green === red) t = n >= green ? 1 : 0;
  else t = Math.max(0, Math.min(1, (n - red) / (green - red)));
  return `hsl(${Math.round(120 * t)}, 65%, 55%)`; // red -> amber -> green
}
// Markup percentage ((price/cost − 1) × 100), shown per listing to 2 s.f.
function markupPct(l) {
  const cost = Number(l.totalCost);
  const price = Number(l.sellingPrice);
  if (!Number.isFinite(cost) || !Number.isFinite(price) || cost <= 0) return null;
  return ((price / cost) - 1) * 100;
}
function pct2(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '0%';
  const e = Math.floor(Math.log10(Math.abs(n)));
  const scale = Math.pow(10, 1 - e); // round to 2 significant figures
  return `${Math.round(n * scale) / scale}%`;
}
function markupColor(n) { return n == null ? '' : (n > 0 ? 'hsl(120, 65%, 55%)' : 'hsl(0, 65%, 55%)'); }
const NUMERIC_KEYS = new Set(['listingNo', 'sellingPrice', 'totalCost', 'markupPct', 'grossMargin', 'netProfit', 'quantity', 'valueCost', 'currentPrice', 'purchaseCount', 'amount', 'balance', 'qty', 'competitorPrice', 'deliveryFee', 'likes', 'wantCount']);
function sortRows(rows, key, dir) {
  const d = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    let va = a[key], vb = b[key];
    if (NUMERIC_KEYS.has(key)) { va = Number(va) || 0; vb = Number(vb) || 0; }
    else { va = String(va ?? '').toLowerCase(); vb = String(vb ?? '').toLowerCase(); }
    return (va < vb ? -1 : va > vb ? 1 : 0) * d;
  });
}
function searchText(kind, r) {
  // ⚠⚠ `listings` HAD NO CASE AT ALL, so this returned '' and `''.includes(q)` is FALSE for every non-empty
  // query — i.e. TYPING IN THE LISTINGS SEARCH BOX EMPTIED THE TABLE. Found 2026-09-27 while adding `other`
  // below (LST-16). It is the same shape as the 'prices' case, which was handled; `listings` was simply never
  // written, and a search box that silently returns nothing looks like "no matches" rather than like a bug.
  if (kind === 'listings') return [r.listingNo, r.title, r.condition, r.status, r.notes, r.other].join(' ');
  if (kind === 'inventory') return [r.itemName, r.category, r.partTypeSpec, r.condition, r.location].join(' ');
  if (kind === 'prices') return r.componentName || '';
  if (kind === 'ledger') return [r.description, r.type, r.category, r.payment, r.notes].join(' ');
  if (kind === 'comps') return [r.title, r.specSummary, r.condition, r.sourceUrl].join(' ');
  return '';
}
function applySearchSort(rows, kind) {
  const u = ui[kind];
  let out = rows;
  if (u.q) { const q = u.q.toLowerCase(); out = out.filter((r) => searchText(kind, r).toLowerCase().includes(q)); }
  return sortRows(out, u.sortKey, u.sortDir);
}
function th(key, label, kind) {
  const u = ui[kind];
  const arrow = u.sortKey === key ? (u.sortDir === 'asc' ? '▲' : '▼') : '';
  return `<th class="sortable" data-sort="${key}">${label}${arrow ? ` <span class="arrow">${arrow}</span>` : ''}</th>`;
}
function toolbar(kind, extra = '') {
  const u = ui[kind];
  const viewToggle = (kind === 'inventory' || kind === 'prices')
    ? `<span class="view-toggle">
        <button data-view="table" class="${u.view === 'table' ? 'active' : ''}">Table</button>
        <button data-view="cards" class="${u.view === 'cards' ? 'active' : ''}">Cards</button>
      </span>` : '';
  return `<div class="toolbar"><input class="search" id="search-${kind}" placeholder="Search…" value="${esc(u.q)}" />${viewToggle}${extra}</div>`;
}
function slider(id, value, { min = 0, max = 2000, step = 1 } = {}) {
  const v = value ?? min;
  return `<div class="slider-wrap">
    <input type="range" id="sl-${id}" min="${min}" max="${max}" step="${step}" value="${v}" />
    <input type="number" id="${id}" step="${step === 1 ? '0.01' : step}" value="${v}" />
  </div>`;
}
function bindSliders() {
  document.querySelectorAll('.slider-wrap').forEach((wrap) => {
    const range = wrap.querySelector('input[type=range]');
    const numIn = wrap.querySelector('input[type=number]');
    if (!range || !numIn) return;
    range.addEventListener('input', () => { numIn.value = range.value; });
    numIn.addEventListener('input', () => {
      const n = Number(numIn.value);
      if (Number.isFinite(n)) range.value = Math.min(Number(range.max), Math.max(Number(range.min), n));
    });
  });
}

// ---------------------------------------------------------------------------
// auth + modal
// ---------------------------------------------------------------------------
async function submitLogin() {
  const u = $('login-user').value.trim();
  const p = $('login-pass').value;
  if (!u || !p) { $('login-err').textContent = 'Username and password required'; return; }
  try {
    const d = await api.login(u, p);
    api.setToken(d.token);
    $('login-modal').classList.add('hidden');
    $('signout').classList.remove('hidden');
    await boot();
  } catch (e) { $('login-err').textContent = e.message; }
}
function showLogin() { $('signout').classList.add('hidden'); $('login-modal').classList.remove('hidden'); }
function openModal(title, bodyHtml, onSave) {
  $('edit-title').textContent = title;
  $('edit-body').innerHTML = bodyHtml;
  $('edit-status').textContent = '';
  saveHandler = onSave;
  $('edit-modal').classList.remove('hidden');
  bindSliders();
}
function closeModal() { $('edit-modal').classList.add('hidden'); saveHandler = null; }

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------
function switchTab(t) {
  currentTab = t;
  document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + t));
  renderTab();
}
async function renderTab() {
  if (currentTab === 'listings') await renderListings();
  else if (currentTab === 'inventory') await renderEntity('inventory');
  else if (currentTab === 'prices') await renderEntity('prices');
  else if (currentTab === 'ledger') await renderLedger();
  else if (currentTab === 'comps') await renderEntity('comps');
  else if (currentTab === 'settings') await renderSettings();
}

// ---------------------------------------------------------------------------
// listings
// ---------------------------------------------------------------------------
async function renderListings() {
  const el = $('tab-listings');
  el.innerHTML = `<div class="panel-head"><h2>Listings</h2><div class="actions">
    <button class="btn" id="import-listing">Import from Carousell</button>
    <button class="btn primary" id="add-listing">+ New listing</button></div></div>
    ${toolbar('listings')}
    <div class="table-wrap"><table class="table"><thead><tr>
      ${th('listingNo', '#', 'listings')}${th('title', 'Title', 'listings')}${th('sellingPrice', 'Price', 'listings')}${th('totalCost', 'Cost', 'listings')}${th('markupPct', '% ↑', 'listings')}${th('grossMargin', 'Gross', 'listings')}${th('netProfit', 'Net', 'listings')}${th('status', 'Status', 'listings')}<th></th>
    </tr></thead><tbody id="listings-body"></tbody></table></div>
    <div class="totals" id="listings-totals"></div>`;
  try {
    const { listings } = await api.get('/api/listings/listings');
    state.listings = listings;
    renderListingsRows();
    bindListings();
  } catch (e) { el.innerHTML += `<p class="err">${esc(e.message)}</p>`; }
}
function renderListingsRows() {
  const rows = applySearchSort(state.listings.map((l) => ({ ...l, markupPct: markupPct(l) })), 'listings');
  const tb = $('listings-body');
  if (!rows.length) tb.innerHTML = `<tr><td colspan="9" class="empty">No listings match.</td></tr>`;
  else tb.innerHTML = rows.map((l) => `<tr>
    <td>${l.listingNo ?? ''}</td>
    <td class="t-title" title="${esc(l.title)}">${l.carousellUrl ? `<a href="${esc(l.carousellUrl)}" target="_blank" rel="noopener">${esc(l.title)}</a>` : esc(l.title)}</td>
    <td>${fmt(l.sellingPrice)}</td>
    <td>${fmt(l.totalCost)}</td>
    <td${l.markupPct == null ? '' : ` style="color:${markupColor(l.markupPct)}"`} title="Price/Cost markup">${pct2(l.markupPct)}</td>
    <td style="color:${profitColor(l.grossMargin)}">${fmt(l.grossMargin)}</td>
    <td style="color:${profitColor(l.netProfit)}">${fmt(l.netProfit)}${l.other ? `<sup class="adj-mark" title="${esc(l.other)}">adj</sup>` : ''}</td>
    <td><span class="chip ${STATUS_CHIP[l.status] || 'gray'}">${STATUS_LABEL[l.status] || l.status}</span></td>
    <td class="actions actions-cell">
      <select class="ledger-drop" data-id="${l.id}" title="Send to ledger">
        <option value="">→ Ledger</option>
        <option value="sale">Log sale</option>
        <option value="expense">Log cost (expense)</option>
        <option value="purchase">Log purchase</option>
      </select>
      <button class="btn sm" data-discover="${l.id}" title="Discover this machine's hardware (option 6)">Scan</button>
      <button class="btn sm" data-copy="${l.id}">Copy</button>
      <button class="btn sm" data-edit="${l.id}">Edit</button>
      <button class="btn sm danger" data-del="${l.id}">×</button>
    </td></tr>`).join('');
  tb.querySelectorAll('[data-copy]').forEach((b) => b.onclick = () => copyListing(Number(b.dataset.copy)));
  tb.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openListingEdit(Number(b.dataset.edit)));
  tb.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => delListing(Number(b.dataset.del)));
  tb.querySelectorAll('[data-discover]').forEach((b) => b.onclick = () => discoverListing(Number(b.dataset.discover), b));
  tb.querySelectorAll('.ledger-drop').forEach((sel) => sel.addEventListener('change', () => ledgerFromListing(sel)));
  const sum = rows.reduce((a, l) => ({ cost: a.cost + (Number(l.totalCost) || 0), gross: a.gross + (Number(l.grossMargin) || 0), net: a.net + (Number(l.netProfit) || 0) }), { cost: 0, gross: 0, net: 0 });
  $('listings-totals').innerHTML = `<span>${rows.length} listing(s)</span><span>Cost <b>${fmt(sum.cost)}</b></span><span>Gross <b style="color:${profitColor(sum.gross)}">${fmt(sum.gross)}</b></span><span>Net <b style="color:${profitColor(sum.net)}">${fmt(sum.net)}</b></span>`;
}
function bindListings() {
  $('search-listings').addEventListener('input', (e) => { ui.listings.q = e.target.value; renderListingsRows(); });
  document.querySelectorAll('#tab-listings th.sortable').forEach((h) => h.addEventListener('click', () => {
    const k = h.dataset.sort; const u = ui.listings;
    if (u.sortKey === k) u.sortDir = u.sortDir === 'asc' ? 'desc' : 'asc'; else { u.sortKey = k; u.sortDir = 'asc'; }
    renderListings();
  }));
  $('add-listing').onclick = () => openListingEdit(null);
  $('import-listing').onclick = () => openPaste('listing');
}

async function openListingEdit(id, prefill) {
  let l = prefill || null;
  if (id && !prefill) {
    try { l = await api.get(`/api/listings/listings/${id}`); } catch (e) { toast(e.message); return; }
  }
  editing = { kind: 'listing', id: prefill ? null : id };
  openModal(id && !prefill ? 'Edit listing' : 'New listing', listingForm(l, l?.parts || []), saveListing);
}
function partRow(p = {}) {
  const pt = p.partType || 'other';
  return `<div class="part-row">
    <select class="p-type">${PART_TYPES.map((t) => `<option value="${t}" ${t === pt ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <input class="p-name" placeholder="Part name" value="${esc(p.partName ?? '')}" />
    <input class="p-cost" type="number" step="0.01" placeholder="Cost" value="${p.partCost ?? ''}" />
    <button type="button" class="btn sm danger p-del">×</button>
  </div>`;
}
function nextListingNo() {
  return Math.max(0, ...state.listings.map((x) => Number(x.listingNo) || 0)) + 1;
}
function listingForm(l, parts) {
  const isEdit = !!(l && l.id);
  const no = (isEdit && l.listingNo != null) ? l.listingNo : nextListingNo();
  return `<div class="form-grid">
    <label class="full">Title<input id="f-title" value="${esc(l?.title ?? '')}" /></label>
    <label>Listing #<input id="f-listingNo" type="number" value="${no}" disabled title="Auto-assigned" /></label>
    <label>Selling price (S$)${slider('f-price', l?.sellingPrice, { max: 3000 })}</label>
    <label>Status<select id="f-status">${STATUS_OPTIONS.map(([k, label]) => `<option value="${k}" ${l?.status === k ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <label>Condition<select id="f-condition">${lookupOptions('condition', l?.condition)}</select></label>
    <label>Carousell URL<input id="f-url" value="${esc(l?.carousellUrl ?? '')}" /></label>
    <label class="full">Notes<textarea id="f-notes">${esc(l?.notes ?? '')}</textarea></label>
    <label class="full">Other — adjustment / reason for the price
      <textarea id="f-other" placeholder="e.g. Clearance: nothing sold it in 2 months, selling at a S$7 loss on purpose to free the shelf">${esc(l?.other ?? '')}</textarea></label>
  </div>
  <div class="parts-head"><strong>Parts</strong><button type="button" class="btn sm" id="add-part">+ Add part</button></div>
  <div class="parts-list" id="parts-list">${parts.map(partRow).join('') || '<p class="muted">No parts.</p>'}</div>`;
}
function collectParts() {
  return [...document.querySelectorAll('#parts-list .part-row')].map((r) => ({
    partType: r.querySelector('.p-type').value,
    partName: r.querySelector('.p-name').value.trim(),
    partCost: num(r.querySelector('.p-cost').value),
  })).filter((p) => p.partName || p.partCost !== null);
}
async function saveListing() {
  const title = $('f-title').value.trim();
  if (!title) { $('edit-status').textContent = 'Title is required'; return; }
  const body = {
    title,
    listingNo: num($('f-listingNo').value),
    sellingPrice: num($('f-price').value),
    status: $('f-status').value,
    condition: $('f-condition').value || null,
    carousellUrl: $('f-url').value.trim() || null,
    notes: $('f-notes').value.trim() || null,
    // LST-16: the Excel "Other" column — an adjustment slot the service already read and wrote while the UI
    // had nowhere to type it, so the one field that could explain a deliberate loss was the one that could
    // not be filled in.
    other: $('f-other').value.trim() || null,
    parts: collectParts(),
  };
  try {
    if (editing.id) await api.put(`/api/listings/listings/${editing.id}`, body);
    else await api.post('/api/listings/listings', body);
    closeModal(); toast(editing.id ? 'Listing updated' : 'Listing created'); await renderListings();
  } catch (e) { $('edit-status').textContent = e.message; }
}
async function delListing(id) {
  if (!confirm('Delete this listing? Its parts and comps go with it.')) return;
  try { await api.del(`/api/listings/listings/${id}`); toast('Deleted'); await renderListings(); }
  catch (e) { toast(e.message); }
}

// One-click send a listing to the ledger (sale / cost / purchase).
async function ledgerFromListing(sel) {
  const kind = sel.value;
  if (!kind) return;
  const l = state.listings.find((x) => x.id === Number(sel.dataset.id));
  sel.value = '';
  if (!l) return;
  const totalCost = Number(l.totalCost) || 0;
  const body = { date: new Date().toISOString(), type: kind, qty: 1, category: null, payment: null, ref: null, notes: null };
  if (kind === 'sale') { body.amount = Number(l.sellingPrice) || 0; body.description = l.title; }
  else if (kind === 'expense') { body.amount = -totalCost; body.description = `Cost: ${l.title}`; }
  else { body.amount = -totalCost; body.description = `Parts: ${l.title}`; }
  try {
    await api.post('/api/listings/ledger', body);
    toast('Added to ledger');
  } catch (e) { toast(e.message); }
}

// Option 6 - discover this machine's hardware and attach the inventory to the listing.
async function discoverListing(id, btn) {
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = '...';
  try {
    const r = await api.post(`/api/listings/listings/${id}/discover`);
    showDiscover(r.inventory, r.capturedAt);
    toast('Hardware discovered and saved to listing');
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
}
function formatInventory(inv) {
  if (!inv || typeof inv !== 'object') return String(inv ?? '');
  const lines = [];
  if (inv.Manufacturer) lines.push('Manufacturer: ' + inv.Manufacturer);
  if (inv.Model) lines.push('Model: ' + inv.Model);
  if (inv.Board) lines.push('Board: ' + inv.Board + (inv.BoardVersion ? ' (rev ' + inv.BoardVersion + ')' : ''));
  if (inv.BiosVersion) lines.push('BIOS: ' + inv.BiosVersion);
  if (inv.Cpu) lines.push('CPU: ' + inv.Cpu);
  (inv.Gpus || []).forEach((g) => lines.push('GPU: ' + (g.Name || '?') + ' - driver ' + (g.DriverVersion || '?')));
  (inv.Disks || []).forEach((d) => lines.push('Disk: ' + (d.FriendlyName || '?') + ' | ' + (d.MediaType || '') + ' | fw ' + (d.FirmwareVersion || '?')));
  (inv.Nics || []).forEach((n) => lines.push('NIC: ' + (n.Name || '?') + ' | ' + (n.Description || '')));
  return lines.join('\n');
}
function showDiscover(inv, capturedAt) {
  $('discover-out').textContent = formatInventory(inv) +
    (capturedAt ? '\n\nCaptured: ' + new Date(capturedAt).toLocaleString() : '');
  $('discover-modal').classList.remove('hidden');
}
function closeDiscover() { $('discover-modal').classList.add('hidden'); }

// ---------------------------------------------------------------------------
// generic entity tabs
// ---------------------------------------------------------------------------
const ENTITIES = {
  inventory: {
    title: 'Inventory', add: '+ Add item', cardTitle: 'itemName',
    cols: [['itemName', 'Item'], ['category', 'Category'], ['partTypeSpec', 'Spec'], ['quantity', 'Qty'], ['condition', 'Condition'], ['location', 'Location'], ['valueCost', 'Value']],
    form: (v = {}) => `<div class="form-grid">
      <label class="full">Item name<input id="f-itemName" value="${esc(v.itemName ?? '')}" /></label>
      <label>Category<select id="f-category">${lookupOptions('category_inventory', v.category)}</select></label>
      <label>Quantity${slider('f-quantity', v.quantity ?? 0, { max: 100 })}</label>
      <label>Condition<select id="f-condition">${lookupOptions('condition', v.condition)}</select></label>
      <label>Location<select id="f-location">${lookupOptions('location', v.location)}</select></label>
      <label>Value / cost${slider('f-valueCost', v.valueCost, { max: 2000 })}</label>
      <label class="full">Spec<input id="f-partTypeSpec" value="${esc(v.partTypeSpec ?? '')}" /></label>
      <label class="full">Notes<textarea id="f-notes">${esc(v.notes ?? '')}</textarea></label>
    </div>`,
    collect: () => ({
      itemName: $('f-itemName').value.trim(), category: $('f-category').value || null,
      quantity: num($('f-quantity').value) ?? 0, condition: $('f-condition').value || null,
      location: $('f-location').value || null, valueCost: num($('f-valueCost').value),
      partTypeSpec: $('f-partTypeSpec').value.trim() || null, notes: $('f-notes').value.trim() || null,
    }),
    required: (d) => !d.itemName && 'itemName',
  },
  prices: {
    title: 'Prices', add: '+ Add price', cardTitle: 'componentName',
    cols: [['componentName', 'Component'], ['currentPrice', 'Avg cost'], ['purchaseCount', 'Lots']],
    form: (v = {}) => `<div class="form-grid">
      <label class="full">Component name<input id="f-componentName" value="${esc(v.componentName ?? '')}" /></label>
      <label>Manual price (used if no purchases)${slider('f-currentPrice', v.currentPrice, { max: 2000 })}</label>
    </div>
    <div class="parts-head"><strong>Purchases (qty × price → average cost)</strong><button type="button" class="btn sm" id="add-purchase">+ Add purchase</button></div>
    <div class="purchases-list" id="purchases-list">${(v.purchases || []).map(purchaseRow).join('') || '<p class="muted">No purchases yet.</p>'}</div>
    <p class="muted" id="avg-preview"></p>`,
    collect: () => ({ componentName: $('f-componentName').value.trim(), currentPrice: num($('f-currentPrice').value) }),
    required: (d) => !d.componentName && 'componentName',
  },
  ledger: {
    title: 'Ledger', add: '+ Add entry',
    cols: [['date', 'Date'], ['type', 'Type'], ['description', 'Description'], ['category', 'Category'], ['qty', 'Qty'], ['amount', 'Amount'], ['balance', 'Balance'], ['payment', 'Payment']],
    form: (v = {}) => `<div class="form-grid">
      <label>Date<input id="f-date" type="date" value="${(v.date || new Date().toISOString()).slice(0, 10)}" /></label>
      <label>Type<select id="f-type"><option value="">—</option>${TYPE_OPTIONS.map(([k, label]) => `<option value="${k}" ${(v.type || '') === k ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label>Category<select id="f-category">${lookupOptions('category_ledger', v.category)}</select></label>
      <label class="full">Qty (drag)${slider('f-qty', v.qty, { min: 0, max: 100, step: 1 })}</label>
      <label>Amount $<input id="f-amount" type="number" step="0.01" value="${v.amount ?? ''}" /></label>
      <label>Payment<select id="f-payment">${lookupOptions('payment', v.payment)}</select></label>
      <label>Ref<input id="f-ref" value="${esc(v.ref ?? '')}" /></label>
      <label class="full">Description<input id="f-description" value="${esc(v.description ?? '')}" /></label>
      <label class="full">Notes<textarea id="f-notes">${esc(v.notes ?? '')}</textarea></label>
      <p class="muted full" id="unit-hint">Unit price and running balance are inferred from qty × amount.</p>
    </div>`,
    collect: () => ({
      date: $('f-date').value ? new Date($('f-date').value).toISOString() : null,
      type: $('f-type').value || null, category: $('f-category').value || null,
      qty: num($('f-qty').value), amount: num($('f-amount').value),
      payment: $('f-payment').value || null, ref: $('f-ref').value.trim() || null,
      description: $('f-description').value.trim() || null, notes: $('f-notes').value.trim() || null,
    }),
  },
  comps: {
    title: 'Comps', add: '+ Add comp', cardTitle: 'title',
    cols: [['title', 'Title'], ['competitorPrice', 'Price'], ['specSummary', 'Specs'], ['condition', 'Condition'], ['deliveryFee', 'Delivery'], ['sourceUrl', 'Source'], ['seenAt', 'Seen']],
    form: (v = {}) => `<div class="form-grid">
      <label class="full">Title<input id="f-title" value="${esc(v.title ?? '')}" /></label>
      <label>Competitor price${slider('f-competitorPrice', v.competitorPrice, { max: 3000 })}</label>
      <label>Delivery fee${slider('f-deliveryFee', v.deliveryFee, { max: 500 })}</label>
      <label>Condition<select id="f-condition">${lookupOptions('condition', v.condition)}</select></label>
      <label>Likes<input id="f-likes" type="number" value="${v.likes ?? ''}" /></label>
      <label>Wants<input id="f-wantCount" type="number" value="${v.wantCount ?? ''}" /></label>
      <label>Source URL<input id="f-sourceUrl" value="${esc(v.sourceUrl ?? '')}" /></label>
      <label class="full">Spec summary (facts only)<textarea id="f-specSummary">${esc(v.specSummary ?? '')}</textarea></label>
      <label class="full">Notes<textarea id="f-notes">${esc(v.notes ?? '')}</textarea></label>
    </div>`,
    collect: () => ({
      title: $('f-title').value.trim() || null, competitorPrice: num($('f-competitorPrice').value),
      deliveryFee: num($('f-deliveryFee').value), condition: $('f-condition').value || null,
      likes: num($('f-likes').value), wantCount: num($('f-wantCount').value),
      sourceUrl: $('f-sourceUrl').value.trim() || null,
      specSummary: $('f-specSummary').value.trim() || null, notes: $('f-notes').value.trim() || null,
      seenAt: new Date().toISOString(),
    }),
  },
};
function entityPath(kind) { return { inventory: '/api/listings/inventory', prices: '/api/listings/prices', ledger: '/api/listings/ledger', comps: '/api/listings/comps' }[kind]; }
function purchaseRow(p = {}) {
  return `<div class="purchase-row">
    <input class="p-qty" type="number" step="1" placeholder="Qty" value="${p.qty ?? ''}" />
    <input class="p-unit" type="number" step="0.01" placeholder="Unit $" value="${p.unitPrice ?? ''}" />
    <button type="button" class="btn sm danger p-del">×</button>
  </div>`;
}
function collectPurchases() {
  return [...document.querySelectorAll('#purchases-list .purchase-row')].map((r) => ({
    qty: num(r.querySelector('.p-qty').value),
    unitPrice: num(r.querySelector('.p-unit').value),
  })).filter((p) => p.qty && p.qty > 0);
}
function fmtCell(kind, row, col) {
  const v = row[col];
  if (col === 'date' || col === 'seenAt') return v ? String(v).slice(0, 10) : '—';
  if (col === 'currentPrice') return v ? `<span class="profit-ok">${fmt(v)}</span>` : '<span class="muted">—</span>';
  if (['valueCost', 'amount', 'balance', 'competitorPrice', 'deliveryFee'].includes(col)) return fmt(v);
  if (col === 'type' && kind === 'ledger') return esc(TYPE_LABEL[v] || v || '—');
  if (col === 'sourceUrl') return v ? `<a href="${esc(v)}" target="_blank" rel="noopener">open ↗</a>` : '—';
  return esc(v ?? '');
}

async function renderEntity(kind) {
  const cfg = ENTITIES[kind];
  const el = $('tab-' + kind);
  const extra = kind === 'comps' ? '<button class="btn" id="paste-comp">Paste comp</button>' : '';
  el.innerHTML = `<div class="panel-head"><h2>${cfg.title}</h2><div class="actions">${extra}<button class="btn primary" id="add-${kind}">${cfg.add}</button></div></div>
    ${toolbar(kind)}
    <div id="${kind}-area"></div>`;
  try {
    const { items } = await api.get(entityPath(kind));
    state[kind] = items;
    renderEntityRows(kind);
    bindEntity(kind);
  } catch (e) { el.innerHTML += `<p class="err">${esc(e.message)}</p>`; }
}
function renderEntityRows(kind) {
  const cfg = ENTITIES[kind];
  const rows = applySearchSort(state[kind], kind);
  const area = $(kind + '-area');
  if (ui[kind].view === 'cards') {
    area.innerHTML = rows.length ? `<div class="cards">${rows.map((r) => `<div class="card-item">
      <div class="card-item-head"><h4>${esc(r[cfg.cardTitle] ?? '')}</h4></div>
      <div class="kv">${cfg.cols.filter((c) => c[0] !== cfg.cardTitle).map((c) => `<div>${c[1]}: <b>${fmtCell(kind, r, c[0])}</b></div>`).join('')}</div>
      <div class="card-item-actions"><button class="btn sm" data-edit="${r.id}">Edit</button><button class="btn sm danger" data-del="${r.id}">×</button></div>
    </div>`).join('')}</div>` : `<p class="empty">Nothing here yet.</p>`;
  } else {
    area.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr>${cfg.cols.map((c) => th(c[0], c[1], kind)).join('')}<th></th></tr></thead><tbody>${rows.length ? rows.map((r) => `<tr>
      ${cfg.cols.map((c) => `<td>${fmtCell(kind, r, c[0])}</td>`).join('')}
      <td class="actions actions-cell"><button class="btn sm" data-edit="${r.id}">Edit</button><button class="btn sm danger" data-del="${r.id}">×</button></td>
    </tr>`).join('') : `<tr><td colspan="${cfg.cols.length + 1}" class="empty">Nothing here yet.</td></tr>`}</tbody></table></div>`;
  }
  area.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openEntityEdit(kind, Number(b.dataset.edit)));
  area.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => delEntity(kind, Number(b.dataset.del)));
}
function bindEntity(kind) {
  $('search-' + kind).addEventListener('input', (e) => { ui[kind].q = e.target.value; renderEntityRows(kind); });
  document.querySelectorAll(`#tab-${kind} th.sortable`).forEach((h) => h.addEventListener('click', () => {
    const u = ui[kind];
    const k = h.dataset.sort;
    if (u.sortKey === k) u.sortDir = u.sortDir === 'asc' ? 'desc' : 'asc'; else { u.sortKey = k; u.sortDir = 'asc'; }
    renderEntity(kind);
  }));
  document.querySelectorAll(`#tab-${kind} .view-toggle button`).forEach((b) => b.addEventListener('click', () => {
    ui[kind].view = b.dataset.view;
    renderEntity(kind);
  }));
  $('add-' + kind).onclick = () => openEntityEdit(kind, null);
  if (kind === 'comps') $('paste-comp').onclick = () => openPaste('comp');
}

// ledger: atomic render (stats + table), fixes the transient $0.00 hide
async function renderLedger() {
  const el = $('tab-ledger');
  el.innerHTML = `<div class="panel-head"><h2>Ledger</h2><div class="actions"><button class="btn primary" id="add-ledger">+ Add entry</button></div></div>
    ${toolbar('ledger')}
    <div class="stat-row" id="ledger-stats"></div>
    <div id="ledger-area"></div>`;
  try {
    const [itemsRes, sum] = await Promise.all([api.get('/api/listings/ledger'), api.get('/api/listings/ledger/summary')]);
    state.ledger = itemsRes.items || [];
    $('ledger-stats').innerHTML = `<div class="stat"><div class="v">${fmt(sum.net)}</div><div class="l">Net</div></div>
      <div class="stat"><div class="v">${fmt(sum.totalSales)}</div><div class="l">Sales</div></div>
      <div class="stat"><div class="v">${fmt(sum.totalExpenses)}</div><div class="l">Expenses</div></div>`;
    renderEntityRows('ledger');
    bindEntity('ledger');
  } catch (e) { el.innerHTML += `<p class="err">${esc(e.message)}</p>`; }
}

async function openEntityEdit(kind, id, prefill) {
  let v = prefill || {};
  if (id && !prefill) {
    if (kind === 'prices') { v = await api.get(`/api/listings/prices/${id}`); }
    else { const { items } = await api.get(entityPath(kind)); v = items.find((r) => r.id === id) || {}; }
  }
  editing = { kind, id: prefill ? null : id };
  // Singular display noun per entity (slice(0,-1) mangles words like "Ledger").
  const noun = { listings: 'listing', inventory: 'item', prices: 'price', ledger: 'entry', comps: 'comp' }[kind] || 'row';
  openModal(id && !prefill ? `Edit ${noun}` : `New ${noun}`, ENTITIES[kind].form(v), saveEntity);
  if (kind === 'prices') { updateAvgPreview(); bindPurchaseButtons(); }
}
function updateAvgPreview() {
  const purchases = collectPurchases();
  const qty = purchases.reduce((s, p) => s + (p.qty || 0), 0);
  const cost = purchases.reduce((s, p) => s + (p.qty || 0) * (p.unitPrice || 0), 0);
  const el = $('avg-preview');
  if (el) el.textContent = qty > 0 ? `Average cost: ${fmt(Math.floor((cost / qty) * 100) / 100)} (floor, 2dp)` : 'Average cost: — (uses manual price until purchases are added)';
}
function bindPurchaseButtons() {
  document.addEventListener('input', (e) => { if (e.target.closest('.purchase-row')) updateAvgPreview(); });
}
async function saveEntity() {
  const cfg = ENTITIES[editing.kind];
  const d = cfg.collect();
  if (cfg.required && cfg.required(d)) { $('edit-status').textContent = cfg.required(d) + ' is required'; return; }
  const path = entityPath(editing.kind);
  try {
    if (editing.kind === 'prices') {
      const body = { componentName: d.componentName, currentPrice: d.currentPrice, purchases: collectPurchases() };
      if (editing.id) await api.put(`${path}/${editing.id}`, body);
      else await api.post(path, body);
    } else {
      if (editing.id) await api.put(`${path}/${editing.id}`, d);
      else await api.post(path, d);
    }
    closeModal(); toast('Saved'); await renderEntity(editing.kind);
  } catch (e) { $('edit-status').textContent = e.message; }
}
async function delEntity(kind, id) {
  if (!confirm('Delete this row?')) return;
  try { await api.del(`${entityPath(kind)}/${id}`); toast('Deleted'); await renderEntity(kind); }
  catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------------------
// Carousell paste + copy
// ---------------------------------------------------------------------------
function openPaste(mode) {
  pasteMode = mode;
  $('paste-title').textContent = mode === 'comp' ? 'Paste competitor listing' : 'Paste your listing';
  $('paste-hint').textContent = mode === 'comp' ? 'Facts are extracted and stored; prose is discarded.' : 'Your own listing — the full description is kept.';
  $('paste-text').value = ''; $('paste-status').textContent = '';
  $('paste-modal').classList.remove('hidden');
}
function closePaste() { $('paste-modal').classList.add('hidden'); pasteMode = null; }
async function parseGo() {
  const text = $('paste-text').value.trim();
  if (!text) { $('paste-status').textContent = 'Paste some text first'; return; }
  $('paste-status').textContent = 'Parsing…';
  try {
    const p = await api.post('/api/listings/parse', { text, mode: pasteMode });
    closePaste();
    if (pasteMode === 'comp') {
      openEntityEdit('comps', null, { title: p.title, competitorPrice: p.sellingPrice, deliveryFee: p.deliveryFee, condition: p.condition, specSummary: p.specSummary, sourceUrl: null });
    } else {
      openListingEdit(null, { title: p.title, sellingPrice: p.sellingPrice, condition: p.condition, description: p.description, notes: p.seller ? `Seller: ${p.seller}` : null, parts: p.parts });
    }
  } catch (e) { $('paste-status').textContent = e.message; }
}
function carousellText(l) {
  const parts = l.parts || [];
  const specLines = parts.map((p) => `- ${String(p.partType).toUpperCase()}: ${p.partName}`).join('\n');
  const lines = [`# ${l.title}`, '', `### S$${(Number(l.sellingPrice) || 0).toFixed(2)}`, '', 'Details', ''];
  if (l.condition) lines.push('Condition', l.condition, '');
  if (l.category) lines.push('Category', `In ${l.category}`, '');
  lines.push('Description', '', l.description || l.notes || 'Fully tested and working.');
  if (specLines) lines.push('', '**Full Specifications**', specLines);
  return lines.join('\n');
}
async function copyListing(id) {
  try {
    const l = await api.get(`/api/listings/listings/${id}`);
    const text = carousellText(l);
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
    else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
    toast('Copied Carousell listing to clipboard');
  } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
async function renderSettings() {
  const el = $('tab-settings');
  el.innerHTML = `<div class="panel-head"><h2>Settings</h2></div>
    <div class="card"><h3>Costs &amp; fees (global)</h3>
      <div class="form-grid">
        <label>Platform fee %<input id="s-plat" type="number" step="0.01" /></label>
        <label>Payment fee %<input id="s-pay" type="number" step="0.01" /></label>
        <label>Shipping (S$)<input id="s-ship" type="number" step="0.01" /></label>
        <label>Profit warn at (S$)<input id="s-warn" type="number" step="0.01" /></label>
        <label>Profit danger at (S$)<input id="s-danger" type="number" step="0.01" /></label>
      </div>
      <div class="actions" style="margin-top:14px">
        <button class="btn primary" id="s-save">Save</button>
        <button class="btn" id="s-recalc">Recalculate profits</button>
      </div>
      <p class="muted" id="s-result"></p>
    </div>
    <div class="card"><h3>Lookups (dropdown lists)</h3><div id="lookups-editor"></div></div>`;
  const s = await api.get('/api/listings/cost-settings');
  settings = s;
  $('s-plat').value = s.platformFeePct ?? 0;
  $('s-pay').value = s.paymentFeePct ?? 0;
  $('s-ship').value = s.shippingCost ?? 0;
  $('s-warn').value = s.profitWarn ?? 0;
  $('s-danger').value = s.profitDanger ?? -20;
  $('s-save').onclick = async () => {
    try {
      await api.put('/api/listings/cost-settings', { platformFeePct: num($('s-plat').value) ?? 0, paymentFeePct: num($('s-pay').value) ?? 0, shippingCost: num($('s-ship').value) ?? 0, profitWarn: num($('s-warn').value) ?? 0, profitDanger: num($('s-danger').value) ?? -20 });
      toast('Saved'); await renderSettings();
    } catch (e) { toast(e.message); }
  };
  $('s-recalc').onclick = async () => {
    try { const r = await api.post('/api/listings/recalc'); $('s-result').textContent = `${r.affectedCount} listing(s) recalculated · total net ${fmt(r.totalNet)}`; }
    catch (e) { toast(e.message); }
  };
  renderLookupsEditor();
}
function renderLookupsEditor() {
  const el = $('lookups-editor');
  const keys = Object.keys(lookups).sort();
  if (!keys.length) { el.innerHTML = '<p class="muted">No lookups.</p>'; return; }
  el.innerHTML = keys.map((k) => `<div class="lookup-group">
    <h4>${esc(k)}</h4>
    <div class="lookup-tags">${(lookups[k] || []).map((o) => `<span class="lookup-tag">${esc(o.value)}<button data-id="${o.id}" title="Remove">×</button></span>`).join('')}</div>
    <div class="lookup-add"><input id="lk-${esc(k)}" placeholder="Add value…" /><button class="btn sm" data-key="${esc(k)}">Add</button></div>
  </div>`).join('');
  el.querySelectorAll('.lookup-tag button').forEach((b) => b.onclick = async () => {
    try { await api.del(`/api/listings/lookups/${b.dataset.id}`); toast('Removed'); await loadLookups(); renderLookupsEditor(); }
    catch (e) { toast(e.message); }
  });
  el.querySelectorAll('.lookup-add button').forEach((b) => b.onclick = async () => {
    const key = b.dataset.key; const val = document.getElementById('lk-' + key).value.trim();
    if (!val) return;
    try { await api.post('/api/listings/lookups', { listKey: key, value: val }); toast('Added'); await loadLookups(); renderLookupsEditor(); }
    catch (e) { toast(e.message); }
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
async function loadLookups() {
  try { lookups = (await api.get('/api/listings/lookups')).lookups || {}; }
  catch { lookups = {}; }
}
async function boot() {
  if (!api.isLoggedIn()) { showLogin(); return; }
  $('login-modal').classList.add('hidden');
  $('signout').classList.remove('hidden');
  await loadLookups();
  try { settings = await api.get('/api/listings/cost-settings'); } catch { /* defaults */ }
  await renderTab();
}

// ---------------------------------------------------------------------------
// wire up
// ---------------------------------------------------------------------------
$('login-btn').addEventListener('click', submitLogin);
$('login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });
$('signout').addEventListener('click', () => { api.clearToken(); location.reload(); });
$('edit-close').addEventListener('click', closeModal);
$('edit-cancel').addEventListener('click', closeModal);
$('edit-save').addEventListener('click', () => { if (saveHandler) saveHandler(); });
// Backdrop click closes the modal only when the press STARTED on the backdrop.
// Otherwise a drag that begins inside the card (e.g. selecting text in an
// input, dragging a slider) and releases over the backdrop would fire a click
// on the overlay and silently close the modal, discarding unsaved work.
let editDownTarget = null;
$('edit-modal').addEventListener('pointerdown', (e) => { editDownTarget = e.target; });
$('edit-modal').addEventListener('click', (e) => {
  if (e.target === $('edit-modal') && editDownTarget === $('edit-modal')) closeModal();
});
$('discover-close').addEventListener('click', closeDiscover);
$('discover-done').addEventListener('click', closeDiscover);
let discoverDownTarget = null;
$('discover-modal').addEventListener('pointerdown', (e) => { discoverDownTarget = e.target; });
$('discover-modal').addEventListener('click', (e) => {
  if (e.target === $('discover-modal') && discoverDownTarget === $('discover-modal')) closeDiscover();
});
$('paste-close').addEventListener('click', closePaste);
$('paste-cancel').addEventListener('click', closePaste);
$('paste-go').addEventListener('click', parseGo);
let pasteDownTarget = null;
$('paste-modal').addEventListener('pointerdown', (e) => { pasteDownTarget = e.target; });
$('paste-modal').addEventListener('click', (e) => {
  if (e.target === $('paste-modal') && pasteDownTarget === $('paste-modal')) closePaste();
});
document.querySelectorAll('#tabs .tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
document.addEventListener('auth:logout', () => { showLogin(); });
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'add-part') {
    const list = $('parts-list');
    if (list.querySelector('.muted')) list.innerHTML = '';
    list.insertAdjacentHTML('beforeend', partRow());
  } else if (e.target && e.target.id === 'add-purchase') {
    const list = $('purchases-list');
    if (list.querySelector('.muted')) list.innerHTML = '';
    list.insertAdjacentHTML('beforeend', purchaseRow());
    updateAvgPreview();
  } else if (e.target && e.target.classList.contains('p-del')) {
    e.target.closest('.part-row, .purchase-row')?.remove();
    if (e.target.closest('.purchase-row')) updateAvgPreview();
  }
});

// --- notepad (draggable, collapsible, autosaved) -----------------------------
const NP_KEY = 'oswald_listings_notepad';
function initNotepad() {
  const panel = $('notepad-panel');
  const text = $('np-text');
  let saveT;
  text.value = localStorage.getItem(NP_KEY) || '';
  $('np-count').textContent = `${text.value.length} chars`;
  text.addEventListener('input', () => {
    $('np-count').textContent = `${text.value.length} chars`;
    clearTimeout(saveT);
    saveT = setTimeout(() => localStorage.setItem(NP_KEY, text.value), 250);
  });
  $('btn-notepad').addEventListener('click', () => {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) text.focus();
  });
  $('np-close').addEventListener('click', () => panel.classList.add('hidden'));
  $('np-toggle').addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    $('np-toggle').textContent = panel.classList.contains('collapsed') ? '▸' : '▾';
  });
  $('np-copy').addEventListener('click', async () => {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text.value);
    else { text.select(); document.execCommand('copy'); }
    toast('Copied');
  });
  $('np-clear').addEventListener('click', () => {
    if (!confirm('Clear the notepad?')) return;
    text.value = '';
    localStorage.setItem(NP_KEY, '');
    $('np-count').textContent = '0 chars';
  });
  // drag by the header (skip drags that start on a button)
  const head = $('np-head');
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    drag = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.x))}px`;
    panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 80, e.clientY - drag.y))}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });
  head.addEventListener('pointerup', () => { drag = null; });
  head.addEventListener('pointercancel', () => { drag = null; });
}

initNotepad();

boot();
