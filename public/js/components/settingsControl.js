// components/settingsControl.js
// Renders a settings gear button (into #settings-control) + the settings modal
// (static #settings-modal in index.html). The store (../utils/settingsStore.js)
// owns the schema and persistence; this component only renders controls, wires
// them to the store, and applies changes to the page.

import {
  loadSettings,
  getSetting,
  setSetting,
  resetSettings,
  SETTINGS_SCHEMA,
  SETTINGS_SECTIONS,
} from '../utils/settingsStore.js';

let modal = null;
let formEl = null;

function el(id) {
  return document.getElementById(id);
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
          `<option value="${o}" ${String(o) === String(value) ? 'selected' : ''}>${o} sec</option>`
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

  if (setting.type === 'readonly') {
    return `
      <div class="settings-row">
        ${label}
        <div class="settings-control">
          <span class="settings-readonly">${value ? 'On' : 'Off'}</span>
        </div>
      </div>`;
  }

  return '';
}

function renderForm() {
  if (!formEl) return;
  formEl.innerHTML = '';

  SETTINGS_SECTIONS.forEach((section) => {
    const defs = SETTINGS_SCHEMA.filter((s) => s.section === section.id);
    if (!defs.length) return;

    const sectionEl = document.createElement('div');
    sectionEl.className = 'settings-section';
    sectionEl.innerHTML = `
      <h3 class="settings-section-title">${section.title}</h3>
      ${section.description ? `<p class="settings-section-desc">${section.description}</p>` : ''}
      <div class="settings-section-body"></div>
    `;

    const body = sectionEl.querySelector('.settings-section-body');
    defs.forEach((s) => {
      body.insertAdjacentHTML('beforeend', controlHtml(s, getSetting(s.key)));
    });

    formEl.appendChild(sectionEl);
  });

  // Wire controls to the store (applies immediately).
  formEl.querySelectorAll('[data-key]').forEach((input) => {
    input.addEventListener('change', () => {
      const value = input.type === 'checkbox' ? input.checked : input.value;
      setSetting(input.dataset.key, value);
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
  setVisible('services-tray', getSetting('showServicesTray'));
  setVisible('server-heading', getSetting('showMcp'));
  setVisible('mcp-control', getSetting('showMcp'));
  setVisible('monitor-heading', getSetting('showMonitoring'));
  setVisible('monitor-control', getSetting('showMonitoring'));
}

async function init() {
  const mount = el('settings-control');
  if (!mount) return;

  mount.innerHTML =
    '<button type="button" id="settings-open" class="settings-gear" title="Settings">⚙</button>';

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
