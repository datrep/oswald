// components/notepad.js
// Persistent scratchpad for the Job Applications page: collect snippets from job
// cards / anything else, autosave to localStorage, then copy it back out into
// any text field. Reusable — drop the markup on another page + initNotepad().
//
// Markup contract (ids): #np-toggle, #np-panel, #np-text, #np-count,
// #np-copy, #np-clear, #np-copied, #np-close.

const NOTEPAD_KEY = 'oswald_jobs_notepad';

function loadText() {
  try {
    return localStorage.getItem(NOTEPAD_KEY) || '';
  } catch {
    return '';
  }
}
function saveText(text) {
  try {
    localStorage.setItem(NOTEPAD_KEY, text);
  } catch {
    /* private mode etc. — ignore */
  }
}

export function initNotepad() {
  const panel = document.getElementById('np-panel');
  const text = document.getElementById('np-text');
  if (!panel || !text) return;

  const count = document.getElementById('np-count');
  const copied = document.getElementById('np-copied');
  const updateCount = () => {
    if (count) count.textContent = `${text.value.length} chars`;
  };

  text.value = loadText();
  updateCount();

  // Autosave (debounced) so typing never loses data.
  let timer;
  text.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => saveText(text.value), 250);
    updateCount();
  });

  document.getElementById('np-toggle')?.addEventListener('click', () => panel.classList.toggle('hidden'));
  document.getElementById('np-close')?.addEventListener('click', () => panel.classList.add('hidden'));

  document.getElementById('np-copy')?.addEventListener('click', async () => {
    text.focus();
    text.select();
    try {
      await navigator.clipboard.writeText(text.value);
      if (copied) copied.textContent = 'Copied!';
    } catch {
      if (copied) copied.textContent = 'Select + Ctrl/Cmd+C';
    }
    setTimeout(() => {
      if (copied) copied.textContent = '';
    }, 1600);
  });

  document.getElementById('np-clear')?.addEventListener('click', () => {
    if (!window.confirm('Clear the notepad?')) return;
    text.value = '';
    saveText('');
    updateCount();
  });
}

/** Append a snippet to the notepad and reveal the panel so the user sees it. */
export function appendNotepad(snippet) {
  const text = document.getElementById('np-text');
  if (!text) return;
  const block = String(snippet ?? '').trim();
  if (!block) return;
  const current = text.value.trim();
  text.value = current ? `${current}\n${block}` : block;
  saveText(text.value);
  const panel = document.getElementById('np-panel');
  if (panel) panel.classList.remove('hidden');
  const count = document.getElementById('np-count');
  if (count) count.textContent = `${text.value.length} chars`;
}
