import { apiGet, apiPost, apiPut, apiDelete, isLoggedIn } from '../api/api.js';
import { getSetting } from '../utils/settingsStore.js';

function confirmIfEnabled(message) {
  return getSetting('confirmDelete') ? confirm(message) : true;
}

// Inline SVG fallback so a missing icon never 404s.
const FALLBACK_ICON =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Ccircle%20cx%3D%228%22%20cy%3D%228%22%20r%3D%227%22%20fill%3D%22%237c8cf8%22%2F%3E%3C%2Fsvg%3E';

// Services Tray Component
const servicesList = document.getElementById('services-list');
const addButton = document.getElementById('service-add-button');
const addForm = document.getElementById('service-add-form');

// form elements
const saveServiceButton = document.getElementById('save-service-button');

const serviceNameInput = document.getElementById('service-name');

const serviceTypeInput = document.getElementById('service-type');

const serviceTargetInput = document.getElementById('service-target');

const serviceIconInput = document.getElementById('service-icon');

let editingServiceId = null;

addButton.addEventListener('click', () => {
  openAddForm();
});

function openAddForm() {
  editingServiceId = null;
  serviceNameInput.value = '';
  serviceTypeInput.value = 'url';
  serviceTargetInput.value = '';
  serviceIconInput.value = '';
  saveServiceButton.textContent = 'Save';
  addForm.classList.remove('hidden');
  serviceNameInput.focus();
}

function openEditForm(service) {
  editingServiceId = service.id;
  serviceNameInput.value = service.name || '';
  serviceTypeInput.value = service.type || 'url';
  serviceTargetInput.value = service.target || '';
  serviceIconInput.value = service.iconPath || '';
  saveServiceButton.textContent = 'Save Changes';
  addForm.classList.remove('hidden');
  serviceNameInput.focus();
}

function resetAddForm() {
  serviceNameInput.value = '';
  serviceTypeInput.value = 'url';
  serviceTargetInput.value = '';
  serviceIconInput.value = '';
  saveServiceButton.textContent = 'Save';
}

document.getElementById('service-add-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  setSaveState(saveServiceButton, true);
  try {
    const serviceData = {
      name: serviceNameInput.value.trim(),
      type: serviceTypeInput.value,
      target: serviceTargetInput.value.trim(),
      iconPath: serviceIconInput.value.trim(),
      description: '',
      enabled: true,
      sortOrder: 0,
    };
    if (editingServiceId) {
      await apiPut(`/api/services/${editingServiceId}`, serviceData);
      editingServiceId = null;
    } else {
      await apiPost('/api/services', serviceData);
    }

    await loadServices(); // Refresh the services list after saving

    resetAddForm();
    addForm.classList.add('hidden'); // Hide the form after saving
  } catch (err) {
    console.error('[ServicesTray] Failed to save service', err);
    alert('Failed to save service');
  } finally {
    setSaveState(saveServiceButton, false);
  }
});

function getServiceIcon(service) {
  // Priority: 1. Custom icon path (if provided), 2. Google favicon, 3. Fallback
  if (service.iconPath && service.iconPath.startsWith('http')) {
    return service.iconPath; // Use remote icons directly if valid HTTP/HTTPS
  }

  try {
    const url = new URL(service.target);
    const domain = url.hostname.replace(/^www\./, ''); // Remove 'www.' prefix

    // Google's favicon API supports sizes (16, 32, 48)
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
  } catch (err) {
    console.warn('[ServicesTray] Invalid URL for service target:', service.target);
    return FALLBACK_ICON; // Fallback
  }
}

const GROUP_LABELS = { url: 'Websites', local_app: 'Local Apps' };

// servicesList
function renderServices(services) {
  servicesList.innerHTML = '';

  const sorted = [...services].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)
  );

  const groups = {};
  for (const s of sorted) {
    const key = s.type === 'local_app' ? 'local_app' : 'url';
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }

  for (const [key, items] of Object.entries(groups)) {
    if (!items.length) continue;
    const heading = document.createElement('div');
    heading.className = 'service-group-heading';
    heading.textContent = GROUP_LABELS[key] || key;
    servicesList.appendChild(heading);
    let itemIndex = 0;
    items.forEach((service) => servicesList.appendChild(renderServiceItem(service, itemIndex++)));
  }
}

function renderServiceItem(service, index) {
  const item = document.createElement('div');
  item.className = 'service-item anim-enter';
  if (index !== undefined && index !== null) {
    item.style.animationDelay = `${index * 0.04}s`;
  }
  const iconSrc = getServiceIcon(service);
  const actions = isLoggedIn()
    ? `<div class="service-actions">
         <button type="button" class="service-edit" title="Edit service">✎</button>
         <button type="button" class="service-delete" title="Delete service">✕</button>
       </div>`
    : '';

  item.innerHTML = `
    <a class="service-link" href="${service.target}" target="_blank" rel="noopener">
      <img class="service-icon" src="${iconSrc}" alt="${service.name}" onerror="this.src='${FALLBACK_ICON}'">
      <span>${service.name}</span>
    </a>
    ${actions}
  `;

  const editBtn = item.querySelector('.service-edit');
  const deleteBtn = item.querySelector('.service-delete');
  if (editBtn) {
    editBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openEditForm(service);
    });
  }
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirmIfEnabled(`Delete service "${service.name}"?`)) return;
      try {
        await apiDelete(`/api/services/${service.id}`);
        await loadServices();
      } catch (err) {
        console.error('[ServicesTray] delete failed', err);
        alert('Failed to delete service');
      }
    });
  }

  return item;
}

async function loadServices() {
  try {
    const services = await apiGet('/api/services');

    renderServices(services);
  } catch (err) {
    console.error('[ServicesTray] Failed to load services', err);
  }
}

loadServices();
console.log('[ServicesTray] loaded');
