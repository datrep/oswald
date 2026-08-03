// Place for utility/helper JS functions shared across pages

function showTime() {
  let date = new Date();

  // Format options: 24h clock and YYYY/MM/DD
  let options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false, // This forces 24-hour format
  };

  // Generate the string (en-GB uses DD/MM/YYYY, so we manually join for YYYY/MM/DD)
  let year = date.getFullYear();
  let month = String(date.getMonth() + 1).padStart(2, '0');
  let day = String(date.getDate()).padStart(2, '0');
  let time = date.toLocaleTimeString('en-GB', { hour12: false });

  let fullDisplay = `${year}/${month}/${day} ${time}`;

  const clockEl = document.getElementById('myClock');
  if (clockEl) clockEl.innerText = fullDisplay;
  setTimeout(showTime, 1000);
}

const modalStack = [];

function registerModal(modalElement, hideMethod = 'style') {
  if (!(modalElement instanceof HTMLElement)) return;
  const entry = { element: modalElement, hideMethod };
  if (!modalStack.some((item) => item.element === modalElement)) {
    modalStack.push(entry);
  }
}

function unregisterModal(modalElement) {
  if (!(modalElement instanceof HTMLElement)) return;
  const index = modalStack.findIndex((item) => item.element === modalElement);
  if (index !== -1) {
    modalStack.splice(index, 1);
  }
}

function hideElement(element, hideMethod = 'style') {
  if (!(element instanceof HTMLElement)) return;
  if (hideMethod === 'class-hidden') {
    element.classList.add('hidden');
    return;
  }
  if (hideMethod === 'attribute-hidden') {
    element.hidden = true;
    return;
  }
  element.style.display = 'none';
}

function closeTopModal() {
  const entry = modalStack.pop();
  if (entry && entry.element instanceof HTMLElement) {
    hideElement(entry.element, entry.hideMethod);
    return true;
  }
  return false;
}

// this entire css modal name convention is bad, CHANGE todo://
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') {
    console.log('Escape key pressed - closing modals if any are open');
    if (!closeTopModal()) {
      const fallbackModal = document.querySelector('.modal');
      if (fallbackModal) hideElement(fallbackModal, 'style');
      const policyPanel = document.querySelector('.policy-form-panel');
      if (policyPanel) hideElement(policyPanel, 'class-hidden');
      const resourceModal = document.querySelector('#resource-modal, .resource-modal');
      if (resourceModal) hideElement(resourceModal, 'style');
    }
  }
});

// Usage
showTime();

// Shared "?" help popover (used by the dashboard and policy pages).
function attachHelpPopover(buttonEl, { title, body }) {
  if (!buttonEl) return;

  let popoverEl = null;
  let isOpen = false;

  const close = () => {
    if (!popoverEl) return;
    popoverEl.remove();
    popoverEl = null;
    isOpen = false;
    buttonEl.setAttribute('aria-expanded', 'false');
  };

  const open = () => {
    close();

    popoverEl = document.createElement('div');
    popoverEl.className = 'help-popover';
    popoverEl.setAttribute('role', 'tooltip');
    popoverEl.innerHTML = `
      <div class="help-popover-title"></div>
      <div class="help-popover-body"></div>
    `;
    popoverEl.querySelector('.help-popover-title').textContent = title || 'More info';
    popoverEl.querySelector('.help-popover-body').textContent = body || '';

    document.body.appendChild(popoverEl);

    const rect = buttonEl.getBoundingClientRect();
    const gap = 8;
    const maxRight = window.innerWidth - 12;

    let left = rect.left;
    let top = rect.bottom + gap;

    const popRect = popoverEl.getBoundingClientRect();
    if (left + popRect.width > maxRight) {
      left = Math.max(12, maxRight - popRect.width);
    }
    if (top + popRect.height > window.innerHeight - 12) {
      top = Math.max(12, rect.top - gap - popRect.height);
    }

    popoverEl.style.left = `${left}px`;
    popoverEl.style.top = `${top}px`;

    isOpen = true;
    buttonEl.setAttribute('aria-expanded', 'true');
  };

  const toggle = () => {
    if (isOpen) close();
    else open();
  };

  buttonEl.setAttribute('aria-haspopup', 'true');
  buttonEl.setAttribute('aria-expanded', 'false');

  buttonEl.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  });

  document.addEventListener('click', (e) => {
    if (!isOpen) return;
    if (e.target === buttonEl) return;
    if (popoverEl && popoverEl.contains(e.target)) return;
    close();
  });

  document.addEventListener('keydown', (e) => {
    if (!isOpen) return;
    if (e.key === 'Escape') close();
  });
}
