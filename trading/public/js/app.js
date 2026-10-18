// trading/public/js/app.js — Trading Agent dashboard (TRD-4).
import { apiGet, apiPost, apiPut, apiDelete, login, getToken, clearToken, isLoggedIn } from './api.js';

const $ = (id) => document.getElementById(id);
const state = { timeframe: '1h', symbol: null, chart: null, btTimeframe: '1h', btSymbol: null, btRange: '1w', btChart: null, symbolMap: {}, coverage: [], paused: false, deliberation: { quantPanel: [], chairs: [] }, strategies: [], barCharts: {}, cdCtx: null, dataPlane: null };

const fmt = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { hour12: false });
};
// ISO -> datetime-local input value (local time).
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
// Pretty numbers: thousands separators, fixed decimals when asked.
const num = (v, dp = null) => {
  if (v == null || Number.isNaN(Number(v))) return '—';
  if (dp == null) return Number(v).toLocaleString('en-US', { maximumFractionDigits: 6 });
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round2 = (v) => (v == null ? '—' : Number(v).toFixed(2));

function feedback(el, msg, ok = true) {
  el.textContent = msg || '';
  el.className = 'feedback ' + (msg ? (ok ? 'ok' : 'err') : '');
}

// F4/F18 (2026-09-18): AN ABSOLUTE TIMESTAMP IS NOT A FRESHNESS STATEMENT.
//
// "17/09/2026, 22:48" on a card that re-renders itself reads as current state, and the audit found two
// live cases of exactly that: a pulse 18.8h old rendered on the front card, and `skipped · kill_switch_hard`
// shown 8 minutes after it stopped being true. The age is now rendered beside the time, derived from the
// same value, so "when" and "how long ago" can never disagree.
function ageLabel(dateish) {
  const t = dateish ? new Date(dateish).getTime() : NaN;
  if (!Number.isFinite(t)) return '';
  const mins = (Date.now() - t) / 60000;
  if (mins < 1) return 'just now';
  if (mins < 90) return `${Math.round(mins)}m ago`;
  if (mins < 60 * 36) return `${(mins / 60).toFixed(1)}h ago`;
  return `${(mins / 1440).toFixed(1)}d ago`;
}

// ---------------- auth ----------------
function showLogin() { $('login-card').classList.remove('hidden'); $('app').classList.add('hidden'); $('btn-auth').textContent = 'Sign in'; }
async function showApp() {
  $('login-card').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('btn-auth').textContent = 'Sign out';
  try {
    const me = await apiGet('/api/trading/me');
    $('user-chip').textContent = `— user #${me.userID} (${(me.roles || []).join(', ')})`;
  } catch { /* me optional */ }
  await refreshAll();
}

// ---------------- controls ----------------
async function refreshKill() {
  const k = await apiGet('/api/trading/kill');
  const tier = k.tier || 'off';
  state.killTier = tier;
  const chip = $('kill-tier');
  chip.className = 'chip ' + tier;
  chip.textContent = tier.toUpperCase();
  if (tier !== 'off') {
    chip.title = `kill tier ${tier.toUpperCase()} — set ${k.at ? fmt(k.at) : 'recently'}. Resume clears it; the tier is never auto-cleared.`;
  } else {
    chip.title = 'no kill in force';
  }
  $('kill-floor').textContent = num(k.disasterFloorPct, 0) + '%';
  $('kill-equity').textContent = num(k.initialEquity);
  $('btn-kill-off').disabled = tier === 'off';
}

async function refreshBridge() {
  const b = await apiGet('/api/trading/bridge');
  state.bridgePaused = !!b.paused;
  state.bridgeParked = !!b.parked;
  const stateEl = $('bridge-state');
  if (b.parked) { stateEl.textContent = 'PARKED — no browser activity'; stateEl.className = 'neg'; }
  else if (b.paused) { stateEl.textContent = 'PAUSED (UI fallback)'; stateEl.className = 'neg'; }
  else if (b.chromeAlive) { stateEl.textContent = 'ok — Chrome connected'; stateEl.className = 'pos'; }
  else { stateEl.textContent = 'Chrome off (auto-starts on capture)'; stateEl.className = 'muted'; }
  $('bridge-fails').textContent = b.consecutiveFails ?? 0;
  $('bridge-cap').textContent = b.watchlist?.symbols?.length ? `${b.watchlist.symbols.length} tracked` : 'off';
  $('btn-bridge-resume').disabled = !b.paused;
  const parkBtn = $('btn-bridge-park');
  if (parkBtn) parkBtn.textContent = b.parked ? 'Unpark' : 'Park (analysis)';
}

async function refreshWakerStatus() {
  // Light status-only refresh — safe to run on a timer (does NOT touch inputs).
  const w = await apiGet('/api/trading/status');
  state.paused = !!w.paused;
  $('waker-running').textContent = state.paused ? 'paused' : w.running ? 'yes' : 'no';
  $('btn-wake-pause').textContent = state.paused ? 'Resume' : 'Pause';
  $('waker-progress').textContent = w.inProgress ? 'waking…' : 'idle';
  $('waker-last').textContent = w.lastWakeAt ? fmt(w.lastWakeAt) : '—';
  $('waker-next').textContent = w.nextWakeAt ? fmt(w.nextWakeAt) : '—';
  $('btn-wake').disabled = !!w.inProgress;
  // 2026-09-12: return the status so refreshWaker() can use it — the watchdog /
  // login / decision block below used to read a `w` that only existed in THIS
  // scope, so refreshWaker threw on every cycle and the old `catch {}` in
  // refreshAll hid it (the Agent card's watchdog rows never rendered).
  return w;
}

async function refreshWaker() {
  const w = await refreshWakerStatus();
  try {
    const s = await apiGet('/api/trading/settings');
    if ($('wake-interval')) $('wake-interval').value = (s.wake && s.wake.intervalMinutes) || 10;
    // TRD-11: agent flags — every behavior flag in one place.
    // F21 (18/09): one read of the two facts the whole page shares. The kill tier comes from
    // `refreshKill` (which paints the header chip); the enabled-strategy list drives both the FLAGS
    // list and the AI State card. They used to be read from `/kill`, `/settings` AND `/state` on three
    // independent schedules, which is how one snapshot could read `kill: hard` here while the header
    // chip still said `OFF`.
    state.strategiesEnabled = s.strategies?.enabled || [];
    // ⚠ /settings HAS NO `mode` FIELD. Read the whole Settings blob back and there is no top-level mode —
    // only `watchlist.mode`, which is a different fact (dynamic vs fixed universe). The mode lives in the
    // STATE TREE (`stateTree.js`: `mode: sim ? 'sim' : 'plus500_demo'`), reachable from /state. So the mode
    // is NOT read here; `renderAiState` owns it (TRD-UI-2), and everything that displays a mode projects
    // that one value through applyMode(). A read of a field that does not exist yields null, and null is a
    // value the page would then have to defend against everywhere — it is not a safer default, it is a
    // silent wrong answer.
    const F = [
      ['wake loop', s.wake?.enabled !== false ? 'on' : 'OFF'],
      ['scheduled', s.wake?.paused ? 'PAUSED' : 'running'],
      ['market hours only', s.wake?.marketHoursOnly !== false ? 'yes' : 'no'],
      ['interval', (s.wake?.intervalMinutes ?? 10) + 'm'],
      ['kill', state.killTier || s.kill?.tier || 'off'],
      ['disaster floor', s.kill?.disasterFloorPct != null ? s.kill.disasterFloorPct + '%' : 'off'],
      ['baseline', s.kill?.initialEquity != null ? num(s.kill.initialEquity, 2) : 'unset'],
      ['paper mode', s.paper?.enabled ? 'ON' : 'off'],
      ['bridge capture', s.bridge?.captureOnWake !== false ? 'on wake' : 'off'],
      ['watchdog', s.watchdog?.enabled !== false ? 'on' : 'off'],
      ['providers', (s.providers?.enabled || []).join('+')],
      ['strategies', (s.strategies?.enabled || []).length ? (s.strategies.enabled.join('+')) : 'NONE — cannot enter'],
      ['position review', ((s.deliberation && s.deliberation.positionReview) || {}).enabled === false ? 'OFF' : 'every ' + (((s.deliberation && s.deliberation.positionReview) || {}).reviewMinutes ?? 5) + 'm'],
      ['pulse', s.pulse?.enabled !== false ? 'on' : 'off'],
      ['central thinking', s.central?.thinking !== false ? 'on' : 'off'],
      ['congress', (s.strategies?.enabled || []).includes('congress') ? (s.congress?.token ? 'on (token)' : 'on (NO token)') : 'off'],
      ['llm', s.llm?.model || 'deepseek-flash'],
      ['llm stub', s.llm?.stub ? 'YES (fake)' : 'off'],
    ];
    // 2026-09-12 (found in a screenshot, not in code): the flags list rendered
    // `kill: hard` GREEN — the heuristic only softened off/PAUSED/unset/NONE,
    // so the most severe state on the desk looked "on/healthy" while the AI
    // State chip beside it showed red. The kill chip now uses the tier itself.
    const tone = (v, k) => {
      const s = String(v);
      if (k === 'kill') return /hard/i.test(s) ? 'hard' : /soft/i.test(s) ? 'soft' : 'open';
      return /OFF|off|PAUSED|unset|NO token|NONE/.test(s) ? 'soft' : 'open';
    };
    $('agent-flags').innerHTML = F.map(([k, v]) => `<span class="chip ${tone(v, k)}" style="margin:1px 2px">${esc(k)}: ${esc(v)}</span>`).join(' ');
    // F28 (2026-09-12 review): the GLOBAL enabled list is not the tradable
    // universe — symbolScope silently disables symbols (an explicit [] means
    // "no strategies"). Live example: enabled=[survgold,survoil] while Bitcoin,
    // Silver, Sugar, SGX, Arabica Coffee and "others" are all [].
    const uni = $('banner-universe');
    if (uni) {
      const enabled = s.strategies?.enabled || [];
      const scope = s.strategies?.symbolScope || {};
      const limited = Object.entries(scope).filter(([, l]) => Array.isArray(l) && l.length > 0).map(([sym, l]) => `${sym} (${l.join('+')})`);
      const barred = Object.entries(scope).filter(([, l]) => Array.isArray(l) && l.length === 0).map(([sym]) => sym);
      const def = scope.others || scope['*'];
      if (!enabled.length) {
        uni.textContent = 'nothing — audit mode';
        uni.className = 'chip soft';
        uni.title = 'strategies.enabled is empty: the desk evaluates every symbol but can never enter a trade.';
      } else if (limited.length) {
        uni.textContent = `${limited.length} symbol${limited.length > 1 ? 's' : ''}`;
        uni.className = 'chip soft';
        uni.title = `enabled: ${enabled.join('+')}\ncan enter: ${limited.join(', ')}\nno strategies (cannot enter): ${barred.join(', ') || '—'}\ndefault for unlisted: ${def ? JSON.stringify(def) : 'global list'}`;
      } else {
        uni.textContent = enabled.join('+');
        uni.className = 'chip open';
        uni.title = `enabled: ${enabled.join('+')} — no per-symbol scope restrictions`;
      }
    }
  } catch { /* flags optional */ }

  // TRD-8 watchdog status
  const wd = w.watchdog || {};
  const wdEl = $('waker-watchdog');
  if (wd.running) { wdEl.textContent = 'on'; wdEl.className = 'v pos'; }
  else { wdEl.textContent = 'off'; wdEl.className = 'v muted'; }
  const lg = $('waker-login');
  if (wd.login && wd.login.alive === false) { lg.textContent = 'SIGNED OUT'; lg.className = 'v neg'; }
  else if (wd.login && wd.login.alive === true) { lg.textContent = 'ok'; lg.className = 'v pos'; }
  else { lg.textContent = '—'; lg.className = 'v muted'; }
  try {
    const ev = await apiGet('/api/trading/events?kind=wake&limit=1');
    const row = (ev.items || [])[0] || null;
    const payload = (row && row.payload) || {};
    // F4: the age of the verdict this card is showing. It renders the newest `wake` event REGARDLESS of age,
    // so without this the reason line is read as what the desk is doing now rather than what it did.
    const when = row && row.createdAt ? ageLabel(row.createdAt) : '';
    // 2026-09-12 (visible only in a screenshot): a skipped wake carries the cause
    // in `skipped` while the envelope's `action` is just the event name 'wake',
    // so this card read "Last decision: wake" with a blank reason — the WHY of a
    // no-op wake was invisible on the front card.
    const skipped = payload.skipped ? `skipped · ${payload.skipped}` : null;
    const action = skipped || (payload.action && payload.action !== 'wake' ? payload.action : (payload.action || '—'));
    if (payload.mode === 'paper' && payload.stance) {
      const tone = payload.stance === 'long' ? 'pos' : payload.stance === 'short' ? 'neg' : 'muted';
      $('waker-decision').innerHTML = `<span class="${tone}">${esc(payload.stance)}</span>`;
      $('waker-reason').textContent = [String(payload.headline || '').slice(0, 80), when].filter(Boolean).join(' · ');
    } else {
      const tone = skipped ? 'warn-t' : action === 'entry' ? 'pos' : action === 'exit' ? 'warn-t' : 'muted';
      $('waker-decision').innerHTML = `<span class="${tone}">${esc(action)}</span>`;
      $('waker-reason').textContent = [String(payload.reason || payload.skipped || payload.headline || '').slice(0, 80), when].filter(Boolean).join(' · ');
    }
    if (row && row.createdAt) $('waker-decision').title = `newest wake event — ${fmt(row.createdAt)} (${when})`;
  } catch { $('waker-decision').textContent = '—'; }
}



function selectSymbol(sym) {
  state.symbol = sym;
  document.querySelectorAll('.tab[data-tab]').forEach((x) => x.classList.remove('active'));
  document.querySelector('[data-tab="prices"]').classList.add('active');
  for (const name of ['wakes', 'events', 'trades', 'alerts', 'prices']) {
    $('tab-' + name).classList.toggle('hidden', name !== 'prices');
  }
  const sel = $('bar-symbol');
  if (state.symbol && [...sel.options].some((o) => o.value === state.symbol)) sel.value = state.symbol;
  refreshBars();
}

async function toggleSymbol(symbol) {
  try {
    const r = await apiPost('/api/trading/watchlist/toggle', { symbol });
    feedback($('watch-feedback'), `${symbol} ${r.removed ? 'removed' : 'added'}`);
    await refreshWatchlist();
    await loadSymbols();
    await refreshBars();
  } catch (e) { feedback($('watch-feedback'), e.message, false); }
}

function renderWlResults(q) {
  const box = $('wl-results');
  const query = (q || '').trim().toLowerCase();
  if (!query) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const tracked = new Set((state.symbols || []).map((s) => s.symbol.toLowerCase()));
  const matches = (state.universe || [])
    .filter((u) => !tracked.has(u.symbol.toLowerCase()) && u.symbol.toLowerCase().includes(query))
    .slice(0, 10);
  if (!matches.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = matches.map((u) => `<div class="wl-item"><span>${esc(u.symbol)}</span><button class="small" data-add="${esc(u.symbol)}">Add</button></div>`).join('');
  box.querySelectorAll('[data-add]').forEach((b) => { b.onclick = () => toggleSymbol(b.dataset.add); });
}

async function refreshWatchlist() {
  const wl = await apiGet('/api/trading/watchlist');
  state.universe = wl.universe || [];
  state.symbols = wl.symbols || [];
  const dynamic = (wl.mode || 'dynamic') === 'dynamic';
  const box = $('watchlist-chips');
  box.innerHTML = state.symbols.length
    ? state.symbols.map((s) => `<span class="chip ${(s.source || 'manual') === 'ai' ? 'soft' : 'off'}" data-sym="${esc(s.symbol)}"><span class="sym-name">${esc(s.symbol)}${(s.source || 'manual') === 'ai' ? ' ★ai' : ''}</span><span class="x" role="button" tabindex="0" aria-label="Remove ${esc(s.symbol)} from the watchlist" title="Remove">×</span></span>`).join(' ')
    : '<span class="muted">empty — search below to add</span>';
  box.querySelectorAll('[data-sym]').forEach((chip) => {
    chip.style.cursor = 'pointer';
    // F12 (2026-09-12 review): a symbol chip now opens that symbol's DECISIONS
    // (filtered) — it used to jump to the chart while the decision trail stayed
    // unfindable. The chart is still one click away in the Prices tab.
    chip.querySelector('.sym-name').onclick = () => {
      const sym = chip.dataset.sym;
      const inp = $('wakes-symbol');
      if (inp) inp.value = sym;
      document.querySelectorAll('.tab[data-tab]').forEach((x) => x.classList.remove('active'));
      const tabBtn = document.querySelector('[data-tab="wakes"]');
      if (tabBtn) tabBtn.classList.add('active');
      for (const name of ['wakes', 'events', 'trades', 'alerts', 'prices']) {
        $('tab-' + name).classList.toggle('hidden', name !== 'wakes');
      }
      refreshWakes().catch(() => {});
    };
    chip.querySelector('.x').onclick = (e) => { e.stopPropagation(); toggleSymbol(chip.dataset.sym); };
    // F14/F28: the remove control is now reachable and operable from the keyboard, not just by a mouse
    // click on a glyph. A tabindex without a key handler would be an accessibility HALF-fix — the control
    // would take focus and then ignore the user.
    chip.querySelector('.x').onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleSymbol(chip.dataset.sym); }
    };
  });
  $('btn-confirm').disabled = !(wl.candidates || []).some((c) => c.found);
  $('wl-mode').textContent = dynamic ? `dynamic · ${state.symbols.length} tracked` : 'fixed';
  // AI discoverer section: separate manual/ai counts + last run.
  const aiCount = state.symbols.filter((s) => (s.source || 'manual') === 'ai').length;
  const manualCount = state.symbols.length - aiCount;
  if ($('wl-ai-count')) $('wl-ai-count').textContent = `manual ${manualCount} · ai ${aiCount}`;
  const dsc = await apiGet('/api/trading/watchlist/discover').catch(() => null);
  if ($('wl-ai-last')) $('wl-ai-last').textContent = dsc && dsc.at ? `last run ${fmt(dsc.at)}${dsc.added ? ` · added ${dsc.added.length}` : ''}` : '';
  const ds = await apiGet('/api/trading/settings').catch(() => null);
  const dc = (ds && (ds.settings || ds).discover) || {};
  if ($('wl-ai-enabled')) $('wl-ai-enabled').checked = dc.enabled === true;
  if ($('wl-ai-max')) { $('wl-ai-max').value = Number(dc.maxAiSymbols) || 5; const v = $('wl-ai-max-v'); if (v) v.textContent = (Number(dc.maxAiSymbols) || 5); }
  // In dynamic mode the watchlist updates itself from capture — no Discover needed.
  $('btn-discover').classList.toggle('hidden', dynamic);
  $('btn-confirm').classList.toggle('hidden', dynamic);
  renderWlResults($('wl-search').value || '');
}

async function refreshProviders() {
  try {
    const s = await apiGet('/api/trading/providers/status');
    state.symbolMap = s.symbolMap || {};
    const cov = await apiGet('/api/trading/providers/coverage').catch(() => ({ items: [] }));
    state.coverage = cov.items || [];
    if (!s.last) { $('prov-binance').textContent = '—'; $('prov-okx').textContent = '—'; $('prov-yahoo').textContent = '—'; $('prov-last').textContent = 'never'; return; }
    const r = s.last.results || {};
    const line = (p) => { const x = r[p]; return x ? (x.ok ? `${x.ticks} ticks` : (x.error || 'failed')) : 'off'; };
    $('prov-binance').textContent = line('binance');
    $('prov-okx').textContent = line('okx');
    $('prov-yahoo').textContent = line('yahoo');
    $('prov-last').textContent = `${fmt(s.last.at)} · ${s.last.ticks} ticks`;
    applyProviderGrey();
  } catch { /* providers optional */ }
}

function coverageLine(symbol, timeframe) {
  const rows = state.coverage.filter((c) => c.symbol === symbol && c.timeframe === timeframe);
  if (!rows.length) return 'no stored bars';
  return rows.map((c) => `${c.venue} ${num(c.bars, 0)} bars · ${fmt(c.fromBar)} → ${fmt(c.toBar)}`).join(' · ');
}

// ---------------- tabs ----------------
const ACTION_TONE = { entry: 'pos', exit: 'neg', none: 'muted' };

// WHY NOTHING WAS DELIBERATED (2026-09-12 — owner: "I would like a reason answer,
// not just 'not deliberated' with no why"). The pipeline DOES record the cause:
// the wake event carries `reason` (e.g. 'SESSION_LOCK observation window') and the
// bundle carries the guards that produced it (`session.state`, `session.detail`,
// `sessionLock`, `stalePrices`). The per-symbol card hard-coded a string and threw
// all of it away, so a correct, deliberate skip (the session guard suppresses the
// LLM call in the pre/post-open window to avoid opening a position minutes before a
// weekend close) was indistinguishable from a failure.
//
// PLAIN ENGLISH (2026-09-30 — owner: "easy to understand reasons ... a normal person
// can understand at a glance"). The causes were already on the record; what was
// missing was a sentence that does not have to be translated. Every branch below
// states WHAT HAPPENED and then WHY, names no code, and never reads as a fault when
// the desk is behaving exactly as designed. The rule for a new cause: if a reader has
// to know what a wake or a guard is to follow the sentence, it is not finished.
// ONE RESOLVER, TWO RENDERINGS, EVERY CAUSE (2026-09-30 — owner: "flesh out all cause cases, and add in the
// shortened reasons"). The cause is decided ONCE in `undeliberatedCause`; `short` is for the glance (a wake
// header, a chip), `long` is for the detail card. Two renderings of one decision cannot drift; two separate
// reason functions would.
//
// ⚠ EVERY BRANCH STATES WHAT HAPPENED AND THEN WHY, NAMES NO CODE, AND NEVER READS AS A FAULT WHEN THE DESK IS
// BEHAVING AS DESIGNED — a session-lock skip is a deliberate act, and the old wording made it look like a failure.
// The rule for a new cause: if a reader has to know what a wake or a guard is to follow the sentence, it is not
// finished.
const CAUSE_TEXT = {
  // ── the desk chose not to look ───────────────────────────────────────────────────────────────────────────
  session_pre: { short: 'waiting for the open', long: 'the market is just before it opens, so the desk waits rather than opening a position into a close' },
  session_post: { short: 'just after the close', long: 'the market has just closed, so the desk waits rather than acting on a stale price' },
  session_window: { short: 'close/open window', long: 'the market is inside its quiet window around the open or the close, and the desk waits rather than opening a position into it' },
  market_closed: { short: 'market shut', long: 'the market is shut right now' },
  stale_prices: { short: 'prices too old', long: 'the newest price is more than 4 hours old, which is too stale to decide on' },
  kill_switch: { short: 'desk stopped by hand', long: 'the kill switch is on, so the desk is stopped on purpose' },
  ai_budget: { short: 'AI budget spent', long: 'the AI budget for this period is used up, so this wake ran without it' },
  ai_unreachable: { short: 'AI unreachable', long: 'the AI could not be reached for this wake, so nothing was decided' },
  nothing_proposed: { short: 'nothing to decide on', long: 'no strategy proposed anything, so there was nothing to ask the AI about' },
  exit_deferred: { short: 'a close was held back', long: 'a close was held back because that position was already being handled this wake' },
  market_micro: { short: 'price-move wake', long: 'this wake was triggered by a price moving near a level, not by the usual schedule' },
  no_watchlist: { short: 'watchlist empty', long: 'there was nothing on the watchlist to scan' },
  capture_off: { short: 'price capture off', long: 'price capture is switched off, so the desk had no fresh prices to work from' },
  wake_failed: { short: 'the wake failed', long: 'this wake failed before it reached the AI — the wake log names the step' },
  // ── a strategy looked and found nothing ──────────────────────────────────────────────────────────────────
  scout_flat: { short: 'quiet — no setup', long: 'this one is flat and quiet — the strategy sees no setup' },
  scout_no_history: { short: 'not enough history', long: 'there is not enough price history yet to judge this one' },
  scout_stale: { short: 'its own feed is old', long: 'the price feed for this one is stale' },
  scout_error: { short: 'the scan failed', long: 'the scan failed on this one' },
  scout_no_setup: { short: 'no setup this wake', long: 'the strategy sees no setup on this one this wake' },
  // ── nothing was recorded ─────────────────────────────────────────────────────────────────────────────────
  other_recorded: { short: 'a recorded reason', long: 'a reason was recorded — open the wake log to read it' },
  unknown: { short: 'no reason recorded', long: 'no reason was recorded — the wake log has the detail' },
};

function undeliberatedCause(p, s = null) {
  const b = (p && p.bundle) || {};
  const sess = b.session || {};
  const dec = (p && p.decision) || {};
  if (dec.failed === true) return 'wake_failed';
  if (b.sessionLock) {
    if (sess.state === 'pre') return 'session_pre';
    if (sess.state === 'post') return 'session_post';
    return 'session_window';
  }
  if (sess.state === 'closed') return 'market_closed';
  if (b.stalePrices) return 'stale_prices';
  if (dec.llmCalled === false) {
    const r = String(dec.reason || '');
    if (/kill/i.test(r)) return 'kill_switch';
    if (/budget|cap\b/i.test(r)) return 'ai_budget';
    if (/closed/i.test(r)) return 'market_closed';
    if (/micro/i.test(r)) return 'market_micro';
    if (/watchlist/i.test(r)) return 'no_watchlist';
    if (/capture/i.test(r)) return 'capture_off';
    if (/deferred/i.test(r)) return 'exit_deferred';
    if (/no_signal|flat/i.test(r)) return 'nothing_proposed';
    if (/unavailable|offline|error|fail|timeout/i.test(r)) return 'ai_unreachable';
    return r ? 'other_recorded' : 'unknown';
  }
  if (s) {
    if (s.flat) return 'scout_flat';
    if (s.status === 'insufficient_data') return 'scout_no_history';
    if (s.status === 'stale') return 'scout_stale';
    if (s.status === 'error') return 'scout_error';
    return 'scout_no_setup';
  }
  return 'unknown';
}

// ⚠⚠ "INSUFFICIENT DATA" WAS A VERDICT WITH NO SHORTFALL IN IT, WHICH IS THE WHOLE COMPLAINT (TRD-UI-8). A
// reader could not tell a symbol ONE bar short from one TWENTY-NINE short, so the honest action - wait a wake, or
// drop the symbol - could not be chosen. Both numbers come from the scan (`minBars`, `barCount`); the threshold is
// NEVER written down here, because a second copy of 30 in the client is a worse answer than the bug. On a row
// with no threshold recorded the wording degrades to what it used to say rather than inventing one.
const insufficientBars = (s) => {
  if (!s || s.status !== 'insufficient_data') return null;
  const need = Number(s.minBars);
  const have = Number(s.barCount != null ? s.barCount : s.tickCount);
  if (!Number.isFinite(need) || !Number.isFinite(have) || !(need > 0)) return null;
  const left = Math.max(0, need - have);
  return { need, have, left, venue: s.tickVenue || s.venue || null };
};
// "6 of 30" - for a column, where the heading can carry the unit
const insufficientCount = (s) => {
  const b = insufficientBars(s);
  return b ? `${b.have} of ${b.need}` : null;
};
// the full sentence, for a row and for a tooltip: what it has, what it needs, how far off it is, and WHICH series
// it is counting - because "24 to go" is untrue of a series that is not filling hourly (Natural Gas has 6 bars
// spread over 22 days on one venue and 18 contiguous ones on another).
const insufficientText = (s) => {
  const b = insufficientBars(s);
  if (!b) return 'insufficient data';
  return `insufficient history — ${b.have} of ${b.need} hourly bars`
    + `${b.left > 0 ? `, ${b.left} to go` : ' (threshold met but the series is unusable)'}`
    + `${b.venue ? ` (counting ${b.venue})` : ''}`;
};

const undeliberatedWhy = (p, s = null) => {
  const cause = undeliberatedCause(p, s);
  // TRD-UI-8: the LONG form names the actual shortfall too. This string is what the "why nothing is entering"
  // banner shows, and a reader must not have to open the scouts table to learn how far off a symbol is.
  if (cause === 'scout_no_history') {
    const b = insufficientBars(s);
    if (b) {
      return `${CAUSE_TEXT.scout_no_history.long} — ${b.have} of ${b.need} hourly bars`
        + `${b.left > 0 ? `, ${b.left} to go` : ''}${b.venue ? ` (counting ${b.venue})` : ''}`;
    }
  }
  return (CAUSE_TEXT[cause] || CAUSE_TEXT.unknown).long;
};
const undeliberatedWhyShort = (p, s = null) => (CAUSE_TEXT[undeliberatedCause(p, s)] || CAUSE_TEXT.unknown).short;

