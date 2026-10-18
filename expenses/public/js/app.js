// expenses/public/js/app.js — General Expense Sheet UI.
import { api } from './api.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n === null || n === undefined || n === '' ? '—' : 'S$' + Number(n).toFixed(2));
const num = (v) => { if (v === '' || v === null || v === undefined) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

const CATEGORY_OPTIONS = [['computer', 'Computer'], ['investing', 'Investing'], ['school', 'School'], ['other', 'Other']];
const CATEGORY_LABEL = Object.fromEntries(CATEGORY_OPTIONS);
const CATEGORY_CHIP = { computer: 'info', investing: 'warn', school: 'green', other: 'gray' };
const PLATFORM_OPTIONS = [['debit', 'Debit'], ['credit', 'Credit']];

const state = { items: [], q: '', category: '', month: '', sortKey: 'expenseDate', sortDir: 'desc' };
let editingId = null;
const trash = []; // { undo }

function toast(msg, opts = {}) {
  const el = $('toast');
  el.textContent = msg;
  if (opts.undo) {
    const btn = document.createElement('button');
    btn.className = 'toast-undo';
    btn.textContent = 'Undo';
    btn.onclick = () => { clearTimeout(el._t); el.classList.add('hidden'); opts.undo(); };
    el.appendChild(btn);
  }
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), opts.ms || 4000);
}

