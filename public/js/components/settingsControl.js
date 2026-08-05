// components/settingsControl.js
// Renders a settings gear button (into #settings-control) + the settings modal
// (static #settings-modal in index.html). The store (../utils/settingsStore.js)
// owns the schema and persistence; this component renders the hierarchical tree
// (categories -> sections -> controls), wires it to the store, and applies
// changes to the page (dashboard panels + global theme/accent + session).

import { clearToken } from '../api/api.js';
import {
  loadSettings,
  getSetting,
  setSetting,
  resetSettings,
  saveServerSetting,
  applyGlobalSettings,
  initSessionTimeout,
  exportSettings,
  importSettings,
  clearLocalData,
  resetDismissals,
  SETTINGS_CATEGORIES,
  SETTINGS_SCHEMA,
  SETTINGS_SECTIONS,
} from '../utils/settingsStore.js';

let modal = null;
let formEl = null;

function el(id) {
  return document.getElementById(id);
}

function optValue(o) {
  return typeof o === 'object' && o !== null ? o.value : o;
}
function optLabel(o) {
  return typeof o === 'object' && o !== null ? o.label : `${o} sec`;
}
function escAttr(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function controlHtml(setting, value) {
  const label = `
    <div class="settings-row-label">
      <strong>${setting.label}</strong>
      ${setting.description ? `<span>${setting.description}</span>` : ''}
    </div>`;

  if (setting.type === 'boolean') {
    return `
      <div class="settings-row">
        ${label}
        <label class="settings-switch" title="${setting.label}">
          <input type="checkbox" data-key="${setting.key}" ${value ? 'checked' : ''} />
          <span class="slider"></span>
        </label>
      </div>`;
  }

  if (setting.type === 'select') {
    const opts = setting.options
      .map(
        (o) =>
          `<option value="${optValue(o)}" ${String(optValue(o)) === String(value) ? 'selected' : ''}>${optLabel(o)}</option>`
      )
      .join('');
    return `
      <div class="settings-row">
        ${label}
        <div class="settings-control">
          <select data-key="${setting.key}">${opts}</select>
        </div>
      </div>`;
  }

  if (setting.type === 'color') {
    return `
      <div class="settings-row">
        ${label}
        <div class="settings-control">
          <input type="color" data-key="${setting.key}" value="${value || setting.default}" />
        </div>
      </div>`;
  }

  if (setting.type === 'readonly') {
    return `
      <div class="settings-row">
        ${label}
        <div class="settings-control">
          <span class="settings-readonly">${value ? 'On' : 'Off'}</span>
        </div>
      </div>`;
  }

  if (setting.type === 'text') {
    return `
      <div class="settings-row">
        ${label}
        <div class="settings-control">
          <input type="text" data-key="${setting.key}" value="${escAttr(value ?? setting.default ?? '')}" />
        </div>
      </div>`;
  }

  return '';
}

// Sections that render action buttons instead of (or in addition to) settings.
function isActionSection(id) {
  return id === 'popup' || id === 'data' || id === 'session';
}

function actionHtml(sectionId) {
  if (sectionId === 'popup') {
    return '<div class="settings-actions"><button type="button" data-action="reset-dismissals">Reset "don\'t show for today"</button></div>';
  }
  if (sectionId === 'data') {
    return `<div class="settings-actions">
      <button type="button" data-action="export">Export settings</button>
      <button type="button" data-action="import">Import settings</button>
      <button type="button" data-action="clear">Clear local data</button>
    </div>`;
  }
  if (sectionId === 'session') {
    return '<div class="settings-actions"><button type="button" data-action="signout">Sign out now</button></div>';
  }
  return '';
}

function renderSection(section) {
  const defs = SETTINGS_SCHEMA.filter((s) => s.section === section.id);
  const rows = defs.map((s) => controlHtml(s, getSetting(s.key))).join('');
  const actions = actionHtml(section.id);
  if (!rows && !actions) return '';
  return `
    <div class="settings-section">
      <h4 class="settings-section-title">${section.title}</h4>
      <div class="settings-section-body">
        ${rows}
        ${actions}
      </div>
    </div>
  `;
}

function renderForm() {
  if (!formEl) return;
  formEl.innerHTML = '';

  SETTINGS_CATEGORIES.forEach((cat) => {
    const catSections = SETTINGS_SECTIONS.filter((s) => s.category === cat.id);
    const html = catSections.map(renderSection).join('');
    if (!html) return;

    const catEl = document.createElement('div');
    catEl.className = 'settings-category';
    catEl.innerHTML = `
      <div class="settings-category-header" role="button" tabindex="0" aria-expanded="true">
        <h3 class="settings-category-title">${cat.title}</h3>
        <span class="settings-category-chevron">▾</span>
      </div>
      <div class="settings-category-body">${html}</div>
    `;

    const header = catEl.querySelector('.settings-category-header');
    const body = catEl.querySelector('.settings-category-body');
    header.addEventListener('click', () => {
      const collapsed = body.classList.toggle('collapsed');
      header.setAttribute('aria-expanded', String(!collapsed));
      header.querySelector('.settings-category-chevron').textContent = collapsed ? '▸' : '▾';
    });
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        header.click();
      }
    });

    formEl.appendChild(catEl);
  });

  // Wire controls to the store (applies immediately). Server-editable settings
  // (e.g. resourcesDir) go through PUT /api/settings instead of localStorage.
  formEl.querySelectorAll('[data-key]').forEach((input) => {
    input.addEventListener('change', () => {
      const value = input.type === 'checkbox' ? input.checked : input.value;
      const def = SETTINGS_SCHEMA.find((s) => s.key === input.dataset.key);
      if (def && def.server && def.editable) {
        saveServerSetting(input.dataset.key, value)
          .then(() => {
            const fb = el('settings-feedback');
            if (fb) showFormFeedback(fb, 'success', 'Server setting saved');
          })
          .catch((err) => {
            const fb = el('settings-feedback');
            if (fb) showFormFeedback(fb, 'error', 'Save failed — ' + (err.message || 'check admin permission'));
            renderForm(); // revert the control to the stored value
          });
      } else {
        setSetting(input.dataset.key, value);
      }
    });
  });

  wireActions();
}