async function refreshWakes() {
  const d = await apiGet('/api/trading/prompts?limit=40');
  const items = d.items || [];
  // TRD-12: one row PER SCOUTED SYMBOL (each with its own decision + detail),
  // grouped under a wake header row — Bitcoin/Soybean Oil/Oil each get a line.
  const rows = [];
  const cdCtx = await cdContext().catch(() => null);
  items.forEach((p, i) => {
    const dec = p.decision || {};
    const snap = (p.bundle && p.bundle.snapshot) || [];
    const prop = (p.bundle && p.bundle.proposal) || {};
    const sigCount = snap.filter((s) => s.signal).length;
    const actedCount = (dec.decisions || []).filter((d) => d.action === 'entry' || d.action === 'exit').length;
    const trigTone = p.triggerType === 'schedule' ? 'open' : p.triggerType === 'alert' ? 'soft' : 'off';
    // TRD-51 fix 1 (2026-09-14): a wake that DIED before deliberation. It has no snapshot and
    // no bundle, so without this branch it rendered as an ordinary row reading "none" — or,
    // because a failure also has zero acted signals, as a COLLAPSED "quiet" row. Four hours of
    // outage looked like four hours of nothing. Failures are never quiet and never "none".
    const failed = dec.failed === true;
    const quiet = !failed && actedCount === 0 && sigCount === 0;
    // A wake that never reached deliberation says so, with the recorded cause.
    const noLlm = dec.llmCalled === false || !!(p.bundle && p.bundle.sessionLock);
    const wakeSummary = failed
      ? `FAILED at ${dec.failedStep || 'unknown step'} — ${dec.error || dec.reason || 'no error recorded'}`
      : snap.length
        ? `${snap.length} scouts · ${actedCount} acted / ${sigCount} sig${quiet ? ' · all flat (click to expand)' : ''}${noLlm ? ` · NOT deliberated: ${undeliberatedWhyShort(p)}` : ''}`
        : (dec.action || dec.reason || 'wake');
    const conf = Math.round((dec.confidence ?? 0) * 100);
    const mark = dec.chairVote === 'yes' ? '✓' : dec.chairVote === 'no' ? '✗' : '—';
    rows.push(`<tr class="wake-head${failed ? ' wake-failed' : ''}" data-group="${i}" data-quiet="${quiet ? 1 : 0}"><td><span class="caret">▾</span> ${fmt(p.createdAt)}</td>
      <td><span class="chip ${failed ? 'rejected' : trigTone}">${failed ? 'FAILED' : esc(p.triggerType)}</span></td>
      <td class="muted" colspan="2">${esc(wakeSummary)}</td><td></td><td></td>
      <td class="mono models">${esc(modelsCell(p.model))}</td>
      <td class="num">${p.latencyMs == null ? '—' : num(p.latencyMs, 0) + 'ms'}</td></tr>`);

    if (!snap.length) {
      // Central/sim wakes have no snapshot — one fallback row. A FAILED wake lands here too:
      // it is the honest shape, because no scout ever ran.
      if (failed) {
        rows.push(`<tr class="clickable wake-failed" data-prompt="${i}" data-group="${i}" tabindex="0" role="button" aria-label="failed wake ${i} — open detail">
          <td></td><td></td>
          <td><b>${esc(dec.failedStep || '—')}</b></td>
          <td><span class="chip rejected">FAILED</span>${dec.failedStepMs != null ? ` <span class="muted mono">${num(dec.failedStepMs, 0)}ms</span>` : ''}</td>
          <td class="muted">no deliberation</td>
          <td class="muted" style="white-space:normal" title="${esc(String(dec.error || dec.reason || ''))}">${esc(String(dec.error || dec.reason || 'no error recorded'))}</td>
          <td></td><td></td></tr>`);
        return;
      }
      const tone = dec.action === 'entry' ? 'open' : dec.action === 'exit' ? 'soft' : 'off';
      rows.push(`<tr class="clickable" data-prompt="${i}" data-group="${i}" tabindex="0" role="button" aria-label="central/sim wake ${i} — open detail">
        <td></td><td></td>
        <td><b>${esc(dec.symbol || '—')}</b></td>
        <td><span class="chip ${tone}">${esc(dec.action || 'none')}</span>${dec.chairVote ? ` ${mark} ${conf}%` : ''}</td>
        <td class="muted">central/sim</td>
        <td class="muted" style="white-space:normal" title="${esc(String(dec.reason || ''))}">${esc(String(dec.reason || ''))}</td>
        <td></td><td></td></tr>`);
      return;
    }

    snap.forEach((s) => {
      const sig = s.signal || {};
      // TRD-UI-8: the shortfall for THIS row, computed once and used in both the reason cell and the status
      // cell - the two places a reader looks, and neither of which said it before.
      const ins = insufficientBars(s);
      // Per-symbol decision from the multi-proposal deliberation (fallback:
      // the legacy single-decision wake rows).
      const symDec = (dec.decisions || []).find((x) => x.symbol === s.symbol) || null;
      let decisionHtml = '';
      if (symDec) {
        const tone = symDec.action === 'entry' ? 'open' : symDec.action === 'exit' ? 'soft' : 'off';
        if (symDec.action === 'entry' || symDec.action === 'exit') {
          decisionHtml = `<span class="chip ${tone}">${esc(symDec.action.toUpperCase())}</span>${symDec.chairVote ? ` <span class="muted">${symDec.chairVote === 'yes' ? '✓' : '✗'}</span> ${symDec.confidence != null ? `<span class="conf-bar"><span class="conf-fill ${symDec.chairVote === 'yes' ? 'yes' : ''}" style="width:${Math.round((symDec.confidence ?? 0) * 100)}%"></span></span><span class="muted mono">${Math.round((symDec.confidence ?? 0) * 100)}%</span>` : ''}` : ''}${symDec.size != null ? ` <span class="muted mono">${num(symDec.size, 4)}</span>` : ''}`;
        } else if (/risk veto/i.test(symDec.reason || '')) {
          const cd = cooldownLeft(cdCtx, symDec.symbol, symDec.direction || null);
          const cdNote = /re-entry cooldown/i.test(symDec.reason || '') && cd ? ` · cooldown ${cd.left.toFixed(1)}h left` : '';
          decisionHtml = `<span class="chip closed">VETOED</span> <span class="muted" style="font-size:12px" title="${esc(String(symDec.reason || ''))}${cd ? ' (client-side cooldown estimate derived from closed trades + settings.risk.reentryCooldownBars)' : ''}">${esc(String(symDec.reason || ''))}${cdNote}</span>`;
        } else {
          decisionHtml = `<span class="chip closed">DECLINED</span> <span class="muted" style="font-size:11px" title="${esc(String(symDec.reason || ''))}">${esc(String(symDec.reason || ''))}</span>`;
        }
      } else {
        const isActed = (dec.action === 'entry' || dec.action === 'exit') && dec.symbol === s.symbol;
        const isProposal = prop.symbol === s.symbol && prop.type;
        if (isActed) {
          const tone = dec.action === 'entry' ? 'open' : 'soft';
          const conf = Math.round((dec.confidence ?? 0) * 100);
          decisionHtml = `<span class="chip ${tone}">${esc(dec.action.toUpperCase())}</span>${dec.chairVote ? ` <span class="muted">${dec.chairVote === 'yes' ? '✓' : '✗'}</span> ${dec.confidence != null ? `<span class="conf-bar"><span class="conf-fill ${dec.chairVote === 'yes' ? 'yes' : ''}" style="width:${conf}%"></span></span><span class="muted mono">${conf}%</span>` : ''}` : ''}`;
        } else if (isProposal && dec.action !== 'entry' && dec.action !== 'exit') {
          decisionHtml = `<span class="chip soft">DECLINED</span> <span class="muted" style="font-size:11px">${esc(String(dec.reason || ''))}</span>`;
        } else if (sig.type) {
          const why = undeliberatedWhy(p, s);
          decisionHtml = `<span class="chip closed">signal ${esc(sig.type)}</span> <span class="muted" style="font-size:11px" title="${esc(why)}">not acted — ${esc(undeliberatedWhyShort(p, s))}</span>`;
        } else {
          const flatTxt = s.flat || (s.status === 'insufficient_data' ? insufficientText(s) : s.status === 'stale' ? 'stale data' : s.status === 'error' ? 'scout error' : 'no signal');
          decisionHtml = `<span class="chip closed">flat</span> <span class="muted" style="font-size:11px">${esc(String(flatTxt))}</span>`;
        }
      }
      const detailBits = [sig.basis, sig.strategy, s.price != null ? 'px ' + num(s.price, 4) : null, s.adx14 != null ? 'ADX ' + round2(s.adx14) : null, s.atr14 != null ? 'ATR ' + round2(s.atr14) : null]
        .filter(Boolean).join(' · ');
      // Execution outcome for THIS symbol (persisted onto the prompt row
      // after deliberation) — show why an approved decision didn't land.
      const exec = (dec.executions || []).find((e) => e.symbol === s.symbol);
      if (exec) {
        if (exec.action === 'entry' && exec.placed) decisionHtml += ' <span class="chip pos">filled</span>';
        else if (exec.action === 'entry' && !exec.placed) decisionHtml += ` <span class="chip rejected" title="${esc(exec.error || '')}">not placed · ${esc(String(exec.reason || 'unknown'))}</span>`;
        else if (exec.action === 'exit') decisionHtml += exec.placed ? ' <span class="chip soft">closed</span>' : ` <span class="chip rejected">close failed · ${esc(String(exec.reason || 'unknown'))}</span>`;
      }
      rows.push(`<tr class="clickable" data-prompt="${i}" data-symbol="${esc(s.symbol)}" data-group="${i}" tabindex="0" role="button" aria-label="wake ${i}, ${esc(s.symbol)} — open decision detail">
        <td></td><td></td>
        <td><b>${esc(s.symbol)}</b></td>
        <td class="reason">${decisionHtml}</td>
        <td class="muted"${ins ? ` title="${esc(insufficientText(s))}"` : ''}>${esc(String(s.status || ''))}${ins ? ` · ${esc(insufficientCount(s))}` : ''}</td>
        <td class="muted" colspan="3" style="white-space:normal">${esc(detailBits)}${s.venue ? ' · ' + esc(s.venue) : ''}</td></tr>`);
    });
  });
  const body = $('wakes-body');
  body.innerHTML = rows.join('') || '<tr><td colspan="8" class="muted">no wakes yet</td></tr>';
  body.querySelectorAll('tr[data-prompt]').forEach((tr) => {
    const open = () => {
      body.querySelectorAll('tr.clickable.selected').forEach((x) => x.classList.remove('selected'));
      tr.classList.add('selected');
      renderWakeDetail(items[Number(tr.dataset.prompt)], tr.dataset.symbol || null);
    };
    tr.onclick = open;
    // F10 (2026-09-12): the drilldown used to be mouse-only.
    tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });
  // F5: collapse a wake group by its header row.
  // 2026-09-12 (owner: "too big for the amount of data shown"): a quiet wake is
  // 12 near-identical "flat" rows that exist only to say nothing happened — the
  // header already says it. Those start COLLAPSED; any wake that acted or fired a
  // signal stays open. One click (or Expand all) reveals the rows.
  body.querySelectorAll('tr.wake-head').forEach((head) => {
    const kidsOf = () => [...body.querySelectorAll(`tr[data-prompt][data-group="${head.dataset.group}"]`)];
    const setOpen = (open) => {
      kidsOf().forEach((k) => k.classList.toggle('hidden', !open));
      const caret = head.querySelector('.caret');
      if (caret) caret.textContent = open ? '▾' : '▸';
    };
    setOpen(head.dataset.quiet !== '1');
    head.onclick = () => setOpen(kidsOf().every((k) => k.classList.contains('hidden')));
  });
  wireWakesToolbar();
  applyWakesFilter();
}

// F5/F12 (2026-09-12 review): 465 unfiltered rows made "one symbol's week"
// impossible. The filter is client-side (the API returns the last 40 prompts).
function applyWakesFilter() {
  const body = $('wakes-body');
  if (!body) return;
  const q = ($('wakes-symbol') ? $('wakes-symbol').value : '').trim().toLowerCase();
  let shown = 0;
  for (const tr of body.querySelectorAll('tr[data-prompt]')) {
    const hit = !q || String(tr.dataset.symbol || '').toLowerCase().includes(q);
    if (hit) shown += 1;
  }
  for (const head of body.querySelectorAll('tr.wake-head')) {
    // Respect the group's collapsed state — otherwise the default "quiet wakes
    // are collapsed" behaviour was undone here on every render (the caret is the
    // single source of truth for open/closed).
    const collapsed = (head.querySelector('.caret') || {}).textContent === '▸';
    const kids = [...body.querySelectorAll(`tr[data-prompt][data-group="${head.dataset.group}"]`)];
    for (const k of kids) {
      const hit = !q || String(k.dataset.symbol || '').toLowerCase().includes(q);
      k.classList.toggle('hidden', !hit || (collapsed && !q));
    }
    head.classList.toggle('hidden', q ? !kids.some((k) => !k.classList.contains('hidden')) : false);
  }
  const cnt = $('wakes-count');
  if (cnt) cnt.textContent = q ? `${shown} rows match “${q}”` : '';
}

let wakesWired = false;
function wireWakesToolbar() {
  if (wakesWired) return;
  wakesWired = true;
  const inp = $('wakes-symbol');
  if (inp) {
    inp.oninput = () => applyWakesFilter();
    inp.onkeydown = (e) => { if (e.key === 'Escape') { inp.value = ''; applyWakesFilter(); } };
  }
  const clr = $('wakes-clear');
  if (clr) clr.onclick = () => { if (inp) inp.value = ''; applyWakesFilter(); };
  const col = $('wakes-collapse');
  if (col) col.onclick = () => {
    const body = $('wakes-body');
    body.querySelectorAll('tr[data-prompt]').forEach((t) => t.classList.add('hidden'));
    body.querySelectorAll('tr.wake-head .caret').forEach((c) => { c.textContent = '▸'; });
  };
  const exp = $('wakes-expand');
  if (exp) exp.onclick = () => {
    const body = $('wakes-body');
    body.querySelectorAll('tr').forEach((t) => t.classList.remove('hidden'));
    body.querySelectorAll('tr.wake-head .caret').forEach((c) => { c.textContent = '▾'; });
  };
}

function pre(text) {
  return text == null ? '<pre class="muted">(none)</pre>' : `<pre>${esc(typeof text === 'string' ? text : JSON.stringify(text, null, 2))}</pre>`;
}

async function renderWakeDetail(p, symbol = null) {
  const box = $('wake-detail');
  if (!p) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const dec = p.decision || {};
  const usage = p.usage || {};
  const bundle = p.bundle || {};
  const snap = bundle.snapshot || [];
  // FOCUSED VIEW: clicking an instrument row shows THAT symbol's decision
  // (its own reason / votes / size), not the wake's first-exec summary.
  // Symbols with no proposal still get an honest per-symbol card.
  const focusDec = symbol
    ? ((dec.decisions || []).find((x) => x.symbol === symbol)
      || (() => {
        const s = snap.find((r) => r.symbol === symbol);
        if (!s) return dec;
        return {
          symbol, action: 'none', llmCalled: false,
          reason: s.signal
            ? `signal ${(s.signal.type || '')} present but NOT deliberated — ${undeliberatedWhy(p, s)}`
            : undeliberatedWhy(p, s),
          type: (s.signal || {}).type || null,
          direction: (s.signal || {}).direction || null,
          strategy: (s.signal || {}).strategy || null,
          size: null, chairVote: null, confidence: null,
        };
      })())
    : dec;
  const ctx = await cdContext();
  const barsBySym = {};
  if (snap.length) {
    await Promise.all(snap.slice(0, 8).map(async (s) => { barsBySym[s.symbol] = await symbolBars(s.symbol); }));
  }

  // Scouts table: EVERY symbol evaluated this wake (signal or not) +
  // per-symbol Donchian-band sparkline + re-entry cooldown remaining.
  let scouts = '';
  if (snap.length) {
    const sigCount = snap.filter((s) => s.signal).length;
    const srows = snap.map((s) => {
      const sig = s.signal || {};
      // TRD-UI-8: the shortfall, when there is one - so the Status cell and the Bars column both say it.
      const ins = insufficientBars(s);
      const st = sig.type === 'entry' ? 'pos' : sig.type === 'exit' ? 'neg' : 'muted';
      const spark = sparklineSvg(s.symbol, barsBySym[s.symbol]);
      const cd = cooldownBarHtml(cooldownLeft(ctx, s.symbol, sig.direction || null));
      return `<tr>
        <td><b>${esc(s.symbol)}</b> <span class="muted">${esc(s.venue || '')}</span></td>
        <td${ins ? ` title="${esc(insufficientText(s))}"` : ''}>${esc(s.status)}${ins ? ` <span class="muted mono">${esc(insufficientCount(s))}</span>` : ''}</td>
        <td class="${st}">${sig.type ? `${esc(sig.type)} ${esc(sig.direction || '')}` : '<span class="muted">—</span>'}</td>
        <td class="muted">${sig.basis ? esc(sig.basis) : (s.flat ? esc(String(s.flat)) : '—')}</td>
        <td>${sig.strategy ? esc(sig.strategy) : '—'}</td>
        <td class="mono">${num(s.price, 4)}</td>
        <td class="mono">${round2(s.adx14)}</td>
        <td class="mono">${round2(s.atr14)}</td>
        <td class="mono">${ins ? `${ins.have} / ${ins.need}` : (s.tickCount ?? '—')}</td>
        <td style="padding:2px 6px">${spark}</td>
        <td style="padding:2px 6px">${cd}</td>
      </tr>`;
    }).join('');
    scouts = `<h3>Scouted symbols — ${snap.length} evaluated, ${sigCount} with signal</h3>
      <div class="table-wrap" style="max-height:280px"><table><thead><tr><th>Symbol</th><th>Status</th><th>Signal</th><th>Basis</th><th>Strategy</th><th>Price</th><th>ADX</th><th>ATR</th><th title="hourly bars available / the number the scan needs">Bars (1h)</th><th>Chart (DC20)</th><th>Cooldown</th></tr></thead><tbody>${srows}</tbody></table></div>`;
  }

  // Proposal + risk.
  const prop = bundle.proposal || {};
  const propHtml = prop.symbol
    ? `<h3>Proposal</h3><div class="kv"><span class="k">${esc(prop.symbol)} ${esc(prop.type || '')} ${esc(prop.direction || '')}</span><span class="v">${esc(prop.basis || '')} · size ${num(prop.size, 4)}</span></div>`
    : (snap.length ? '<h3>Proposal</h3><div class="muted">none this wake</div>' : '');
  const riskHtml = focusDec.riskReasons ? `<div class="kv"><span class="k">Risk</span><span class="v muted mono">${esc(focusDec.riskReasons.join('; '))} · size ${num(focusDec.riskSize, 4)}</span></div>` : '';

  // Votes: who said yes / no.
  const v = focusDec.votes || {};
  let votesHtml = '';
  const qv = v.quantVotes || [];
  const cv = v.chairVotes || [];
  if (qv.length || cv.length) {
    const qRows = qv.map((x) => `<tr><td>quant: <b>${esc(x.type)}</b></td><td>${x.vote > 0 ? '<span class="pos">yes (+' + round2(x.vote) + ')</span>' : x.vote < 0 ? '<span class="neg">no (' + round2(x.vote) + ')</span>' : '<span class="muted">abstain</span>'}</td><td class="muted">${esc(x.note || '')}</td></tr>`).join('');
    const cRows = cv.map((x) => `<tr><td>chair: <b>${esc(x.id || x.model || '?')}</b></td><td>${x.vote === 'yes' ? '<span class="pos">YES</span>' : x.vote === 'no' ? '<span class="neg">NO</span>' : '<span class="muted">' + esc(x.vote || 'abstain') + '</span>'}</td><td class="muted">${x.confidence != null ? Math.round(x.confidence * 100) + '%' : '—'} ${esc(String(x.reason || ''))}</td></tr>`).join('');
    votesHtml = `<h3>Who said yes / no</h3>
      <div class="kv"><span class="k">quant panel score</span><span class="v">${round2(v.quantScore)}</span></div>
      <div class="kv"><span class="k">chair score</span><span class="v">${round2(v.chairScore)}</span></div>
      <div class="kv"><span class="k">total (≥0 approves)</span><span class="v">${round2(v.total)}</span></div>
      <table style="margin-top:6px;font-size:12.5px"><tbody>${qRows}${cRows}</tbody></table>`;
  }

  // Callout for a wake that produced no action for this symbol. Two very different
  // cases, and the second was mislabelled: a decision the chairs CONSIDERED and
  // rejected, versus one that never reached deliberation at all because a guard
  // suppressed the LLM call. Calling the latter "Declined — explicit" is simply
  // wrong, and it is the label the owner queried.
  let declined = '';
  if (focusDec.action !== 'entry' && focusDec.action !== 'exit' && focusDec.reason && !/no_signal/.test(focusDec.reason || '')) {
    const rr = (focusDec.riskReasons || []).join('; ');
    // TRD-114 (2026-09-21): TWO INDEPENDENT GATES WERE RENDERED AS ONE SENTENCE. The risk engine's notes are
    // RESIZE records from a gate that PASSED ("venue cost 0.119439...% = 40% of R"), and printing them
    // straight under "deliberation declined" made them read as the reason for the decline. It told the owner
    // the engine had stopped a trade the engine had passed, and hid the actual cause, which was the chairs'
    // signal-quality dissent (ADX 13.5, "range up", a range-fade rather than a breakout). A risk note is not
    // a veto, and a veto is not a note — each block now says which one it is.
    const isRiskVeto = /risk veto/i.test(focusDec.reason || '');
    const rrLabel = isRiskVeto
      ? 'risk gate — this IS the refusal reason'
      : 'risk engine notes — this gate PASSED; it adjusted the size, it did not make this decision';
    const rrBlock = rr
      ? `<div class="muted" style="margin-top:6px;font-size:11px">${rrLabel}</div>`
        + `<div class="muted mono" style="margin-top:2px">${esc(rr)}</div>`
      : '';
    const inner = `<b>${esc(focusDec.reason)}</b>${rrBlock}${focusDec.blockedReason ? `<div class="muted" style="margin-top:4px">blocked: ${esc(focusDec.blockedReason)}</div>` : ''}`;
    declined = focusDec.llmCalled === false
      ? `<h3 class="sec-h">Not deliberated <span class="hint">the AI was not asked this wake — here is why</span></h3>
      <div class="note-box">${inner}</div>`
      : `<h3 class="neg" style="color:var(--danger)">Declined — explicit</h3>
      <div style="border:1px solid var(--danger);border-radius:8px;padding:8px 10px;background:rgba(253,164,175,.06)">
        ${inner}
      </div>`;
  }

  // Execution outcomes for this wake (filtered to the focused symbol).
  const execs = (dec.executions || []).filter((e) => !symbol || e.symbol === symbol);
  let execHtml = '';
  if (execs.length) {
    execHtml = '<h3>Executions</h3>' + execs.map((e) => {
      const ok = e.placed === true;
      const label = e.action === 'entry'
        ? (ok ? 'filled' : `not placed · ${e.reason || 'unknown'}`)
        : (ok ? 'closed' : `close failed · ${e.reason || 'unknown'}`);
      return `<div class="kv"><span class="k">${esc(e.symbol)} ${esc(e.action)}</span><span class="v ${ok ? 'pos' : 'neg'}">${esc(label)}${e.error ? ` (${esc(e.error)})` : ''}</span></div>`;
    }).join('');
  }

  // 2026-09-11: source-level UI addition — the BOOK ROUND (chairs deliberating
  // hold/close when positions are open but no proposal exists) is a symbol-less
  // decision that was recorded but never surfaced. Render it explicitly.
  const bookDec = (dec.decisions || []).find((x) => x.symbol == null && ((x.votes || {}).chairVotes || []).length) || null;
  let bookHtml = '';
  if (bookDec) {
    const bc = (bookDec.votes && bookDec.votes.chairVotes) || [];
    const bRows = bc.map((x) => `<tr><td>chair: <b>${esc(x.id || x.model || '?')}</b>${x.persona ? ` <span class="muted">(${esc(x.persona)})</span>` : ''}</td><td>${x.vote === 'yes' ? '<span class="pos">YES</span>' : x.vote === 'no' ? '<span class="neg">NO</span>' : '<span class="muted">' + esc(x.vote || 'abstain') + '</span>'}</td><td class="muted">${x.confidence != null ? Math.round(x.confidence * 100) + '%' : '—'} ${esc(String(x.reason || ''))}</td></tr>`).join('');
    bookHtml = `<h3>Book round — positions open, no proposal · chairs deliberated hold/close</h3>
      <div class="kv"><span class="k">chair vote</span><span class="v">${esc(bookDec.chairVote || '—')}${bookDec.confidence != null ? ' · confidence ' + Math.round(bookDec.confidence * 100) + '%' : ''}</span></div>
      <table style="margin-top:6px;font-size:12.5px"><tbody>${bRows}</tbody></table>`;
  }

  box.innerHTML = `
    <div class="detail-panel">
      <h3>Decision${symbol ? ` — ${esc(symbol)}` : ''}</h3>
      ${pre(focusDec)}
      ${declined}
      ${bookHtml}
      ${execHtml}
      ${propHtml}
      ${riskHtml}
      ${scouts}
      ${votesHtml}
      <h3>LLM prompt (what the chair was deliberating)</h3>
      ${bundle.text ? `<pre>${esc(bundle.text)}</pre>` : '<pre class="muted">(bundle text not stored for this prompt)</pre>'}
      <h3>Raw model response</h3>
      ${pre(p.response)}
      <h3>Usage</h3>
      ${pre(usage)}
    </div>`;
}

