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

async function pingIP(ip) {
  console.log(`Pinging ${ip}...`);
  const start = performance.now();
  try {
    // Try connecting to the IP (note: needs CORS support on server)
    await fetch(`http://${ip}`, { mode: 'no-cors', cache: 'no-cache' });
    const end = performance.now();
    return { ip, status: 'active', time: Math.round(end - start) + 'ms' };
    if (response.ok) {
      // unreachable due to CORS, so we check status code instead
      if (response.status === 200 || response.status === 304 + (end - start) < 300)
        return { ip, status: 'active', time: Math.round(end - start) + 'ms' };
      else return { ip, status: 'slow', time: Math.round(end - start) + 'ms' };
    }
  } catch (error) {
    return { ip, status: 'inactive', time: null, error: error.message };
  }
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