function wireActions() {
  formEl.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const fb = el('settings-feedback');
      if (action === 'reset-dismissals') {
        resetDismissals();
        if (fb) showFormFeedback(fb, 'success', 'Dismissals reset — the popup will show again.');
      } else if (action === 'export') {
        exportSettings();
        if (fb) showFormFeedback(fb, 'success', 'Settings exported as JSON');
      } else if (action === 'import') {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json';
        input.addEventListener('change', async () => {
          const file = input.files[0];
          if (!file) return;
          try {
            const text = await file.text();
            importSettings(text);
            renderForm();
            if (fb) showFormFeedback(fb, 'success', 'Settings imported');
          } catch (err) {
            console.error('[Settings] import failed', err);
            if (fb) showFormFeedback(fb, 'error', 'Import failed — invalid file');
          }
        });
        input.click();
      } else if (action === 'clear') {
        if (!confirm('Clear all local settings and cached data?')) return;
        clearLocalData();
        renderForm();
        if (fb) showFormFeedback(fb, 'success', 'Local data cleared');
      } else if (action === 'signout') {
        clearToken();
        window.dispatchEvent(new CustomEvent('auth:logout'));
        closeModal();
      }
    });
  });
}

function openModal() {
  if (!modal) return;
  renderForm();
  modal.classList.add('show');
}

function closeModal() {
  if (modal) modal.classList.remove('show');
}

// Centralized apply: run after load and on every settings change.
function applySettings() {
  const setVisible = (id, visible) => {
    const node = el(id);
    if (node) node.style.display = visible ? '' : 'none';
  };
  setVisible('services-section', getSetting('showServicesTray'));
  setVisible('mcp-section', getSetting('showMcp'));
  setVisible('monitoring-section', getSetting('showMonitoring'));
  applyGlobalSettings();
  initSessionTimeout();
}

async function init() {
  const mount = el('settings-control');
  if (!mount) return;

  mount.innerHTML =
    '<button type="button" id="settings-open" class="settings-gear" title="Settings" aria-label="Settings"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>';

  modal = el('settings-modal');
  formEl = el('settings-form');

  el('settings-open').addEventListener('click', openModal);
  el('settings-modal-close')?.addEventListener('click', closeModal);
  el('settings-done')?.addEventListener('click', closeModal);
  el('settings-reset')?.addEventListener('click', () => {
    if (!confirm('Reset all settings to their defaults?')) return;
    resetSettings();
    renderForm();
    const fb = el('settings-feedback');
    if (fb) showFormFeedback(fb, 'success', 'Settings reset to defaults');
  });

  // Close on outside click and Escape.
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && modal.classList.contains('show')) closeModal();
  });

  await loadSettings();
  applySettings();
  window.addEventListener('settings:changed', applySettings);
  window.addEventListener('settings:reset', applySettings);
}

init();