// F23/F24 (2026-09-12 review): the Activity list used to print
// `JSON.stringify(payload).slice(0,120)` — raw JSON cut mid-token, ANSI escapes
// and all — and its kind colours were dead CSS (`.event-kind.decision` never
// matched a real kind; the DB has 43). Both are fixed here.
const EV_FAMILY = {
  act: ['wake', 'decision', 'order_attempt', 'order_rejected', 'order_unconfirmed', 'order_recovered', 'order_unconfirmed_expired', 'order_blocked', 'trade_opened', 'trade_closed', 'position_review', 'alert', 'alternatives', 'paper_trade', 'reconciliation', 'discover_signal', 'politician_alert'],
  state: ['account', 'meta', 'self_health', 'pulse', 'digest', 'whitepaper', 'central', 'ask', 'autopsy', 'multi_signal', 'fill_telemetry', 'day_start', 'account_switch', 'goal50_reached'],
  sec: ['kill', 'tune', 'tune_revert', 'llm_model_mismatch', 'redaction'],
  err: ['error', 'black_swan', 'divergence_alert', 'phantom_fill', 'watchdog_login_death', 'watchdog_waker_stale'],
};
function evClass(kind) {
  for (const [fam, list] of Object.entries(EV_FAMILY)) if (list.includes(kind)) return 'ev-' + fam;
  return 'ev-app';
}
const ANSI_RE = /\u001b\[[0-9;]*m/g;
// 2026-09-12 (user-reported crop): aggregator.js:237 joins one model string per
// CHAIR VOTE, so a 3-chair wake printed "deepseek-v4-pro, deepseek-v4-pro,
// deepseek-v4-pro" — a 326px cell that pushed the 8-column Decisions table 59px
// past the panel and made every row scroll sideways. Collapse to "model ×n".
function modelsCell(m) {
  const list = String(m == null ? '' : m).split(',').map((x) => x.trim()).filter(Boolean);
  if (!list.length) return '—';
  const counts = new Map();
  list.forEach((x) => counts.set(x, (counts.get(x) || 0) + 1));
  return [...counts].map(([x, n]) => (n > 1 ? `${x} ×${n}` : x)).join(', ');
}
function flatText(s, max = 200) {
  return String(s == null ? '' : s).replace(ANSI_RE, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function summarizeEvent(e) {
  const p = e.payload;
  if (p == null) return '—';
  if (typeof p === 'string') return flatText(p, 160);
  const bits = [];
  if (p.level && p.level !== 'info') bits.push(`[${p.level}]`);
  if (p.symbol) bits.push(String(p.symbol));
  const text = p.reason || p.detail || p.summary || p.headline || p.message || p.action || p.source;
  if (text) bits.push(flatText(text, 150));
  if (!bits.length) bits.push(flatText(JSON.stringify(p), 140));
  return bits.join(' · ');
}

async function refreshEvents() {
  const kind = $('events-kind') ? $('events-kind').value : '';
  const d = await apiGet('/api/trading/events?limit=120' + (kind ? '&kind=' + encodeURIComponent(kind) : ''));
  const items = d.items || [];
  const note = $('events-note');
  if (note) note.textContent = kind ? `last ${items.length} “${kind}” events` : `last ${items.length} events (all kinds)`;
  const rows = items.map((e, i) => {
    const p = e.payload;
    const lvl = p && typeof p === 'object' ? (p.level || '') : '';
    const lvlChip = lvl && lvl !== 'info' ? `<span class="chip ${lvl === 'error' ? 'rejected' : 'soft'}" style="margin-right:6px">${esc(lvl)}</span>` : '';
    return `<tr class="clickable" data-event="${i}" tabindex="0" role="button" aria-label="event ${i}: ${esc(e.kind)} — show full payload">
      <td>${fmt(e.createdAt)}</td>
      <td><span class="event-kind ${evClass(e.kind)}">${esc(e.kind)}</span></td>
      <td class="muted" style="white-space:normal">${lvlChip}${esc(summarizeEvent(e))}</td>
    </tr>`;
  }).join('');
  $('events-body').innerHTML = rows || '<tr><td colspan="3" class="muted">no events yet</td></tr>';
  $('events-body').querySelectorAll('[data-event]').forEach((tr) => {
    const toggle = () => {
      const prev = tr.nextElementSibling;
      if (prev && prev.classList.contains('event-detail')) { prev.remove(); tr.classList.remove('selected'); return; }
      $('events-body').querySelectorAll('tr.clickable.selected').forEach((x) => x.classList.remove('selected'));
      tr.classList.add('selected');
      const ev = items[Number(tr.dataset.event)];
      const detail = document.createElement('tr');
      detail.className = 'event-detail';
      detail.innerHTML = `<td colspan="3" style="white-space:normal">${pre(ev.payload)}</td>`;
      tr.after(detail);
    };
    tr.onclick = toggle;
    tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  });
}

function tradeChip(status) {
  const cls = status === 'open' ? 'open' : status === 'closed' ? 'closed' : status === 'phantom' ? 'phantom' : 'rejected';
  return `<span class="chip ${cls}">${esc(status)}</span>`;
}

// ---------------- cooldown + signal sparkline helpers ----------------
async function cdContext() {
  if (state.cdCtx && Date.now() - state.cdCtx.at < 30000) return state.cdCtx;
  const [st, tr] = await Promise.all([
    apiGet('/api/trading/settings').catch(() => null),
    apiGet('/api/trading/trades?limit=200').catch(() => ({ items: [] })),
  ]);
  const s = st && (st.settings || st);
  const cdBars = Number((s && s.risk && s.risk.reentryCooldownBars) ?? 6);
  state.cdCtx = { at: Date.now(), cdBars, trades: (tr && tr.items) || [] };
  return state.cdCtx;
}
function cooldownLeft(ctx, symbol, direction) {
  if (!ctx || !(ctx.cdBars > 0)) return null;
  let bestAt = null;
  for (const t of ctx.trades) {
    if (t.status !== 'closed' || t.symbol !== symbol || (direction && t.direction !== direction)) continue;
    const at = t.closeAt ? new Date(t.closeAt).getTime() : null;
    if (at && (bestAt == null || at > bestAt)) bestAt = at;
  }
  if (bestAt == null) return null;
  const left = ctx.cdBars - (Date.now() - bestAt) / 3600000;
  if (left <= 0) return null;
  return { left, pct: Math.max(0, Math.min(1, left / ctx.cdBars)) };
}
function cooldownBarHtml(left) {
  if (!left) return '<span class="muted">—</span>';
  return `<span class="cd-bar" title="re-entry cooldown ${left.left.toFixed(1)}h remaining"><span class="cd-fill" style="width:${Math.round(left.pct * 100)}%"></span></span><span class="muted mono" style="font-size:10px">${left.left.toFixed(1)}h</span>`;
}
async function symbolBars(symbol) {
  const c = state.barCharts[symbol];
  if (c && Date.now() - c.at < 120000) return c.bars;
  const d = await apiGet('/api/trading/bars?symbol=' + encodeURIComponent(symbol) + '&timeframe=1h&limit=60').catch(() => null);
  const bars = (d && d.items) || [];
  state.barCharts[symbol] = { at: Date.now(), bars };
  return bars;
}
// Mini chart: recent 1h closes + Donchian-20 band (live convention: band from
// the bars BEFORE the current one, the way the turtle sees it).
function sparklineSvg(symbol, bars) {
  if (!bars || bars.length < 25) return '<span class="muted">insufficient bars</span>';
  const W = 140, H = 28, PAD = 3;
  const closes = bars.map((b) => Number(b.closePrice)).filter((v) => Number.isFinite(v));
  const highs = bars.map((b) => Number(b.high)).filter((v) => Number.isFinite(v));
  const lows = bars.map((b) => Number(b.low)).filter((v) => Number.isFinite(v));
  const hs = highs.slice(-21, -1);
  const ls = lows.slice(-21, -1);
  if (!hs.length || !closes.length) return '<span class="muted">—</span>';
  const upper = Math.max(...hs);
  const lower = Math.min(...ls);
  const last = closes[closes.length - 1];
  const win = closes.slice(-40);
  let lo = Math.min(...win, lower), hi = Math.max(...win, upper);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const X = (i) => (W - 2 * PAD) * (i / (win.length - 1)) + PAD;
  const Y = (v) => H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD);
  const pts = win.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const yU = Y(upper), yL = Y(lower);
  const tone = last > upper ? '#6ee7b7' : last < lower ? '#fda4af' : '#9aa3b2';
  return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" title="${esc(symbol)}: DC20 [${lower.toFixed(2)}..${upper.toFixed(2)}] · last ${last.toFixed(2)}">` +
    `<line x1="${PAD}" y1="${yU}" x2="${W - PAD}" y2="${yU}" stroke="#6b7280" stroke-width="1" stroke-dasharray="3 2" />` +
    `<line x1="${PAD}" y1="${yL}" x2="${W - PAD}" y2="${yL}" stroke="#6b7280" stroke-width="1" stroke-dasharray="3 2" />` +
    `<polyline points="${pts}" fill="none" stroke="${tone}" stroke-width="1.6" />` +
    `<circle cx="${X(win.length - 1).toFixed(1)}" cy="${Y(last).toFixed(1)}" r="2" fill="${tone}" /></svg>`;
}

async function refreshTrades() {
  const [d, rev] = await Promise.all([
    apiGet('/api/trading/trades?limit=200'),
    // 2026-09-11: the 5-min review loop's newest verdict per symbol (shown in
    // the Review column so the deliberation is visible where positions live).
    apiGet('/api/trading/events?kind=position_review&limit=60').catch(() => ({ items: [] })),
  ]);
  const items = d.items || [];
  const lastRev = {};
  for (const e of (rev.items || [])) {
    const pay = e.payload || {};
    if (pay.symbol && !lastRev[pay.symbol]) lastRev[pay.symbol] = { ...pay, at: e.createdAt };
  }
  const open = items.filter((t) => t.status === 'open');
  const past = items.filter((t) => t.status !== 'open');
  // TRD-11: 1s live overlay from the frontend (matches by plus500PositionId
  // or symbol+direction).
  const live = (d.live && d.live.items) || [];
  const liveOf = (t) => live.find((p) =>
    (t.plus500PositionId && p.positionId && String(t.plus500PositionId) === String(p.positionId))
    || (!t.plus500PositionId && p.name === t.symbol && p.direction === t.direction));
  const openHtml = open.map((t) => {
    const p = liveOf(t);
    const cur = p && p.currentRate != null ? p.currentRate : (t.currentRate != null ? t.currentRate : null);
    const fp = p && p.pnl != null ? p.pnl : (t.floatingPnl != null ? t.floatingPnl : null);
    const rv = lastRev[t.symbol];
    // F15: a review verdict is a recommendation, not an order rejection.
    // TRD-89 (2026-09-18): and for a strategy that owns its own exit the verdict is ADVISORY — the chair
    // may want a close but may not make one. Rendering that as a plain `close` would show an
    // executed-looking verdict beside a position that is still open: the table would tell the reader the
    // desk did something it did not. The chip says which it is, and the title says why.
    const rvAdvisory = !!(rv && rv.advisory);
    const rvWhy = !rv ? ''
      : rv.advisoryReason === 'strategy_policy' ? ' — NOT executed: this strategy owns its own exit (review is advisory)'
        : rv.advisoryReason === 'mirrored_position' ? ' — NOT executed: mirrored position, closeMirrored is off'
          : '';
    const rvLabel = !rv ? ''
      : `${rv.action === 'close' ? (rvAdvisory ? 'close · advisory' : 'close') : 'hold'}${rv.confidence != null ? ' ' + Math.round(rv.confidence * 100) + '%' : ''}`;
    const rvHtml = rv
      ? `<span class="chip ${rv.action === 'close' && !rvAdvisory ? 'review' : 'muted'}" title="${esc(`${String(rv.reason || '')} — review ${fmt(rv.at)}${rvWhy}`)}">${esc(rvLabel)}</span>`
      : '<span class="muted">—</span>';
    // TRD-94 (2026-09-18): an entry taken while every chair abstained on a budget cap is a DIFFERENT
    // instrument from an approved one — it was not deliberated and it was sized down. That distinction
    // used to exist only in the wake log, so the book showed the two kinds as identical rows. The trade
    // note now carries the marker and it is rendered as a chip, not as muted prose.
    const chairOff = /·\s*CHAIR OFFLINE \(([^)]*)\)/i.exec(String(t.note || ''));
    const noteHtml = `${chairOff ? `<span class="chip soft" title="every chair abstained on a budget cap, so this entry was never deliberated — the desk took it quant-only at a reduced size (aggregator.js chairDegraded). Nothing here was voted on.">CHAIR OFFLINE${chairOff[1] ? ' · ' + esc(chairOff[1]) : ''}</span> ` : ''}${esc(String(t.note || '').replace(/ · CHAIR OFFLINE \([^)]*\)/i, ''))}`;
    // F14: money right-aligned + tabular, positives signed.
    return `<tr>
    <td class="num">${t.id}</td>
    <td>${esc(t.symbol)}</td>
    <td>${esc(t.direction)}</td>
    <td class="num">${num(t.size, 4)} ${esc(t.units || '')}</td>
    <td class="num">${num(t.openPrice)}</td>
    <td class="num">${t.stopPrice != null ? num(t.stopPrice, 4) : '<span class="muted">—</span>'}</td>
    <td class="num">${cur != null ? num(cur) : '—'}</td>
    <td class="num ${fp > 0 ? 'pos' : fp < 0 ? 'neg' : ''}">${fp != null ? (fp > 0 ? '+' : '') + num(fp) : '—'}</td>
    <td>${rvHtml}</td>
    <td>${tradeChip(t.status)}</td>
    <td class="muted">${noteHtml}</td>
    <td><button class="small secondary" data-close-trade="${t.id}" aria-label="Close position ${esc(t.symbol)} #${t.id}" title="closes at market through POST /orders/close — the venue close is reported, not assumed">Close</button></td>
  </tr>`;
  }).join('') || '<tr><td colspan="12" class="muted">no open positions — Plus500 rows appear here after the mirror</td></tr>';
  setIfChanged('trades-body', openHtml);
  // 2026-09-12 (owner: "past positions seem to be broken"): this list mixed three
  // different things — real closes, closes whose P&L we never captured, and orders
  // the venue REJECTED (which never opened at all) — and carried no close time and
  // no close reason. Closes now lead with price/P&L/held/closed/reason, rejected
  // rows are grouped at the end, and the heading states the money.
  const byIdDesc = (a, b) => b.id - a.id;
  const closes = past.filter((t) => t.status !== 'rejected').sort(byIdDesc);
  const rejected = past.filter((t) => t.status === 'rejected').sort(byIdDesc);
  const held = (min) => (min == null ? '—' : min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`);
  const reasonCell = (t) => {
    const m = /^venue closed — (.+)$/.exec(String(t.note || ''));
    if (m) return `<span class="chip muted" title="Plus500 closed this position itself; recorded by the venue-close sync">${esc(m[1])}</span>`;
    return `<span class="muted">${esc(t.note || '')}</span>`;
  };
  const statusCell = (t) => {
    if (t.status === 'phantom') return '<span class="chip phantom" title="the venue has no such open position and no close was found for it">phantom</span>';
    if (t.status === 'closed' && t.grossPnl == null) return '<span class="chip soft" title="closed at the venue but no P&L was ever recorded — run Sync venue closes">no P&L</span>';
    return '<span class="muted">closed</span>';
  };
  const pastRow = (t, isRejected) => `<tr>
    <td class="num">${t.id}</td>
    <td>${esc(t.symbol)}</td>
    <td>${esc(t.direction)}</td>
    <td class="num">${num(t.size, 4)} ${esc(t.units || '')}</td>
    <td class="num">${t.openPrice != null ? num(t.openPrice) : '—'}</td>
    <td class="num">${t.closePrice != null ? num(t.closePrice) : '—'}</td>
    <td class="num ${t.grossPnl > 0 ? 'pos' : t.grossPnl < 0 ? 'neg' : ''}">${t.grossPnl != null ? (t.grossPnl > 0 ? '+' : '') + num(t.grossPnl) : '—'}</td>
    <td class="num">${held(t.holdingMinutes)}</td>
    <td class="num">${t.closeAt ? fmt(t.closeAt) : '—'}</td>
    <td>${isRejected ? '<span class="chip off" title="the venue rejected this order — it never opened">rejected</span>' : statusCell(t)}</td>
    <td>${isRejected ? `<span class="muted">${esc(t.rejectReason || t.note || '')}</span>` : reasonCell(t)}</td>
  </tr>`;
  let pastHtml = closes.map((t) => pastRow(t, false)).join('');
  if (rejected.length) {
    pastHtml += `<tr><td colspan="11" class="muted" style="border-top:1px solid var(--border)">never filled — the venue rejected ${rejected.length} order${rejected.length === 1 ? '' : 's'}</td></tr>`;
    pastHtml += rejected.map((t) => pastRow(t, true)).join('');
  }
  setIfChanged('trades-past-body', pastHtml || '<tr><td colspan="11" class="muted">nothing closed yet</td></tr>');
  const withPnl = closes.filter((t) => t.grossPnl != null);
  const realized = withPnl.reduce((a, t) => a + Number(t.grossPnl), 0);
  const sumEl = $('past-summary');
  if (sumEl) {
    sumEl.textContent = closes.length
      ? `${closes.length} close${closes.length === 1 ? '' : 's'} · net ${realized >= 0 ? '+' : ''}${num(realized)}`
        + `${closes.length - withPnl.length ? ` · ${closes.length - withPnl.length} with no P&L` : ''}`
        + `${rejected.length ? ` · ${rejected.length} rejected` : ''}`
      : 'nothing closed yet';
  }
  // Venue-close sync: on demand, for anything the mirror could not account for.
  const syncBtn = $('btn-sync-closes');
  if (syncBtn && !syncBtn.dataset.wired) {
    syncBtn.dataset.wired = '1';
    syncBtn.onclick = async () => {
      syncBtn.disabled = true;
      feedback($('past-feedback'), 'reading Plus500 closed positions…');
      try {
        const r = await apiPost('/api/trading/trades/sync-closes');
        feedback($('past-feedback'), r.healed.length
          ? `recovered ${r.healed.length} close${r.healed.length === 1 ? '' : 's'} · net ${r.netPnl >= 0 ? '+' : ''}${num(r.netPnl)}`
          : `nothing to recover — ${r.checked} unresolved, ${r.venueRows} venue rows read`);
        await refreshTrades();
      } catch (e) {
        feedback($('past-feedback'), e.message, false);
      } finally { syncBtn.disabled = false; }
    };
  }
  // F9: the positions count belongs in the banner, not 3 screens down.
  state.openCount = open.length;
  // F13 (18/09): the row-level Close button needs the trade it is closing — the confirm quotes the
  // position, so the reader can see WHAT they are about to close at market, not just its id.
  state.openTrades = open;
  const openChip = $('banner-open');
  if (openChip) {
    openChip.textContent = `${open.length} open`;
    openChip.className = 'chip ' + (open.length ? 'open' : 'off');
    openChip.title = open.length ? open.map((t) => `${t.symbol} ${t.direction} ×${num(t.size, 4)}`).join('\n') : 'flat book';
  }
}

async function refreshAlerts() {
  const d = await apiGet('/api/trading/alerts');
  const METRIC_LABEL = { price: 'price', changePct: 'daily change %', buyersPct: 'buyers %' };
  // F27 (2026-09-18): the Triggered column read `a.triggeredAt`, and `TradingAlerts` has NO such column —
  // the row is `lastTriggeredAt`. So an alert that had fired rendered as one that never had. The name now
  // comes from the schema rather than from a guess at it.
  // TRD-UI-9 (D) 2026-10-03: browse-mode linearization read bare tokens ("Gold / above / never / 91%").
  // Each value now carries a visually-hidden label; table navigation gets the same from the <th scope="col">s.
  const rows = (d.items || []).map((a) => `<tr>
    <td><span class="sr-only">alert symbol </span>${esc(a.symbol)}</td>
    <td><span class="sr-only">metric </span><span class="event-kind">${esc(METRIC_LABEL[a.metric] || a.metric || 'price')}</span></td>
    <td><span class="sr-only">condition </span>${esc(a.direction)}</td>
    <td class="mono"><span class="sr-only">threshold </span>${num(a.threshold)}${a.metric === 'buyersPct' ? '%' : a.metric === 'changePct' ? '%' : ''}</td>
    <td><span class="sr-only">last triggered </span>${a.lastTriggeredAt ? `${fmt(a.lastTriggeredAt)} · ${ageLabel(a.lastTriggeredAt)}` : '<span class="muted">never</span>'}</td>
    <td><button class="small danger" data-del-alert="${a.id}" aria-label="Delete alert for ${esc(a.symbol)}">×</button></td>
  </tr>`).join('');
  $('alerts-body').innerHTML = rows || '<tr><td colspan="6" class="muted">no alerts</td></tr>';
  document.querySelectorAll('[data-del-alert]').forEach((b) => {
    b.onclick = () => apiDelete(`/api/trading/alerts/${b.dataset.delAlert}`).then(() => refreshAlerts()).catch((e) => feedback($('alerts-feedback'), e.message, false));
  });
}

// ---------------- prices ----------------
async function loadSymbols() {
  const wl = await apiGet('/api/trading/watchlist');
  const symbols = (wl.symbols || []).map((s) => s.symbol);
  const universe = (wl.universe || []).map((u) => u.symbol);
  const sel = $('bar-symbol');
  sel.innerHTML = symbols.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  if (!state.symbol && symbols.length) state.symbol = symbols[0];
  if (state.symbol) sel.value = state.symbol;
  const bt = $('bt-symbol');
  bt.innerHTML = universe.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  // F25 (2026-09-18): the local-alert form asked for a SYMBOL as free text while the Plus500 form beside it
  // offered a picker — and the local one is the form that feeds the desk's own alert engine, which matches
  // on the exact string. A typo therefore created an alert that could never fire, silently. The same symbol
  // list now backs it as a datalist (suggestions) and the save handler refuses an unknown name.
  const dl = $('al-symbols');
  if (dl) dl.innerHTML = [...new Set([...symbols, ...universe])].map((s) => `<option value="${esc(s)}"></option>`).join('');
  if (!state.btSymbol) state.btSymbol = universe[0] || symbols[0] || null;
  if (state.btSymbol) bt.value = state.btSymbol;
  // Positions tab trade form + Plus500 alert create selectors.
  const ts = $('trade-symbol');
  if (ts) ts.innerHTML = symbols.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  const as = $('al-p500-symbol');
  if (as) as.innerHTML = symbols.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
}

async function refreshQuarantine() {
  const body = $('quarantine-body');
  if (!body) return;
  try {
    const d = await apiGet('/api/trading/quarantine?limit=20');
    body.innerHTML = (d.items || []).map((q) => `<tr>
      <td>${fmt(q.capturedAt)}</td>
      <td>${esc(q.symbol)}</td>
      <td class="mono">${num(q.bid)}</td>
      <td class="mono">${num(q.ask)}</td>
      <td><span class="chip soft">${esc(q.reason)}</span></td>
      <td class="muted">${esc(q.detail || '')}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">no rejected ticks yet</td></tr>';
  } catch { body.innerHTML = '<tr><td colspan="6" class="muted">unavailable</td></tr>'; }
}

async function rebuildBars() {
  try {
    const r = await apiPost('/api/trading/bars/rebuild');
    feedback($('bars-rebuild-feedback'), `flagged deleted ${r.deletedFlagged} · hourly ${r.rebuilt.hourly} · daily ${r.rebuilt.daily}`, true);
    await refreshBars();
  } catch (e) {
    feedback($('bars-rebuild-feedback'), e.message, false);
  }
}

async function refreshBars() {
  if (!state.symbol) return;
  const q = new URLSearchParams({ timeframe: state.timeframe, limit: 300 });
  q.set('symbol', state.symbol);
  const d = await apiGet('/api/trading/bars?' + q.toString());
  const bars = d.items || [];
  $('bar-count').textContent = `${bars.length} bars`;
  $('bar-coverage').textContent = coverageLine(state.symbol, state.timeframe);
  const rows = [...bars].reverse().slice(0, 30).map((b) => `<tr>
    <td>${fmt(b.barStart)}</td>
    <td class="mono">${num(b.openPrice)}</td>
    <td class="mono">${num(b.high)}</td>
    <td class="mono">${num(b.low)}</td>
    <td class="mono">${num(b.closePrice)}</td>
    <td>${b.volume ?? '—'}</td>
  </tr>`).join('');
  $('bars-body').innerHTML = rows || '<tr><td colspan="6" class="muted">no bars yet — run Build bars</td></tr>';
  if (window.Chart) {
    if (state.chart) state.chart.destroy();
    state.chart = new Chart($('bars-chart'), {
      type: 'line',
      data: {
        labels: bars.map((b) => fmt(b.barStart)),
        datasets: [{
          label: `${state.symbol} ${state.timeframe} close`,
          // TRD-12 Phase 0: missing data renders as GAPS, never as 0.
          data: bars.map((b) => (b.closePrice == null ? null : b.closePrice)),
          spanGaps: true,
          borderColor: '#7c8cf8', backgroundColor: 'rgba(124,140,248,.12)',
          pointRadius: 0, tension: 0.15, fill: true,
        }],
      },
      options: {
        plugins: { legend: { labels: { color: '#8b96a8' } } },
        scales: {
          x: { ticks: { color: '#8b96a8', maxTicksLimit: 10 }, grid: { color: 'rgba(42,51,68,.5)' } },
          y: { ticks: { color: '#8b96a8' }, grid: { color: 'rgba(42,51,68,.5)' } },
        },
      },
    });
  }
}

function metricCard(title, m) {
  // 2026-09-12: six identical .kv rows gave the headline number the same weight
  // as "Final capital". Net P&L is the answer, so it leads as a stat.
  const tone = m.netPnl > 0 ? 'pos' : m.netPnl < 0 ? 'neg' : '';
  return `<div class="card"><h2>${title}</h2>
    <div class="stat" style="margin-bottom:8px"><div class="k">Net P&amp;L</div><span class="v ${tone}">${num(m.netPnl)}</span></div>
    <div class="kv"><span class="k">Trades</span><span class="v">${m.trades}</span></div>
    <div class="kv"><span class="k">Win rate</span><span class="v">${m.winRate}%</span></div>
    <div class="kv"><span class="k">Profit factor</span><span class="v">${m.profitFactor == null ? '—' : num(m.profitFactor)}</span></div>
    <div class="kv"><span class="k">Max drawdown</span><span class="v">${num(m.maxDrawdownPct)}%</span></div>
    <div class="kv"><span class="k">Final capital</span><span class="v">${num(m.finalCapital)}</span></div>
  </div>`;
}

function drawBtChart(chart) {
  if (!window.Chart || !chart) return;
  if (state.btChart) state.btChart.destroy();
  const entriesBuy = new Map(); const entriesSell = new Map(); const exitsWin = new Map(); const exitsLoss = new Map();
  for (const m of chart.markers || []) {
    if (m.direction === 'buy') entriesBuy.set(m.entryTime, m.entryPrice); else entriesSell.set(m.entryTime, m.entryPrice);
    if (m.netPnl >= 0) exitsWin.set(m.exitTime, m.exitPrice); else exitsLoss.set(m.exitTime, m.exitPrice);
  }
  const dataArr = (map) => chart.closes.map((_, i) => (map.has(chart.times[i]) ? map.get(chart.times[i]) : null));
  state.btChart = new Chart($('bt-chart'), {
    type: 'line',
    data: {
      labels: chart.times.map(fmt),
      datasets: [
        { label: 'close', data: chart.closes.map((c) => (c == null ? null : c)), spanGaps: true, borderColor: '#7c8cf8', pointRadius: 0, tension: 0.1 },
        { label: 'buy entry', data: dataArr(entriesBuy), showLine: false, pointStyle: 'triangle', pointRotation: 0, pointRadius: 8, borderColor: '#6ee7b7', backgroundColor: '#6ee7b7' },
        { label: 'sell entry', data: dataArr(entriesSell), showLine: false, pointStyle: 'triangle', pointRotation: 180, pointRadius: 8, borderColor: '#fda4af', backgroundColor: '#fda4af' },
        { label: 'win exit', data: dataArr(exitsWin), showLine: false, pointRadius: 5, borderColor: '#6ee7b7', backgroundColor: '#6ee7b7' },
        { label: 'loss exit', data: dataArr(exitsLoss), showLine: false, pointRadius: 5, borderColor: '#fda4af', backgroundColor: '#fda4af' },
      ],
    },
    options: {
      plugins: { legend: { labels: { color: '#8b96a8', boxWidth: 12 } } },
      scales: {
        x: { ticks: { color: '#8b96a8', maxTicksLimit: 12 }, grid: { color: 'rgba(42,51,68,.5)' } },
        y: { ticks: { color: '#8b96a8' }, grid: { color: 'rgba(42,51,68,.5)' } },
      },
    },
  });
}

function applyProviderGrey() {
  const venue = $('bt-venue').value;
  const map = state.symbolMap || {};
  for (const opt of $('bt-symbol').options) {
    const name = opt.value;
    const supported = venue === 'plus500' || (map[name] && map[name][venue]);
    opt.className = supported ? '' : 'unsupported';
    opt.textContent = supported ? name : `${name} (not listed on ${venue})`;
  }
}

async function refreshConsistency() {
  const body = $('bt-consistency-body');
  if (!body) return;
  try {
    const d = await apiGet('/api/trading/backtests?limit=100');
    const venue = $('bt-venue').value;
    const tf = state.btTimeframe || '1h';
    const rows = (d.items || [])
      .filter((r) => (r.symbols || []).includes(state.btSymbol))
      .map((r) => ({ r, cfg: r.config || {}, m: (r.metrics || {}).cfd || {}, mc: (r.metrics || {}).monteCarlo || null, prov: r.provenance || {} }))
      .filter((x) => String(x.cfg.venue || 'plus500') === venue && String(x.cfg.timeframe || '1h') === tf)
      .slice(0, 30)
      .map((x) => {
        const pnl = x.mc
          ? `<span class="${x.mc.netPnlP50 > 0 ? 'pos' : x.mc.netPnlP50 < 0 ? 'neg' : ''}">${num(x.mc.netPnlP50)}</span> <span class="muted">[${num(x.mc.netPnlP5)}…${num(x.mc.netPnlP95)}]</span>`
          : `<span class="${x.m.netPnl > 0 ? 'pos' : x.m.netPnl < 0 ? 'neg' : ''}">${num(x.m.netPnl)}</span>`;
        const dd = x.mc ? `${num(x.mc.ddP95)}% <span class="muted">(p95)</span>` : `${num(x.m.maxDrawdownPct)}%`;
        const range = `${esc(x.cfg.range || 'all')}${x.mc ? ` <span class="muted">mc×${x.mc.trials}</span>` : ''}`;
        return `<tr>
        <td>${fmt(x.r.createdAt)}</td>
        <td>${range}</td>
        <td>${num(x.prov.bars, 0)}</td>
        <td>${pnl}</td>
        <td>${x.m.winRate ?? '—'}%</td>
        <td>${x.m.profitFactor == null ? '—' : num(x.m.profitFactor)}</td>
        <td>${dd}</td>
      </tr>`;
      }).join('');
    body.innerHTML = rows || '<tr><td colspan="7" class="muted">no runs for this symbol/venue/timeframe yet</td></tr>';
  } catch { /* consistency optional */ }
}

function updateRangeButtons() {
  // 15m history only spans ~59 days on yahoo — 1y is not honor-able.
  document.querySelectorAll('#tab-backtest [data-range]').forEach((b) => {
    const tooLong = state.btTimeframe === '15m' && b.dataset.range === '1y';
    b.classList.toggle('disabled', tooLong);
    b.title = tooLong ? '15m history spans ~59 days — 1y not possible' : '';
    if (tooLong && state.btRange === '1y') { state.btRange = '1m'; b.classList.remove('active'); document.querySelector('#tab-backtest [data-range="1m"]')?.classList.add('active'); }
  });
}

// TRD-11: backtest-local strategy editor (never touches the live one).
function renderBtStrategies() {
  const sel = $('bt-strategy');
  if (!sel) return;
  const capable = state.strategies.filter((s) => s.id === 'turtle'); // backtest-capable only
  sel.innerHTML = capable.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  renderBtParams();
}

function btStrategy() {
  const s = state.strategies.find((x) => x.id === $('bt-strategy').value);
  return s || state.strategies[0];
}

function renderBtParams() {
  const box = $('bt-params');
  if (!box) return;
  const s = btStrategy();
  if (!s) { box.innerHTML = ''; return; }
  // 2026-09-12: these used to sit in a NESTED .toolbar whose `input{min-width:140px}`
  // overrode their own width:60px — six 140px boxes for two-digit params.
  box.innerHTML = (s.params || []).filter((p) => p.type === 'number').map((p) =>
    `<label>${esc(p.label)} <input type="number" step="${p.step || 1}" data-bt-param="${esc(p.key)}" value="${p.value}" /></label>`).join('');
}

function btParams() {
  const out = {};
  for (const el of document.querySelectorAll('[data-bt-param]')) {
    if (el.value !== '') out[el.dataset.btParam] = Number(el.value);
  }
  return out;
}

async function runSweep() {
  if (!state.btSymbol) return feedback($('bt-feedback'), 'no symbol selected', false);
  const params = btParams();
  // Grid: each editable param varies x0.5 / x1 / x1.5 (cap 40 combos).
  const grid = {};
  for (const [k, v] of Object.entries(params)) {
    grid[k] = [Math.round(v * 0.5 * 10) / 10, v, Math.round(v * 1.5 * 10) / 10];
  }
  feedback($('bt-feedback'), `sweeping ${Object.keys(grid).length} params…`);
  try {
    const r = await apiPost('/api/trading/backtest/sweep', {
      symbol: state.btSymbol, venue: $('bt-venue').value, timeframe: state.btTimeframe || '1h',
      range: state.btRange === 'all' ? null : state.btRange,
      config: { refreshData: !!$('bt-refresh').checked, strategy: $('bt-strategy').value, grid },
    });
    if (r.error) return feedback($('bt-feedback'), r.error, false);
    const rows = (r.runs || []).map((x) => `<tr>
      <td class="${x.netPnl > 0 ? 'pos' : 'neg'}">${num(x.netPnl)}</td>
      <td class="mono">${Object.entries(x.params).map(([k, v]) => `${k}=${v}`).join(' ')}</td>
      <td>${x.trades}</td><td>${num(x.winRate, 0)}%</td><td>${num(x.profitFactor)}</td><td>${num(x.maxDrawdownPct, 1)}%</td>
    </tr>`).join('');
    $('bt-sweep-results').innerHTML = `<h3 class="muted" style="margin:0 0 6px">Param sweep — ${r.profitable}/${r.combos} profitable · nothing auto-applied</h3>
      <div class="table-wrap"><table><thead><tr><th>Net P&amp;L</th><th>Params</th><th>Trades</th><th>Win%</th><th>PF</th><th>MaxDD</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    feedback($('bt-feedback'), `sweep done — best ${num(r.best?.netPnl)} with ${JSON.stringify(r.best?.params)}`);
  } catch (e) { feedback($('bt-feedback'), e.message, false); }
}

async function runBacktest() {
  if (!state.btSymbol) return feedback($('bt-feedback'), 'no symbol selected', false);
  feedback($('bt-feedback'), 'running…');
  try {
    const r = await apiPost('/api/trading/backtest', {
      symbol: state.btSymbol,
      venue: $('bt-venue').value,
      timeframe: state.btTimeframe || '1h',
      range: state.btRange === 'all' ? null : state.btRange,
      config: {
        refreshData: !!$('bt-refresh').checked,
        monteCarlo: !!$('bt-mc').checked,
        monteCarloTrials: Number($('bt-mc-trials').value) || 200,
        strategy: $('bt-strategy') ? $('bt-strategy').value : 'turtle',
        params: btParams(),
      },
    });
    if (r.error) return feedback($('bt-feedback'), r.error, false);
    $('bt-metrics').innerHTML = metricCard('Spot baseline', r.metrics.spot) + metricCard('CFD estimated', r.metrics.cfd)
      + (r.monteCarlo ? `<div class="card"><h2>Monte Carlo (${r.monteCarlo.trials} trials)</h2>
        <div class="kv"><span class="k">Net P&amp;L band</span><span class="v">${num(r.monteCarlo.netPnl.p5)} … ${num(r.monteCarlo.netPnl.p50)} … ${num(r.monteCarlo.netPnl.p95)}</span></div>
        <div class="kv"><span class="k">Max DD (median / p95 / worst)</span><span class="v">${num(r.monteCarlo.maxDrawdownPct.p50)}% / ${num(r.monteCarlo.maxDrawdownPct.p95)}% / ${num(r.monteCarlo.maxDrawdownPct.worst)}%</span></div>
        <div class="kv"><span class="k">Win rate band</span><span class="v">${num(r.monteCarlo.winRate.p5)}% … ${num(r.monteCarlo.winRate.p95)}%</span></div>
        <div class="kv"><span class="k">PF p50/p95</span><span class="v">${num(r.monteCarlo.profitFactor.p50)} / ${num(r.monteCarlo.profitFactor.p95)}</span></div>
        <div class="kv muted" style="font-size:11px"><span class="k">jitter</span><span class="v">spread ${r.monteCarlo.jittered.spread} · slippage ${r.monteCarlo.jittered.slippage} · swap ${r.monteCarlo.jittered.swap}${r.monteCarlo.seed != null ? ` · seed ${r.monteCarlo.seed}` : ''}</span></div>
        <div class="kv muted" style="font-size:11px"><span class="k">note</span><span class="v">chart markers + worksheet = base-case cost world; MC varies costs only, not trades</span></div>
      </div>` : '');
    const rows = (r.worksheetCfd || []).map((t, i) => `<tr>
      <td>${i + 1}</td>
      <td>${esc(t.direction)}</td>
      <td class="mono">${fmt(t.entryTime)} @ ${num(t.entryPrice)}</td>
      <td class="mono">${fmt(t.exitTime)} @ ${num(t.exitPrice)}</td>
      <td>${t.nights}</td>
      <td class="neg">${num(t.costs)}</td>
      <td class="${t.netPnl > 0 ? 'pos' : t.netPnl < 0 ? 'neg' : ''}">${num(t.netPnl)}</td>
      <td class="muted">${esc(t.reason)}</td>
    </tr>`).join('');
    $('bt-body').innerHTML = rows || '<tr><td colspan="8" class="muted">no trades in range (need more bars)</td></tr>';
    $('bt-provenance').textContent = `${r.bars} bars · ${fmt(r.period.from)} → ${fmt(r.period.to)} · run #${r.id}${r.monteCarlo ? ` · MC×${r.monteCarlo.trials}` : ''}`;
    const bf = r.backfilled ? ` (backfilled ${r.backfilled.bars} bars)` : '';
    const rn = r.rangeNote ? ` — note: ${r.rangeNote}` : '';
    const mcs = r.monteCarlo ? ` — MC: median P&L ${num(r.monteCarlo.netPnl.p50)} [${num(r.monteCarlo.netPnl.p5)}…${num(r.monteCarlo.netPnl.p95)}]` : '';
    feedback($('bt-feedback'), `done — ${r.metrics.cfd.trades} trades${bf}${mcs}${rn}`);
    drawBtChart(r.chart);
    refreshConsistency();
  } catch (e) { feedback($('bt-feedback'), e.message, false); }
}

// ---------------- deliberation (TRD-9 H) ----------------
// MUST list every panel voter the engine supports (quantVotes handles
// turtle/adx/meanrev/macd/rsi2/rsi) — a missing type gets silently DROPPED
// on save, which looked like "save resets all parameters".
const PANEL_TYPES = ['turtle', 'adx', 'meanrev', 'macd', 'rsi2', 'rsi'];
const PERSONA_OPTIONS = ['', 'trend', 'risk', 'macro'];

function renderDeliberation() {
  const d = state.deliberation || { quantPanel: [], chairs: [] };
  $('delib-panel').innerHTML = PANEL_TYPES.map((t) => {
    const p = (d.quantPanel || []).find((x) => x.type === t) || { weight: 0 };
    const on = p.weight > 0;
    return `<label class="voter">
      <input type="checkbox" data-panel-type="${t}" ${on ? 'checked' : ''} /> <b>${t}</b> weight
      <input type="number" step="0.5" min="0" max="5" data-panel-weight="${t}" value="${p.weight ?? 0}" ${on ? '' : 'disabled'} />
    </label>`;
  }).join('');
  document.querySelectorAll('[data-panel-type]').forEach((cb) => {
    cb.onchange = () => {
      const w = document.querySelector(`[data-panel-weight="${cb.dataset.panelType}"]`);
      if (w) w.disabled = !cb.checked;
    };
  });
  const chairs = d.chairs || [];
  // ★ TRD-DEL-1: "seat default" IS NOT A VALUE, IT IS A LOOKUP — and the operator could not see the answer.
  // A seat stored with no persona still votes through the persona its POSITION implies (trend / risk / macro),
  // so the panel showed three identical "seat default" rows while three different lenses produced the reasons
  // below them. `chairsResolved` carries what the server will actually send, so the label reads
  // `seat default → risk` and the weights stop being tuned blind.
  const resolved = d.chairsResolved || [];
  // 2026-09-12: the row carried its own inline "temp"/"weight" words AND six
  // different control widths, so chairs did not line up. Column labels now live
  // in one header row (.chair-head in the markup) and the row shares its grid.
  $('delib-chairs').innerHTML = chairs.map((c, i) => {
    const r = resolved[i] || {};
    const inherited = r.personaSource === 'seat-default' && r.persona;
    const seatLabel = inherited ? `seat default \u2192 ${esc(r.persona)}` : 'seat default';
    const hint = r.persona
      ? `seat default means ${esc(r.persona)} for this seat (${esc(r.personaSource || 'unknown')})`
      : 'seat default resolves to no persona for this seat';
    return `<div class="chair-row" data-chair-row="${i}">
    <input data-c-id value="${esc(c.id || '')}" placeholder="id" aria-label="chair id" />
    <input data-c-model value="${esc(c.model || '')}" placeholder="model (blank = default)" aria-label="chair model" />
    <input type="number" step="0.1" min="0" max="2" data-c-temp value="${c.temperature ?? ''}" placeholder="def" title="blank = the model's own default temperature" aria-label="temperature" />
    <input type="number" step="0.5" min="0" max="5" data-c-weight value="${c.weight ?? 1}" aria-label="vote weight" />
    <select data-c-persona aria-label="chair persona" title="${hint}">${PERSONA_OPTIONS.map((o) => `<option value="${o}" ${(c.persona || '') === o ? 'selected' : ''}>${o || seatLabel}</option>`).join('')}</select>
    <button class="small danger" data-chair-del="${i}" aria-label="remove chair">×</button>
  </div>`;
  }).join('') || '<div class="muted">no chairs — pure quant mode</div>';
  document.querySelectorAll('[data-chair-del]').forEach((b) => {
    b.onclick = () => {
      state.deliberation.chairs.splice(Number(b.dataset.chairDel), 1);
      renderDeliberation();
    };
  });
}

async function refreshDeliberation() {
  try {
    const s = await apiGet('/api/trading/settings');
    state.deliberation = s.deliberation || { quantPanel: [], chairs: [] };
    const pr = (s.deliberation && s.deliberation.positionReview) || {};
    if ($('pr-enabled')) $('pr-enabled').checked = pr.enabled !== false;
    if ($('pr-minutes')) $('pr-minutes').value = pr.reviewMinutes ?? 5;
    if ($('pr-max')) $('pr-max').value = pr.maxPerWake ?? 1;
    if ($('pr-conf')) $('pr-conf').value = pr.minConfidence ?? 0.7;
    if ($('pr-mirrored')) $('pr-mirrored').checked = pr.closeMirrored === true;
    renderDeliberation();
    renderRiskSizing(s);
  } catch { /* settings optional */ }
}

// ---------------- risk & sizing sliders (implied goal) ----------------
// 2026-09-11: max-position slider ceiling raised 20% → 80%. Anything past
// 40% of equity in a single position raises a DANGER notification — no
// lockout: the value saves and the risk gate uses it as-is (owner rule).
//
// 2026-09-12: exposure-cap slider ceiling 50% → 100%. The per-position slider
// could already request 25-40%, but the EXPOSURE BUDGET is the control that
// actually binds: at a 50% book cap a single 40% position left only 10% for
// everything else, so a 25-40% sizing regime was not expressible. Measured
// consequence of the cap binding — on 2026-09-11 the notional cap (8%) made
// size = capPct x equity / price regardless of `riskPerTradePct`, so real risk
// per trade was 0.05-0.28% of equity instead of the 1% the frozen strategies
// declare, and a 2.145% favourable Oil move was worth S$20.17. `sizeCalc` on
// every entry decision carries cappedAtPct/finalSize/reasons as the audit trail.
const RISK_MAXPOS_DANGER_PCT = 40;
function riskMaxPosWarn() {
  const el = $('risk-maxpos');
  const w = $('risk-maxpos-warn');
  if (!el || !w) return;
  w.style.display = Number(el.value) > RISK_MAXPOS_DANGER_PCT ? 'inline' : 'none';
}
// ★★ THE STOP CAP AND THE COST CEILING PULL AGAINST EACH OTHER, AND THE SLIDER MUST SAY SO (owner ask 2026-09-25).
// `stopPolicy.costShareCheck` computes `costShare = venue round trip % / stop cap %`, so a TIGHTER cap RAISES the
// share — and past the ceiling `risk.js` REFUSES the entry outright. Every instrument therefore has a MINIMUM cap
// it can carry, and a single global cap can silently exclude one entirely.
// MEASURED 2026-09-25 at cap 0.30% / ceiling 0.65: Silver's round trip 0.1936% gives **0.6453** — 0.002 of a
// percentage point under the ceiling — and Bitcoin's 0.25% gives **0.8333, which is OVER it**, i.e. Bitcoin could
// not enter at all at the cap the desk was running. That is the "positions getting capped, then rejected" the
// owner saw, and a slider without this note would let the same thing happen silently from the other direction.
let riskCostFloors = null;
async function loadCostFloors() {
  if (riskCostFloors) return riskCostFloors;
  riskCostFloors = await apiGet('/api/trading/risk/cost-floors').catch(() => null);
  return riskCostFloors;
}
function renderCostFloor() {
  const el = $('risk-costfloor');
  const capEl = $('risk-stopcap');
  if (!el || !capEl) return;
  const f = riskCostFloors;
  if (!f) { el.style.display = 'none'; return; }
  el.style.display = 'inline';
  const cap = Number(capEl.value) || 0;
  const ceilingPct = (Number(f.ceiling) * 100).toFixed(1);
  if (!(cap > 0)) {
    el.textContent = 'stop cap OFF — the venue stop is the declared 2xATR, so this dial excludes nothing';
    return;
  }
  const items = f.items || [];
  const over = items.filter((x) => x.minCapPct != null && cap < x.minCapPct);
  const worst = items.find((x) => x.minCapPct != null);
  if (over.length) {
    el.textContent = `⚠ cap ${cap}% would REFUSE ${over.length} of ${items.filter((x) => x.minCapPct != null).length} on cost: `
      + over.map((x) => `${x.symbol} needs \u2265${x.minCapPct}%`).join(', ')
      + ` — costShare = round trip \u00f7 cap, ceiling ${ceilingPct}%.`
      + (f.globalMinCapPct ? ` Nothing is excluded at \u2265${f.globalMinCapPct}%.` : '');
  } else {
    el.textContent = `ok at ${cap}%: every instrument clears the ${ceilingPct}% cost ceiling`
      + (worst ? ` (tightest is ${worst.symbol}, needs \u2265${worst.minCapPct}%)` : '');
  }
}
// ★★ TRD-RSK-2 (2026-09-27): WHY IS THE DESK NOT TRADING, ON THE SCREEN.
// The owner's report was "positions getting capped ... then rejected (not like they LLM knows if it got rejected
// or not, its silent)". The refusal was recorded, but only as prose inside a wake event, so answering "why" meant
// reading that prose against `agent/risk.js` — an investigation that got it WRONG once. The gate now emits veto
// CODES and this renders them, so the answer is visible instead of reconstructable.
let riskRefusals = null;
// WHY NOTHING IS ENTERING, IN PLAIN ENGLISH (2026-09-30 — owner: "its not properly shown to the user, thats why it
// got confused"). The banner named the RULE that refused and how often, which is the right ATTRIBUTION and the
// wrong answer to "why can't I see a trade". A code is not a reason: `venue_minimum 12` says a rule fired twelve
// times and leaves the reader to work out for themselves that the book is full. The code stays (it is the
// machine-readable key, and every record is attributed by it); what is added is what it MEANS.
const VETO_PLAIN = {
  venue_minimum: 'the position the risk dial asked for is smaller than the venue will trade — usually because the book is close to its cap',
  exposure_budget: 'the book is already at its total exposure cap, so there is no room for a new position',
  correlation: 'the new position would move with one already open',
  cost_ceiling: 'the venue round trip costs too much of the risk being taken',
  margin_utilisation: 'the margin the venue sets aside for the book is used up',
  daily_loss_halt: 'the day has lost more than its limit, so entries stop until tomorrow',
  reentry_cooldown: 'this one was traded too recently',
  already_open_symbol: 'a position in this symbol is already open',
  min_realised_rr: 'the reward does not clear the minimum for the risk taken',
  stale_entry: 'too long passed between the decision and the price it was made on',
  max_positions: 'the desk already holds as many positions as it may',
  max_new_trades: 'the desk has opened as many trades today as it may',
  ui_fallback_pause: 'the bridge is paused, so entries are held',
  risk_floor: 'the account is below its safety floor, so entries stop',
};
const vetoPlain = (code) => VETO_PLAIN[String(code || '')] || String(code || '').replace(/_/g, ' ');
async function loadRefusals() {
  if (riskRefusals) return riskRefusals;
  riskRefusals = await apiGet('/api/trading/risk/refusals?days=14').catch(() => null);
  renderRefusals();
  return riskRefusals;
}
function renderRefusals() {
  const el = $('risk-refusals');
  if (!el || !riskRefusals) return;
  const r = riskRefusals;
  el.style.display = 'inline';
  const top = (r.byLayer || []).slice(0, 4)
    .map((x) => `${x.key.replace(/_/g, ' ')} ${x.sharePct}%`).join(' \u00b7 ');
  const codes = (r.byVetoCode || []).length
    ? ` \u00b7 risk vetoes by rule: ${r.byVetoCode.map((c) => `${c.key} ${c.n}`).join(', ')}`
    : '';
  // ⚠ THE WINDOW IS STATED AS MEASURED, NOT AS ASKED FOR. `store.listEvents` clamps at 500 events without
  // saying so, so a 14-day request can cover 4 days — the TRD-77 defect, which this route reproduced in its own
  // first version and now reports (`truncated` + `coveredSince`).
  const cover = r.truncated
    ? `last ${r.events} events, from ${String(r.coveredSince || '').slice(0, 10)} (14 days requested \u2014 READ CAPPED at ${r.eventCap})`
    : `${r.wakes} wakes over ${r.days} days`;
  // ★ THE ANSWER, NOT JUST THE ATTRIBUTION. The most common rule gets translated, and the full list moves to the
  // tooltip so the line still fits on the panel.
  const topVeto = (r.byVetoCode || [])[0];
  const why = topVeto ? ` \u00b7 the usual reason: ${vetoPlain(topVeto.key)}` : '';
  el.textContent = `why nothing is entering \u2014 ${cover}: ${top}${codes}${why}`;
  el.title = topVeto
    ? `Most common refusal (${topVeto.n}x): ${vetoPlain(topVeto.key)}\n\nAll rules that refused: `
      + r.byVetoCode.map((c) => `${c.key} ${c.n}x \u2014 ${vetoPlain(c.key)}`).join('\n')
      + `\n\nEvery refusal is attributed to one rule; the code is on the decision record.`
    : '';
}
function renderRiskSizing(s) {
  const r = s.risk || {};
  const set = (id, val, unit) => {
    const el = $(id);
    if (!el) return;
    el.value = val;
    const v = $(id + '-v');
    if (v) v.textContent = Number(val) + unit;
  };
  set('risk-riskpct', Number(r.riskPerTradePct ?? 1), '%');
  set('risk-maxpos', Number(r.maxEquityPerPositionPct ?? 5), '%');
  set('risk-expcap', Number(r.exposureCapPct ?? 15), '%');
  // Trade caps (2026-09-11): daily new-trade cap + concurrent open-position
  // cap — both were settings-only; the wake event quotes whichever bites
  // ("daily new-trade cap (N) reached" / "max positions (N) reached").
  set('risk-dailycap', Number(r.maxNewTradesPerDay ?? 6), '');
  set('risk-maxcount', Number(r.maxPositions ?? 3), '');
  // Re-entry cooldown: 0 = disabled (the risk gate treats <=0 as off).
  const cd = Number(r.reentryCooldownBars ?? 6);
  set('risk-cooldown', cd > 0 ? cd : 6, 'h');
  const cdOn = $('risk-cooldown-on');
  if (cdOn) {
    cdOn.checked = cd > 0;
    const syncCooldown = () => {
      const on = cdOn.checked;
      const el = $('risk-cooldown');
      el.disabled = !on;
      const v = $('risk-cooldown-v');
      if (v) v.textContent = on ? Number(el.value || 6) + 'h' : 'off';
    };
    cdOn.onchange = syncCooldown;
    syncCooldown();
  }
  const runin = $('risk-runin');
  if (runin) {
    // S1 (2026-09-13): the dial labelled "risk per trade" is INERT while the
    // per-position notional cap binds, because the gate computes
    //   size = capPct x equity / price      (the Turtle formula is clamped away)
    // so realised risk = capPct x the stop's distance in %. Measured on 2026-09-11:
    // the 8% cap put real risk at 0.05-0.28% of equity against a declared 1%.
    // Say so here, with the effective cap, instead of leaving a control that
    // silently does nothing.
    const capPct = Number(r.maxEquityPerPositionPct ?? 5);
    const factor = (s.learning && s.learning.parityValidated) ? 1 : 0.5;
    const effCap = +(capPct * factor).toFixed(1);
    const runIn = (s.learning && s.learning.parityValidated)
      ? 'parity validated — full size on new entries'
      : 'run-in: parity not yet validated → all new-entry sizes halved (0.5x); mean-reversion family takes another 0.5x';
    runin.textContent = `${runIn} · EFFECTIVE per-position cap ${effCap}% (${capPct}% × ${factor}) — realised risk = that × the stop's distance in %, so "risk per trade" (${Number(r.riskPerTradePct ?? 1)}%) has no effect while the cap binds`;
  }
  for (const [id, unit] of [['risk-riskpct', '%'], ['risk-maxpos', '%'], ['risk-expcap', '%'], ['risk-dailycap', ''], ['risk-maxcount', ''], ['risk-cooldown', 'h']]) {
    const el = $(id);
    if (!el || el.dataset.bound) continue;
    el.dataset.bound = '1';
    el.oninput = () => {
      const v = $(id + '-v');
      if (v) v.textContent = Number(el.value) + unit;
      if (id === 'risk-maxpos') riskMaxPosWarn();
      // ★ TRD-LLM-2 (#1413): the declared dial and the cap interact, so moving EITHER must repaint the note that
      // says which one binds. Without this, dragging "risk per trade" leaves a stale note claiming the reverse.
      if (id === 'risk-riskpct') renderRiskBindNote();
    };
  }
  riskMaxPosWarn();
  // ★ TRD-LLM-2 (#1413): FOUR dials, and two of them existed only in settings until now —
  // `maxRiskPerTradePct` (the cap that binds every ticket) and `correlationVeto` (the rule that was actually
  // blocking the desk on 2026-09-25). A dial nobody can see is a dial nobody can tune.
  // 0 means OFF for the two percentage dials and is rendered as the word `off`, so an off dial cannot be mistaken
  // for a very tight one.
  const DIALS = [
    { id: 'risk-stopcap', get: () => r.maxAdversePct ?? 0.3, unit: '%', off: true },
    { id: 'risk-tpoffset', get: () => r.takeProfitOffsetPct ?? 0, unit: '%', off: true },
    { id: 'risk-maxrisk', get: () => r.maxRiskPerTradePct ?? 0, unit: '%', off: true },
    // ⚠ correlationVeto is a COEFFICIENT, not a percentage, and it has NO off-by-zero: the gate tests
    // `|c| >= threshold`, so 0 would refuse every entry. Its slider starts at 0.1 and its "off" direction is UP.
    { id: 'risk-corrveto', get: () => r.correlationVeto ?? 0.7, unit: '', off: false, dp: 2 },
  ];
  for (const d of DIALS) {
    const el = $(d.id);
    if (!el) continue;
    el.value = Number(d.get());
    const paint = () => {
      const v = $(d.id + '-v');
      const n = Number(el.value);
      if (v) v.textContent = (n <= 0 && d.off) ? 'off' : (d.dp ? n.toFixed(d.dp) : String(n)) + d.unit;
      if (d.id === 'risk-stopcap') renderCostFloor();
      if (d.id === 'risk-maxrisk') renderRiskBindNote();
    };
    // Assigned (not added) on every refresh, so repeated renders cannot stack handlers.
    el.oninput = paint;
    paint();
  }
  loadCostFloors().then(renderCostFloor);
  // ★ TRD-TP-1 (2026-09-28): the target ANCHOR is a two-state switch, not a slider, and it decides what every
  // ticket carries — so it gets the same treatment the sliders got (visible, explained, and impossible to mistake
  // for off). Rendered from settings, never from a local default, so the panel cannot show a state the desk is
  // not in.
  renderTpAnchor(r);
  loadRefusals();
  renderRiskBindNote();
}

// The anchor switch, and the sentence that says which geometry the desk is currently buying.
function renderTpAnchor(r) {
  const el = $('risk-tpanchor-on');
  const v = $('risk-tpanchor-v');
  if (!el) return;
  const placed = !!(r && r.takeProfitAnchor === 'placed');
  el.checked = placed;
  if (v) {
    v.textContent = placed
      ? 'placed — every ticket carries the declared 1.5R'
      : 'declared — a capped stop leaves the target further away (current behaviour)';
  }
  el.onchange = () => { $('risk-tpanchor-v').textContent = el.checked
    ? 'placed — every ticket carries the declared 1.5R'
    : 'declared — a capped stop leaves the target further away'; };
}

// ★ TRD-LLM-2 (#1413): THE DIAL THAT IS INERT MUST SAY SO ON SCREEN.
// `riskPerTradePct` sets the base size and `maxRiskPerTradePct` recomputes it, and BOTH divide by the same
// effective stop distance — so the smaller always wins, for every symbol. On the live config the declared dial
// reads 2% while the realised risk per trade is 0.07%, i.e. roughly 28x smaller. The panel previously showed the
// 2% slider with no hint that it did nothing, and the desk's own veto text had been printing the real number all
// along. This note is the missing half of that disclosure.
function renderRiskBindNote() {
  const el = $('risk-maxrisk-note');
  if (!el) return;
  const declaredEl = $('risk-riskpct');
  const capEl = $('risk-maxrisk');
  if (!declaredEl || !capEl) { el.style.display = 'none'; return; }
  const declared = Number(declaredEl.value);
  const cap = Number(capEl.value);
  el.style.display = 'inline';
  if (!(cap > 0)) {
    el.textContent = `⚠ per-trade risk cap OFF — the declared risk per trade (${declared}%) governs, so every position is sized several times larger than this panel otherwise implies`;
    return;
  }
  if (cap < declared) {
    el.textContent = `\u26a0 "risk per trade" (${declared}%) is INERT — this cap (${cap}%) is smaller and both divide by the SAME stop distance, so the realised risk per trade is ${cap}%, not ${declared}%`;
    return;
  }
  el.textContent = `risk per trade ${declared}% binds — the ${cap}% cap is not reached`;
}

async function saveRiskSizing() {
  try {
    const cdOn = $('risk-cooldown-on');
    const cdEnabled = cdOn ? cdOn.checked : true;
    const patch = {
      riskPerTradePct: Number($('risk-riskpct').value),
      maxEquityPerPositionPct: Number($('risk-maxpos').value),
      exposureCapPct: Number($('risk-expcap').value),
      maxNewTradesPerDay: Number($('risk-dailycap').value),
      maxPositions: Number($('risk-maxcount').value),
      reentryCooldownBars: cdEnabled ? (Number($('risk-cooldown').value) || 6) : 0,
      // 0 is a MEANING here, not an absence: `adverseStopCap` returns "no cap" for `<= 0`, so 0 = the declared
      // 2xATR stop, and 0 on the TP offset = the un-offset target.
      maxAdversePct: Number($('risk-stopcap') ? $('risk-stopcap').value : 0) || 0,
      takeProfitOffsetPct: Number($('risk-tpoffset') ? $('risk-tpoffset').value : 0) || 0,
      // ★ TRD-LLM-2 (#1413): the two dials that decide what the desk can trade. `maxRiskPerTradePct` is saved even
      // as 0 because 0 is a MEANING here — it disables the risk cap and hands sizing back to `riskPerTradePct`.
      // `correlationVeto` is clamped to its slider floor rather than to 0, because `|c| >= 0` would refuse every
      // entry: a 0 reaching the gate is the most permissive-looking way to write the most destructive setting.
      maxRiskPerTradePct: Number($('risk-maxrisk') ? $('risk-maxrisk').value : 0) || 0,
      correlationVeto: Number($('risk-corrveto') ? Math.max(0.1, Number($('risk-corrveto').value)) : 0.7),
      // ★ TRD-TP-1 (2026-09-28): the target ANCHOR. Two explicit states, and an UNCHECKED box writes `'declared'`
      // rather than being omitted — an absent field must not read as "leave whatever was there", because the
      // whole point of this dial is that its two positions are both deliberate.
      takeProfitAnchor: ($('risk-tpanchor-on') && $('risk-tpanchor-on').checked) ? 'placed' : 'declared',
    };
    await apiPut('/api/trading/settings', { risk: patch });
    riskCostFloors = null; // re-read the floors so the note reflects the new cap
    const danger = patch.maxEquityPerPositionPct > RISK_MAXPOS_DANGER_PCT;
    const capNote = patch.maxAdversePct > 0 ? `stop cap ${patch.maxAdversePct}%` : 'stop cap OFF';
    const riskNote = patch.maxRiskPerTradePct > 0 && patch.maxRiskPerTradePct < patch.riskPerTradePct
      ? `risk/trade ${patch.maxRiskPerTradePct}% binds (declared ${patch.riskPerTradePct}% inert)`
      : `risk/trade ${patch.riskPerTradePct}%`;
    feedback($('risk-feedback'), (cdEnabled ? 'saved' : 'saved — cooldown disabled') + ` — ${capNote}`
      + `, take-profit offset ${patch.takeProfitOffsetPct > 0 ? patch.takeProfitOffsetPct + '%' : 'off'}`
      + `, ${riskNote}, correlation veto ${patch.correlationVeto}`
      + (danger ? ` — ⚠ danger: ${patch.maxEquityPerPositionPct}% of equity in one position (>${RISK_MAXPOS_DANGER_PCT}%)` : ''), true);
    await refreshDeliberation();
  } catch (e) { feedback($('risk-feedback'), e.message, false); }
}

async function runPositionReview(feedbackEl) {
  feedback(feedbackEl, 'reviewing positions one by one…');
  try {
    const r = await apiPost('/api/trading/review/run');
    const done = r.results || [];
    if (!done.length) { feedback(feedbackEl, r.reason || 'nothing to review'); }
    else {
      feedback(feedbackEl, `reviewed ${r.reviewed} — ` + done.map((x) => `${esc(x.symbol)}:${esc(x.action || 'error')}${x.closed ? ' (CLOSED)' : x.advisory ? ' (advisory)' : ''}`).join(' · '));
    }
    await refreshTrades();
    return r;
  } catch (e) { feedback(feedbackEl, e.message, false); }
}

// ---------------- meta shadow + strategies (TRD-10) ----------------
async function refreshMeta() {
  try {
    const m = await apiGet('/api/trading/meta');
    const v = (m.latest && m.latest.payload) || null;
    if (!v) {
      $('meta-regime').textContent = '—'; $('meta-trend').textContent = '—'; $('meta-conf').textContent = '—';
      $('meta-scale').textContent = '—'; $('meta-win').textContent = '—'; $('meta-note').textContent = 'first verdict on next wake';
      return;
    }
    $('meta-regime').textContent = v.regime;
    $('meta-regime').className = 'v ' + (v.regime === 'trend' ? 'pos' : v.regime === 'range' ? 'warn-t' : 'muted');
    $('meta-trend').textContent = v.trend;
    $('meta-conf').textContent = v.confidence != null ? Math.round(v.confidence * 100) + '%' : '—';
    $('meta-scale').textContent = v.scaleFactor != null ? v.scaleFactor + 'x' : '—';
    $('meta-win').textContent = v.winRate != null ? v.winRate + '%' : '—';
    $('meta-note').textContent = `${v.symbol || ''} · ${v.venue || ''} · ADX ${v.adx14 ?? '—'} · ${fmt(v.at)}`;
  } catch { /* meta optional */ }
}

// F8/TRD-91 (2026-09-18): WHAT THE DESK MAY ACTUALLY TRADE. The `enabled` checkbox list below is NOT the
// effective set — an explicit symbolScope entry replaces it per symbol, so a strategy can be live while
// its checkbox reads off (rsi2 was, on Bitcoin, while holding the largest closed sample on the desk).
// The server resolves this with the same helper the parity harness uses, so this panel and the safety
// net cannot disagree. It also surfaces the two ways `enabled` lies, as the parity notes do.
function renderEffectiveScope(d) {
  const el = $('strat-effective');
  if (!el) return;
  const rows = d.perSymbol || [];
  const notes = d.notes || [];
  if (!rows.length && !notes.length) { el.innerHTML = ''; return; }
  const others = d.othersDefault;
  const head = `<div class="muted" style="font-size:11.5px;margin:0 0 6px">Effective scope — what can actually open a position (a <b>symbolScope</b> entry replaces <code>enabled</code> for that symbol; default for unlisted: <code>${esc(others == null ? '(none — cannot trade)' : JSON.stringify(others))}</code>)</div>`;
  const table = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Symbol</th><th>Strategies that can open here</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.symbol)}</td><td>${r.strategies.length ? r.strategies.map((x) => `<span class="chip open" style="margin:1px 2px">${esc(x)}</span>`).join('') : '<span class="chip soft" style="margin:1px 2px">nothing — cannot trade</span>'}</td></tr>`).join('')}</tbody></table></div>` : '';
  const warn = notes.length ? `<div style="margin-top:8px">${notes.map((n) => `<div class="chip soft" style="display:block;margin:3px 0;white-space:normal;text-align:left;line-height:1.5" title="${esc(n.reason)}">${esc(n.strategy)}: ${esc(n.reason)}</div>`).join('')}</div>` : '';
  el.innerHTML = head + table + warn;
}