function sortRows(rows) {
  const d = state.sortDir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    let va = a[state.sortKey], vb = b[state.sortKey];
    if (state.sortKey === 'amount') { va = Number(va) || 0; vb = Number(vb) || 0; }
    else { va = String(va ?? '').toLowerCase(); vb = String(vb ?? '').toLowerCase(); }
    return (va < vb ? -1 : va > vb ? 1 : 0) * d;
  });
}
function filtered() {
  let rows = state.items;
  if (state.q) { const q = state.q.toLowerCase(); rows = rows.filter((r) => [r.description, r.tags, r.platform].filter(Boolean).join(' ').toLowerCase().includes(q)); }
  return sortRows(rows);
}
function th(key, label) {
  const arrow = state.sortKey === key ? (state.sortDir === 'asc' ? '▲' : '▼') : '';
  return `<th class="sortable" data-sort="${key}">${label}${arrow ? ` <span class="arrow">${arrow}</span>` : ''}</th>`;
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
function openModal(v) {
  editingId = v?.id ?? null;
  $('edit-title').textContent = editingId ? 'Edit expense' : 'Add expense';
  $('f-description').value = v?.description ?? '';
  $('f-amount').value = v?.amount ?? '';
  $('f-category').value = v?.category ?? 'other';
  $('f-platform').value = v?.platform ?? '';
  $('f-tags').value = v?.tags ?? '';
  $('f-expenseDate').value = v?.expenseDate ? String(v.expenseDate).slice(0, 10) : new Date().toISOString().slice(0, 10);
  $('edit-status').textContent = '';
  $('edit-modal').classList.remove('hidden');
}
function closeModal() { $('edit-modal').classList.add('hidden'); editingId = null; }
async function saveExpense() {
  const category = $('f-category').value;
  const amount = num($('f-amount').value);
  if (!category) { $('edit-status').textContent = 'Category is required'; return; }
  if (amount === null) { $('edit-status').textContent = 'Amount is required'; return; }
  const body = {
    category,
    description: $('f-description').value.trim() || null,
    amount,
    platform: $('f-platform').value || null,
    tags: $('f-tags').value.trim() || null,
    expenseDate: $('f-expenseDate').value ? new Date($('f-expenseDate').value).toISOString() : null,
  };
  try {
    if (editingId) await api.put(`/api/expenses/${editingId}`, body);
    else await api.post('/api/expenses', body);
    closeModal();
    toast(editingId ? 'Expense updated' : 'Expense added');
    await load();
  } catch (e) { $('edit-status').textContent = e.message; }
}
async function delExpense(id) {
  if (!confirm('Delete this expense?')) return;
  try {
    const snap = state.items.find((x) => x.id === id) || {};
    await api.del(`/api/expenses/${id}`);
    trash.push({ undo: async () => { await api.post('/api/expenses', snap); await load(); } });
    toast('Expense deleted', { undo: () => { const bin = trash.pop(); if (bin) bin.undo().then(() => toast('Expense restored')).catch((e) => toast(e.message)); } });
    await load();
  } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
function renderStats(stats) {
  const el = $('stats');
  const byCat = stats.byCategory || [];
  const chip = (c) => {
    const row = byCat.find((x) => x.category === c) || { total: 0, cnt: 0 };
    return `<div class="stat"><div class="v">${fmt(row.total)}</div><div class="l">${CATEGORY_LABEL[c]} · ${row.cnt}</div></div>`;
  };
  el.innerHTML = `<div class="stat stat--total"><div class="v">${fmt(stats.total)}</div><div class="l">Total · ${stats.count} expense(s)</div></div>` +
    CATEGORY_OPTIONS.map(([k]) => chip(k)).join('');
}
function renderRows() {
  const rows = filtered();
  const tb = $('expenses-body');
  if (!rows.length) tb.innerHTML = `<tr><td colspan="7" class="empty">No expenses yet — add one, or Sync from the ledger.</td></tr>`;
  else tb.innerHTML = rows.map((r) => `<tr>
    <td>${r.expenseDate ? String(r.expenseDate).slice(0, 10) : '—'}</td>
    <td><span class="chip ${CATEGORY_CHIP[r.category] || 'gray'}">${CATEGORY_LABEL[r.category] || esc(r.category)}</span></td>
    <td class="t-desc" title="${esc(r.description)}">${esc(r.description || '')}</td>
    <td>${fmt(r.amount)}</td>
    <td>${r.platform ? esc(r.platform[0].toUpperCase() + r.platform.slice(1)) : '—'}</td>
    <td class="t-tags">${esc(r.tags || '')}</td>
    <td class="actions actions-cell">
      <button class="btn sm" data-edit="${r.id}">Edit</button>
      <button class="btn sm danger" data-del="${r.id}">×</button>
    </td></tr>`).join('');
  tb.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openModal(state.items.find((x) => x.id === Number(b.dataset.edit))));
  tb.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => delExpense(Number(b.dataset.del)));
  $('listings-totals').textContent = `${rows.length} expense(s)`;
}
function bindSort() {
  document.querySelectorAll('th.sortable').forEach((h) => h.addEventListener('click', () => {
    const k = h.dataset.sort;
    if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else { state.sortKey = k; state.sortDir = k === 'amount' ? 'desc' : 'asc'; }
    renderRows();
  }));
}
async function load() {
  try {
    const qs = new URLSearchParams();
    if (state.category) qs.set('category', state.category);
    if (state.month) qs.set('month', state.month);
    const [list, stats] = await Promise.all([
      api.get('/api/expenses' + (qs.toString() ? '?' + qs.toString() : '')),
      api.get('/api/expenses/stats' + (state.month ? '?month=' + state.month : '')),
    ]);
    state.items = list.items || [];
    renderStats(stats);
    renderRows();
    bindSort();
  } catch (e) { $('expenses-body').innerHTML = `<tr><td colspan="7" class="err">${esc(e.message)}</td></tr>`; }
}
async function syncNow(silent) {
  try {
    const { imported } = await api.post('/api/expenses/sync');
    if (!silent || imported > 0) toast(imported > 0 ? `Synced ${imported} ledger expense(s)` : 'Already up to date');
    await load();
  } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------------------
// export (CSV / JSON)
// ---------------------------------------------------------------------------
function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function toCSV(rows) {
  if (!rows.length) return '';
  const keys = ['expenseDate', 'category', 'description', 'amount', 'platform', 'tags'];
  const cell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [keys.join(','), ...rows.map((r) => keys.map((k) => cell(k === 'expenseDate' && r[k] ? String(r[k]).slice(0, 10) : r[k])).join(','))].join('\r\n');
}
function bindExport() {
  $('exp-csv').onclick = () => {
    const rows = filtered();
    if (!rows.length) { toast('Nothing to export'); return; }
    download('expenses.csv', toCSV(rows), 'text/csv');
    toast(`Exported ${rows.length} row(s) as CSV`);
  };
  $('exp-json').onclick = () => {
    const rows = filtered();
    if (!rows.length) { toast('Nothing to export'); return; }
    download('expenses.json', JSON.stringify(rows, null, 2), 'application/json');
    toast(`Exported ${rows.length} row(s) as JSON`);
  };
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
async function boot() {
  if (!api.isLoggedIn()) { showLogin(); return; }
  $('login-modal').classList.add('hidden');
  $('signout').classList.remove('hidden');
  await syncNow(true);
  await load();
}

// ---------------------------------------------------------------------------
// wire up
// ---------------------------------------------------------------------------
$('login-btn').addEventListener('click', submitLogin);
$('login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });
$('signout').addEventListener('click', () => { api.clearToken(); location.reload(); });
$('edit-close').addEventListener('click', closeModal);
$('edit-cancel').addEventListener('click', closeModal);
$('edit-save').addEventListener('click', saveExpense);
$('add-expense').addEventListener('click', () => openModal(null));
$('btn-sync').addEventListener('click', () => syncNow(false));
$('search').addEventListener('input', (e) => { state.q = e.target.value; renderRows(); });
$('f-category-filter').addEventListener('change', (e) => { state.category = e.target.value; load(); });
$('f-month').addEventListener('change', (e) => { state.month = e.target.value; load(); });
$('btn-clear-month').addEventListener('click', () => { $('f-month').value = ''; state.month = ''; load(); });
document.addEventListener('auth:logout', () => showLogin());
bindExport();
boot();