async function refreshStrategies() {
  try {
    const d = await apiGet('/api/trading/strategies');
    state.strategies = d.items || [];
    renderEffectiveScope(d);
    const hint = $('strat-effective-hint');
    if (hint) {
      const live = state.strategies.filter((s) => s.live).map((s) => s.id);
      hint.textContent = `live: ${live.length ? live.join('+') : 'nothing'} · the checkbox below edits strategies.enabled only`;
    }
    // 2026-09-12 (owner: "readability hierarchy"): 6 cards × ~15 inline-labelled
    // inputs read as one long wall. Name is a real title, params are a compact
    // auto-fill grid, and the panel is a bordered card per strategy.
    $('strat-list').innerHTML = state.strategies.map((s) => {
      // The badge states EFFECTIVE liveness. Without it the card reads "unchecked" for a strategy the
      // desk is actively trading, which is precisely how rsi2 stayed invisible through a 13-trade churn.
      const badge = s.live && s.viaScope && s.viaScope.length
        ? `<span class="chip soft" style="font-weight:400;font-size:11px" title="live through symbolScope while absent from strategies.enabled — the checkbox does not control this (TRD-91)">live via scope: ${esc(s.viaScope.join(', '))}</span>`
        : s.live ? '<span class="chip open" style="font-weight:400;font-size:11px">live</span>'
          : '<span class="chip off" style="font-weight:400;font-size:11px" title="not reachable: no symbolScope entry and the default does not name it">cannot run</span>';
      // TRD-89: the review policy is a behaviour the operator must be able to see and question.
      const revBadge = s.reviewAuthority === 'advisory'
        ? '<span class="chip muted" style="font-weight:400;font-size:11px" title="the exit chair may advise on this strategy but may not close its positions — the strategy own mechanical exit and its venue stop do that">review: advisory</span>'
        : '<span class="chip muted" style="font-weight:400;font-size:11px" title="the exit chair may close a position from this strategy">review: decider</span>';
      return `<div class="strat-card${s.live ? ' on' : ''}">
      <label class="strat-name"><input type="checkbox" data-strat-enable="${esc(s.id)}" ${s.enabled ? 'checked' : ''} aria-label="enable ${esc(s.name)} in strategies.enabled" /> <span>${esc(s.name)}</span> <span class="muted" style="font-weight:400;font-size:11.5px">${esc(s.id)}</span> ${badge} ${revBadge}</label>
      <div class="strat-desc">${esc(s.description)}</div>
      <div class="strat-params">${s.params.map((p) => p.type === 'bool'
        ? `<label><span>${esc(p.label)}</span><input type="checkbox" data-strat-param="${esc(s.id)}.${esc(p.key)}" ${p.value ? 'checked' : ''} aria-label="${esc(p.label)}" /></label>`
        : `<label><span>${esc(p.label)}</span><input type="number" step="${p.step || 1}" min="${p.min}" max="${p.max}" data-strat-param="${esc(s.id)}.${esc(p.key)}" value="${p.value}" aria-label="${esc(p.label)}" /></label>`).join('')}</div>
    </div>`;
    }).join('');
    $('congress-token-row').classList.toggle('hidden', !state.strategies.some((s) => s.id === 'congress'));
    renderBtStrategies();
  } catch { /* strategies optional */ }
}

// ---------------- scope + hypotheses (TRD-75/85/86) ----------------
// WHY THIS PANEL EXISTS AT ALL (2026-09-15): `GET /binding` had NO consumer. The reviewer has been
// deciding which strategy runs on which instrument — and, since TRD-85, proposing SCOPE ADDITIONS that an
// armed writer applies unattended — with the result visible only to whoever called the API by hand. That
// is the "recorded and read by nothing" failure this workstream keeps finding, one layer up: a capability
// nobody can see is a capability nobody can correct.
//
// It renders the three things that decision produces: the binding itself, the last proposal's refusals,
// and the HYPOTHESES — claims with a named falsifier and the data they need, which grant no scope.
function hypothesesHtml(v, raw) {
  const list = Array.isArray(v && v.rows) ? v.rows : (Array.isArray(raw) ? raw.map((h) => ({ ...h, status: 'recorded', reasons: [] })) : []);
  if (!list.length) return '<div class="muted">none this round — the reviewer had no falsifiable claim to make, which is a valid answer.</div>';
  return list.map((h) => {
    const ok = h.status === 'accepted';
    const fb = h.falsifiableBy || {};
    const falsifier = fb.strategy
      ? `test: <b>${esc(fb.strategy)}</b>`
      : fb.needsAuthoring
        ? `test: <b>new strategy must be authored</b>${fb.sketch ? ` — ${esc(fb.sketch)}` : ''}`
        : '<b>no falsifier</b>';
    const data = (h.requiredData || []).length ? ` · needs ${(h.requiredData || []).map((d) => `<code>${esc(d)}</code>`).join(', ')}` : '';
    const why = (h.reasons || []).map((r) => `<div class="${r.level === 'error' ? 'neg' : 'muted'}" style="font-size:11.5px">· ${esc(r.level)}: ${esc(r.reason)}</div>`).join('');
    return `<div style="border-left:3px solid ${ok ? 'var(--success)' : 'var(--danger)'};padding:2px 0 2px 8px;margin:6px 0">
      <div><span class="chip ${ok ? 'off' : 'hard'}">${ok ? 'ACCEPTED' : 'REFUSED'}</span> <b>${esc(h.symbol || '?')}</b> — ${esc(h.statement || '(no statement)')}</div>
      <div class="muted" style="font-size:11.5px">${falsifier}${data}</div>${why}</div>`;
  }).join('');
}

async function refreshBinding() {
  try {
    const d = await apiGet('/api/trading/binding');
    const table = d.table || {};
    const rows = (table.symbols || []);
    const inScope = rows.filter((r) => (r.strategies || []).length).length;
    if ($('binding-state')) $('binding-state').textContent = `${inScope}/${rows.length} symbols in scope · reviewer ${d.proposer && d.proposer.enabled ? 'on' : 'off'}`;
    const last = (d.lastProposal && d.lastProposal.payload) || null;
    // F24 (2026-09-18): the provenance tag was a CONSTANT — every binding row read "params from default"
    // because the sources were only ever joined into one tooltip string, while `binding.js` computes them
    // PER KEY (`paramSources`: symbol | global | default). Arabica/Silver/Sugar `meanrev` demonstrably come
    // from `symbolParams`, so the one label whose whole job is to say where a number came from was wrong on
    // every row that mattered — the same class as F1/F3/F4. It is now rendered per key, on the value itself.
    const SRC_TAG = { symbol: 'sym', global: 'glob', default: 'dflt' };
    const paramSourcesTitle = (s) => {
      const src = s.paramSources || {};
      const entries = Object.entries(src);
      if (!entries.length) return 'no resolved params (frozen layer)';
      return `where each value comes from: ${entries.map(([k, v]) => `${k} ← ${v}`).join(', ')}`;
    };
    const params = (s) => {
      const src = s.paramSources || {};
      const tuned = Object.entries(s.tuned || {});
      if (!tuned.length) return s.tunable ? 'defaults' : 'frozen';
      return tuned.map(([k, v]) => `<span title="${esc(k)} ← ${esc(src[k] || 'default')}">${esc(k)}=${esc(v)}<span class="muted" style="font-size:9px">·${esc(SRC_TAG[src[k]] || src[k] || 'dflt')}</span></span>`).join(' ');
    };
    const scopeRows = rows.map((r) => `<div style="padding:1px 0">
      <b>${esc(r.symbol)}</b>
      ${(r.strategies || []).length
    ? (r.strategies || []).map((s) => `<span class="chip off" title="${esc(paramSourcesTitle(s))}">${esc(s.strategy)}${s.tunable ? '' : ' (frozen)'}</span> <code style="font-size:11px">${params(s)}</code>`).join(' ')
    : `<span class="muted">no strategy in scope${r.scopeSource === 'global_list' ? ' (inherits the global enabled list)' : ` (via ${esc(r.scopeSource)})`}</span>`}
    </div>`).join('');
    const problems = (d.problems || []).length
      ? `<div style="margin-top:6px">${(d.problems || []).slice(0, 6).map((p) => `<div class="${p.level === 'error' ? 'neg' : 'muted'}" style="font-size:11.5px">· ${esc(p.symbol || '')} ${esc(p.strategy || '')}: ${esc(p.reason)}</div>`).join('')}</div>`
      : '';
    const hyps = last
      ? `<div style="margin-top:10px"><b>Hypotheses</b> <span class="muted">(grant no scope — the lab decides)</span></div>${hypothesesHtml(last.hypothesesVerdict, last.hypotheses)}`
      : '<div class="muted" style="margin-top:10px">no reviewer proposal recorded yet.</div>';
    const refused = last && (last.reasons || []).length
      ? `<div style="margin-top:10px"><b>Last proposal</b> <span class="muted">${esc(last.at || '')} · accepted: ${String(last.accepted)}</span></div>${(last.reasons || []).slice(0, 8).map((r) => `<div class="${r.level === 'error' ? 'neg' : 'muted'}" style="font-size:11.5px">· ${esc(r.level)}: ${esc(r.reason)}</div>`).join('')}`
      : '';
    const unbound = last && (last.unbound || []).length
      ? `<div style="margin-top:8px"><b>Declined</b></div>${(last.unbound || []).map((u) => `<div class="muted" style="font-size:11.5px">· ${esc(u.symbol)}: ${esc(u.reason)}</div>`).join('')}`
      : '';
    const wants = last && (last.wantsPhysical || []).length
      ? `<div style="margin-top:8px"><b>Wants telemetry</b></div>${(last.wantsPhysical || []).map((w) => `<div class="muted" style="font-size:11.5px">· ${esc(w.symbol)}: <code>${esc(w.sourceId)}</code></div>`).join('')}`
      : '';
    // TRD-84 question 2 (2026-09-22): DID IT RUN, OR DID IT HAVE NOTHING TO SAY?
    // The reviewer's skip was recorded as telemetry and read by nothing, so a refused reviewer and an idle one
    // looked identical on every surface - and the panel would show a STALE proposal as if it were the current
    // answer. The two are separated by TIMESTAMP: a skip newer than the newest proposal means the last attempt
    // did not run, which is a different fact from "the reviewer last spoke on <date>".
    const skip = d.lastSkip || null;
    const propAt = d.lastProposal && d.lastProposal.at ? new Date(d.lastProposal.at).getTime() : 0;
    const skipAt = skip && skip.at ? new Date(skip.at).getTime() : 0;
    const skipNewer = !!(skip && skipAt > propAt);
    const skipLine = skip
      ? `<div style="margin-top:8px">${skipNewer
        ? `<b class="warn-t">Last reviewer attempt did NOT run</b> <span class="muted">${esc(fmt(skip.at))} · reason <code>${esc(skip.reason || 'unknown')}</code>${skip.stranded ? ' · a stranded proposal was re-offered' : ''}</span>`
        : `<span class="muted">last skip ${esc(fmt(skip.at))}: <code>${esc(skip.reason || 'unknown')}</code> — a later proposal exists, so this is history</span>`}</div>`
      : '';
    if ($('binding-state') && skipNewer) {
      // The heading is what stays visible when the body is scrolled, so the "did not run" fact belongs in both.
      $('binding-state').textContent += ` · last attempt skipped (${skip.reason || 'unknown'})`;
    }
    if ($('binding-body')) {
      $('binding-body').innerHTML = `<div><b>Binding</b> <span class="muted">(one row per instrument)</span></div>${skipLine}${scopeRows}${problems}${hyps}${refused}${unbound}${wants}`;
    }
  } catch (e) {
    if ($('binding-body')) $('binding-body').innerHTML = `<span class="neg">could not read the binding: ${esc(e.message)}</span>`;
  }
}

async function saveStrategies() {  const enabled = [];
  const params = {};
  for (const s of state.strategies) {
    const cb = document.querySelector(`[data-strat-enable="${CSS.escape(s.id)}"]`);
    if (cb && cb.checked) enabled.push(s.id);
    const p = {};
    for (const pm of s.params) {
      const el = document.querySelector(`[data-strat-param="${CSS.escape(s.id)}.${CSS.escape(pm.key)}"]`);
      if (!el) continue;
      p[pm.key] = pm.type === 'bool' ? !!el.checked : (el.value === '' ? pm.def : Number(el.value));
    }
    params[s.id] = p;
  }
  const patch = { strategies: { enabled, params } };
  const tokenInput = $('congress-token');
  if (tokenInput && tokenInput.value.trim()) patch.congress = { token: tokenInput.value.trim() };
  try {
    await apiPut('/api/trading/settings', patch);
    if (tokenInput) tokenInput.value = '';
    await refreshStrategies();
    feedback($('strat-feedback'), `saved — enabled: ${enabled.join(', ') || 'none'}`);
  } catch (e) { feedback($('strat-feedback'), e.message, false); }
}

async function saveDeliberation() {  const panel = PANEL_TYPES.map((t) => {
    const cb = document.querySelector(`[data-panel-type="${t}"]`);
    const w = document.querySelector(`[data-panel-weight="${t}"]`);
    if (!cb || !cb.checked) return { type: t, weight: 0 };
    return { type: t, weight: Number(w.value) || 0 };
  }).filter((p) => p.weight > 0);
  const chairs = [...document.querySelectorAll('[data-chair-row]')].map((row, i) => {
    const sel = row.querySelector('[data-c-persona]');
    // Keep an existing persona when the dropdown is left on "seat default"
    // (otherwise saving silently strips personas -> identical chair echoes).
    const prev = (state.deliberation && state.deliberation.chairs && state.deliberation.chairs[i]) || {};
    const persona = (sel && sel.value) ? sel.value : (prev.persona || null);
    return {
      id: String(row.querySelector('[data-c-id]').value || 'chair').trim(),
      model: row.querySelector('[data-c-model]').value.trim() || null,
      temperature: row.querySelector('[data-c-temp]').value === '' ? null : Number(row.querySelector('[data-c-temp]').value),
      weight: Number(row.querySelector('[data-c-weight]').value) || 0,
      persona,
    };
  }).filter((c) => c.weight > 0).slice(0, 3);
  try {
    const s = await apiPut('/api/trading/settings', { deliberation: { quantPanel: panel, chairs } });
    state.deliberation = s.deliberation || { quantPanel: panel, chairs };
    renderDeliberation();
    feedback($('delib-feedback'), `saved — ${panel.length} panel voters, ${chairs.length} chairs`);
  } catch (e) { feedback($('delib-feedback'), e.message, false); }
}

// ---------------- pulse (TRD-11) ----------------
const CAT_LABEL = { crypto: 'crypto', commodities: 'commodities', singapore: 'sg', 'hong-kong': 'hk', equities: 'equities' };
// Fallback for older stored pulses that predate category markers.
function guessCat(name) {
  const n = String(name || '');
  if (/bitcoin|ethereum|solana|bnb|ripple|stellar|cardano|chainlink|litecoin|polkadot|polygon|filecoin|avalanche|toncoin|tron|uniswap|pax|crypto/i.test(n)) return 'crypto';
  if (/gold|silver|oil|gas|copper|palladium|platinum|corn|soybean|wheat|sugar|coffee|hogs|cattle|aluminum|heating/i.test(n)) return 'commodities';
  if (n === 'SGX') return 'singapore';
  return 'equities';
}

async function refreshPulse() {
  try {
    const d = await apiGet('/api/trading/pulse');
    const v = d.latest?.payload || null;
    const body = $('pulse-body');
    if (!v || !v.headline) {
      const err = d.lastError ? ` · ⚠ ${d.lastError.payload?.where || 'error'}: ${String(d.lastError.payload?.error || '').slice(0, 140)}` : '';
      body.innerHTML = `<span class="muted">no pulse yet — press Run now (first one takes ~10s)${esc(err)}</span>`;
      return;
    }
    const chip = v.sentiment === 'risk-on' ? '<span class="chip pos">risk-on</span>' : v.sentiment === 'risk-off' ? '<span class="chip neg">risk-off</span>' : '<span class="chip muted">neutral</span>';
    const movers = (v.movers || []).slice(0, 6).map((m) => {
      const cat = m.cat || guessCat(m.symbol);
      return `
      <div class="pulse-mover">
        <span class="mover-name">${esc(m.symbol)}</span><span class="cat ${esc(cat)}">${esc(CAT_LABEL[cat] || 'eq')}</span>
        <span class="v ${Number(m.pct) >= 0 ? 'pos' : 'neg'}">${Number(m.pct) > 0 ? '+' : ''}${num(m.pct)}%</span>
        ${m.why ? `<span class="why muted">${esc(m.why)}</span>` : ''}
      </div>`;
    }).join('');
    body.innerHTML = `
      <div class="pulse-head">${esc(v.headline)} ${chip}</div>
      <div class="muted" style="font-size:11px;margin-bottom:4px">${fmt(v.at)} · ${ageLabel(v.at)} · ${esc(v.model || '')}</div>
      ${movers}
      ${(v.drivers || []).length ? `<div class="pulse-sec muted"><b>Drivers</b> — ${esc(v.drivers.join(' · '))}</div>` : ''}
      ${(v.risks || []).length ? `<div class="pulse-sec muted"><b>Risks</b> — ${esc(v.risks.join(' · '))}</div>` : ''}
      ${(v.watch || []).length ? `<div class="pulse-sec muted"><b>Watch</b> — ${esc(v.watch.join(' · '))}</div>` : ''}`;
  } catch { /* pulse optional */ }
}

async function runPulse(scope) {
  feedback($('pulse-feedback'), 'analyzing markets…');
  try {
    const r = await apiPost('/api/trading/pulse/run', scope != null ? { scope } : {});
    feedback($('pulse-feedback'), r.headline ? `pulse generated (${r.latencyMs}ms)` : 'generated');
    await refreshPulse();
  } catch (e) { feedback($('pulse-feedback'), e.message, false); }
}

// ---------------- news (S2, 2026-10-03) ----------------
// Read-only window onto NewsItems via the deterministic digest. The title links out to the stored
// item's url; undated items say nothing rather than a fabricated age. Not a live region: silent
// refresh, no announcement churn (the UI a11y rules from the 10-03 sitting).
async function refreshNews() {
  try {
    const d = await apiGet('/api/trading/news');
    const body = $('news-body');
    const meta = $('news-meta');
    if (!d || !Array.isArray(d.symbols) || !d.symbols.length) {
      body.innerHTML = '<span class="muted">no items yet — the hourly fetch writes them; check back shortly</span>';
      meta.textContent = d && d.asOf ? `as of ${fmt(d.asOf)}` : '';
      return;
    }
    body.innerHTML = d.symbols.map((s) => `
      <div class="news-sym">
        <div class="news-sym-name">${esc(s.symbol)}</div>
        ${s.items.map((it) => `<div class="news-item"><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a><span class="muted"> — ${esc(it.source || it.engine || '?')}${it.publishedAt ? ' · ' + ageLabel(it.publishedAt) : ''}</span></div>`).join('')}
      </div>`).join('');
    meta.textContent = `${d.totals.items} items across ${d.totals.symbols} symbols · as of ${fmt(d.asOf)}`;
  } catch { /* news optional */ }
}

// ---------------- paper (TRD-11) ----------------
function renderPaperTables(d) {
  // A throw here used to leave both tables blank inside refreshPaper's silent
  // catch — a panel that looks like "no positions" when it is actually broken.
  // Never silent again.
  try {
    const open = d.open || [];
    const closed = d.closed || [];
    // 2026-09-12: headers were <tr><th> inside an unbounded table — no scroll
    // container, no sticky header. Now thead + tbody inside .table-wrap.tight.
    $('paper-open').innerHTML = `<thead><tr><th>Symbol</th><th>Dir</th><th>Size</th><th>Open</th><th>Reason</th></tr></thead><tbody>` +
      (open.length ? open.map((t) =>
        `<tr><td>${esc(t.symbol)}</td><td>${esc(t.direction)}</td><td class="mono num">${num(t.size, 4)}</td><td class="mono num">${num(t.openPrice)}</td><td class="muted" style="white-space:normal">${esc(t.reason || '')}</td></tr>`).join('')
        : '<tr><td class="muted" colspan="5">no open positions</td></tr>') + '</tbody>';
    $('paper-closed').innerHTML = `<thead><tr><th>Symbol</th><th>Dir</th><th>P&L</th><th>Closed</th><th>Reason</th></tr></thead><tbody>` +
      (closed.length ? closed.map((t) =>
        `<tr><td>${esc(t.symbol)}</td><td>${esc(t.direction)}</td><td class="mono num ${t.pnl >= 0 ? 'pos' : 'neg'}">${num(t.pnl, 2)}</td><td>${fmt(t.closeAt)}</td><td class="muted" style="white-space:normal">${esc(t.reason || '')}</td></tr>`).join('')
        : '<tr><td class="muted" colspan="5">nothing closed yet</td></tr>') + '</tbody>';
  } catch (e) {
    console.error('renderPaperTables failed', e);
    feedback($('paper-feedback'), `ledger tables failed to render: ${e.message}`, false);
  }
}

async function refreshPaper() {
  try {
    const d = await apiGet('/api/trading/paper');
    const eq = d.equity || {};
    state.simMode = !!d.enabled;
    // The Paper-tab checkbox reflects the PAPER SUBSYSTEM's own switch, which is what /paper is FOR — it is
    // the control the user flips, and it is the write path. The page-wide SIM/DEMO LABELS are not read from
    // here any more (TRD-UI-2): they project `state.mode` via applyMode, whose single reader is /state.
    $('paper-toggle').checked = !!d.enabled;
    applyMode();
    $('paper-equity').textContent = `${num(eq.equity, 2)} (${eq.pnlPct >= 0 ? '+' : ''}${num(eq.pnlPct, 2)}%)`;
    $('paper-equity').className = 'v ' + (eq.pnlPct >= 0 ? 'pos' : 'neg');
    $('paper-realized').textContent = `${num(eq.realized, 2)} (${eq.closedCount} closed)`;
    $('paper-float').textContent = `${num(eq.unrealized, 2)} (${eq.openPositions} open)`;
    $('paper-swap').textContent = eq.swapAccrued != null ? `${num(eq.swapAccrued, 2)} (overnight funding, ${num((d.config && d.config.swapDailyPct) ?? 0.02, 2)}%/night)` : '—';
    const v = d.lastCentral?.payload || null;
    if (v) {
      // The stored central payload carries `actions` as a COUNT (it is a number in
      // every row), so `(v.actions || []).map(...)` threw a TypeError on every load
      // — and the bare `catch` below swallowed it, which is why this panel never
      // rendered its tables. Handle array | string | number.
      const acts = Array.isArray(v.actions)
        ? (v.actions.map((a) => `${a.side} ${a.symbol} ${num(a.sizePct, 1)}% — ${a.reason}`).join('; ') || 'none')
        : typeof v.actions === 'string' ? v.actions
          : Number.isFinite(v.actions) ? `${v.actions} action(s)` : 'none';
      $('paper-verdict').innerHTML = `${esc(v.headline || v.stance)} · conf ${num((v.confidence ?? 0) * 100, 0)}%<br>` +
        `stance ${esc(v.stance || '—')} · actions: ${esc(acts)}${v.model ? ' · model ' + esc(v.model) : ''}` +
        `${Array.isArray(v.reasoningSteps) && v.reasoningSteps.length ? '<br>steps: ' + esc(v.reasoningSteps.join(' → ')) : ''}`;
    }
    // TRD-11: explicit failure states — never a silent '—'.
    const failEl = $('paper-fail');
    const failures = [];
    if (v && v.parseFailure) failures.push('central parse failure (raw response in Decisions)');
    if (d.lastError) failures.push(`${d.lastError.payload?.where || 'error'}: ${String(d.lastError.payload?.error || '').slice(0, 160)}`);
    if (failures.length) { failEl.textContent = '⚠ ' + failures.join(' · '); failEl.className = 'feedback err'; }
    else { failEl.textContent = ''; failEl.className = 'feedback'; }
    renderPaperTables(d);
  } catch (e) {
    // Was a bare `catch { /* paper optional */ }`: a failure here left the whole
    // panel showing stale stats and two blank tables with no evidence anywhere.
    console.error('refreshPaper failed', e);
  }
}

// TRD-11: demo account indicators — per-metric green/red vs the baseline.
async function refreshAccount() {
  try {
    const d = await apiGet('/api/trading/account');
    const a = d.live || d.latest?.payload;
    // 2026-09-11: only feed the chart a FRESH read. d.live persists after the
    // bridge dies — pushing it would extend the curve with a fabricated value
    // at stale levels. No fresh read => no point (the gap is marked on resume).
    const liveAgeMs = d.live && d.live.readAt ? Date.now() - new Date(d.live.readAt).getTime() : Infinity;
    if (liveAgeMs <= 15000 && d.live.equity != null) pushEquityTick(d.live.equity);
    // TRD-70 (2026-09-14): "when we READ" is a different clock from "when we got a USABLE
    // value". `readAt` only advances on an ACCEPTED strip, so a stretch of rejected
    // transitional frames freezes it while the poller is reading perfectly well — and this
    // panel then showed a frozen number with nothing to say why. `lastReadAt` is the read
    // side, so the two can be told apart and NAMED.
    const readAgeMs = d.live && d.live.lastReadAt ? Date.now() - new Date(d.live.lastReadAt).getTime() : liveAgeMs;
    const reading = readAgeMs <= 15000;
    const rejectStreak = (d.live && d.live.rejectedStreak) || 0;
    // Show the sample's real age next to the number. A static "1s" claim is what made a 2.5s
    // (sometimes 6s) cadence read as "the desk stopped"; a live age cannot over-promise.
    const ageEl = $('eq-age');
    if (ageEl) {
      ageEl.textContent = liveAgeMs === Infinity ? '' : `${liveAgeMs < 9500 ? (liveAgeMs / 1000).toFixed(1) + 's' : Math.round(liveAgeMs / 60000) + 'm'} old`;
      ageEl.title = 'age of the venue account-strip sample behind this number (read about once a second)';
    }
    const box = $('account-indicators');
    if (!box) return;
    if (!a || a.equity == null) { box.innerHTML = '<span class="muted">— (bridge off / first read pending)</span>'; return; }
    const s = await apiGet('/api/trading/settings').catch(() => null);
    const baseline = s && s.kill && s.kill.initialEquity != null ? Number(s.kill.initialEquity) : null;
    const chip = (label, value, tone, title) =>
      `<span class="chip ${tone}" title="${esc(title || '')}">${esc(label)} ${value}</span> `;
    let html = '';
    if (baseline != null) {
      const delta = a.equity - baseline;
      html += chip('eq', num(a.equity, 2), delta >= 0 ? 'open' : 'soft', `vs kill baseline (ratcheted) ${num(baseline, 2)} — not day-start`);
      html += chip(delta >= 0 ? '▲' : '▼', (delta >= 0 ? '+' : '') + num(delta, 2), delta >= 0 ? 'open' : 'soft', `equity − kill.initialEquity (ratcheted baseline ${num(baseline, 2)})`);
    } else {
      html += chip('eq', num(a.equity, 2), 'off', 'baseline not set — use Set baseline');
    }
    html += chip('P/L', (a.pnl >= 0 ? '+' : '') + num(a.pnl, 2), a.pnl >= 0 ? 'open' : 'soft', 'live profit/loss');
    html += chip('avail', num(a.available, 2), 'off', 'available balance');
    html += chip('m.margin', num(a.margin, 2), 'off', 'maintenance margin');
    // TWO DIFFERENT CONDITIONS, named separately — this is the whole point of the change:
    //  * reading but rejecting  -> the venue is emitting transitional frames; the desk is fine
    //  * not reading at all     -> a real fault (bridge off, tab moved, poller stalled)
    if (reading && liveAgeMs > 15000) {
      html += chip('reading · rejected', `×${rejectStreak}`, 'soft',
        `the poller IS reading the strip (last read ${Math.round(readAgeMs / 1000)}s ago), but ${rejectStreak} consecutive frame(s) failed the flicker guard (P&L reads 0 while equity still carries the pre-P&L value). Showing the last good value, not a stale one.`);
    } else if (liveAgeMs > 90000) {
      html += chip('stale', Math.round(liveAgeMs / 60000) + 'm', 'soft', 'no fresh account read — last successful read age');
    }
    box.innerHTML = html;
  } catch { /* account optional */ }
}
// Live mirror: refresh every 1s while signed in (Plus500 updates per second).
// F13 (2026-09-12): pollers STOP while the tab is hidden — a backgrounded tab
// used to keep hitting SQL + the bridge at 2 req/s.
function poll(fn, ms) { return setInterval(() => { if (isLoggedIn() && !document.hidden) fn().catch(() => {}); }, ms); }
poll(() => tracked('account', refreshAccount), 1000);
// Mirror refresh: positions every 1s (frontend overlay), alerts every 30s.
poll(() => tracked('trades', refreshTrades), 1000);
poll(() => tracked('alerts', refreshAlerts), 30000);

// ---------------- AI state + ask the AI ----------------

// TRD-UI-2 (2026-09-22): THE MODE FACT HAS ONE READER.
//
// F21's complaint was one fact with several readers, and its closing note said the remaining item "needs the
// endpoint merge, not another projection". SIM-vs-PLUS500-DEMO was still answered by TWO endpoints on two
// schedules: /paper (as the boolean `enabled`) and /state (as the string `mode`). Both derive from the same
// `settings.paper.enabled` on the server, so they agree in principle and can still disagree on screen —
// exactly how the earlier `kill: hard` / `kill: OFF` split happened.
//
// The merge: **/state owns it**, because that endpoint NAMES the mode (`sim` | `plus500_demo`) rather than
// exposing a boolean the client would have to re-map into a name — re-mapping in the client is how two
// vocabularies for one fact start. Every mode label projects this one value.
//
// ⚠ An UNREAD mode stays unread. `applyMode` paints a neutral dash rather than falling through to
// "PLUS500 DEMO", because defaulting to the venue branch is a claim about the desk made from no data.
function applyMode() {
  const mode = state.mode || null;
  const isSim = mode === 'sim';
  const el = $('banner-mode');
  if (el) {
    el.textContent = mode ? (isSim ? 'SIM' : 'PLUS500 DEMO') : '—';
    el.className = 'chip ' + (mode ? (isSim ? 'soft' : 'open') : 'muted');
  }
  const tgl = $('paper-mode-toggle');
  if (tgl) tgl.textContent = mode ? (isSim ? 'Paper mode: ON' : 'Paper mode: OFF') : 'Paper mode: —';
}

async function renderAiState() {
  try {
    const s = await apiGet('/api/trading/state');
    // The single reader of the mode fact. Set BEFORE painting, so applyMode and the chips below can only
    // ever read the value this same response carried.
    state.mode = s.mode || null;
    applyMode();
    const w = s.waker || {};
    const demo = (s.positions && s.positions.demo) || [];
    const sim = (s.positions && s.positions.sim) || [];
    const last = s.lastDecision || {};
    const paused = !!w.paused;
    const statusTxt = paused ? 'AI ASLEEP — wake loop paused (manual wakes only)'
      : w.inProgress ? 'AI THINKING — a wake is running right now'
      : 'AI AWAKE — waiting for the next scheduled wake';
    // TRD-UI-9 (B) 2026-10-03: the status LINE announces a COUNT. The full 18-name strategies run was
    // read aloud here AND in the chips on every render; the Strategy card still carries the full list
    // on demand, and the tooltip keeps it for pointer users.
    const strategies = state.strategiesEnabled || s.strategies || [];
    const line = `${state.mode === 'sim' ? 'SIM paper desk' : 'PLUS500 DEMO desk'} · ${statusTxt} · kill ${state.killTier || (s.kill && s.kill.tier) || 'off'} · strategies ${strategies.length ? strategies.length + ' enabled' : 'none'} · demo ${demo.length} open · sim ${sim.length} open`;
    const el = $('ai-state-line');
    if (el.textContent !== line) el.textContent = line;
    el.title = strategies.length ? strategies.join('+') : '';
    el.className = paused ? 'warn-t' : w.inProgress ? 'pos' : '';
    const chips = [
      ['mode', state.mode === 'sim' ? 'SIM' : (state.mode ? 'DEMO' : '—'), state.mode === 'sim' ? 'soft' : 'open', ''],
      ['waker', paused ? 'PAUSED' : w.inProgress ? 'waking' : 'running', paused ? 'soft' : 'open', ''],
      ['kill', state.killTier || (s.kill && s.kill.tier) || 'off', !state.killTier || state.killTier === 'off' ? 'off' : state.killTier === 'hard' ? 'hard' : 'soft', ''],
      ['strategies', strategies.length ? String(strategies.length) : 'none', strategies.length ? 'open' : 'closed', strategies.join('+')],
      ['demo positions', String(demo.length), demo.length ? 'open' : 'closed', ''],
      ['sim positions', String(sim.length), sim.length ? 'open' : 'closed', ''],
      ['alerts', String((s.alerts && s.alerts.count) || 0), 'closed', ''],
    ];
    $('ai-state-chips').innerHTML = chips.map(([k, v, cls, tip]) => `<span class="chip ${cls}"${tip ? ` title="${esc(tip)}"` : ''}>${esc(k)}: ${esc(v)}</span>`).join(' ');
    const la = $('ai-last');
    if (last.action || last.skipped) {
      const label = last.action || `skipped: ${esc(last.skipped)}`;
      const tone = last.action === 'entry' ? 'pos' : last.action === 'exit' ? 'warn-t' : 'muted';
      la.innerHTML = `<span class="${tone}">${esc(label)}${last.mode === 'paper' && last.stance ? ' (' + esc(last.stance) + ')' : ''}</span> <span class="muted">— ${esc(String(last.reason || last.headline || '').slice(0, 70))}</span>`;
    } else la.textContent = 'none yet';
    $('ai-next').textContent = paused ? 'paused' : (w.nextWakeAt ? fmt(w.nextWakeAt) : '—');
    // TRD-12: per-symbol venue sessions (passive feed) — open/closed + next open.
    // 2026-09-11: label as MARKET session — bare "<symbol> open" was misread
    // as an open position (false positive). These chips are market hours only.
    const sessEl = $('ai-sessions');
    if (sessEl) {
      const sessions = s.sessions || [];
      if (!sessions.length) {
        sessEl.innerHTML = '<span class="muted">no venue session data yet</span>';
      } else {
        sessEl.innerHTML = sessions.map((x) => {
          const tip = 'title="venue market session (tradable now?) — not a position"';
          const label = x.open
            ? `<span class="chip open" ${tip}>${esc(x.symbol)} market open</span>`
            : `<span class="chip soft" ${tip}>${esc(x.symbol)} market closed${x.next && x.next.from ? ' · opens ' + fmt(x.next.from) : ''}</span>`;
          return label;
        }).join(' ');
      }
    }
  } catch { $('ai-state-line').textContent = 'state unavailable'; }
}

let asking = false;
async function askAi() {
  const input = $('ask-input');
  const q = (input.value || '').trim();
  if (!q || asking) return;
  asking = true;
  $('btn-ask').disabled = true;
  feedback($('ask-feedback'), 'asking…');
  $('ask-answer').textContent = '';
  $('ask-meta').textContent = '';
  try {
    const r = await apiPost('/api/trading/ask', { question: q });
    $('ask-answer').textContent = r.answer;
    $('ask-meta').textContent = `${r.model} · ${num((r.usage && r.usage.completionTokens) || 0, 0)} tokens · ${fmt(r.at)}`;
    feedback($('ask-feedback'), '', true);
  } catch (e) {
    feedback($('ask-feedback'), e.message, false);
  } finally {
    asking = false;
    $('btn-ask').disabled = false;
  }
}
// F21: the AI State card renders the SHARED values, so its own tick refreshes those values first —
// it can only ever show what the header chip is showing.
setInterval(() => { if (isLoggedIn()) refreshKill().then(() => renderAiState()).catch(() => {}); }, 15000);
// Waker panel (Wake tab) self-refreshes on the same cadence — before this it only
// updated on page load, so "Next wake <past time>" / "idle" looked like the wake
// loop had stopped while wakes were actually firing (2026-09-11 false alarm).
setInterval(() => { if (isLoggedIn()) refreshWakerStatus().catch(() => {}); }, 15000);

async function renderScripts() {
  try {
    const d = await apiGet('/api/trading/scripts');
    // 2026-09-12 (user-reported crop): this row needed 567px inside a 279px column,
    // so the description collapsed to 0px width and every row scrolled sideways.
    // Two-line rows: name/cadence/nav/last-run on top, full description underneath.
    //
    // F32 (2026-09-18): the liveness cell used to be `lastAt ? fmt(lastAt) : '—'`, and the dash was
    // indistinguishable from a process that had stopped — four of its rows pointed at event sources that
    // no code emits, so the card showed `—` for the price capture and the positions mirror throughout the
    // very outage an operator would have opened this card to diagnose. Now the cell says WHAT KIND of
    // silence it is, and a process that has missed its own declared cadence is flagged as OVERDUE.
    const rows = (d.items || []).map((s) => {
      const live = s.lastAt
        ? `<span class="mono muted row-at">${fmt(s.lastAt)}${s.lastSummary ? ` · ${esc(s.lastSummary)}` : ''}</span>`
        : `<span class="muted row-at" title="${esc((s.liveness && s.liveness.text) || '')}">${esc((s.liveness && s.liveness.text) || '—')}</span>`;
      const flags = [
        s.overdue ? '<span class="chip rejected" title="has not run within its declared cadence">OVERDUE</span>' : '',
        (s.enabled === false) ? '<span class="chip closed" title="switched off in settings, so silence is expected">disabled</span>' : '',
      ].join(' ');
      return `<div class="row">
      <div class="row-top">
        <b>${esc(s.name)}</b>
        <span class="muted">${esc(s.cadence)}</span>
        ${s.navigates ? '<span class="chip soft">NAVIGATES browser</span>' : '<span class="chip closed">no nav</span>'}
        ${flags}
        ${live}
      </div>
      <div class="row-note">${esc(s.desc)}</div>
    </div>`;
    }).join('');
    $('scripts-list').innerHTML = rows || '<span class="muted">no scripts registered</span>';
  } catch { $('scripts-list').textContent = 'unavailable'; }
}
setInterval(() => { if (isLoggedIn()) renderScripts().catch(() => {}); }, 60000);
// ---------------- pipeline mirror (TRD-12 Phase 0) ----------------
async function renderPipeline() {
  try {
    const p = await apiGet('/api/trading/pipeline');
    const body = $('pipeline-body');
    if (!body) return;
    let html = '';
    const showSteps = (steps) => (steps || []).map((s) => {
      const tone = s.error ? 'neg' : s.skipped ? 'muted' : 'pos';
      return `<span class="${tone}">${esc(s.name)}</span><span class="muted"> ${s.ms != null ? s.ms + 'ms' : '…'}</span>${s.skipped ? `<span class="muted"> (${esc(String(s.skipped).slice(0, 40))})</span>` : ''}${s.error ? `<span class="muted"> ${esc(s.error.slice(0, 50))}</span>` : ''}`;
    }).join(' · ');
    if (p.inFlight) {
      html += `<div><span class="pos">▶ wake #${p.inFlight.wakeId} (${esc(p.inFlight.trigger)})</span> <span class="muted">${fmt(p.inFlight.at)}</span></div>`;
      html += `<div style="margin:4px 0">${showSteps(p.inFlight.steps)}</div>`;
    } else if (p.last) {
      html += `<div>last wake <b>#${p.last.wakeId}</b> (${esc(p.last.trigger)}) <span class="muted">${fmt(p.last.at)} · ${p.last.doneAt ? ((new Date(p.last.doneAt) - new Date(p.last.at)) / 1000).toFixed(1) + 's' : ''}${p.last.summary ? ' · ' + esc(String(p.last.summary.action || p.last.summary.skipped || '')) : ''}</span></div>`;
      html += `<div style="margin:4px 0">${showSteps(p.last.steps)}</div>`;
    } else {
      html += '<span class="muted">no wake recorded yet</span>';
    }
    const b = p.bridge || {};
    html += `<div style="margin-top:6px;border-top:1px solid rgba(42,51,68,.5);padding-top:4px">bridge holder: <b>${esc(b.holder || 'idle')}</b>${b.since ? ` <span class="muted">since ${fmt(b.since)}</span>` : ''}</div>`;
    if ((b.overlaps || []).length) {
      html += `<div class="warn-t" style="margin-top:2px">⚠ overlaps: ${b.overlaps.map((o) => `${esc(o.script)}↔${esc(o.with)} ${fmt(o.at)}`).join(' · ')}</div>`;
    }
    body.innerHTML = html;
  } catch { $('pipeline-body').textContent = 'unavailable'; }
}
setInterval(() => { if (isLoggedIn()) renderPipeline().catch(() => {}); }, 15000);

// ---------------- equity curve + strategy stats (TRD-12 Phase 2) ----------------
// 2026-09-11: the demo series is now the LIVE equity strip — seeded from the
// persisted account history (kind 'account' events, >=30s cadence) and appended
// every second from refreshAccount(), so the curve is finely detailed instead of
// one point per wake. The chart is created ONCE and updated in place (the old
// destroy+recreate re-animated the whole thing every 30s) and with
// maintainAspectRatio:false the canvas fills the 150px .chart-box (it used to
// render at the canvas attribute ratio 300:60 — a thin strip with dead space).
let equityChart = null;
let eqSim = [];
// 2026-09-24: `seedTruncated` carries the SEED's provenance to the panel, so the chart can state
// how deep the series actually goes instead of leaving the reader to infer it from the axis.
const eqState = { live: [], seeded: false, lastAt: 0, windowMs: 7200000, seedTruncated: false, levelBreaks: 0, levelSuppressed: 0, pending: null };

function eqTimeLabel(ms, full) {
  const d = new Date(ms);
  const t = d.toLocaleTimeString('en-GB', { hour12: false });
  if (full) return `${d.toLocaleDateString('en-GB')} ${t}`;
  // 2026-09-24: was `> 86400000`, which left the new 1d window printing bare HH:MM — and at
  // exactly 24h, two ticks a full day apart print the identical label.
  if (!eqState.windowMs || eqState.windowMs >= 86400000) return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })} ${t.slice(0, 5)}`;
  return t.slice(0, 5);
}

// 2026-09-11: drop transitional-frame samples from the PERSISTED history. The
// venue strip occasionally banked a frame where pnl read 0 while equity was
// the PRE-pnl value. The EXACT identity is `equity ≈ a.equity − a.pnl` (the
// balance with the floating P&L stripped) — scale-independent, so it catches
// 2-dollar flickers (eq 4028.46/pnl 0 between 4025.9x/−2.5x pairs) and the
// 110-dollar Sep-9 era alike. The coarse midpoint rule stays as a fallback;
// legitimate flat-book samples (pnl 0 on both sides) are kept.
function eqDespike(points) {
  const out = [];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const a = points[i - 1];
    const b = points[i + 1];
    if (p.y != null && a && b && a.pnl != null && b.pnl != null && p.pnl === 0 && a.pnl !== 0 && b.pnl !== 0) {
      const noPnlEquity = a.y - a.pnl;
      if (Math.abs(p.y - noPnlEquity) <= Math.max(0.5, Math.abs(a.y) * 0.0002)) continue;
      const mid = (a.y + b.y) / 2;
      if (Math.abs(p.y - mid) > Math.max(Math.abs(mid) * 0.0025, 2)) continue;
    }
    out.push(p);
  }
  return out;
}

// Insert a null break point wherever the series jumps over a missing stretch.
function eqWithBreaks(points, gapMs) {
  const out = [];
  for (const p of points) {
    const prev = out.length ? out[out.length - 1] : null;
    if (prev && prev.y != null && p.x - prev.x > gapMs) out.push({ x: prev.x + 1, y: null });
    out.push(p);
  }
  return out;
}

// ★★ 2026-09-30 — A BREAK IN TIME WAS HANDLED; A BREAK IN LEVEL WAS NOT, AND THE OWNER SAW IT.
//
// `eqWithBreaks` refuses to connect two samples separated by a missing STRETCH OF TIME. Nothing refused to
// connect two samples separated by an impossible JUMP IN VALUE, so a 186x discontinuity was drawn as a
// vertical line through the curve — and a single poisoned value at the series' GLOBAL MINIMUM also stretches
// the y-scale, flattening the real curve for every window that contains it.
//
// THE INSTANCE, measured. `EquityTicks` (userId 1, 187,959 rows, 2026-09-11..09-30) holds **12 consecutive
// rows at `equity = 22.28`** (2026-09-29T07:56:00..07:56:56Z) against ~4,149 either side — and 22.28 is the
// MINIMUM OF THE WHOLE TABLE (max 4,159.49). The `account` TradingEvents series carries the same reading.
// The ratio is 4,149.76 / 22.28 = **186.2**, which is the desk's own `account_switch` signature:
// `agent/accountPoller.js` documents this exact value — "the strip then reports a totally different equity
// level (live: 4025 -> 22.28 in one poll)".
//
// AND EVERY GUARD DOWNSTREAM PASSES IT ON PURPOSE:
//   * `isPlausibleSample` returns TRUE for it — `if (isAccountSwitch(acc, prev)) return true;` ("account
//     change — never a strip flicker"). A 186x jump is therefore accepted *because* it is large.
//   * `eqDespike` only bites when `pnl === 0` AND the stripped-balance identity holds; here |22.28 - 4149|
//     is ~4,127, far outside its tolerance, so the point is KEPT.
//   * `eqWithBreaks` sees no time gap at all — the samples are 5 s apart.
// The poller is RIGHT to accept the new level (a real account switch must not leave the desk blind), so the
// fix belongs here: the chart must draw a switch as a GAP, exactly as `eqDecimate` already insists — "removing
// one joins two segments the desk deliberately refused to connect, which is the single thing this chart must
// not do". Neither of these two segments is a lie; the LINE BETWEEN THEM is.
//
// THE THRESHOLD IS THE DESK'S OWN DEFINITION OF "NOT A P&L MOVE", not a new number: `isAccountSwitch` uses
// `ratio < 0.2 || ratio > 5`, so the same test is reused here rather than invented. For scale, the largest
// real hourly swing measured on this desk is 4,159.49 -> 4,013.88 = 3.5%, an order of magnitude inside it.
const EQ_LEVEL_BREAK_LO = 0.2;
const EQ_LEVEL_BREAK_HI = 5;
// A LEVEL THAT PERSISTS IS THE ACCOUNT; A LEVEL THAT FLASHES IS NOT.
// The 2026-09-29 excursion lasted **154 s / 30 samples** and then returned to 4,149 — so it is a visit to
// another account, not this account's equity. Without a persistence rule the two cases are indistinguishable
// at the moment they arrive, and adopting the new level immediately would plot the excursion anyway (samples
// 2..30 of the run agree with sample 1, so a "confirm on the next sample" rule adopts in 5 seconds).
// Ten minutes is the same order as the desk's own wake cadence, so a level that outlives a wake is real.
const EQ_LEVEL_MIN_MS = 10 * 60 * 1000;

function eqIsLevelBreak(prevY, y) {
  const a = Number(prevY), b = Number(y);
  if (!(a > 0) || !(b > 0)) return false;      // a 0/negative equity is a different fault, not this one
  const r = b / a;
  return r < EQ_LEVEL_BREAK_LO || r > EQ_LEVEL_BREAK_HI;
}

// Walk the series, find maximal runs whose LEVEL disagrees with the last established one, and decide per run:
//   * run shorter than EQ_LEVEL_MIN_MS (or still open at the right edge) -> SUPPRESSED: the whole run collapses
//     to a single null marker, and the established level is unchanged. Chart.js scales to every non-null point,
//     so leaving even one of these in would let 30 samples out of 66,099 define the y-axis for the whole series
//     and flatten the real curve — measured: the seed's range is 22.28..4,159.49 while the week's largest real
//     hourly swing is 74.97.
//   * run at least that long -> ADOPTED after a gap: the level becomes the new baseline and its samples plot,
//     so a REAL switch to another account is still shown as a new segment rather than hidden.
// Both branches KEEP A GAP. Nothing is dropped from the record — the readings stay in `EquityTicks`, in the
// `account` event and in the `account_switch` event — and `eqState.levelBreaks`/`suppressed` say so on screen.
function eqBreakOnLevel(points) {
  const out = [];
  let lastReal = null;
  let breaks = 0, suppressed = 0;
  let i = 0;
  while (i < points.length) {
    const p = points[i];
    if (p.y == null) { out.push(p); i += 1; continue; }          // existing gap markers pass through
    if (lastReal && eqIsLevelBreak(lastReal.y, p.y)) {
      // Collect the whole run that disagrees with the established level.
      let j = i;
      while (j < points.length && points[j].y != null && eqIsLevelBreak(lastReal.y, points[j].y)) j += 1;
      const run = points.slice(i, j);
      const runMs = run.length > 1 ? run[run.length - 1].x - run[0].x : 0;
      out.push({ x: p.x, y: null });
      breaks += 1;
      if (runMs < EQ_LEVEL_MIN_MS) {
        // Suppressed: the run contributes ONE gap marker and nothing else. `lastReal` is untouched, so the
        // level on the far side is compared against the level before the excursion — which is what makes the
        // return trip break correctly too.
        suppressed += run.length;
      } else {
        out.push(...run);
        lastReal = run[run.length - 1];
      }
      i = j;
      continue;
    }
    out.push(p);
    lastReal = p;
    i += 1;
  }
  eqState.levelBreaks = breaks;
  eqState.levelSuppressed = suppressed;
  return out;
}

// ---------------- long windows (2026-09-24): 6h / 1d / 3d / 1w ----------------
// The strip grew past 12h, and the fine tick layer banks ~11-16k rows/day. MEASURED on
// 2026-09-24 (EquityTicks, userId 1, 135,375 rows from 2026-09-11): 6h = 2,303 rows, 12h = 4,390,
// 1d = 11,401, 3d = 42,581, 1w = 80,220. Three consequences, all of which had to be handled or
// the new buttons would have shown a confident and wrong chart:
//   1. the seed must reach back 7 days (it asked for 48h);
//   2. the live buffer must not DELETE its oldest points (it did — see eqTrim);
//   3. a week is ~266 points per pixel on this canvas, so the seed is decimated.
const EQ_SEED_HOURS = 168;        // 1w
const EQ_TICK_LIMIT = 200000;     // >= the 80,220 rows a 1w window needs (store clamps at 200k)
const EQ_SEED_BUDGET = 16000;     // decimated seed size; ~53 distinguishable px at 300px wide
const EQ_POINT_CAP = 24000;       // hard ceiling on the in-memory series

// Decimate to a point budget. A uniform STRIDE is used rather than a per-bucket average, because
// each point carries the venue's `pnl` reading and eqDespike reads it per point — averaging would
// fabricate a pnl that no sample ever reported.
// ⚠ NULL GAP MARKERS ARE NEVER DROPPED. Removing one joins two segments the desk deliberately
// refused to connect, which is the single thing this chart must not do.
function eqDecimate(points, budget) {
  if (!Number.isFinite(budget) || budget <= 0 || points.length <= budget) return points;
  const stride = points.length / budget;
  const out = [];
  // ⚠ `next` ACCUMULATES THE IDEAL POSITION; it is not recomputed from the kept index. Measuring
  // the step from the already-rounded index compounds the rounding and silently under-fills the
  // budget — measured at budget 16,000 over 80,220 points it returned 13,371 (16% short), because
  // `i - lastKept >= 5.0137` can only ever fire on an integer step of 6.
  let next = 0;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    if (p.y == null) { out.push(p); continue; }   // gaps are free — they never consume the budget
    if (i >= next) { out.push(p); next += stride; }
  }
  // Anchor the RIGHT edge. Without this the newest seed point can fall inside the last stride and be
  // dropped, leaving the seed's join with the live feed hanging on a hole.
  const last = points[points.length - 1];
  if (last && last.y != null && out[out.length - 1] !== last) out.push(last);
  return out;
}

// ★ THE BUFFER IS A FIXED-SIZE HISTORY, NOT A SLIDING WINDOW (2026-09-24).
// This used to be `if (arr.length > 7200) arr.splice(0, arr.length - 7200)`, which DELETED the
// oldest points. Against a 7200-point live tail that was a trim; against a week-long seed it is
// amnesia — 1d/3d/1w would draw a full-width axis over data that had already been thrown away,
// and the loss is invisible because the right edge is pinned to now (F7).
// Instead, halve the resolution of the OLDEST half and keep the span, so a long window degrades to
// coarser data rather than to missing data. The recent half is never touched, so 30m/2h/6h keep
// full resolution.
function eqTrim(arr, cap) {
  let guard = 0;
  while (arr.length > cap && guard < 32) {
    const keepFrom = Math.floor(arr.length / 2);
    const head = [];
    for (let i = 0; i < keepFrom; i += 1) {
      const p = arr[i];
      if (p.y == null || i % 2 === 0) head.push(p);   // gaps always survive
    }
    const tail = arr.slice(keepFrom);
    arr.length = 0;
    arr.push(...head, ...tail);
    guard += 1;
  }
}

// What the series actually holds, printed next to the chart. The axis is pinned to now, so a window
// wider than the data draws a full-width axis over a partial curve — this is the only thing on
// screen that separates "flat all week" from "we only have two days".
function eqRenderNote() {
  const el = $('eq-span');
  if (!el) return;
  if (!eqState.live.length) { el.textContent = ''; return; }
  const pts = eqState.live.reduce((n, p) => n + (p.y != null ? 1 : 0), 0);
  const heldMs = Date.now() - eqState.live[0].x;
  // ★ THE WARNING IS DERIVED FROM THE DATA, NOT FROM THE SERVER'S FLAG. The defect it guards — a
  // window wider than the series, drawn across a full-width axis because the right edge is pinned
  // to now — is a property of the two spans, so it can be decided locally. It also fires when the
  // desk is simply younger than the window, which is the same lie and worth the same warning, and
  // it keeps working against a server too old to send `truncated` at all.
  const short = eqState.windowMs > 0 && heldMs < eqState.windowMs * 0.95;
  const why = eqState.seedTruncated ? ' (seed clipped at the row cap)' : '';
  el.textContent = [
    short
      ? `⚠ ${(eqState.windowMs / 86400000).toFixed(1)}d window over ${(heldMs / 86400000).toFixed(1)}d held${why}`
      : `${(heldMs / 86400000).toFixed(1)}d held`,
    `${pts.toLocaleString()} pts`,
    // A GAP THAT THE DESK CHOSE IS NOT THE SAME AS A GAP THE DESK COULD NOT READ, so it is named.
    eqState.levelBreaks
      ? `${eqState.levelBreaks} level break${eqState.levelBreaks === 1 ? '' : 's'}${eqState.levelSuppressed ? ` (${eqState.levelSuppressed} sample${eqState.levelSuppressed === 1 ? '' : 's'} withheld)` : ''} — not drawn as a move`
      : '',
  ].filter(Boolean).join(' · ');
  el.title = 'depth and point count of the series behind this chart after seeding and decimation'
    + (short ? ' — the selected window reaches further back than the data, so its LEFT edge is empty' : '')
    + (eqState.seedTruncated ? ' — the seed request hit its row cap' : '')
    + (eqState.levelBreaks
      ? ` — ${eqState.levelBreaks} place(s) where the equity level jumped by more than 5x or under 0.2x. That is the`
        + ' desk\'s own account-switch signature (agent/accountPoller.js isAccountSwitch), not a P&L move, so the'
        + ' curve is broken there instead of being drawn as a vertical line, and an excursion shorter than 10 minutes'
        + ' is withheld from the plot because a level that flashes is not the account. NOTHING IS LOST: every withheld'
        + ' reading is still in EquityTicks, in the account event and in the account_switch event. It is kept out of'
        + ' the SCALE because Chart.js sizes the y-axis to every non-null point, and one excursion let 30 samples out'
        + ' of 66,099 flatten the whole week\'s curve.'
      : '');
}

function eqEnsureChart() {
  if (equityChart || !window.Chart) return;
  const el = $('equity-chart');
  if (!el) return;
  equityChart = new Chart(el, {
    type: 'line',
    data: { datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, normalized: true, parsing: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { labels: { color: '#8b96a8', boxWidth: 12 } },
        tooltip: {
          callbacks: {
            title: (it) => (it.length ? eqTimeLabel(it[0].parsed.x, true) : ''),
            label: (c) => (c.parsed.y == null ? 'no data' : `${c.dataset.label}: ${num(c.parsed.y, 2)}`),
          },
        },
      },
      scales: {
        x: { type: 'linear', ticks: { color: '#8b96a8', maxTicksLimit: 8, callback: (v) => eqTimeLabel(Number(v), false) }, grid: { color: 'rgba(42,51,68,.5)' } },
        y: { grace: '4%', ticks: { color: '#8b96a8', callback: (v) => Number(v).toLocaleString() }, grid: { color: 'rgba(42,51,68,.5)' } },
      },
    },
  });
  // insurance for the created-while-hidden case (tab in background at boot)
  setTimeout(() => { try { equityChart.resize(); } catch { /* */ } }, 250);
}

function eqUpdate() {
  eqRenderNote();
  if (!equityChart) return;
  const xs = equityChart.options.scales.x;
  // F7 (2026-09-12 review): pin the right edge to NOW. Before this the axis
  // auto-fit to the last sample, so a STOPPED feed silently rescaled and looked
  // like a complete chart with no gap.
  const lastX = eqState.live.length ? eqState.live[eqState.live.length - 1].x : 0;
  const right = Math.max(Date.now(), lastX);
  xs.max = right;
  xs.min = eqState.windowMs ? right - eqState.windowMs : undefined;
  const sets = [{
    label: 'demo (live strip)', data: eqState.live, borderColor: '#6ee7b7',
    backgroundColor: 'rgba(110,231,183,.10)', borderWidth: 2, pointRadius: 0, tension: 0.1, fill: true, spanGaps: false,
  }];
  if (eqSim.length) sets.push({ label: 'sim (per wake)', data: eqSim, borderColor: '#7c8cf8', borderWidth: 1.5, pointRadius: 0, tension: 0.15, fill: false, hidden: true });
  equityChart.data.datasets = sets;
  equityChart.update('none');
}

// Live feed from the account strip (refreshAccount).
// ⚠ CADENCE, MEASURED 2026-09-14 (TRD-70): this used to claim "live reads normally land every
// 1s". They did not. The poller loop was `pollOnce(); sleep(1s)` and pollOnce performs two CDP
// round-trips, so the real period was 1s + work — measured over 20s: NINE advances of
// `live.readAt`, mean interval 2.4s, with stalls to ~6s. The loop is now fixed-rate, so it can
// land near 1s, but a consumer must still tolerate a few seconds of a flat value: that is the
// venue strip's cadence, not a fault. Only a LONG gap means the read stopped.
// Missing stretches are marked with a null break point so the chart shows a
// GAP instead of a fabricated connecting line ("no data" stays visibly no
// data). Thresholds: live reads normally land every few seconds, so >90s means the read stopped
// (bridge off); the persisted history alternates ≥30s cadence with per-wake samples (~10 min), so only >20 min means truly missing.
const EQ_LIVE_GAP_MS = 90000;
const EQ_SEED_GAP_MS = 20 * 60 * 1000;
function pushEquityTick(equity) {
  const y = Number(equity);
  if (!Number.isFinite(y)) return;
  const x = Date.now();
  const arr = eqState.live;
  const lastP = arr[arr.length - 1];
  // ⚠ THE LAST ENTRY MAY BE A NULL GAP MARKER (a wake-cadence hole). Levels must be compared against the
  // last REAL sample — comparing against a marker made every following tick look continuous.
  const lastReal = lastP && lastP.y != null ? lastP
    : (arr.length > 1 && arr[arr.length - 2].y != null ? arr[arr.length - 2] : null);

  // ---- A LIVE LEVEL BREAK IS HELD, NOT PLOTTED, UNTIL IT EARNS THE LEVEL (same rule as eqBreakOnLevel) ----
  // The owner flipping the Plus500 tab between accounts is exactly the live case the poller's comment
  // describes, so it cannot be handled only in the seed. A breaking reading is parked in `pending` rather
  // than drawn: if the level returns before EQ_LEVEL_MIN_MS the excursion becomes ONE gap marker (nothing
  // plotted, nothing lost — the reading is still in EquityTicks and the account/account_switch events); if it
  // persists, the buffer is flushed after a gap and becomes the new baseline, so a real switch still shows.
  const pend = eqState.pending;
  if (pend) {
    if (!eqIsLevelBreak(pend.from, y)) {
      arr.push({ x: pend.at, y: null });              // the excursion ended: one honest gap
      eqState.levelBreaks += 1;
      eqState.levelSuppressed += pend.samples.length;
      eqState.pending = null;
    } else {
      pend.samples.push({ x, y });
      if (x - pend.at >= EQ_LEVEL_MIN_MS) {           // it persisted: this IS the account now
        arr.push({ x: pend.at, y: null });
        arr.push(...pend.samples);
        eqState.levelBreaks += 1;
        eqState.pending = null;
      }
      const lab0 = $('eq-latest'); if (lab0) lab0.textContent = num(y, 2);
      return;
    }
  } else if (lastReal && eqIsLevelBreak(lastReal.y, y)) {
    eqState.pending = { from: lastReal.y, at: x, samples: [{ x, y }] };
    const lab0 = $('eq-latest'); if (lab0) lab0.textContent = num(y, 2);
    return;
  }

  if (lastReal === lastP && x - lastP.x < 700) { lastP.x = x; lastP.y = y; }
  else {
    if (lastP && lastP.y != null && x - lastP.x > EQ_LIVE_GAP_MS) arr.push({ x: lastP.x + 1, y: null });
    arr.push({ x, y });
  }
  eqTrim(arr, EQ_POINT_CAP);
  const lab = $('eq-latest');
  if (lab) lab.textContent = num(y, 2);
  if (Date.now() - eqState.lastAt >= 2000) {
    eqState.lastAt = Date.now();
    eqEnsureChart();
    eqUpdate();
  }
}

async function renderEquity() {
  try {
    if (!eqState.seeded) {
      try {
        // 2026-09-24: hours=48 -> EQ_SEED_HOURS (168) and an explicit tickLimit. The endpoint's
        // `limit` is the COARSE events cap (4000); ticks have their own, larger one, and before
        // this the route never forwarded one — so a 1w window would have been silently served
        // as the newest 40,000 ticks (~2.4 days), with no signal that the left edge was missing.
        const live = await apiGet(`/api/trading/equity/live?hours=${EQ_SEED_HOURS}&tickLimit=${EQ_TICK_LIMIT}`);
        // 2026-09-11: the seed now has TWO sources — persisted fine ticks
        // (<=5s, the series of record) and the older 30s account events that
        // fill the span before the first tick. Each gets its own gap rule so
        // the event era isn't chopped into confetti (wake-cadence gaps there
        // are normal) while tick holes (>90s = poller off) break honestly.
        const evPts = ((live.events || live.items) || []).filter((r) => r.equity != null)
          .map((r) => ({ x: new Date(r.createdAt).getTime(), y: Number(r.equity), pnl: r.pnl == null ? null : Number(r.pnl) }))
          .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
        const tkPts = (live.ticks || []).filter((r) => r.equity != null)
          .map((r) => ({ x: new Date(r.at).getTime(), y: Number(r.equity), pnl: r.pnl == null ? null : Number(r.pnl) }))
          .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
        const raw = eqBreakOnLevel(eqWithBreaks(eqDespike(evPts), EQ_SEED_GAP_MS).concat(eqWithBreaks(eqDespike(tkPts), EQ_LIVE_GAP_MS)));
        // Decimate the SEED only. Live-following points stay full resolution, so 30m/2h/6h are
        // unaffected by the 1w budget.
        const seed = eqDecimate(raw, EQ_SEED_BUDGET);
        eqState.live = seed.concat(eqState.live);
        eqState.seedTruncated = !!(live.truncated && live.truncated.ticks);
        eqState.seeded = true;
      } catch { /* retry on the next cycle */ }
    }
    const [sim, stats] = await Promise.all([
      apiGet('/api/trading/equity?mode=sim&limit=500').catch(() => ({ items: [] })),
      apiGet('/api/trading/analytics/strategies?week=1'),
    ]);
    eqSim = (sim.items || []).map((r) => ({ x: new Date(r.capturedAt).getTime(), y: Number(r.equity) }));
    eqEnsureChart();
    eqUpdate();
    // 2026-09-12 (user-reported crop): the fixed 90/100/100/80px cells + a flex:1
    // trailing cell needed 543px in a 279px column, so `exp/hold/MFE/MAE` was
    // clipped and the panel scrolled sideways. Wrapping rows now.
    // ★ THE WINDOW IS ON THE CARD, not only in the request. A win rate with no window attached is the
    // number the reader assumes matches whatever they already had in mind, and this card used to say
    // nothing while showing 30 days. The label is built from the SERVER's window report, so the two cannot
    // disagree about what was measured.
    const winLabel = (stats.window && stats.window.label) ? stats.window.label : 'window unknown';
    $('strategy-stats-body').innerHTML = (stats.strategies || []).length
      ? `<div class="muted" style="font-size:11px;margin-bottom:2px">win rate — ${esc(winLabel)}</div>`
        + (stats.strategies || []).map((s) => `<div class="row">
          <div class="row-top">
            <b>${esc(s.strategy)}</b>
            <span>${s.trades} trades</span>
            <span class="${s.winRate >= 50 ? 'pos' : 'neg'}">WR ${s.winRate}%</span>
            <span class="${s.totalPnl >= 0 ? 'pos' : 'neg'}">P&L ${num(s.totalPnl)}</span>
            <span class="muted">PF ${s.profitFactor}</span>
          </div>
          <div class="row-note">exp ${num(s.expectancy)} · hold ${s.avgHoldingMin}m · MFE ${s.avgMfePct}% · MAE ${s.avgMaePct}%</div>
        </div>`).join('')
      : `<span class="muted">no closed trades in ${esc(winLabel)} — strategy stats appear after the first exits</span>`;
    $('drift-flags').innerHTML = (stats.flags || []).map((f) => `<div class="warn-t" style="font-size:12px">⚠ drift: ${esc(f.strategy)} live WR ${f.liveWinRate}% vs backtest ${f.backtestWinRate}%</div>`).join('');
    // F18 (2026-09-12 review, bible §3): the chart's series must exist in the DOM.
    const tbl = $('equity-table');
    if (tbl) {
      const body = tbl.querySelector('tbody');
      const samples = eqState.live.filter((p) => p.y != null).slice(-40).reverse();
      body.innerHTML = samples.length
        ? samples.map((p) => `<tr><td>${esc(fmt(new Date(p.x).toISOString()))}</td><td>${num(p.y, 2)}</td></tr>`).join('')
        : '<tr><td colspan="2">no samples captured yet</td></tr>';
    }
  } catch { $('strategy-stats-body').textContent = 'unavailable'; }
}
setInterval(() => { if (isLoggedIn()) renderEquity().catch(() => {}); }, 30000);

// ---------------- white paper (TRD-12 Phase 2) ----------------
// F9 (2026-09-18): the white paper is the densest panel on the desk and it was rendering RAW MARKDOWN —
// `**2026-2027 Yearly Strategic Baseline**` — because the model is asked for plain text and writes markdown
// anyway. ESCAPE FIRST, then promote only the three tokens that appear in practice (bold, `#` heading,
// bullets): a formatter must never become an injection path, and an unrecognised token stays visible text
// rather than being silently dropped.
function mdLite(md) {
  return esc(String(md || ''))
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/^\s*#{1,6}\s*(.+)$/gm, '<b>$1</b>')
    .replace(/^\s*[-*]\s+(.+)$/gm, '· $1')
    .replace(/\n{2,}/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

async function renderWhitepaper() {
  try {
    const d = await apiGet('/api/trading/whitepaper');
    const body = $('whitepaper-body');
    if (!body) return;
    // F5 (2026-09-22): IS THIS PAPER DESCRIBING THE DESK AS IT IS NOW?
    // The paper is written FROM `deskFacts`, which leads with the mode, the kill tier and the enabled
    // strategies — so those are the facts it makes claims about, and the producer now records the values it
    // saw (`payload.book`). Comparing them against the live shared state turns "is this superseded?" from a
    // judgement about the paper's AGE into a comparison it can actually answer.
    //
    // ⚠ WHAT THIS DOES NOT CHECK. The paper's prose may assert things about price levels, sessions or
    // positions that have since moved; nothing here reads the prose. So the mark means "the book it was
    // written under has changed", not "every claim in this text is now wrong" — and it says exactly that,
    // rather than claiming the stronger thing. Equally, when `book` is ABSENT (papers written before this
    // change) the panel says the paper predates book tracking instead of reporting "no change": an
    // uncompared paper is not a superseded one, but it is not a verified-current one either.
    const liveBook = { mode: state.mode, killTier: state.killTier, enabled: (state.strategiesEnabled || []).slice().sort() };
    // ⚠ COMPARE ONLY WHAT IS ACTUALLY KNOWN. A field the page has not read yet is `null`/undefined here, and
    // a blind `!==` would call that a CHANGE — reporting SUPERSEDED on every paper every time the page loads
    // before its first /state and /kill responses land. This is the same defect shape as the `disabled` claim
    // made from a 401: a missing value coerced into the confident branch. So each field is compared only when
    // its live value has been read, the count of compared fields is tracked, and a paper that could not be
    // compared at all gets its own verdict instead of silently passing as current.
    const bookDrift = (book) => {
      if (!book) return { known: false, compared: 0, changed: [] };
      const changed = [];
      let compared = 0;
      if (state.killTier != null) { compared++; if (book.killTier !== liveBook.killTier) changed.push(`kill tier ${book.killTier} -> ${liveBook.killTier}`); }
      if (liveBook.mode != null) { compared++; if ((book.mode || null) !== liveBook.mode) changed.push(`mode ${book.mode} -> ${liveBook.mode}`); }
      if ((state.strategiesEnabled || []).length || (book.enabled || []).length) {
        compared++;
        const was = (book.enabled || []).join('+') || 'none';
        const now = liveBook.enabled.join('+') || 'none';
        if (was !== now) changed.push(`strategies ${was} -> ${now}`);
      }
      return { known: true, compared, changed };
    };
    const order = ['yearly', 'monthly', 'weekly'];
    const parts = [];
    for (const tier of order) {
      const w = d.latest && d.latest[tier];
      if (!w) { parts.push(`<div style="margin-bottom:6px"><b>${tier}</b> <span class="muted">not generated yet</span></div>`); continue; }
      const drift = bookDrift(w.book);
      const mark = !drift.known
        ? ' <span class="chip soft" title="written before the paper recorded the book it described, so it cannot be compared against the live desk">book unrecorded</span>'
        : !drift.compared
          ? ' <span class="chip muted" title="the live mode, kill tier and strategy list have not been read yet, so nothing can be compared — this is not the same as the book being unchanged">book not comparable yet</span>'
          : drift.changed.length
            ? ` <span class="chip hard" title="the paper was written under a different desk: ${esc(drift.changed.join('; '))}">SUPERSEDED — ${esc(drift.changed.join('; '))}</span>`
            : ` <span class="chip open" title="${drift.compared} of 3 book facts compared; all unchanged since this paper was written">matches live book (${drift.compared}/3)</span>`;
      parts.push(`<div style="margin-bottom:6px"><b>${tier} (${esc(w.period)})</b> <span class="muted">${fmt(w.at)} · ${ageLabel(w.at)}</span>${mark}<div class="muted">${mdLite(String(w.text).slice(0, 700))}</div></div>`);
    }
    body.innerHTML = parts.join('');
  } catch { $('whitepaper-body').textContent = 'unavailable'; }
}
// Fire once at load, not only on the interval. This panel was reachable ONLY from a 60s tick, so for the
// first minute after every page load it showed `—` — a read-only surface that is blank when first looked at
// is the same problem as being behind curl, just quieter. (TRD-UI-3, 2026-09-22.)
if (isLoggedIn()) renderWhitepaper().catch(() => {});
setInterval(() => { if (isLoggedIn()) renderWhitepaper().catch(() => {}); }, 60000);

// ---------------- token budget (TRD-12 Phase 2) ----------------
async function renderBudget() {
  try {
    const d = await apiGet('/api/trading/budget');
    const body = $('budget-body');
    if (!body) return;
    // TRD-96: an UNCAPPED consumer used to render as "(0%)" because the old summary sent cap 0 with
    // pct 0 — the same output as a consumer that never runs. An uncapped consumer has no denominator,
    // so it says so and is styled as a warning: it is bounded only by the total cap.
    const rows = (d.consumers || []).map((c) => {
      const cls = c.uncapped ? 'warn-t' : c.pct >= 100 ? 'neg' : c.pct >= 80 ? 'warn-t' : 'muted';
      const right = c.uncapped ? `${c.used}/∞ <span class="chip open">UNCAPPED</span>` : `${c.used}/${c.cap} (${c.pct}%)`;
      return `<span class="b-k mono">${esc(c.consumer)}</span><span class="${cls}">${right}</span>`;
    }).join('');
    // FOUND 2026-09-18 while verifying TRD-96, same class as it: the chip was rendered from the mere
    // PRESENCE of boostUntil, so a boost that expired on 2026-09-10 was still advertised 8 days later
    // while every cap in the very same panel was computed at 1x (budget.capFor tests the timestamp
    // against now). The panel said 3x and meant 1x. Expiry is now stated, not implied.
    const boostAt = d.settings.boostUntil ? new Date(d.settings.boostUntil) : null;
    const boostChip = !boostAt ? ''
      : boostAt.getTime() > Date.now()
        ? ` <span class="chip open">BOOST until ${fmt(d.settings.boostUntil)}</span>`
        : ` <span class="chip muted" title="the 3x boost has expired — the caps shown here are the declared daily caps, not 3x">BOOST expired ${fmt(d.settings.boostUntil)}</span>`;
    body.innerHTML = rows + `<span class="b-k">total today</span><span><b>${d.usage.total}</b> / ${d.settings.totalDaily}${boostChip}</span>`;
    if (!$('budget-total').dataset.loaded) {
      $('budget-total').value = d.settings.totalDaily;
      $('budget-total').dataset.loaded = '1';
      if (d.settings.boostUntil) $('budget-boost').value = toLocalInput(d.settings.boostUntil);
    }
  } catch { /* optional */ }
}
setInterval(() => { if (isLoggedIn()) renderBudget().catch(() => {}); }, 30000);

// ---------------- AI self-tuning (Phase 2 of implied goal) ----------------
async function refreshTuner() {
  const stateEl = $('tuner-state');
  const adj = $('tuner-adjustments');
  if (!stateEl || !adj) return;
  try {
    const t = await apiGet('/api/trading/tuner');
    const cfg = t.config || {};
    if ($('tuner-enabled') && !$('tuner-enabled').dataset.loaded) {
      $('tuner-enabled').checked = cfg.enabled === true;
      if ($('tuner-interval')) $('tuner-interval').value = Number(cfg.intervalHours) || 24;
      $('tuner-enabled').dataset.loaded = '1';
    }
    stateEl.textContent = `· enabled ${cfg.enabled === true ? 'yes' : 'no'} · interval ${cfg.intervalHours || 24}h · parity ${t.parityValidated ? 'validated (live ok)' : 'NOT validated (sim-only)'} · last ${t.last ? fmt(t.last.at) : 'never'}`;
    const h = await apiGet('/api/trading/tuner/history');
    const items = h.items || [];
    if (!items.length) { adj.innerHTML = '<div>no AI adjustments yet</div>'; return; }
    const lines = [];
    for (const ev of items) {
      if (ev.skipped) {
        lines.push(`<div class="muted">${fmt(ev.at)} — skipped: ${esc(ev.skipped)}</div>`);
        continue;
      }
      for (let i = 0; i < ev.changes.length; i++) {
        const c = ev.changes[i];
        const bits = [];
        if (c.params) {
          const diff = Object.keys(c.params.after || {}).filter((k) => Number(c.params.after[k]) !== Number(c.params.before && c.params.before[k]));
          if (diff.length) bits.push('params: ' + diff.map((k) => `${k} ${num(c.params.before[k], 4)}→${num(c.params.after[k], 4)}`).join(', '));
        }
        if (c.enabled) bits.push(`enabled ${c.enabled.before}→${c.enabled.after}`);
        // ★ TRD-TUN-1 (2026-09-29): A DRY RUN APPLIED NOTHING, SO THERE IS NOTHING TO REVERT. This button used to
        // be offered on proposals that were never executed, and clicking it wrote the proposal's stale
        // before-values into live settings while logging an ordinary `tune_revert`. The server now refuses, but a
        // control that can only fail should not be offered at all — and naming the row as a proposal is the
        // honest label.
        const dry = ev.dryRun === true;
        lines.push(`<div><b>${esc(c.strategy)}</b> <span class="mono">${esc(bits.join(' · ') || 'no-op')}</span> <span class="muted">${fmt(ev.at)} · ${esc(c.reasoning || '')}</span> `
          + (dry
            ? '<span class="muted" title="a dry run wrote nothing, so there is nothing to undo">proposal — never applied</span>'
            : `<button class="small secondary" data-revert="${ev.eventId}" data-idx="${i}">Revert</button>`)
          + '</div>');
      }
    }
    adj.innerHTML = lines.join('');
    adj.querySelectorAll('[data-revert]').forEach((b) => {
      b.onclick = async () => {
        try {
          await apiPost('/api/trading/tuner/revert', { eventId: Number(b.dataset.revert), index: Number(b.dataset.idx) });
          feedback($('tuner-feedback'), 'reverted — reverted change restored');
          await refreshTuner(); await refreshStrategies();
        } catch (e) { feedback($('tuner-feedback'), e.message, false); }
      };
    });
  } catch { /* tab may be loading */ }
}

// TRD-UI-1 (2026-09-22): THE THREE SELF-CHECKS AS BUTTONS.
//
// WHY THEY WERE SCRIPTS ONLY. `GET /ping` is mounted with `ifToken`, so its liveness half is public and
// the SQL / model / bridge half needs a token — which meant the only way to ask "is the bridge actually
// working?" was curl. The bridge is the SHARED Chrome tab the desk drives, so that is the question an
// operator asks BEFORE trusting a capture, and it should not need a shell.
//
// ⚠ EACH BUTTON REPORTS THE RAW CHECK, NOT A PASS/FAIL SUMMARY. The detail is the part that says WHY,
// and the distinction it carries is one this desk has already paid for: a model key answering 402 is a
// credit problem, not a broken key, and "a seat abstaining on credit rendered exactly like a seat with
// nothing to say" (TRD-94). A one-word verdict would throw that away and buy a green tick with it.
const PING_PATHS = {
  sql: { method: 'get', path: '/api/trading/ping', label: 'self-check' },
  model: { method: 'post', path: '/api/trading/ping/deepseek', label: 'model' },
  bridge: { method: 'post', path: '/api/trading/ping/browser', label: 'bridge' },
};

function pingRow(name, c) {
  if (!c) return `<div><b>${esc(name)}</b> <span class="muted">unchecked</span></div>`;
  // ⚠ THREE STATES, NOT TWO — and the third one is why this is not `c.ok ? ... : ...`.
  //
  // The bridge probe is ASYNCHRONOUS: `POST /ping/browser` answers `{status:'started'}` and `GET /ping`
  // returns the cached probe as `{status:'running'}`, BOTH WITH NO `ok` FIELD AT ALL. Rendering an absent
  // `ok` as failure prints "NOT ok" for a probe that simply has not finished yet — measured on the live
  // server 2026-09-22, where all three routes answered 200 and `checks.browser` was `{status:'started'}`.
  // A button that cries wolf on its first press teaches the operator to ignore the button.
  const state = c.ok === true ? 'ok' : c.ok === false ? 'NOT ok' : 'pending';
  const cls = state === 'ok' ? 'pos' : state === 'pending' ? 'muted' : 'neg';
  const detail = c.status ? `${c.status}${c.detail ? ' — ' + c.detail : ''}` : (c.detail || '');
  return `<div><b>${esc(name)}</b> <b class="${cls}">${state}</b> `
    + `<span class="muted">${esc(String(detail).slice(0, 220))}</span></div>`;
}

async function testPing(which) {
  const spec = PING_PATHS[which];
  const fb = $('ping-feedback');
  const out = $('ping-result');
  if (!spec || !out) return;
  if (fb) fb.textContent = `checking ${spec.label}…`;
  try {
    const r = spec.method === 'get' ? await apiGet(spec.path) : await apiPost(spec.path, {});
    // The combined self-check answers with all three at once; the two POSTs answer with their own.
    if (which === 'sql') {
      const c = (r && r.checks) || {};
      out.innerHTML = pingRow('SQL', c.sql) + pingRow('model', c.deepseek) + pingRow('bridge', c.browser);
    } else {
      out.innerHTML = pingRow(spec.label, r);
    }
  } catch (e) {
    out.innerHTML = `<span class="neg">${esc(String((e && e.message) || e))}</span>`;
  } finally {
    if (fb) fb.textContent = '';
  }
}

// TRD-UI-3 (2026-09-22): THE CAN-TRADE LIST, VISIBLE WITHOUT HOVERING.
//
// The header chip already carries this in a `title`, so it is invisible until the pointer happens to rest
// on it — and it is the answer to "what can this desk actually do?", the question asked every time a wake
// does nothing. The distinction it must not lose: an EXPLICIT empty scope means the symbol can never enter
// (that is how a symbol is RETIRED), which is NOT the same as "no scope configured, so it inherits the
// global list". A list showing only the enabled strategies would overstate the desk.
const canTradeUniverse = (settings) => {
  const enabled = (settings && settings.strategies && settings.strategies.enabled) || [];
  const scope = (settings && settings.strategies && settings.strategies.symbolScope) || {};
  const rows = Object.entries(scope)
    .filter(([sym]) => sym !== 'others' && sym !== '*')
    .map(([sym, list]) => ({ symbol: sym, strategies: Array.isArray(list) ? list : [] }));
  const def = scope.others || scope['*'];
  return { enabled, rows, def: Array.isArray(def) ? def : null };
};

async function refreshCanTrade() {
  const el = $('cantrade-body');
  if (!el) return;
  try {
    const settings = await apiGet('/api/trading/settings');
    const st = $('cantrade-state');
    const { enabled, rows, def } = canTradeUniverse(settings);
    const canEnter = rows.filter((r) => r.strategies.length > 0);
    if (st) st.textContent = `${canEnter.length} of ${rows.length} can enter · enabled: ${enabled.join('+') || 'NONE'}`;
    if (!rows.length) {
      el.innerHTML = '<span class="muted">no per-symbol scope stored — every symbol inherits the global list</span>';
      return;
    }
    const body = rows.map((r) => {
      const can = r.strategies.length > 0;
      const badge = can ? `<b class="pos">${esc(r.strategies.join('+'))}</b>` : '<b class="muted">cannot enter</b>';
      return `<tr><td>${esc(r.symbol)}</td><td>${badge}</td>`
        + `<td class="muted">${can ? '' : 'empty scope — retired, not merely unconfigured'}</td></tr>`;
    }).join('');
    el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Symbol</th><th>May enter via</th><th></th></tr></thead>'
      + `<tbody>${body}</tbody></table></div>`
      + `<div class="muted" style="margin-top:6px">default for unlisted: ${esc(def ? JSON.stringify(def) : 'the global enabled list')}</div>`;
  } catch {
    // Say it in the HEADING as well as the body — and never draw an empty list, because an empty list reads
    // as "no symbol can trade" when the truth is "this panel could not read the answer". This panel exists to
    // answer "can it trade?", so answering wrongly is worse here than not answering.
    const st = $('cantrade-state');
    if (st) st.textContent = 'settings unreadable';
    el.innerHTML = '<span class="warn-t">could not read the settings — the tradable universe is <b>UNKNOWN</b> '
      + 'here, not empty.</span>';
  }
}

// TRD-UI-3 (2026-09-22): SHADOW SURFACES, SHOWN AS DISABLED.
//
// The audit's instruction was specific — expose these two reads "in Strategy, showing `disabled`", because
// both are switched off in `strategies.enabled` today, "so an empty panel would lie about why there is
// nothing there". A blank table reads as "nothing happened"; `disabled` reads as "nothing is SCHEDULED to
// happen", and only one of those is true. That difference is the whole point of the panel.
// labels are the registry's own `name` values (strategies/multiFactor.js:126, strategies/congress.js:133) —
// NOT invented here, so the screen cannot drift from the registry or name a strategy something it is not.
const SHADOW_SURFACES = [
  { id: 'multi', label: 'Equities Multi-Factor', note: 'shadow-only ranking — it never trades' },
  { id: 'congress', label: 'Congress Buys (Quiver)', note: 'politician-activity signal' },
];

async function refreshShadowSurfaces() {
  const el = $('shadow-body');
  if (!el) return;
  try {
    const settings = await apiGet('/api/trading/settings').catch(() => null);
    const st = $('shadow-state');
    // ⚠ UNREADABLE IS NOT DISABLED. This panel claims to say WHY there is nothing to show, so it must not
    // answer that question when it could not read the answer. A failed settings fetch (`enabled` falls back to
    // [] here) would have rendered both surfaces as `disabled` — a confident statement about configuration
    // made from an authentication error. Observed live: every Strategy route returned 401 while the app shell
    // still loaded, so this is the DEFAULT state of a stale or signed-out tab, not an edge case.
    if (!settings || !settings.strategies) {
      if (st) st.textContent = 'settings unreadable';
      el.innerHTML = '<span class="warn-t">could not read <code>strategies.enabled</code> — whether these are '
        + 'enabled is <b>UNKNOWN</b>, not off. An unreadable setting is not a disabled one.</span>';
      return;
    }
    const enabled = settings.strategies.enabled || [];
    // Post the reads INDEPENDENTLY of the settings read, so a surface that did produce a signal still shows
    // when it last did even if the settings call fails.
    const [m, c] = await Promise.all([
      apiGet('/api/trading/multi').catch(() => null),
      apiGet('/api/trading/congress').catch(() => null),
    ]);
    const latestOf = { multi: m && m.latest, congress: c && (c.latestPull || c.latestSignal) };
    const readOk = { multi: m !== null, congress: c !== null };
    const on = SHADOW_SURFACES.filter((s) => enabled.includes(s.id)).length;
    if (st) st.textContent = `${on} of ${SHADOW_SURFACES.length} enabled`;
    el.innerHTML = SHADOW_SURFACES.map((s) => {
      const isOn = enabled.includes(s.id);
      const last = latestOf[s.id];
      const when = last && last.createdAt ? fmt(last.createdAt) : (readOk[s.id] ? 'never recorded' : 'read failed');
      return `<div><b>${esc(s.label)}</b> <b class="${isOn ? 'pos' : 'muted'}">${isOn ? 'enabled' : 'disabled'}</b> `
        + `<span class="muted">${isOn ? '' : 'not in <code>strategies.enabled</code>, so nothing schedules it · '}`
        + `last ${esc(when)} · ${esc(s.note)}</span></div>`;
    }).join('');
  } catch {
    const st2 = $('shadow-state');
    if (st2) st2.textContent = 'render failed';
    el.innerHTML = '<span class="warn-t">could not render the shadow surfaces — their state is <b>UNKNOWN</b>, '
      + 'not off.</span>';
  }
}

// TRD-UI-3 (2026-09-22): THE DIGEST THE CHAIRS READ — the audit's wording was "Expose in Health; it is what
// the chairs actually read". It is the desk's own summary of itself, so it decides what deliberation SEES.
// `payload` may arrive parsed or as a raw string depending on the reader, so both are handled.
async function refreshDigest() {
  const el = $('digest-body');
  const st = $('digest-state');
  if (!el) return;
  try {
    const d = await apiGet('/api/trading/digest');
    if (!d || d.id == null) {
      if (st) st.textContent = 'never recorded';
      el.innerHTML = '<span class="muted">no digest recorded — nothing has written one yet</span>';
      return;
    }
    // THE SHAPE IS THE PRODUCER'S, not a guess: waker.js:203 writes exactly
    // `{ date, bullets[], stats, actor? }`. There is no `text`/`summary` field — reading for one would have
    // reported "no readable text" on a digest that is perfectly readable, which is the same class of error as
    // inventing a label. `bullets` is the content.
    let p = d.payload;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch { /* keep the raw string */ } }
    const bullets = (p && Array.isArray(p.bullets)) ? p.bullets : [];
    const stats = (p && p.stats) || null;
    // `actor` is present ONLY when the LLM actually wrote the bullets (waker.js:202 spreads it
    // conditionally). Its ABSENCE is the finding: the digest the chairs read is the three canned fallback
    // lines, not an LLM read. The desk's own midnight digest says so with a MISSING field, so a screen that
    // did not render the absence would present a fallback as a digest.
    const llmWritten = !!(p && p.actor);
    if (st) st.textContent = `${p && p.date ? p.date : 'undated'} · ${llmWritten ? 'LLM-written' : 'FALLBACK text'} · ${bullets.length} bullet${bullets.length === 1 ? '' : 's'}`;
    const head = `event ${esc(fmt(d.createdAt))}`
      + `${p && p.date ? ` · digest day ${esc(p.date)}` : ''}`;
    const flag = llmWritten
      ? ` written by <b class="pos">${esc(p.actor)}</b>`
      : ` <b class="warn-t">no actor field — these are the canned fallback bullets, not an LLM digest</b>`;
    if (!bullets.length) { el.innerHTML = '<span class="muted">the event exists but carries no bullets array</span>'; return; }
    const rows = stats ? Object.entries(stats)
      .filter(([k, v]) => k !== 'prices' && v != null)
      .map(([k, v]) => `<span class="chip soft" style="margin:1px 2px">${esc(k)}: ${esc(String(v))}</span>`).join(' ') : '';
    el.innerHTML = `<div class="muted" style="margin-bottom:4px">${head}${flag}</div>`
      + `<ul style="margin:4px 0 6px 18px;padding:0">${bullets.map((b) => `<li>${esc(String(b))}</li>`).join('')}</ul>`
      + (rows ? `<div>${rows}</div>` : '')
      + (stats && stats.prices ? `<div class="muted" style="margin-top:4px">prices: ${esc(Object.entries(stats.prices).map(([k, v]) => `${k} ${v}`).join(', '))}</div>` : '');
  } catch {
    // ⚠ "never recorded" and "could not read it" must not collapse. The panel's first branch says no digest has
    // ever been written; saying that from a failed fetch would report the desk as having no digest when it has
    // one and the tab simply is not authenticated.
    if (st) st.textContent = 'unreadable';
    el.innerHTML = '<span class="warn-t">could not read the digest — whether one exists is <b>UNKNOWN</b>. '
      + 'This is not the same as "never recorded".</span>';
  }
}

// ---------------- self-health tab (Phase 1 of implied goal) ----------------
// TRD-UI-1 (2026-09-22): THE CALENDAR THE SESSION GUARD READS.
//
// WHY THIS VIEW IS NOT COSMETIC. The session guard REFUSES ENTRIES on a stored event, so the stored
// events ARE the reason the desk will not trade on a given day. With no view, that refusal arrived with
// no visible cause: the operator sees "market closed" and has nothing to check it against.
//
// ⚠ AND IT STATES WHAT IT DOES NOT COVER. `calendar.importCalendar` reads federalreserve.gov, so the
// stored rows are FOMC meeting days and nothing else — CPI and NFP are NOT covered, which the module says
// in its own header. A calendar that LOOKED complete while missing the two releases that move rates most
// would be worse than no calendar, because it would be trusted. The empty-state text says the same thing.
async function refreshCalendar() {
  const el = $('calendar-body');
  const st = $('calendar-state');
  if (!el) return;
  try {
    const r = await apiGet('/api/trading/calendar?days=14');
    const items = Array.isArray(r && r.items) ? r.items : [];
    if (st) {
      const srcs = [...new Set(items.map((x) => x.source).filter(Boolean))].join(', ');
      st.textContent = items.length
        ? `${items.length} event(s) in the next 14 days${srcs ? ` · source ${srcs}` : ''}`
        : 'nothing stored in the next 14 days';
    }
    if (!items.length) {
      el.innerHTML = '<span class="muted">no stored events — the guard will refuse nothing on a calendar basis.'
        + ' Import FOMC dates, and note that CPI / NFP are NOT covered by that source.</span>';
      return;
    }
    const rows = items.map((e) => '<tr>'
      + `<td>${esc(String(e.eventDate).slice(0, 10))}</td>`
      + `<td>${esc(e.eventType || '—')}</td>`
      + `<td>${esc(e.note || '—')}</td>`
      + `<td>${esc(e.symbol || '*')} <span class="muted">${esc(e.source || '')}</span></td>`
      + '</tr>').join('');
    el.innerHTML = '<div class="table-wrap"><table><thead><tr>'
      + '<th>Date</th><th>Type</th><th>Note</th><th>Symbol / source</th>'
      + `</tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch { el.textContent = 'unavailable'; }
}

async function importCalendarFromVenue() {
  const fb = $('calendar-feedback');
  if (fb) fb.textContent = 'importing…';
  try {
    const r = await apiPost('/api/trading/calendar/import', { days: 7 });
    if (fb) fb.textContent = `imported ${r && r.imported != null ? r.imported : '?'} event(s)`;
    await refreshCalendar();
  } catch (e) {
    if (fb) fb.textContent = String((e && e.message) || e);
  }
}

async function refreshHealth() {
  const statusEl = $('health-status');
  const lastEl = $('health-last');
  const body = $('health-body');
  if (!statusEl || !body) return;
  try {
    const r = await apiGet('/api/trading/self-health');
    const s = r.latest;
    if (!s) {
      statusEl.textContent = '—'; statusEl.className = 'chip muted';
      lastEl.textContent = 'never run';
      body.innerHTML = '<div class="muted">no self-health snapshot yet — click Run now</div>';
      state.healthSince = null;
      return;
    }
    const tone = s.status === 'bad' ? 'rejected' : s.status === 'warn' ? 'soft' : 'open';
    // TRD-UI-9 (A) 2026-10-03: a live region announces on EVERY DOM write — including a same-text
    // rewrite. The chip and the banner below therefore update only when their text CHANGES; otherwise
    // the health poll re-read the whole degraded block to a screen reader every cycle (the NVDA
    // listen-through captured ~7 full re-reads in one sitting).
    const healthChipTxt = s.status.toUpperCase();
    if (statusEl.textContent !== healthChipTxt) statusEl.textContent = healthChipTxt;
    statusEl.className = 'chip ' + tone;
    lastEl.textContent = 'last run ' + fmt(s.at) + ` · ${s.bad} bad / ${s.warn} warn` + (s.standing ? ` / ${s.standing} standing` : '');
    // P1-12 (2026-09-10): owner-visible degradation banner — the desk tells
    // the owner the moment self-health leaves 'ok', never silent.
    // TRD-UI-9 (A) 2026-10-03: …but the write happens ONLY when the composed text changed (see the
    // chip note above) — the banner is a role=status live region and used to re-announce in full on
    // every 15s poll while the desk was degraded.
    const banner = $('health-banner');
    if (banner) {
      const offenders = s.status === 'ok' ? '' : (s.checks || []).filter((c) => c.status !== 'ok' && !c.standing)
        .map((c) => `${esc(c.label)}: ${esc(c.detail || '')}`).join(' · ');
      const bannerHtml = offenders
        ? `<span class="chip ${tone}">DESK DEGRADED (${esc(s.status.toUpperCase())})</span><span style="font-size:12px">${offenders.slice(0, 500)}</span>`
        : '';
      if (banner.dataset.sig !== bannerHtml) {
        banner.dataset.sig = bannerHtml;
        banner.classList.toggle('hidden', !bannerHtml);
        banner.innerHTML = bannerHtml;
      }
    }
    // Cards (v2) + run-history dots.
    const history = await apiGet('/api/trading/events?kind=self_health&limit=10').catch(() => null);
    const dots = history && Array.isArray(history.items)
      ? [...history.items].reverse().map((e) => {
        const st = e.payload && e.payload.status;
        const t = st === 'bad' ? 'rejected' : st === 'warn' ? 'soft' : 'open';
        return `<span class="chip ${t}" title="${esc(fmt(e.createdAt))}">${st === 'ok' ? '✓' : st === 'warn' ? '!' : '✗'}</span>`;
      }).join('')
      : '';
    const cards = (s.checks || []).map((c) => {
      // ★ TRD-F20-EPOCH: a STANDING row is a documented condition no action clears. It renders as a NEUTRAL
      // card with its own chip rather than as damage, because `bad`/`warn` above already mean "something is
      // wrong now" — and because a yellow card nobody can clear is what taught the operator to ignore this
      // panel in the first place. The full detail text is rendered unchanged: nothing is hidden, only graded.
      const st = c.standing ? 'standing' : c.status;
      const ct = st === 'bad' ? 'rejected' : st === 'warn' ? 'soft' : st === 'standing' ? 'muted' : 'open';
      const edge = st === 'bad' ? '#f87171' : st === 'warn' ? '#fcd34d' : st === 'standing' ? '#94a3b8' : '#6ee7b7';
      return `<div class="health-card" style="border-left:3px solid ${edge}"><div><b>${esc(c.label)}</b></div><div><span class="chip ${ct}"${c.standing ? ' title="Documented condition — irreversible or by design, and no action clears it. It is counted separately from bad/warn and does not mark the desk degraded."' : ''}>${esc(st)}</span></div><div class="muted" style="font-size:12px;white-space:normal">${esc(c.detail || '')}</div></div>`;
    }).join('');
    body.innerHTML = `<div class="health-grid">${cards}</div><div class="muted" style="margin-top:8px">history: ${dots || '—'}</div>`;
  } catch { /* tab may be loading */ }
}

async function refreshScorecard() {
  const el = $('scorecard-body');
  if (!el) return;
  try {
    const r = await apiGet('/api/trading/scorecard');
    if (!r || !Array.isArray(r.items) || !r.items.length) { el.textContent = 'no strategy-tagged closed trades yet'; return; }
    const goal = Number(r.goal) || 50;
    const rows = r.items.map((i) => {
      const pct = Math.min(100, Math.round((i.live.n / goal) * 100));
      const bar = `<div style="display:inline-block;width:60px;height:6px;background:var(--border);border-radius:3px;overflow:hidden;vertical-align:middle;margin-right:4px"><div style="width:${pct}%;height:100%;background:${pct >= 100 ? '#6ee7b7' : '#60a5fa'}"></div></div>`;
      return `<tr><td><b>${esc(i.strategy)}</b></td><td>${bar} ${i.live.n}/${goal}</td><td>${i.live.winRate}%</td><td>${i.live.pf ?? '—'}</td><td>${i.live.pnl >= 0 ? '+' : ''}${i.live.pnl.toFixed(2)}</td><td>${i.backtest?.pf ?? '—'}</td><td>${i.backtest?.trades ?? '—'}</td><td>${i.backtest?.oosPnl ?? '—'}</td></tr>`;
    }).join('');
    el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Strategy</th><th>n / ${goal} (criterion b)</th><th>Win%</th><th>Live PF</th><th>Live PnL</th><th>Backtest PF</th><th>Bt n</th><th>Bt OOS PnL</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch { /* tab may be loading */ }
}

// TRD-UI-3 (2026-09-22): THE STRATEGY LAB CANDIDATE SCOREBOARD.
//
// WHY THIS SURFACE EXISTS: the lab is the gate that grants scope (TRD-74), and its only surface before this
// was a paragraph in the binding panel — so a verdict that decides whether a pair may ever trade was
// unreadable without curl. `GET /api/trading/lab/scoreboard` existed the whole time and was declared
// `expose-pending` in test/ui-routes.test.js precisely because a screen should carry it (F13/B).
//
// ⚠ THE PANEL SAYS THE LAB DOES NOT GATE, because that is the only way this panel could cause harm:
// `lab/scoreboard.js` states the same limit in its own header, and a verdict rendered as a decision would
// invite someone to read "FAIL" as "forbidden" and "no release" as "not allowed". The WRITES
// (register / score / retest / release) stay script-only and are deliberately not wired here.
async function refreshLabScoreboard() {
  const el = $('lab-sb-body');
  if (!el) return;
  try {
    const r = await apiGet('/api/trading/lab/scoreboard');
    const cands = Array.isArray(r && r.candidates) ? r.candidates : [];
    const rels = Array.isArray(r && r.releases) ? r.releases : [];
    const st = $('lab-sb-state');
    if (st) {
      st.textContent = `k=${r.k} shots on goal (context, never a threshold) · BH q=${r.q} · `
        + `${cands.length} candidate(s) · ${rels.length} release(s)`;
    }
    if (!cands.length) { el.innerHTML = '<span class="muted">no lab candidates registered</span>'; return; }
    const stage = (sc, key) => {
      const s = sc && sc.stages && sc.stages[key];
      if (!s) return '<span class="muted">—</span>';
      const bits = [];
      if (s.n != null) bits.push(`n=${s.n}`);
      // ⚠ `num`, NOT `fmt`. `fmt` is `new Date(iso).toLocaleString(...)` — a DATE formatter. The first
      // version of this panel passed a profit factor (0.375) and a p-value (0.919) through it, and the
      // Strategy tab rendered them as `PF=01/01/1970, 07:30:00 p=01/01/1970, 07:30:00`: the UNIX EPOCH.
      // Every number was correct and every rendered cell was nonsense, which is exactly the failure a
      // type-free renderer produces when it reaches for the wrong helper. Found by LOOKING at the panel;
      // no route contract or unit test could see it, and `test/ui-format-guards.test.js` now pins it.
      if (s.pf != null) bits.push(`PF=${num(s.pf, 3)}`);
      if (s.p != null) bits.push(`p=${num(s.p, 4)}`);
      const v = String(s.verdict || '—');
      const cls = v === 'PASS' ? 'pos' : v === 'FAIL' ? 'neg' : 'muted';
      return `${bits.join(' ')} <b class="${cls}">${esc(v)}</b>`;
    };
    const rows = cands.map((c) => {
      const rel = rels.find((x) => String(x.id) === String(c.releaseId));
      const when = c.frozenAt ? ` <span class="muted">frozen ${fmt(c.frozenAt)}</span>` : '';
      return '<tr>'
        + `<td><b>${esc(c.strategy)}</b> <span class="muted">#${esc(String(c.registrationNo ?? '—'))}</span></td>`
        + `<td>${esc(c.symbol)} <span class="muted">${esc(c.venue || '')}</span></td>`
        + `<td>${esc(c.status || '—')}${when}</td>`
        + `<td>${stage(c.score, 'A')}</td>`
        + `<td>${stage(c.score, 'B')}</td>`
        + `<td>${rel ? `#${esc(String(rel.id))}${rel.releasedAt ? ` <span class="muted">${fmt(rel.releasedAt)}</span>` : ''}` : '<span class="muted">none</span>'}</td>`
        + '</tr>';
    }).join('');
    el.innerHTML = '<div class="table-wrap"><table><thead><tr>'
      + '<th>Candidate</th><th>Symbol</th><th>Status</th><th>Stage A (W2)</th><th>Stage B (W3)</th><th>Release</th>'
      + `</tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch { el.textContent = 'unavailable'; }
}

// ---------------- refresh all ----------------
// F6 (2026-09-12 review): every panel fetch is TRACKED. A success records the
// time; a failure keeps the last success time and marks the panel failed. The
// banner "Data" chip summarises the whole page, so a dead API can no longer
// leave a plausible-looking frozen desk (the old code was 26× `catch {}`).
const ASOF = {};
const ASOF_SLA_MS = { kill: 60000, bridge: 60000, waker: 60000, account: 30000, trades: 30000, alerts: 120000, wake_detail: 900000, wakes: 900000, events: 900000, watchlist: 900000, providers: 300000, deliberation: 900000, meta: 300000, strategies: 900000, scorecard: 900000, pulse: 900000, paper: 180000, bars: 300000, quarantine: 300000, aiState: 120000, scripts: 300000, pipeline: 180000, equity: 180000, whitepaper: 3600000, budget: 300000, health: 900000, tuner: 900000, dataPlane: 120000 };
const ASOF_LABEL = { kill: 'kill switch', bridge: 'bridge', waker: 'agent', account: 'account strip', trades: 'positions', alerts: 'alerts', wakes: 'decisions', events: 'activity', watchlist: 'watchlist', providers: 'providers', deliberation: 'deliberation', meta: 'regime', strategies: 'strategies', scorecard: 'scorecard', pulse: 'pulse', paper: 'paper', bars: 'prices', quarantine: 'quarantine', aiState: 'AI state', scripts: 'scripts', pipeline: 'pipeline', equity: 'equity', whitepaper: 'white paper', budget: 'budget', health: 'health', tuner: 'tuner', dataPlane: 'data plane' };

async function tracked(key, fn) {
  try {
    const r = await fn();
    ASOF[key] = { at: Date.now(), ok: true };
    return r;
  } catch (e) {
    const prev = ASOF[key];
    ASOF[key] = { at: prev && prev.at ? prev.at : null, ok: false };
    throw e;
  } finally {
    syncFreshness();
  }
}

function hhmmss(ms) { return new Date(ms).toLocaleTimeString('en-GB', { hour12: false }); }

function ageText(key) {
  const a = ASOF[key];
  if (!a) return '';
  if (a.ok) return `as of ${hhmmss(a.at)}`;
  return a.at ? `⚠ stale — last ok ${hhmmss(a.at)}` : '⚠ never loaded';
}

function renderAsof() {
  for (const [id, key] of [['trades-asof', 'trades'], ['wakes-asof', 'wakes'], ['eq-asof', 'equity']]) {
    const el = $(id);
    if (!el) continue;
    el.textContent = ageText(key);
    el.className = 'asof' + (ASOF[key] && !ASOF[key].ok ? ' stale' : '');
  }
}

// F32 (2026-09-18): THE HEADER'S SECOND QUESTION — is the desk's DATA still arriving?
//
// Until now the `Data` chip was computed entirely here, from whether each PANEL's API call had succeeded.
// That is a true and useless answer: during the 2026-09-17 outage every panel loaded fine, so the chip read
// `fresh` for ~16 hours while the tape the desk was trading on had frozen the previous evening. The chip now
// carries both answers, and the server's verdict wins when it objects — a desk with a dead feed is not
// "fresh" no matter how healthy its own HTTP calls are.
async function refreshDataPlane() {
  const v = await apiGet('/api/trading/data-plane');
  state.dataPlane = v;
  syncFreshness();
  return v;
}

function syncFreshness() {
  const now = Date.now();
  const failed = [];
  const stale = [];
  for (const [key, a] of Object.entries(ASOF)) {
    const sla = ASOF_SLA_MS[key] || 300000;
    const age = a.at ? now - a.at : Infinity;
    const label = ASOF_LABEL[key] || key;
    if (!a.ok) failed.push(`${label}: last fetch FAILED${a.at ? ` — showing data ${Math.round(age / 60000)}m old` : ' — nothing loaded'}`);
    else if (age > sla) stale.push(`${label}: ${age >= 120000 ? Math.round(age / 60000) + 'm' : Math.round(age / 1000) + 's'} old (SLA ${sla >= 120000 ? Math.round(sla / 60000) + 'm' : Math.round(sla / 1000) + 's'})`);
  }
  const chip = $('banner-data');
  if (chip) {
    const dp = state.dataPlane;
    const dpBad = dp && dp.state && dp.state !== 'ok';
    const bad = failed.length + stale.length;
    if (dpBad) {
      // The desk's OWN data is the louder fact, so it owns the chip. The panel list is still in the
      // tooltip, because "my panels loaded" remains true and useful — it is just no longer the headline.
      const dpChipTxt = dp.chip || dp.state.toUpperCase();
      if (chip.textContent !== dpChipTxt) chip.textContent = dpChipTxt;
      chip.className = 'chip rejected';
      chip.title = [
        `DATA PLANE ${dp.state.toUpperCase()} — the desk's own feed, not this browser's fetches:`,
        ...dp.reasons.map((r) => `• ${r.detail}`),
        '',
        `panels: ${bad ? `${bad} stale/failed` : 'all within SLA'}`,
        ...failed, ...stale,
      ].join('\n');
    } else {
      const freshChipTxt = bad ? `${bad} stale` : 'fresh';
      if (chip.textContent !== freshChipTxt) chip.textContent = freshChipTxt;
      chip.className = 'chip ' + (failed.length ? 'rejected' : stale.length ? 'soft' : 'open');
      chip.title = [...failed, ...stale].join('\n') || 'every panel fetched within its SLA';
    }
  }
  renderAsof();
  syncTradeButton();
}

// F8 (2026-09-12): the trade button must not invite a click the desk will
// refuse — and it must say WHICH desk the order goes to.
function syncTradeButton() {
  const btn = $('btn-trade');
  if (!btn) return;
  const reasons = [];
  if (state.paused) reasons.push('wake loop paused');
  if (state.killTier && state.killTier !== 'off') reasons.push(`kill ${state.killTier}`);
  if (state.bridgePaused) reasons.push('bridge paused');
  btn.disabled = reasons.length > 0;
  btn.textContent = state.simMode ? 'Submit → PAPER' : 'Submit → PLUS500 DEMO';
  btn.title = reasons.length
    ? `disabled: ${reasons.join(' · ')} — resolve on the banner/Agent card first (manual submits still route server-side)`
    : state.simMode ? 'fills in the simulated broker (paper account)' : 'sends a real order to the Plus500 DEMO account';
}

// F13: skip an identical re-render (the 1s positions poll used to rewrite the
// table every second even when nothing changed).
const lastHtml = {};
function setIfChanged(id, html) {
  if (lastHtml[id] === html) return false;
  lastHtml[id] = html;
  const el = $(id);
  if (el) el.innerHTML = html;
  return true;
}

async function refreshAll() {
  // Order matters only for the banner chips: kill/mode first, money next.
  await tracked('kill', refreshKill).catch(() => {});
  await tracked('bridge', refreshBridge).catch(() => {});
  await tracked('waker', refreshWaker).catch(() => {});
  // F32: the desk's own data health, refreshed with the other banner chips so the `Data` chip cannot be
  // describing one moment while the kill/mode chips describe another.
  await tracked('dataPlane', refreshDataPlane).catch(() => {});
  await tracked('account', refreshAccount).catch(() => {});
  await tracked('alerts', refreshAlerts).catch(() => {});
  await tracked('trades', refreshTrades).catch(() => {});
  await tracked('wakes', refreshWakes).catch(() => {});
  await tracked('events', refreshEvents).catch(() => {});
  await tracked('watchlist', refreshWatchlist).catch(() => {});
  await tracked('providers', refreshProviders).catch(() => {});
  await tracked('deliberation', refreshDeliberation).catch(() => {});
  await tracked('meta', refreshMeta).catch(() => {});
  await tracked('strategies', refreshStrategies).catch(() => {});
  await tracked('binding', refreshBinding).catch(() => {});
  await tracked('scorecard', refreshScorecard).catch(() => {});
  await tracked('pulse', refreshPulse).catch(() => {});
  await tracked('news', refreshNews).catch(() => {});
  await tracked('paper', refreshPaper).catch(() => {});
  await tracked('bars', async () => { await loadSymbols(); await refreshBars(); }).catch(() => {});
  await tracked('quarantine', refreshQuarantine).catch(() => {});
  await tracked('aiState', renderAiState).catch(() => {});
  await tracked('scripts', renderScripts).catch(() => {});
  await tracked('pipeline', renderPipeline).catch(() => {});
  await tracked('equity', renderEquity).catch(() => {});
  await tracked('whitepaper', renderWhitepaper).catch(() => {});
  await tracked('budget', renderBudget).catch(() => {});
  await tracked('health', refreshHealth).catch(() => {});
  await tracked('tuner', refreshTuner).catch(() => {});
}

// ---------------- boot ----------------
function boot() {
  $('btn-auth').onclick = () => { if (isLoggedIn()) { clearToken(); location.reload(); } else showLogin(); };
  // F13 (18/09): 31 of 109 routes had no click path, and the one that mattered was POST /orders/close —
  // the desk could not be told to close a position by hand. The confirm QUOTES the position (the §4
  // rule: a confirmation's weight should match its blast radius, and a market close is the largest
  // reversible action here). Delegated from `document`, so re-rendering the table cannot orphan it.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-close-trade]');
    if (!btn) return;
    const id = Number(btn.getAttribute('data-close-trade'));
    const t = (state.openTrades || []).find((x) => Number(x.id) === id);
    const what = t
      ? `#${t.id} ${t.symbol} ${t.direction} ${num(t.size, 4)} ${t.units || ''} @ ${num(t.openPrice)}`
      : `trade #${id}`;
    if (!confirm(`Close ${what} at market?\n\nThis sends a real close to the venue. If the venue cannot reach the position the refusal is reported here, not swallowed.`)) return;
    btn.disabled = true;
    feedback($('trade-feedback'), `closing ${what}…`);
    try {
      const r = await apiPost('/api/trading/orders/close', { tradeId: id });
      feedback($('trade-feedback'), r.closed === false
        ? `REFUSED — ${r.reason || 'see the event log'}`
        : `closed ${what}${r.closePrice != null ? ` @ ${num(r.closePrice)}` : ''}${r.pnl != null ? ` · P&L ${num(r.pnl)}` : ''}`, r.closed !== false);
      await refreshTrades();
    } catch (err) { feedback($('trade-feedback'), err.message, false); }
    finally { btn.disabled = false; }
  });
  $('btn-login').onclick = async () => {
    try {
      await login($('username').value.trim(), $('password').value);
      $('password').value = '';
      $('login-feedback').textContent = '';
      await showApp();
    } catch (e) { feedback($('login-feedback'), e.message, false); }
  };
  // TRD-UI-9 (C) 2026-10-03: destructive confirms use the IN-PAGE dialog. Under NVDA the native
  // window.confirm read with a stray host-app word ("Code dialog HARD KILL …" — the VS Code browser
  // naming the dialog), and a native confirm cannot carry a label. Same text verbatim; Cancel holds
  // focus by default; Esc closes with an empty returnValue (false) — only Proceed resolves true.
  async function askConfirm({ title, body, okLabel = 'Proceed' }) {
    const dlg = $('confirm-dialog');
    if (!dlg || typeof dlg.showModal !== 'function') return window.confirm(`${title}\n\n${body}\n\nProceed?`);
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    $('confirm-ok').textContent = okLabel;
    $('confirm-cancel').onclick = () => dlg.close('cancel');
    $('confirm-ok').onclick = () => dlg.close('ok');
    return new Promise((resolve) => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
      dlg.showModal();
      $('confirm-cancel').focus();
    });
  }
  // F1 (2026-09-12): soft is the safe exit — one click, secondary styling.
  // Hard closes positions and takes the desk offline, so it confirms first.
  $('btn-kill-soft').onclick = () => apiPost('/api/trading/kill', { tier: 'soft', reason: 'dashboard' })
    .then(() => tracked('kill', refreshKill))
    .catch((e) => feedback($('kill-feedback'), e.message, false));
  $('btn-kill-hard').onclick = async () => {
    const open = state.openCount || 0;
    const ok = await askConfirm({
      title: 'HARD KILL',
      body: `This blocks new entries AND closes ${open} open position(s) at market.\nIt cannot be undone — Resume only lifts the tier.`,
      okLabel: 'Proceed',
    });
    if (!ok) return;
    return apiPost('/api/trading/kill', { tier: 'hard', reason: 'dashboard', autoClose: true })
      .then((r) => {
        // F19 (2026-09-18): the close is STARTED by this request rather than merely implied by the tier, so
        // the acknowledgement names which of the two actually happened. Before this, the dialog promised a
        // market close and the tier was the only thing that changed.
        feedback($('kill-feedback'), r && r.autoCloseSweep === 'started'
          ? `HARD — entries blocked; closing ${open} position(s) now (outcome in Events as kill_auto_close)`
          : 'HARD — entries blocked', true);
        return tracked('kill', refreshKill);
      })
      .catch((e) => feedback($('kill-feedback'), e.message, false));
  };
  $('btn-kill-off').onclick = () => apiPost('/api/trading/kill', { tier: 'off', reason: 'dashboard resume' })
    .then(() => tracked('kill', refreshKill))
    .catch((e) => feedback($('kill-feedback'), e.message, false));

  $('btn-bridge-resume').onclick = () => apiPost('/api/trading/bridge/resume').then(refreshBridge).catch((e) => feedback($('capture-feedback'), e.message, false));
  $('btn-bridge-park').onclick = () => apiPost('/api/trading/bridge/park', { on: !state.bridgeParked }).then(refreshBridge).catch((e) => feedback($('capture-feedback'), e.message, false));

  // 2026-10-05: the LIVE bridge state machine (compact mount). Both the picture and the data come from
  // code — bridge-state-graph.json (exported from trading/plus500/bridgeStateGraph.js, pinned against the
  // reducer) + bridge-state.json (the observer's own output). Self-polling; no auth needed (static origin).
  try {
    if (window.BridgeMachine && $('bridge-machine')) BridgeMachine.mount($('bridge-machine'), { compact: true });
  } catch (e) { console.warn('bridge machine mount failed', e); }

  $('btn-ask').onclick = askAi;
  $('ask-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') askAi(); });

  $('btn-whitepaper').onclick = () => apiPost('/api/trading/whitepaper/generate', { force: true }).then((r) => { feedback($('whitepaper-feedback'), 'generated', true); renderWhitepaper(); }).catch((e) => feedback($('whitepaper-feedback'), e.message, false));
  $('budget-save').onclick = async () => {
    try {
      const body = { totalDaily: Number($('budget-total').value) || undefined, boostUntil: $('budget-boost').value || null };
      await apiPut('/api/trading/budget', body);
      feedback($('budget-feedback'), 'saved', true);
      await renderBudget();
    } catch (e) { feedback($('budget-feedback'), e.message, false); }
  };
  $('budget-clear-boost').onclick = async () => {
    try { await apiPut('/api/trading/budget', { boostUntil: null }); feedback($('budget-feedback'), 'boost cleared', true); await renderBudget(); }
    catch (e) { feedback($('budget-feedback'), e.message, false); }
  };

  $('btn-review').onclick = () => runPositionReview($('trade-feedback'));
  // The reviewer is billed by the token (TRD-84: ~14k per call against a daily cap), so a manual trigger
  // says so before it spends. The dashboard's own cadence normally drives it.
  if ($('btn-binding-propose')) {
    $('btn-binding-propose').onclick = async () => {
      if (!confirm('Ask the binding reviewer now?\n\nThis bypasses the 12h cadence and costs roughly 14,000 tokens.')) return;
      try {
        const r = await apiPost('/api/trading/binding/propose', { force: true });
        feedback($('binding-feedback'), r && r.skipped ? `skipped: ${r.skipped}` : `accepted: ${r && r.accepted} · ${(r && r.proposal && r.proposal.bindings || []).length} binding(s)`, !!(r && r.accepted));
        await refreshBinding();
      } catch (e) { feedback($('binding-feedback'), e.message, false); }
    };
  }
  if ($('events-kind')) $('events-kind').onchange = () => refreshEvents().catch(() => {});
  $('delib-pr-run').onclick = () => runPositionReview($('delib-pr-feedback'));
  $('delib-pr-save').onclick = async () => {
    try {
      await apiPut('/api/trading/settings', {
        deliberation: {
          positionReview: {
            enabled: $('pr-enabled').checked,
            reviewMinutes: Math.max(0.5, Number($('pr-minutes').value) || 5),
            maxPerWake: Math.max(0, Number($('pr-max').value) || 1),
            minConfidence: Math.max(0, Math.min(1, Number($('pr-conf').value) || 0.7)),
            closeMirrored: $('pr-mirrored').checked,
          },
        },
      });
      feedback($('delib-pr-feedback'), 'saved');
      await refreshDeliberation();
    } catch (e) { feedback($('delib-pr-feedback'), e.message, false); }
  };

  $('btn-capture').onclick = async () => {
    feedback($('capture-feedback'), 'capturing…');
    try { const r = await apiPost('/api/trading/capture'); feedback($('capture-feedback'), `captured ${r.captured} ticks${r.missing?.length ? ' (missing: ' + r.missing.join(', ') + ')' : ''}`); }
    catch (e) { feedback($('capture-feedback'), e.message, false); }
  };

  $('btn-wake').onclick = async () => {
    feedback($('wake-feedback'), 'waking…');
    try {
      const userInput = ($('wake-input') ? $('wake-input').value : '').trim();
      const r = await apiPost('/api/trading/wake', userInput ? { userInput } : {});
      if (r.queued) feedback($('wake-feedback'), `queued — another wake (${r.current || '?'}) is running; this one runs right after it`);
      else {
        const why = r.reason ? ` — ${r.reason}` : '';
        feedback($('wake-feedback'), `done (${r.action || r.skipped || 'ok'}${why}${r.decision?.symbol ? ' ' + r.decision.symbol : ''})`);
      }
      if ($('wake-input')) $('wake-input').value = '';
      await refreshAll();
    }
    catch (e) { feedback($('wake-feedback'), e.message, false); }
  };

  $('btn-wake-pause').onclick = async () => {
    try {
      await apiPost('/api/trading/wake/pause', { paused: !state.paused });
      feedback($('wake-feedback'), state.paused ? 'resumed' : 'paused — scheduled wakes stopped (manual still works)');
      await refreshAll();
    } catch (e) { feedback($('wake-feedback'), e.message, false); }
  };

  $('btn-discover').onclick = async () => {
    feedback($('watch-feedback'), 'discovering… (takes ~30s)');
    try { const r = await apiPost('/api/trading/watchlist/discover'); const found = (r.candidates || []).filter((c) => c.found).length; feedback($('watch-feedback'), `found ${found}/${(r.candidates || []).length}`); await refreshWatchlist(); }
    catch (e) { feedback($('watch-feedback'), e.message, false); }
  };
  $('btn-confirm').onclick = async () => {
    try {
      const wl = await apiGet('/api/trading/watchlist');
      const symbols = (wl.candidates || []).filter((c) => c.found).map((c) => ({ symbol: c.plus500Name, venue: 'plus500' }));
      if (!symbols.length) return feedback($('watch-feedback'), 'nothing found to confirm', false);
      await apiPost('/api/trading/watchlist/confirm', { symbols });
      feedback($('watch-feedback'), `confirmed ${symbols.length} symbols`);
      await refreshWatchlist(); await loadSymbols(); await refreshBars();
    } catch (e) { feedback($('watch-feedback'), e.message, false); }
  };
  $('btn-bars').onclick = () => apiPost('/api/trading/bars/build').then((r) => feedback($('watch-feedback'), `hourly ${r.hourly} · daily ${r.daily} · ticks deleted ${r.ticksDeleted}`)).catch((e) => feedback($('watch-feedback'), e.message, false));
  $('btn-bars-rebuild').onclick = rebuildBars;

  // AI discoverer section (2026-09-10).
  if ($('wl-ai-max')) $('wl-ai-max').oninput = () => { const v = $('wl-ai-max-v'); if (v) v.textContent = $('wl-ai-max').value; };
  if ($('btn-wl-ai-run')) {
    $('btn-wl-ai-run').onclick = async () => {
      feedback($('wl-ai-feedback'), 'running discovery… (~30s)');
      try {
        const r = await apiPost('/api/trading/watchlist/discover-ai', { force: true });
        if (r.skipped) feedback($('wl-ai-feedback'), `skipped — ${r.skipped}`, false);
        else feedback($('wl-ai-feedback'), `matched ${r.matches}/${r.candidates} · added ${(r.added || []).length}`);
        await refreshWatchlist();
      } catch (e) { feedback($('wl-ai-feedback'), e.message, false); }
    };
  }
  if ($('btn-wl-ai-save')) {
    $('btn-wl-ai-save').onclick = async () => {
      try {
        await apiPut('/api/trading/settings', { discover: { enabled: $('wl-ai-enabled').checked, maxAiSymbols: Number($('wl-ai-max').value) || 5 } });
        feedback($('wl-ai-feedback'), 'saved');
      } catch (e) { feedback($('wl-ai-feedback'), e.message, false); }
    };
  }

  $('wl-search').oninput = () => renderWlResults($('wl-search').value);

  $('btn-providers').onclick = async () => {
    feedback($('prov-feedback'), 'snapshotting…');
    try {
      const r = await apiPost('/api/trading/providers/snapshot');
      feedback($('prov-feedback'), r.skipped ? 'within 60s gate' : `${r.ticks} ticks (${r.results.binance?.ticks ?? 0} binance / ${r.results.okx?.ticks ?? 0} okx / ${r.results.yahoo?.ticks ?? 0} yahoo)`);
      await refreshProviders();
    } catch (e) { feedback($('prov-feedback'), e.message, false); }
  };

  document.querySelectorAll('.tab[data-tab]').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab[data-tab]').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      for (const name of ['wakes', 'events', 'trades', 'alerts', 'prices', 'backtest', 'deliberation', 'strategy', 'paper', 'health']) {
        $('tab-' + name).classList.toggle('hidden', name !== t.dataset.tab);
      }
      if (t.dataset.tab === 'health') { refreshHealth(); refreshCalendar(); refreshDigest(); }
      if (t.dataset.tab === 'strategy') { refreshStrategies(); refreshTuner(); refreshScorecard(); refreshLabScoreboard(); refreshCanTrade(); refreshShadowSurfaces(); }
    };
  });
  // Equity chart window: 30m / 2h / 12h / all (live-following min, now = right edge).
  document.querySelectorAll('[data-eqwin]').forEach((b) => {
    b.onclick = () => {
      eqState.windowMs = b.dataset.eqwin === 'all' ? 0 : Number(b.dataset.eqwin) || 7200000;
      document.querySelectorAll('[data-eqwin]').forEach((x) => x.classList.toggle('active', x === b));
      eqUpdate();
    };
  });
  $('tf-1h').onclick = () => { state.timeframe = '1h'; $('tf-1h').classList.add('active'); $('tf-1d').classList.remove('active'); refreshBars(); };
  $('tf-1d').onclick = () => { state.timeframe = '1d'; $('tf-1d').classList.add('active'); $('tf-1h').classList.remove('active'); refreshBars(); };
  $('bar-symbol').onchange = () => { state.symbol = $('bar-symbol').value; refreshBars(); };

  document.querySelectorAll('#tab-prices [data-tf]').forEach((b) => {
    b.onclick = () => { state.timeframe = b.dataset.tf; document.querySelectorAll('#tab-prices [data-tf]').forEach((x) => x.classList.toggle('active', x === b)); refreshBars(); };
  });
  document.querySelectorAll('#tab-backtest [data-tf]').forEach((b) => {
    b.onclick = () => { state.btTimeframe = b.dataset.tf; document.querySelectorAll('#tab-backtest [data-tf]').forEach((x) => x.classList.toggle('active', x === b)); updateRangeButtons(); };
  });
  document.querySelectorAll('#tab-backtest [data-range]').forEach((b) => {
    b.onclick = () => { state.btRange = b.dataset.range; document.querySelectorAll('#tab-backtest [data-range]').forEach((x) => x.classList.toggle('active', x === b)); };
  });
  $('bt-symbol').onchange = () => { state.btSymbol = $('bt-symbol').value; refreshConsistency(); };
  $('bt-venue').onchange = () => { applyProviderGrey(); refreshConsistency(); };
  $('btn-backtest').onclick = runBacktest;
  updateRangeButtons();

  // TRD-11: wake interval, positions mirror, trade submit, backtest-local
  // strategy + sweep, Plus500 alerts mirror.
  $('btn-wake-interval').onclick = async () => {
    const mins = Math.max(1, Math.min(240, Number($('wake-interval').value) || 10));
    try { await apiPut('/api/trading/settings', { wake: { intervalMinutes: mins } }); feedback($('wake-feedback'), `interval set to ${mins}m (applies from the next schedule)`); }
    catch (e) { feedback($('wake-feedback'), e.message, false); }
  };
  $('btn-mirror').onclick = async () => {
    feedback($('trade-feedback'), 'mirroring Plus500 open positions…');
    try { const r = await apiPost('/api/trading/reconcile'); feedback($('trade-feedback'), `mirrored — ${(r.opened || []).length} opened / ${(r.phantom || []).length} phantom / ${(r.closed || []).length} closed`); await refreshTrades(); }
    catch (e) { feedback($('trade-feedback'), e.message, false); }
  };
  $('btn-trade').onclick = async () => {
    const symbol = $('trade-symbol').value;
    const direction = $('trade-dir').value;
    if (!symbol) return feedback($('trade-feedback'), 'pick a symbol', false);
    feedback($('trade-feedback'), 'submitting…');
    try {
      const mode = await apiGet('/api/trading/paper');
      const amount = Number($('trade-amount').value);
      if (mode.enabled) {
        const r = await apiPost('/api/trading/paper/open', { symbol, direction, sizePct: amount > 0 && amount <= 100 ? amount : null });
        feedback($('trade-feedback'), `sim order filled — ${r.trade.symbol} ${r.trade.direction} ×${num(r.trade.size, 4)} @ ${num(r.trade.openPrice)} (open positions tab + central sees it next wake)`);
        await refreshPaper();
      } else {
        // TRD-43: this used to post `amount`, which `executor.openTrade` does not read (it reads
        // `size`) — so `Number(undefined)` was NaN and EVERY manual order was refused as
        // `size_must_be_positive`. The control looked alive and never placed anything.
        // The stop is now explicit: blank means "no stop", which the desk accepts but stamps and
        // flags rather than recording as zero risk.
        const stopRaw = ($('trade-stop') ? $('trade-stop').value : '').trim();
        const stopPrice = stopRaw === '' ? null : Number(stopRaw);
        if (stopRaw !== '' && !(Number.isFinite(stopPrice) && stopPrice > 0)) {
          return feedback($('trade-feedback'), 'stop must be a positive number (or blank for none)', false);
        }
        const r = await apiPost('/api/trading/orders/open', { symbol, direction, size: amount || 1, stopPrice });
        feedback($('trade-feedback'), `${r.placed === false ? 'REFUSED — ' : 'submitted to Plus500 demo — '}${r.positionId ? 'positionId ' + r.positionId : (r.reason || 'see open positions')}`
          + (r.placed === false || stopPrice != null ? '' : ' (NO STOP — this position cannot be measured in R)'),
          r.placed !== false);
        await refreshTrades();
      }
    } catch (e) { feedback($('trade-feedback'), e.message, false); }
  };
  $('btn-bt-sweep').onclick = runSweep;
  if ($('bt-strategy')) { $('bt-strategy').onchange = renderBtParams; }
  $('btn-alerts-sync').onclick = async () => {
    feedback($('alerts-plus-feedback'), 'syncing Plus500 alert sidebars (bridge)…');
    try {
      const r = await apiPost('/api/trading/alerts/plus500/sync');
      const found = (r.symbols || []).filter((s) => s.alerts.length).map((s) => `${s.symbol} (${s.alerts.length})`);
      feedback($('alerts-plus-feedback'), found.length ? `Plus500 alerts seen: ${found.join(', ')}` : (r.error || 'no alerts listed on Plus500 sidebars yet'));
    } catch (e) { feedback($('alerts-plus-feedback'), e.message, false); }
  };
  $('btn-alerts-create').onclick = async () => {
    const symbol = $('al-p500-symbol').value;
    const value = Number($('al-p500-value').value);
    if (!symbol || !Number.isFinite(value)) return feedback($('alerts-plus-feedback'), 'symbol + price required', false);
    feedback($('alerts-plus-feedback'), 'creating on Plus500 (sidebar automation)…');
    try {
      const r = await apiPost('/api/trading/alerts/plus500/create', { symbol, value, side: $('al-p500-side').value });
      feedback($('alerts-plus-feedback'), `created on Plus500 + mirrored locally (#${r.localId}) — push goes to your phone, wake loop also watches it`);
      await refreshAlerts();
    } catch (e) { feedback($('alerts-plus-feedback'), e.message, false); }
  };

  // deliberation editor
  $('delib-save').onclick = saveDeliberation;
  $('risk-save').onclick = saveRiskSizing;
  $('delib-add-chair').onclick = () => {
    const chairs = state.deliberation.chairs || [];
    if (chairs.length >= 3) return feedback($('delib-feedback'), 'max 3 chairs', false);
    chairs.push({ id: 'chair-' + (chairs.length + 1), model: null, temperature: null, weight: 1 });
    renderDeliberation();
  };

  // strategy editor
  $('strat-save').onclick = saveStrategies;
  // AI self-tuning (Phase 2 of implied goal, 2026-09-10).
  if ($('btn-tuner-save')) {
    $('btn-tuner-save').onclick = async () => {
      try {
        await apiPut('/api/trading/settings', { tuner: { enabled: $('tuner-enabled').checked, intervalHours: Math.max(6, Number($('tuner-interval').value) || 24) } });
        feedback($('tuner-feedback'), 'saved');
        await refreshTuner();
      } catch (e) { feedback($('tuner-feedback'), e.message, false); }
    };
  }
  // TRD-45 Phase 0: read the Plus500 page the operator has ALREADY navigated to. A button rather
  // than a CLI, because that is how the mirror is meant to be refreshed (a manual trigger was in
  // the plan from the start). Read-only: the probe never navigates, so this is safe whenever the
  // desk is idle — it just reads what is on screen.
  if ($('btn-probe-instruments')) {
    $('btn-probe-instruments').onclick = async () => {
      const out = $('probe-result');
      feedback($('probe-feedback'), 'reading the loaded Plus500 page…');
      try {
        const r = await apiPost('/api/trading/instruments/probe');
        if (r.skipped) { feedback($('probe-feedback'), `skipped — ${r.skipped}`, false); return; }
        const kw = (((r.keyword || {}).textHits) || []).length + (((r.keyword || {}).attrHits) || []).length;
        feedback($('probe-feedback'), r.tableFound
          ? `${r.rowCount} instrument(s) · ${kw} contract-metadata hit(s)`
          : 'no instrument table on the loaded page', r.tableFound);
        const names = r.allNames || [];
        const cats = r.highlighted || [];
        out.innerHTML = [
          `<div><b>${esc(r.url || '')}</b></div>`,
          `<div>table: ${r.tableFound ? 'yes' : 'no'} · rows: ${r.rowCount || 0} · market: ${esc(String(r.market))}</div>`,
          cats.length ? `<div>highlighted: ${cats.map(esc).join(' · ')}</div>` : '',
          (r.categories || []).length ? `<div>categories seen: ${(r.categories || []).length}</div>` : '',
          names.length ? `<div>instruments: ${names.length} — ${names.slice(0, 12).map(esc).join(', ')}${names.length > 12 ? ' …' : ''}</div>` : '',
          kw
            ? `<div class="warn-t">contract metadata FOUND (${kw} hit(s)) — see trading/docs/INSTRUMENT_MIRROR_PHASE0.md</div>`
            : '<div class="muted">no contract metadata on this page</div>',
        ].join('');
      } catch (e) { feedback($('probe-feedback'), e.message, false); }
    };
  }

  if ($('btn-tuner-run')) {
    $('btn-tuner-run').onclick = async () => {
      feedback($('tuner-feedback'), 'tuner deliberating…');
      try {
        const r = await apiPost('/api/trading/tuner/run');
        if (r.skipped) feedback($('tuner-feedback'), `skipped — ${r.skipped}`, false);
        else feedback($('tuner-feedback'), `${(r.changes || []).length} change(s) applied${(r.rejected || []).length ? ` · ${r.rejected.length} rejected` : ''}`);
        await refreshTuner(); await refreshStrategies();
      } catch (e) { feedback($('tuner-feedback'), e.message, false); }
    };
  }
  $('congress-pull').onclick = async () => {
    feedback($('congress-feedback'), 'pulling Congress trades…');
    try {
      const token = $('congress-token').value.trim() || null;
      const r = await apiPost('/api/trading/providers/congress/pull', token ? { token } : {});
      feedback($('congress-feedback'), `pulled ${r.pull.total} trades (${r.pull.buys} buys) · ranked ${r.rank.evaluated} tickers`);
      if (token) $('congress-token').value = '';
    } catch (e) { feedback($('congress-feedback'), e.message, false); }
  };

  // pulse + paper (TRD-11)
  $('pulse-run').onclick = () => runPulse();
  $('pulse-wl').onclick = () => runPulse('watchlist');
  $('pulse-custom').onclick = () => {
    const q = $('pulse-query').value.trim();
    if (!q) return feedback($('pulse-feedback'), 'type a scope first (e.g. gold)', false);
    runPulse(q);
  };
  $('btn-baseline').onclick = async () => {
    try { const r = await apiPost('/api/trading/kill/baseline'); feedback($('kill-feedback'), `baseline set to ${num(r.initialEquity, 2)} (live demo equity)`); await refreshKill(); await refreshAccount(); }
    catch (e) { feedback($('kill-feedback'), e.message, false); }
  };
  $('btn-past').onclick = async () => {
    const box = $('past-trades');
    box.classList.toggle('hidden');
    $('btn-past').textContent = box.classList.contains('hidden') ? 'View past positions' : 'Hide past positions';
    if (!box.classList.contains('hidden')) await refreshTrades();
  };
  $('paper-mode-toggle').onclick = async () => {
    try {
      const cur = await apiGet('/api/trading/paper');
      const next = !cur.enabled;
      await apiPut('/api/trading/settings', { paper: { enabled: next } });
      feedback($('paper-feedback'), 'paper mode ' + (next ? 'ON (wakes now trade the paper ledger)' : 'off'));
      // The write path KNOWS the new value, so it states it instead of waiting up to 15s for /state to say so.
      // This is not a second reader: it is the same one fact, set by the request that changed it.
      state.mode = next ? 'sim' : 'plus500_demo';
      applyMode();
      await refreshPaper();
    } catch (e) { feedback($('paper-feedback'), e.message, false); }
  };
  $('paper-toggle').onchange = async () => {
    try {
      const next = $('paper-toggle').checked;
      await apiPut('/api/trading/settings', { paper: { enabled: next } });
      feedback($('paper-feedback'), 'paper mode ' + (next ? 'ON (wakes now trade the paper ledger)' : 'off'));
      state.mode = next ? 'sim' : 'plus500_demo';
      applyMode();
      await refreshPaper();
    } catch (e) { feedback($('paper-feedback'), e.message, false); }
  };
  $('paper-reset').onclick = async () => {
    if (!confirm('Reset the paper account? (deletes all paper trades)')) return;
    try { await apiPost('/api/trading/paper/reset'); feedback($('paper-feedback'), 'paper account reset'); await refreshPaper(); }
    catch (e) { feedback($('paper-feedback'), e.message, false); }
  };
  $('paper-wake').onclick = async () => {
    feedback($('paper-feedback'), 'central AI deliberating (thinking ON)…');
    try {
      const r = await apiPost('/api/trading/wake');
      feedback($('paper-feedback'), r.mode === 'paper' ? `verdict: ${r.decision?.stance} — ${r.decision?.headline || ''} (${r.durationMs}ms)` : `wake done (${r.action || r.skipped || 'ok'})`);
      await refreshPaper();
    } catch (e) { feedback($('paper-feedback'), e.message, false); }
  };

  // TRD-9 provider history buttons
  $('btn-backfill').onclick = async () => {
    const symbol = state.btSymbol || state.symbol;
    if (!symbol) return feedback($('prov-feedback'), 'no symbol selected', false);
    feedback($('prov-feedback'), `backfilling ${symbol} 1h from yahoo…`);
    try {
      const r = await apiPost('/api/trading/providers/backfill', { provider: 'yahoo', symbol, timeframe: '1h' });
      feedback($('prov-feedback'), r.error ? r.error : `${r.bars} bars · ${fmt(r.from)} → ${fmt(r.to)}`);
      await refreshProviders();
    } catch (e) { feedback($('prov-feedback'), e.message, false); }
  };
  $('btn-backfill-all').onclick = async () => {
    feedback($('prov-feedback'), 'downloading all history (slow — takes minutes)…');
    try {
      const r = await apiPost('/api/trading/providers/backfill-all', { timeframes: ['1h'] });
      const failed = r.results.filter((x) => x.error).length;
      feedback($('prov-feedback'), `done: ${r.ok} backfills ok${failed ? `, ${failed} failed` : ''}`);
      await refreshProviders();
    } catch (e) { feedback($('prov-feedback'), e.message, false); }
  };

  $('btn-open-plus500').onclick = async () => {
    if (!state.symbol) return;
    feedback($('watch-feedback'), `opening ${state.symbol} in Plus500…`);
    try { const r = await apiPost('/api/trading/watchlist/open', { symbol: state.symbol }); feedback($('watch-feedback'), `opened — chart: ${r.chartTitle || 'selected'}`); }
    catch (e) { feedback($('watch-feedback'), e.message, false); }
  };

  $('al-add').onclick = async () => {
    const symbol = $('al-symbol').value.trim();
    const threshold = Number($('al-threshold').value);
    if (!symbol || Number.isNaN(threshold)) return feedback($('alerts-feedback'), 'symbol + threshold required', false);
    // F25: a symbol the desk does not track makes a DEAD alert, and the engine will never say so. Refuse it
    // with the nearest candidates rather than a bare error, so the fix is one click away.
    const known = new Set([...(state.symbols || []).map((s) => s.symbol), ...(state.universe || []).map((u) => u.symbol)]);
    if (known.size && !known.has(symbol)) {
      const near = [...known].filter((k) => k.toLowerCase().includes(symbol.toLowerCase()) || symbol.toLowerCase().includes(k.toLowerCase())).slice(0, 4);
      return feedback($('alerts-feedback'), `"${symbol}" is not a symbol this desk tracks — ${near.length ? `did you mean ${near.join(', ')}?` : `pick from the watchlist (${known.size} symbols)`}`, false);
    }
    try {
      await apiPost('/api/trading/alerts', { symbol, direction: $('al-direction').value, threshold });
      $('al-symbol').value = ''; $('al-threshold').value = '';
      feedback($('alerts-feedback'), 'alert added');
      await refreshAlerts();
    } catch (e) { feedback($('alerts-feedback'), e.message, false); }
  };

  // Self-health (Phase 1 of implied goal, 2026-09-10).
  // TRD-UI-1: the three self-checks. Wired here beside the self-health run control, because they answer
  // the same class of question (is the desk able to read the world?) from the one tab an operator opens
  // when something looks wrong.
  for (const [id, which] of [['btn-test-sql', 'sql'], ['btn-test-model', 'model'], ['btn-test-bridge', 'bridge']]) {
    if ($(id)) $(id).onclick = () => testPing(which);
  }
  if ($('btn-calendar-import')) $('btn-calendar-import').onclick = importCalendarFromVenue;
  if ($('btn-health-run')) {
    $('btn-health-run').onclick = async () => {
      feedback($('health-feedback'), 'checking…');
      try {
        const r = await apiPost('/api/trading/self-health/run');
        if (r.skipped) feedback($('health-feedback'), `skipped — ${r.skipped}`, false);
        else feedback($('health-feedback'), `status ${r.status} (${r.bad} bad / ${r.warn} warn)`);
        await refreshHealth();
      } catch (e) { feedback($('health-feedback'), e.message, false); }
    };
  }

  if (isLoggedIn()) showApp(); else showLogin();
  setInterval(() => { if (isLoggedIn()) refreshAll(); }, 30000);
}

boot();

