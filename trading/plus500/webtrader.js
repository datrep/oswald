// trading/plus500/webtrader.js — page objects for Plus500 WebTrader (read-only).
// Amendment A1: all selectors come from a SELECTOR_MAP (defaults below, overridden
// by TradingSettings.selectors.map — hot-patchable without a redeploy). Refs in
// the Plus500 DOM regenerate per snapshot, so we use text/aria heuristics + DOM
// scanning, never Playwright snapshot refs.
/* global document, window, location, getComputedStyle, HTMLInputElement, CIQ */ // page.evaluate callbacks run in the browser context
'use strict';

const { jitterDelay } = require('../lib/pacing');
const classMatch = require('./matching'); // TRD-36: class-aware name matching
// TRD-TRL-2 (#1485): the trailing-stop ARITHMETIC, kept in a pure module so a unit test can pin it without the
// live bridge. Everything below this line is the DOM half; everything that can silently cost money is in there.
const {
  plan: planTrailingStop, distanceFromPercent, pipsForTarget, distanceForCount, verifyReadback,
  verifyStopRelationship,
} = require('../agent/trailingStop');

const URLS = {
  trade: 'https://app.plus500.com/trade',
  positions: 'https://app.plus500.com/open-positions',
  closedPositions: 'https://app.plus500.com/closed-positions',
  orders: 'https://app.plus500.com/open-orders',
};

// symbol -> Plus500 category page URL (captured from the user's click-through;
// /trade/commodities = ETF commodities, /trade/all-commodities = spot).
const CATEGORY_URLS = {
  cryptocurrencies: 'https://app.plus500.com/trade/cryptocurrencies',
  commodities: 'https://app.plus500.com/trade/all-commodities',
  singapore: 'https://app.plus500.com/trade/singapore',
  'hong-kong': 'https://app.plus500.com/trade/hong-kong',
};
// Some category lists are split across paginated URLs (e.g. hong-kong--s-z).
const CATEGORY_FALLBACKS = {
  'hong-kong': 'https://app.plus500.com/trade/hong-kong--s-z',
};
const SYMBOL_CATEGORY = {
  bitcoin: 'cryptocurrencies', ethereum: 'cryptocurrencies', solana: 'cryptocurrencies', bnb: 'cryptocurrencies',
  gold: 'commodities', silver: 'commodities', oil: 'commodities', 'soybean oil': 'commodities',
  // Soft commodities live on the same all-commodities page (2026-09-10:
  // missing map entries made Sugar entries fail with "category page missing").
  sugar: 'commodities', 'arabica coffee': 'commodities', coffee: 'commodities', gasoline: 'commodities',
  sgx: 'singapore', shein: 'hong-kong',
  // 2026-09-14 (TRD-50): the watchlist has drifted since this map was written, and an unmapped
  // symbol does not fail softly — openInstrument throws `no category mapping for <symbol>`, so
  // POST /watchlist/open answers a 500 and the symbol can never be probed. Geely Automobile
  // failed exactly that way while the other two were blocked by transient page failures.
  // Category assignment follows the desk's own precedent rather than a guess: SHEIN is pinned to
  // 'hong-kong' and the discoverer reads HK listings off that same page, while every commodity
  // (Gold/Silver/Oil/Sugar/Coffee/Gasoline) lives on 'commodities'.
  'brent oil': 'commodities',
  'geely automobile': 'hong-kong', 'china shenhua': 'hong-kong', 'swire pacific': 'hong-kong',
  sats: 'singapore',
  // ★★ 2026-10-02: BOTH INSTRUMENTS ADDED ON 2026-09-30 WERE MISSING FROM THIS MAP, AND ONE OF THEM FAILED LIVE.
  //
  // `openInstrument` SEARCHES FIRST and returns `via: 'search'` on a hit; the category is only consulted when the
  // search misses. So a symbol with no entry fails ONLY when search misses — and then it THROWS
  // `no category mapping for <symbol>` rather than landing on a page. Measured live 2026-10-02:
  //
  //     POST /watchlist/open {"symbol":"Natural Gas"}  ->  "no category mapping for Natural Gas"
  //     POST /watchlist/open {"symbol":"Gold"}         ->  via=search, ticket price 4175.63
  //
  // ⚠ THE MAP ALREADY HAD `'soybean oil'` AND NOT `'soybeans'` — the same omission, hidden only because risk
  // vetoed Soybeans on `venue_minimum` before it could ever reach the order path. Two of the four symbols added
  // on 2026-09-30 were unmapped; the other two (SGX, Ethereum) happened to be covered.
  //
  // ⚠ AND THIS IS THE RECURRING SHAPE: a PER-SYMBOL fact that must be updated by hand when a symbol is added, in
  // a place nothing tests. `test/venue-category-coverage.test.js` now pins the whole watchlist against this map,
  // so the next symbol added fails a test instead of failing at the venue.
  'natural gas': 'commodities', soybeans: 'commodities',
};

// Default selector/text map. Values are plain text anchors or DOM hints.
const DEFAULT_SELECTOR_MAP = {
  navTrade: 'Trade',
  navPositions: 'Open Positions',
  navOrders: 'Orders',
  searchCombobox: 'Search our Instruments',
  demoMarker: 'Switch to Real Money',
  logout: 'Log out',
  accountLabels: ['Available', 'Equity', 'M. Margin', 'Profit/Loss'],
  positionsHeaders: ['Type / Instrument', 'Net P&L', 'Current Rate', 'Opening Rate', 'Open Time', 'Limit / Stop'],
  ordersHeaders: ['Type / Instrument', 'Value', 'Current Rate', 'Order rate', 'Created', 'Limit / Stop'],
  instrumentsHeaders: ['Buy', 'Sell'],
  marketClosed: 'Market is closed',
};

function selectorMap(settings) {
  return { ...DEFAULT_SELECTOR_MAP, ...((settings && settings.selectors && settings.selectors.map) || {}) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Plus500's generic connectivity error page. Treated as a distinct, soft-block-
// or-stale-session signal: never hammer, retry with backoff, count toward the
// UI Fallback Pause gate.
const CONN_ERROR_TEXT = 'Could not connect to the server';

// ★ THE NAVIGATION BUDGET IS A PARAMETER (2026-09-17), and the default preserves the old behaviour
// exactly (45s + 15s + 45s + 15s = up to 120s of held tab). That worst case MATCHED the capture's
// `waitMs: 120000` to the millisecond, so any page slow enough to burn its budget starved the desk's
// own market data feed: `plus500_frontend captured:0 — bridge busy (watchdog) — lock wait exceeded`.
// A caller that must not hold the shared tab for long (the watchdog's periodic login ping) now says
// so, instead of every caller inheriting the slowest case.
async function gotoPage(page, route, _settings, { timeoutMs = 45000, contentWaitMs = 15000 } = {}) {
  const url = URLS[route];
  if (!url) throw new Error(`unknown route: ${route}`);
  const contentIters = Math.max(0, Math.ceil(contentWaitMs / 500));
  await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
  // SPA boot can take several seconds (spinner + 'Loading...' title); wait for
  // real content, reload once if it stays blank.
  let bodyText = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 400) : '')).catch(() => '');
  for (let i = 0; i < contentIters && bodyText.length < 40; i++) {
    await sleep(500);
    bodyText = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 400) : '')).catch(() => '');
  }
  if (bodyText.length < 40) {
    await page.reload({ timeout: timeoutMs, waitUntil: 'domcontentloaded' }).catch(() => {});
    for (let i = 0; i < contentIters && bodyText.length < 40; i++) {
      await sleep(500);
      bodyText = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 400) : '')).catch(() => '');
    }
  }
  if (bodyText.includes(CONN_ERROR_TEXT)) {
    const err = new Error('plus500_connection_error');
    err.connError = true;
    throw err;
  }
  return { url: page.url(), loggedIn: await isLoggedIn(page) };
}

// Retry a bridge action with human-scale backoff on connection errors.
async function withConnRetry(fn, { attempts = 3, baseDelayMs = 5000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!e || !e.connError) throw e;
      const delay = baseDelayMs * Math.pow(3, i) + Math.random() * 2000; // 5s, 15s, 45s
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function pageText(page, max = 5000) {
  return page.evaluate((m) => (document.body ? document.body.innerText.slice(0, m) : ''), max).catch(() => '');
}

// ★★★ 2026-09-27: THE DEMO MARKER IS IN A *COLLAPSED* MENU, SO `innerText` CANNOT SEE IT.
//
// THE DEFECT, MEASURED. `assertDemo` looks for the literal string 'switch to real money', which lives in the
// Plus500 account menu — and it read the page with `document.body.innerText`, which **omits hidden and
// unrendered elements**. A COLLAPSED menu contributes nothing to `innerText` but is fully present in
// `textContent`. So on a page whose account menu is closed, the guard reported "demo marker NOT found" for a
// page that is demonstrably a DEMO account, and `not_demo` is FAIL-CLOSED at four call sites
// (capture.js:579 tick capture, connector/browser.js:196 the order path, discoverer.js:107, routes.js:1428/1438)
// — so the desk stopped capturing prices and stopped placing orders on a healthy session.
//
// WHY THE SYMPTOM LOOKED LIKE A LOGIN PROBLEM, which cost two days: the ACCOUNT BANNER still rendered
// ('Available'/'Equity' are visible text), so `readAccount` kept returning a balance while every other read was
// refused. A stale-but-plausible equity on the Health card, next to a refusal everywhere else, reads exactly
// like a dead session. It was never the session.
//
// WHY THIS STILL FAILS CLOSED. The previous fix in this area widened the search from 5000 chars to the whole
// body and argued it could not weaken the guard because "the marker only ever appears on a DEMO account, so
// searching more text can only ever find a real demo marker, never invent one". **The same argument holds
// verbatim for `textContent`** — it can only surface MORE of the SAME page's own text. On a real-money account
// the menu offers 'switch to demo', so the demo-only string is still absent and the guard still refuses.
//
// ⚠ `textContent` is a SUPERSET and it is noisier (it includes scripts, styles and hidden nodes), so it is used
// only for the DEMO MARKER check — a boolean that needs one exact string — and NOT for the callers that parse
// layout or read rendered values. `pageText` is deliberately left as `innerText` for those.
async function pageTextIncludingHidden(page, max = 400000) {
  return page.evaluate((m) => {
    if (!document.body) return '';
    const visible = document.body.innerText || '';
    const all = document.body.textContent || '';
    // Visible text first, then the rest. The marker is searched for in the concatenation, so order only affects
    // which copy a human reading a truncation would see.
    return (visible + '\n' + all).slice(0, m);
  }, max).catch(() => '');
}

// IS THE SESSION ALIVE? ★ REWRITTEN 2026-10-03 — THE RENDER-TIMING FALSE NEGATIVE.
//
// MEASURED (temp/bridge-probe6-2026-10-03.js, 09:24-09:25 UTC): the shared tab is navigated several
// times a minute (the mirror's TRD-11 cycle), and EVERY navigation rebuilds the SPA shell — for
// ~2-3 seconds afterwards `document.body.innerText` reads 0-1 characters while the shell markup is
// already in `textContent`. Settled /open-positions: innerText 788 chars with 'Available' at 222 and
// 'Equity' at 245, seven `li[automation]` cells, both <strong> labels. The same tab one beat earlier,
// mid-navigation: innerText 1 char, zero `li[automation]` cells, no words.
//
// A reader that samples the tab at an arbitrary instant therefore sees "signed out" whenever it lands
// in the shell window — which is how the watchdog paged the owner with false "plus500 signed out"
// alerts on 2026-10-03 while the account strip was demonstrably alive (the 09:13:45Z account event was
// read 56 s INSIDE a declared death window). See docs/incident-2026-10-03-false-login-death.md.
//
// THE FIX READS EVIDENCE THAT IS INDEPENDENT OF RENDER TIMING. The account strip's own cells —
// `li[automation="available-balance"]` / `li[automation="equity"]`, the exact elements
// `readAccountStatus` parses — mount with the shell and exist only for a signed-in session; so do the
// 'Available'/'Equity' <strong> labels `readAccount` parses. Both are DOM-structural: no layout
// needed, no innerText, no 5000-char window. The rendered-text read REMAINS as the fallback (a UI
// variant that shows the banner without either structural marker still resolves), widened from the
// historical first-5000 window to the whole body — the same truncation class fixed for `assertDemo`
// on 2026-09-27. Fail-closed is unchanged: a signed-out tab lands on the login UI, which carries none
// of this evidence and whose URL leaves app.plus500.com.
async function isLoggedIn(page) {
  try {
    const url = page.url();
    if (!/app\.plus500\.com/.test(url)) return false;
    const dom = await page.evaluate(() => {
      if (document.querySelector('li[automation="available-balance"]') && document.querySelector('li[automation="equity"]')) return true;
      let sa = false;
      let se = false;
      for (const s of document.querySelectorAll('strong')) {
        const t = (s.textContent || '').trim().replace(/\.$/, '');
        if (t === 'Available') sa = true;
        else if (t === 'Equity') se = true;
        if (sa && se) return true;
      }
      return false;
    }).catch(() => false);
    if (dom) return true;
    const text = await pageText(page, 400000);
    return text.includes('Available') && text.includes('Equity');
  } catch {
    return false;
  }
}

// ★ A NEGATIVE IN-PLACE READ MUST BE ALLOWED TO RESOLVE BEFORE IT IS A VERDICT (2026-10-03).
// The watchdog's verify path navigates, which OPENS A FRESH SHELL WINDOW of the same kind the read
// just stumbled into; a verdict taken inside that window is a coin flip on render timing, and the
// watchdog PAGES THE OWNER on `loggedIn:false`. This helper polls long enough for the SPA to boot,
// and distinguishes three outcomes the caller must not conflate:
//   - loggedIn:true            — account evidence appeared; the session is alive.
//   - loggedIn:false, settled  — the page RENDERED (plenty of text) and still shows no account
//                                evidence for two consecutive samples; a real logout renders
//                                exactly this shape.
//   - !settled                 — the page never finished rendering inside the budget (shell the
//                                whole time). That is a render problem, not a signed-out session,
//                                and the caller must SKIP rather than accuse.
// The two-sample settled rule exists because the shell mounts progressively; a single 200-char
// sample can be caught before the account strip mounts (settled innerTexts observed: 297-788 chars).
async function waitForLogin(page, { timeoutMs = 8000, pollMs = 750, settledMinChars = 200 } = {}) {
  const started = Date.now();
  let settledStreak = 0;
  let bodyLen = 0;
  for (;;) {
    if (await isLoggedIn(page)) return { loggedIn: true, waitedMs: Date.now() - started };
    bodyLen = (await pageText(page, settledMinChars + 100)).length;
    settledStreak = bodyLen >= settledMinChars ? settledStreak + 1 : 0;
    const waitedMs = Date.now() - started;
    if (settledStreak >= 2) return { loggedIn: false, settled: true, waitedMs, bodyLen };
    if (waitedMs >= timeoutMs) return { loggedIn: false, settled: false, waitedMs, bodyLen };
    await sleep(pollMs);
  }
}

// IS THE PAGE ACTUALLY RENDERED? A blank body is a DEAD RENDER, not a login problem and not an
// absence of the marker we happen to be looking for. Measured repeatedly on 2026-09-14: after a
// burst of per-symbol navigations the shared tab settles at `document.body.innerText` of 0-1
// characters, and every guard that reads the page then reports its own failure —
//   assertDemo  -> "demo marker NOT found in 1 chars of body text"
//   isLoggedIn  -> false (no 'Available'/'Equity'), so healthCheck says `login_required`
//   bankChartBars -> no_chart_engine
// Three different symptoms, ONE cause, and each one blamed itself.
//
// `recoverTradePage` is the single recovery for that cause: navigate the tab back to the trade
// route (which forces a fresh render) and report what the page actually is afterwards. It is
// deliberately a NAVIGATION rather than a `page.reload()` — reload keeps whatever route the SPA
// drifted to, which is how a tab parked on an instrument ticket stays unusable.
async function recoverTradePage(page) {
  const before = await pageText(page, 120);
  try {
    await gotoPage(page, 'trade');
    await sleep(1500); // the SPA boots asynchronously; a read straight after goto can still be blank
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 120), bodyLenBefore: before.length, bodyLenAfter: null };
  }
  const after = await pageText(page, 200);
  return { ok: after.length > 20, bodyLenBefore: before.length, bodyLenAfter: after.length, url: String(page.url()).slice(0, 120) };
}

// ★ SOFT PARK (2026-10-05, #1511): park the tab on /open-positions via the app's OWN nav button —
// proved live to be a CLIENT-SIDE route change (JS marker survives, no document load, no splash).
// This is the "soft navigation" the operator asked for; DIRECT URL loads produce the loading screen
// and the truncated first render instead. Falls back to the caller's hard navigation when the button
// is absent or the route does not change within the race.
async function softParkOpenPositions(page, { timeoutMs = 8000 } = {}) {
  const before = String(page.url() || '');
  if (/\/open-positions/.test(before)) return { ok: true, via: 'already' };
  const sel = '[data-testid="NavigationBar.Button.openPositionsNav.Open"], [data-testid="NavigationBar.Button.openPositionsNav"]';
  try {
    await page.locator(sel).first().click({ timeout: 5000 });
  } catch (e) {
    return { ok: false, via: 'no_button', error: String(e.message || e).slice(0, 100) };
  }
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (/\/open-positions/.test(String(page.url() || ''))) return { ok: true, via: 'nav_button', ms: Date.now() - t0 };
    await sleep(250);
  }
  return { ok: false, via: 'no_change', ms: Date.now() - t0 };
}

// DEMO-ONLY guard: the demo account shows a "Switch to Real Money" item.
// Fail-closed: if we can't CONFIRM demo, report demo:false and refuse orders (P3).
//
// ★ THE 5000-CHARACTER BLIND SPOT — FIXED 2026-09-14. This used the default `pageText(page)`,
// which returns only the FIRST 5000 CHARACTERS of `document.body.innerText`. The marker lives in
// an account menu, so on a page whose text runs longer than the window it is simply not in the
// string being searched — and the guard then reports "NOT found" for a page that DOES show it.
//
// Measured consequence: `not_demo` is fail-closed at FOUR call sites — capture.js:237
// (tick capture), connector/browser.js:171 (the order path), discoverer.js:107 and
// routes.js:943 (watchlist open). So a false negative here does not merely skip a check, it
// stops price capture AND order placement outright. Observed live: 0/12 watchlist navigations,
// and a capture returning `captured: 0`, on a page that was demonstrably healthy — the earlier
// run on the same session had reported `banner=open` and written 15 quotes per symbol.
//
// The window is now the WHOLE body text. This cannot weaken the guard: the marker only ever
// appears on a DEMO account, so searching more text can only ever find a real demo marker, never
// invent one. A real-money account still fails closed. What it stops is the guard refusing a
// correctly-configured desk because its page had grown past an arbitrary truncation.
//
// The failure detail now reports the text length, so the next occurrence is diagnosable from the
// telemetry instead of being a bare "NOT found" — which is how the BLANK-page case above was
// separated from a genuine missing marker instead of being guessed at.
async function assertDemo(page, _settings) {
  try {
    // ★ Reads BOTH innerText and textContent — see `pageTextIncludingHidden`. The marker is in a collapsed
    // account menu, so `innerText` alone reports "NOT found" on a healthy DEMO account and that refusal is
    // fail-closed at four call sites.
    const text = await pageTextIncludingHidden(page, 400000);
    const demo = text.toLowerCase().includes('switch to real money');
    // `blank` is reported structurally so callers never have to pattern-match this string to tell
    // "the account is not demo" from "the page has not rendered". Those need opposite responses:
    // one is a refusal, the other is a recovery.
    const blank = text.trim().length <= 20;
    return {
      demo,
      blank,
      bodyLen: text.length,
      detail: demo ? 'demo marker present'
        : (blank ? `page has no content (${text.length} chars) — not evidence about the account`
          : `demo marker NOT found in ${text.length} chars of body text (innerText + textContent)`),
    };
  } catch (e) {
    return { demo: false, blank: false, bodyLen: null, detail: `demo check error: ${String(e.message || e).slice(0, 120)}` };
  }
}

// Account banner: Available / Equity / M. Margin / Profit/Loss.
async function readAccount(page, settings) {
  const map = selectorMap(settings);
  return page.evaluate((labels) => {
    const out = {};
    const strongs = [...document.querySelectorAll('strong')];
    for (const label of labels) {
      const el = strongs.find((s) => s.textContent.trim().replace(/\.$/, '') === label.replace(/\.$/, ''));
      if (!el) continue;
      let node = el;
      for (let i = 0; i < 4 && node; i++) {
        const parent = node.parentElement;
        if (!parent) break;
        const text = parent.textContent.trim();
        const m = text.match(/(S\$|US\$|\$)?\s?([\d,]+\.?\d*)/);
        if (m) { out[label.replace(/\.$/, '')] = { raw: text.replace(/\s+/g, ' '), value: parseFloat(m[2].replace(/,/g, '')) }; break; }
        node = parent;
      }
    }
    return out;
  }, map.accountLabels);
}

// Modern account strip: #accountStatus with li[automation=...] cells (2026 UI).
// Values carry U+200E bidi marks — strip everything non-numeric before parse.
async function readAccountStatus(page) {
  return page.evaluate(() => {
    const el = document.getElementById('accountStatus');
    if (!el) return null;
    const val = (name) => {
      const li = el.querySelector(`li[automation="${name}"]`);
      if (!li) return null;
      const span = li.querySelector('[data-currency], span');
      const clean = String(span ? span.textContent : li.textContent).replace(/[\u200e\u200f\u200b]/g, '').replace(/[^0-9.-]/g, '');
      const n = parseFloat(clean);
      return Number.isFinite(n) ? n : null;
    };
    return {
      available: val('available-balance'),
      equity: val('equity'),
      margin: val('maintenance-margin'),
      pnl: val('total-net-profit-loss'),
    };
  });
}

// --- TRD-11: Plus500 alerts mirror (Plus500 = source of truth) -------------
// Open an instrument's alert sidebar and read whatever it renders for that
// instrument (existing alerts if present, else the blank add-form).
async function readInstrumentAlerts(page, instrumentTestId) {
  await page.click(`[data-testid="${instrumentTestId}"]`, { timeout: 5000 }).catch(() => { throw new Error(`alert bell not clickable for ${instrumentTestId}`); });
  await sleep(1800);
  const dump = await page.evaluate(() => {
    const sb = document.querySelector('#load-sidebar, #sidebar');
    if (!sb) return null;
    const name = sb.querySelector('[data-testid="InstrumentHeader.Button.Name"] strong')?.textContent?.trim() || '';
    const text = sb.innerText.replace(/\s+/g, ' ').slice(0, 400);
    // existing-alert rows (defensive: selectors may drift)
    const rows = [...sb.querySelectorAll('[class*="alert-row" i], [class*="existing" i], [data-testid*="Existing" i], [data-testid*="Alert.Row" i]')]
      .map((el) => el.innerText.replace(/\s+/g, ' ').trim().slice(0, 120))
      .filter(Boolean);
    return { name, text, rows };
  });
  await page.evaluate(() => document.querySelector('[data-testid="AlertsSidebar.AddEdit.CancelNewAlert.Link"]')?.click()).catch(() => {});
  await sleep(600);
  return dump || { name: instrumentTestId, text: '', rows: [] };
}

// Create a PRICE alert via the sidebar (the flow the user documented:
// bell -> sidebar -> rateAlertSpinner -> priceType radio -> Set Alert).
async function createPriceAlert(page, { value, side = 'buy' }) {
  const spinner = page.locator('#rateAlertSpinner');
  await spinner.waitFor({ state: 'attached', timeout: 8000 });
  await spinner.evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(value));
  await page.click(side === 'sell' ? '#priceTypeSell' : '#priceTypeBuy', { timeout: 4000 }).catch(() => {});
  await page.click('#setAlertBtn', { timeout: 5000 });
  await sleep(2000);
  const after = await page.evaluate(() => document.querySelector('#load-sidebar')?.innerText?.replace(/\s+/g, ' ').slice(0, 300) || '');
  if (/could not|error|failed/i.test(after)) throw new Error(`plus500 rejected alert: ${after.slice(0, 120)}`);
  return { ok: true, sidebar: after.slice(0, 200) };
}

// TRD-11: read the instrument's current Buyers % from the alert sidebar's
// Sentiment tab (bell -> Sentiment tab -> sidebar text "Buyers % NN%").
async function readInstrumentSentiment(page, instrumentTestId) {
  await page.click(`[data-testid="${instrumentTestId}"]`, { timeout: 5000 }).catch(() => { throw new Error(`alert bell not clickable for ${instrumentTestId}`); });
  await sleep(1800);
  await page.evaluate(() => document.querySelector('[data-testid="AlertsSidebar.AddEdit.Tabs.Sentiment.Tab"]')?.click()).catch(() => {});
  await sleep(1200);
  const out = await page.evaluate(() => {
    const sb = document.querySelector('#load-sidebar');
    const text = sb ? sb.innerText.replace(/\s+/g, ' ') : '';
    const m = text.match(/Buyers\s*%\s*([\d.]+)\s*%?/i);
    const name = sb && sb.querySelector('[data-testid="InstrumentHeader.Button.Name"] strong')
      ? sb.querySelector('[data-testid="InstrumentHeader.Button.Name"] strong').textContent.trim() : null;
    return { name, buyersPct: m ? parseFloat(m[1]) : null };
  });
  await page.evaluate(() => document.querySelector('[data-testid="AlertsSidebar.AddEdit.CancelNewAlert.Link"]')?.click()).catch(() => {});
  await sleep(600);
  return out;
}

// Generic table reader: find the table whose header row contains the first of the
// given headers, then map rows by header text.
async function readTable(page, headers) {
  return page.evaluate((needles) => {
    const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ');
    const tables = [...document.querySelectorAll('table')];
    for (const tbl of tables) {
      const headRow = tbl.querySelector('thead tr, tr');
      if (!headRow) continue;
      const headCells = [...headRow.querySelectorAll('th, td')].map((c) => c.textContent.trim());
      if (!headCells.length) continue;
      const idx = headCells.findIndex((h) => needles.some((n) => norm(h).includes(norm(n))));
      if (idx === -1) continue;
      const rows = [];
      for (const tr of tbl.querySelectorAll('tbody tr, tr')) {
        if (tr === headRow) continue;
        const cells = [...tr.querySelectorAll('td, th')].map((c) => c.textContent.trim().replace(/\s+/g, ' '));
        if (!cells.length || !cells.some((c) => c)) continue;
        rows.push(cells);
      }
      if (rows.length) return { headers: headCells, rows };
    }
    return null;
  }, headers);
}

function parseMoney(text) {
  const m = String(text || '').match(/-?[\d,]+(?:\.\d+)?/);
  return m ? parseFloat(m[0].replace(/,/g, '')) : null;
}

// Shared self-contained DOM parser for open positions (runs inside the page).
function positionsEval() {
  const clean = (s) => (s || '').replace(/[\u200e\u200f\u200b\u00a0]/g, '').trim().replace(/\s+/g, ' ');
  const num = (s) => {
    const m = clean(s).match(/-?[\d,]+(?:\.\d+)?/);
    return m ? parseFloat(m[0].replace(/,/g, '')) : null;
  };
  const rowIds = [...new Set(
    [...document.querySelectorAll('[data-testid]')]
      .map((el) => el.getAttribute('data-testid') || '')
      .filter((t) => /^OpenPosition\.\d+$/.test(t))
  )];
  const items = [];
  for (const testid of rowIds) {
    const id = testid.split('.')[1];
    const row = document.querySelector(`[data-testid="${testid}"]`);
    const cell = (suffix) => document.querySelector(`[data-testid="${id}.${suffix}"]`)
      || row && row.querySelector(`[data-testid$=".${suffix}"]`)
      || row && row.querySelector(`.position-${suffix.toLowerCase()}, .${suffix.toLowerCase()}`);
    let nameEl = row && row.closest('[data-testid^="OpenPositions.Group."]')
      ? row.closest('[data-testid^="OpenPositions.Group."]').querySelector('[data-testid$=".InstrumentName"]')
      : null;
    if (!nameEl) {
      let g = row && row.previousElementSibling;
      while (g && !g.classList.contains('position-group-title')) g = g.previousElementSibling;
      nameEl = g && g.querySelector('strong');
    }
    if (!nameEl) nameEl = row && row.querySelector('.name, strong.name');
    const dirEl = cell('Direction');
    const amtEl = cell('Amount');
    const curEl = cell('CurrentRate');
    const openEl = cell('OpenRate');
    const pnlEl = cell('NetPL');
    const amt = amtEl ? clean(amtEl.textContent) : '';
    const sizeM = amt.match(/([\d,.]+(?:\.[\d]+)?)\s*(Options|Shares|Contracts|Troy Ounces|Barrels|Units)/i);
    const dirText = dirEl ? clean(dirEl.textContent).toLowerCase() : null;
    items.push({
      positionId: id || null,
      name: nameEl ? clean(nameEl.textContent) : null,
      direction: /buy|sell/.test(dirText || '') ? (/sell/.test(dirText) ? 'sell' : 'buy') : null,
      size: sizeM ? parseFloat(sizeM[1].replace(/,/g, '')) : null,
      units: sizeM ? sizeM[2] : null,
      currentRate: curEl ? num(curEl.textContent) : null,
      openingRate: openEl ? num(openEl.textContent) : null,
      pnl: pnlEl ? num(pnlEl.textContent) : null,
    });
  }
  // TRD-106: `sawDom` is the part that makes an EMPTY read meaningful — the positions page rendered
  // (group title or rows), so "no rows" is a flat venue rather than a page that has no positions on it.
  return {
    items,
    empty: items.length === 0,
    sawDom: !!(document.querySelector('[data-testid^="OpenPosition."]') || document.querySelector('.position-group-title')),
  };
}

// TRD-EXE-1 (#1454) — MEASURE THE VENUE'S ORDER BOOK. This is a SHAPE MEASUREMENT, not a reader, and
// the name says so on purpose.
//
// WHY NOT A READER YET. `readOrders` above is a TABLE reader keyed on header text, written before the
// app moved to a data-testid DOM — the same shape `readPositions` had to abandon. For the ORDER list it
// is worse than merely stale: **nothing in this repo has ever SEEN its row testid**, so no selector here
// can be asserted, only OBSERVED. `#1454` item 4 is blocked on exactly that prefix, and guessing it is
// strictly worse than the ambiguity it would remove: a POSITION mislabelled as a queued order makes the
// desk believe a fill did NOT happen when it had.
//
// So this reports the shape it found. The first run against the live venue IS the measurement; every
// later run is then self-documenting instead of an argument about a prefix nobody wrote down.
//
// READ-ONLY. It navigates, waits and reads. There is NO click in this function, so it cannot cancel or
// modify anything at the venue. The cancel/adopt half of item 2 must be written separately, deliberately,
// and against a testid this measurement has actually produced.
function orderBookEval() {
  const clean = (s) => (s || '').replace(/[\u200e\u200f\u200b\u00a0]/g, '').trim().replace(/\s+/g, ' ');
  const all = [...document.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid') || '');
  const histogram = {};
  for (const t of all) { const k = String(t).split('.')[0]; histogram[k] = (histogram[k] || 0) + 1; }
  // Row candidates, using the app's OWN observed convention (<Prefix>.<numeric id> as in OpenPosition.<id>
  // and AlertsSidebar.List.Row.<id>) — reported as candidates, never used as if they were known.
  const rowLike = [...new Set(all.filter((t) => /^[A-Za-z][\w-]*\.[\w-]+\.\d+$/.test(t) || /^[A-Za-z][\w-]*\.\d+$/.test(t)))];
  const orderish = [...new Set(all.filter((t) => /order/i.test(t)))];
  const text = clean(document.body ? document.body.innerText : '');
  // ⚠ THE FIRST RUN OF THIS MEASUREMENT WAS WRONG, AND THIS IS THE FIX. The mount check accepted ANY
  // testid as "the app rendered", so a page carrying only overlay chrome — measured: exactly 4 testids,
  // `InactivityTimer` x2, `WalkThrough`, `Dialog`, and an EMPTY body — was reported as `mounted:true` with
  // no rows, which reads as "the venue has no orders". It does not mean that. An overlay is not content,
  // and a blank body is the TRD-66 dead render this repo already knows about.
  // So the shape now separates the three cases that were collapsed: CONTENT (an order list), OVERLAY-ONLY
  // (chrome mounted, route did not render), and NOTHING (the app never booted).
  const overlayTestids = [...new Set(all.filter((t) => /^(InactivityTimer|WalkThrough|Dialog|Modal|Toast|Cookie)/i.test(String(t))))];
  const dialogSel = '[role="dialog"], [data-testid="Dialog"], .modal, [class*="dialog" i]';
  const dialogText = [...document.querySelectorAll(dialogSel)]
    .map((el) => clean(el.textContent)).filter(Boolean).slice(0, 5).map((s) => s.slice(0, 300));
  // Shadow roots: if the app renders inside a custom element, innerText on <body> is EMPTY while the
  // content is really there. Counting this is the difference between "nothing rendered" and "this reader
  // cannot see what rendered".
  let shadowLen = 0;
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { shadowLen += clean(el.shadowRoot.textContent || '').length; walk(el.shadowRoot); }
    }
  };
  try { walk(document); } catch { /* a detached root can throw during teardown */ }
  const htmlLen = document.documentElement ? document.documentElement.outerHTML.length : 0;
  return {
    url: String(location.href).slice(0, 200),
    testidCount: all.length,
    histogram,
    rowLike: rowLike.slice(0, 60),
    orderish: orderish.slice(0, 60),
    sawDom: all.length > 0,
    bodyLen: text.length,
    htmlLen,
    shadowLen,
    overlayTestids,
    dialogText,
    contentState: rowLike.length > 0 ? 'content'
      : (all.length > 0 || shadowLen > 200) ? 'overlay_or_shell_only'
        : htmlLen > 5000 ? 'shell_only' : 'nothing_rendered',
    bodyText: text.slice(0, 1200),
    bodySignals: {
      edit: /\bEdit\b/i.test(text),
      cancel: /\bCancel\b/i.test(text),
      noOrders: /no (open )?orders|no results|nothing to show|no data/i.test(text),
      signIn: /sign in|log in|password/i.test(text),
    },
  };
}

// Navigates to the order book, waits for the app to mount, and measures it. Read-only: no clicks.
// Parked back on /open-positions afterwards, which is where the mirror poller expects the tab.
async function readOrderBookShape(page) {
  const urlBefore = String(page.url()).slice(0, 200);
  if (!String(page.url()).includes('/open-orders')) {
    await withConnRetry(() => page.goto(URLS.orders, { timeout: 45000, waitUntil: 'domcontentloaded' }));
  }
  // Poll for the app to mount rather than sleeping a fixed time — a fixed sleep is what made the first
  // sidebar probe read a sidebar that was not there yet, and a longer sleep is not a fix for that.
  // ⚠ "MOUNTED" MUST MEAN CONTENT, NOT CHROME. The first version of this waited on
  // `document.querySelectorAll('[data-testid]').length > 0` and therefore returned success on a page whose
  // only testids were `InactivityTimer`/`WalkThrough`/`Dialog` with an empty body. The wait condition is
  // now the thing we actually need: a rendered body, or a row-shaped testid.
  const deadline = Date.now() + 30000;
  let mounted = false;
  while (Date.now() < deadline) {
    mounted = await page.evaluate(() => {
      const bodyLen = document.body ? document.body.innerText.trim().length : 0;
      const rows = document.querySelectorAll('[data-testid]').length;
      return bodyLen > 300 || rows > 8;
    }).catch(() => false);
    if (mounted) break;
    await page.waitForTimeout(500);
  }
  const shape = await page.evaluate(orderBookEval);
  return { ...shape, urlBefore, mounted, waitedForMount: mounted };
}

async function readPositions(page, _settings) {
  // Current DOM (2026): rows carry data-testid "OpenPosition.<id>" with
  // per-id cells "<id>.Type/.Direction/.Amount/.NetPL/.CurrentRate/.OpenRate",
  // grouped under "OpenPositions.Group.<instrumentId>" (name =
  // "OpenPositions.Group.<id>.InstrumentName"). Older DOM had
  // .position-group-title + .position-direction/.amount/.current-rate.
  if (!String(page.url()).includes('/open-positions')) {
    await withConnRetry(() => page.goto(URLS.positions, { timeout: 45000, waitUntil: 'domcontentloaded' }));
  }
  await page.waitForFunction(
    () => document.querySelector('.position-group-title') || document.querySelector('[data-testid^="OpenPosition."]'),
    null,
    { timeout: 20000 }
  ).catch(() => {});
  await page.waitForTimeout(1500); // let lazy rows render
  return page.evaluate(positionsEval);
}

// TRD-11: evaluate-only read (NO navigation) — used by the 1s live poller
// when the bridge tab is already on /open-positions.
// 2026-09-11: report onPage so callers can distinguish "read is definitive"
// (we are ON the positions page and parsed it) from "page has no position
// DOM at all" (parked elsewhere -> items=[] is NOT evidence of zero positions).
// TRD-106 (2026-09-19): `onPage` is a SUBSTRING TEST on page.url(), and callers were using it as
// the gate for rows they had already parsed — so when Plus500 rewrites the URL after the app boots,
// a row read off the live DOM was discarded for failing a string test. It is kept as one signal
// among three: `items` (rows exist — evidence by itself), `sawDom` (the positions DOM was present,
// so `items.length === 0` is a genuine FLAT read), `onPage` (the URL says so). Only the EMPTY case
// needs the second and third; a parsed row needs nothing else.
async function readPositionsLive(page) {
  const r = await page.evaluate(positionsEval);
  return { ...r, onPage: String(page.url()).includes('/open-positions') };
}

// Active price alerts list: https://app.plus500.com/trade/alerts renders a
// sidebar list with rows "AlertsSidebar.List.Row.<id>" + ListItem cells
// (InstrumentName / Type / Threshold). The user's 3 alerts live here.
async function readPlus500Alerts(page) {
  if (!String(page.url()).includes('/trade/alerts')) {
    await withConnRetry(() => page.goto('https://app.plus500.com/trade/alerts', { timeout: 45000, waitUntil: 'domcontentloaded' }));
  }
  await page.waitForFunction(
    () => document.querySelector('[data-testid^="AlertsSidebar.List.Row."]') || document.querySelector('[data-testid="AlertsSidebar.List.Container"]'),
    null,
    { timeout: 20000 }
  ).catch(() => {});
  await page.waitForTimeout(1200);
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/[\u200e\u200f\u200b\u00a0]/g, '').trim().replace(/\s+/g, ' ');
    const items = [...document.querySelectorAll('[data-testid^="AlertsSidebar.List.Row."]')].map((row) => {
      const tid = row.getAttribute('data-testid') || '';
      const cell = (k) => row.querySelector(`[data-testid="AlertsSidebar.ListItem.${k}"]`);
      return {
        id: tid.split('.').pop() || null,
        instrument: cell('InstrumentName') ? clean(cell('InstrumentName').textContent) : null,
        type: cell('Type') ? clean(cell('Type').textContent) : null,
        threshold: cell('Threshold') ? clean(cell('Threshold').textContent) : null,
      };
    });
    return { items, empty: items.length === 0 };
  });
}

async function readOrders(page, settings) {
  const map = selectorMap(settings);
  const tbl = await readTable(page, map.ordersHeaders);
  if (!tbl) return { items: [], empty: true };
  const h = tbl.headers.map((x) => x.toLowerCase());
  const col = (name) => h.findIndex((x) => x.includes(name));
  const items = [];
  for (const cells of tbl.rows) {
    if (!cells[0] || /^Edit|^Cancel$/i.test(cells[0])) continue;
    const dir = /\bsell\b/i.test(cells.join(' ')) && !/\bbuy\b/i.test(cells.join(' ')) ? 'sell'
      : /\bbuy\b/i.test(cells.join(' ')) ? 'buy' : null;
    items.push({
      name: cells[0],
      direction: dir,
      value: col('value') >= 0 ? parseMoney(cells[col('value')]) : null,
      currentRate: col('current rate') >= 0 ? parseMoney(cells[col('current rate')]) : null,
      orderRate: col('order rate') >= 0 ? parseMoney(cells[col('order rate')]) : null,
    });
  }
  return { items, empty: items.length === 0 };
}

// Trade page instrument rows: name + Sell (bid) / Buy (ask) buttons + market state.
async function readTradeInstruments(page, settings) {
  const map = selectorMap(settings);
  return page.evaluate((closedText) => {
    const rows = [];
    const buttons = [...document.querySelectorAll('button')];
    for (const b of buttons) {
      const label = (b.textContent || '').trim();
      const m = label.match(/^(Buy|Sell)\s+([\d,.]+)$/);
      if (!m) continue;
      let container = b;
      for (let i = 0; i < 6 && container; i++) {
        container = container.parentElement;
        if (!container) break;
        const text = (container.textContent || '').trim().replace(/\s+/g, ' ');
        if (text.length > 8 && !/^(Buy|Sell)\s/.test(text)) {
          const closed = text.toLowerCase().includes((closedText || 'market is closed').toLowerCase());
          const name = text.split(/[-+]?\d+(?:\.\d+)?%/)[0].replace(/\s+/g, ' ').trim().split(/\s{2,}/)[0];
          rows.push({ name: name || '?', [m[1].toLowerCase()]: parseFloat(m[2].replace(/,/g, '')), closed, raw: text.slice(0, 200) });
          break;
        }
      }
    }
    // merge buy+sell by name proximity (same row)
    const merged = [];
    const byName = new Map();
    for (const r of rows) {
      if (!byName.has(r.name)) byName.set(r.name, { name: r.name, closed: r.closed });
      Object.assign(byName.get(r.name), r);
    }
    for (const v of byName.values()) merged.push(v);
    return merged;
  }, map.marketClosed);
}

// Search for an instrument and select it: fill the search box, press Enter
// (selects the first result — human-like), read the trade ticket (the only
// Buy/Sell buttons after selection) + the 'Current buy/sell rate' blocks.
// Edge cases handled: no results, slow dropdown (exact-text click fallback),
// market-closed instruments, thousands-separated prices, previous-selection
// leftovers.
// The loaded category page renders instruments in .instrument-table-container.
// A row (.instrument-row) has direct children: .name, .change ("-0.92%"),
// .button-sell ("Sell 78,311.67"), .button-buy ("Buy 78,429.23").
// Text may carry invisible bidi marks (U+200E/U+200F) — strip before parsing.
async function readInstrumentTable(page) {
  return page.evaluate(() => {
    const clean = (s) =>
      (s || '').replace(/[\u200e\u200f\u200b\u00a0]/g, '').trim().replace(/\s+/g, ' ');
    const num = (s) => {
      const m = clean(s).match(/[\d,]+(?:\.\d+)?/);
      return m ? parseFloat(m[0].replace(/,/g, '')) : null;
    };
    const container = document.querySelector('[class*="instrument-table-container"]');
    if (!container) return { rows: [], error: 'no_instrument-table-container' };
    const rows = [];
    for (const rowEl of container.querySelectorAll('[class*="instrument-row"]')) {
      const nameEl = rowEl.querySelector('.name');
      if (!nameEl) continue;
      const changeEl = rowEl.querySelector('.change');
      const sellEl = rowEl.querySelector('.button-sell');
      const buyEl = rowEl.querySelector('.button-buy');
      rows.push({
        name: clean(nameEl.textContent),
        change: changeEl ? clean(changeEl.textContent) : null,
        sell: sellEl ? num(sellEl.textContent) : null,
        buy: buyEl ? num(buyEl.textContent) : null,
      });
    }
    return { rows };
  });
}

// Poll until the instrument table renders (rows > 0), up to timeoutMs.
async function waitForTable(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await readInstrumentTable(page);
    if (t.rows && t.rows.length) return t;
    await new Promise((r) => setTimeout(r, 500));
  }
  return readInstrumentTable(page);
}

// TRD-PRU-3 (2026-10-08) — READ-ONLY CATEGORY SCREEN. "What does the venue offer, and at what spread?"
//
// Owner ask, verbatim: "a separate set of new instruments that has the same type as the winners, like another
// test case." The first step is a SCREEN, and a screen must be an observation rather than a trade: this navigates
// each category page, waits for the instrument table and reads every row's own buy/sell. NO ticket, NO click, NO
// order — the same safety class as the trail sweeps, and it touches no decision input (the era clock is
// unaffected by construction).
//
// ⚠ PATHS ARE CONSTRAINED to `/trade/<slug>` so this cannot be pointed at a form or a checkout page; a rejected
// path is REPORTED per page rather than silently skipped.
async function probeInstrumentPages(page, settings, { paths = [], settleMs = 2500 } = {}) {
  const out = { at: new Date().toISOString(), pages: [] };
  for (const p of paths) {
    const path = String(p || '');
    if (!/^\/trade\/[a-z0-9-]+$/i.test(path)) { out.pages.push({ path, error: 'path_not_allowed' }); continue; }
    const row = { path, url: null, rows: [], error: null };
    try {
      await withConnRetry(() => page.goto('https://app.plus500.com' + path, { timeout: 45000, waitUntil: 'domcontentloaded' }));
      await page.waitForTimeout(settleMs);
      const t = await waitForTable(page, 20000);
      row.url = String(page.url()).slice(0, 120);
      row.rows = (t.rows || []).map((r) => {
        const mid = r.buy != null && r.sell != null ? (r.buy + r.sell) / 2 : null;
        const spread = r.buy != null && r.sell != null ? +(r.buy - r.sell).toFixed(6) : null;
        return {
          name: r.name, buy: r.buy, sell: r.sell, change: r.change,
          spread, spreadPct: mid && spread != null ? +(spread / mid * 100).toFixed(4) : null,
        };
      });
      if (!row.rows.length && t && t.error) row.error = t.error;
    } catch (e) { row.error = String((e && e.message) || e).slice(0, 160); }
    out.pages.push(row);
  }
  return out;
}

// TRD-PRU-3b (2026-10-08) — PER-SYMBOL CHART BACKFILL READ (read-only). For each symbol: focus it through the
// same reach the capture uses, then read the chart engine's own series (~up to 1000 bars at the chart's current
// interval) WITH the interval verdict fields (`intervalSec` claim + `measuredIntervalSec` from the series), so a
// study never has to trust a timeframe label. No ticket, no click beyond focus, no order, no settings write.
async function probeInstrumentBars(page, settings, { symbols = [] } = {}) {
  const out = { at: new Date().toISOString(), symbols: [] };
  for (const s of symbols) {
    const symbol = String(s || '').trim();
    const row = { symbol, chartSymbol: null, count: 0, intervalSec: null, measuredIntervalSec: null, bars: [], error: null };
    if (!symbol || symbol.length > 40) { row.error = 'bad_symbol'; out.symbols.push(row); continue; }
    try {
      const opened = await openInstrument(page, settings, symbol);
      if (opened && opened.error) row.error = String(opened.error).slice(0, 120);
      await page.waitForTimeout(1800); // the chart (re)loads asynchronously after focus
      const c = await readChartBars(page);
      if (!c || !c.bars || c.bars.length < 10) {
        row.error = (c && c.error) || 'too_few_chart_bars';
      } else {
        row.chartSymbol = c.symbol || null;
        row.count = c.bars.length;
        row.intervalSec = c.intervalSec == null ? null : Number(c.intervalSec);
        row.measuredIntervalSec = c.measuredIntervalSec == null ? null : Number(c.measuredIntervalSec);
        row.bars = c.bars.map((b) => ({ DT: b.DT, O: b.Open, H: b.High, L: b.Low, C: b.Close }));
      }
    } catch (e) { row.error = String((e && e.message) || e).slice(0, 140); }
    out.symbols.push(row);
  }
  return out;
}

// Find a watchlist symbol in the loaded table (exact name, then substring).
// TRD-36 (2026-09-11): class-aware — a plain spot name must never resolve to
// an OPTION row ("Oil | Call 101 | Sep W2"). Opt in with { allowOptions: true }.
function matchRow(rows, symbol, opts = {}) {
  return classMatch.pickRow(rows, symbol, opts);
}

// Chart header title — the selected instrument's name lives in <P500-CHART-TITLE>.
async function readChartTitle(page) {
  return page.evaluate(() => {
    const el = document.querySelector('P500-CHART-TITLE');
    return el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : null;
  }).catch(() => null);
}

// ★★ WHAT INTERVAL IS THE CHART ON, AND CAN IT BE PINNED? (2026-09-25 — MEASURED: IT CANNOT.)
//
// `readChartBars` reports `layout.interval * unitSec` from whatever the SHARED TAB was last left on, and
// `bankChartBars` banks the rows under `TF_MAP[thatInterval]`. So the interval is a UI state that no desk
// flow ever sets, and it silently decides TWO things the desk depends on:
//
//  1. WHICH TIMEFRAME LABEL THE SERIES IS WRITTEN UNDER. `TF_MAP[900]` is `'15m'`, and it is the ONLY entry
//     that maps BELOW 1h — every other interval (300 falls through to 1h, 1800 is mapped to 1h, 3600,
//     14400, 86400) writes 1h or coarser. So a chart left on 15m is the ONE state in which the `'1h'` series
//     receives NOTHING. Structure reads exactly one series — `quant.STRUCTURE_CHART_VENUE` at
//     `timeframe: '1h'`, which TRD-STR-1 made the primary AND ONLY structure venue — and nothing consumes
//     `plus500_chart` at `'15m'` (`quant.BIG_TFS` is `['5m','1h','4h','1d']`; yahoo/binance/okx win the
//     others). Measured live 2026-09-25: the tab was ON 15m (`{interval:15, timeUnit:'minute'}`, bar spacing
//     900000 ms), so the only structure venue was not being refreshed at 1h at all.
//  2. HOW MUCH HISTORY ONE READ OVERWRITES. ChartIQ caps masterData at `maxMasterDataSize` = **1000** bars
//     (read off the live engine, not assumed), so a read's reach is 1000 x interval: 15m is ~10.4 days,
//     native 1h is ~41.7 days.
//
// ★ AND THE CHART CANNOT BE PINNED THROUGH THE ENGINE — THIS WAS TRIED, NOT ASSUMED. `stx.setPeriodicity`
// EXISTS and returns without throwing, and on this venue it is a LABEL-CHANGER. Its own minified source sets
// the layout UNCONDITIONALLY and only afterwards tries to reload:
//
//     ke.periodicity=me, ke.interval=be, ke.timeUnit=Ce;            // <- the claim, made FIRST
//     ...if (needDifferentData) { ... if (quoteDriver) {...} else dataCallback ? dataCallback()
//       : console.log("cannot change periodicity because neither dataCallback or quoteDriver are set"); }
//
// On the live engine `engine.dataCallback === null` and `engine.quoteDriver === false`, so the reload branch
// cannot run at all: the claim is recorded, the series is left alone, and the failure is a console.log
// rather than a throw. MEASURED: `layout` read 3600s while the series measured 900000 ms of bar spacing for
// 45 seconds across five navigations. Driving it would therefore write rows LABELLED 1h, built from 15m bars,
// carrying `sourceIntervalSec = 3600` — the design-doc §4.1 defect with a FALSIFIED provenance, which is
// strictly worse than the mixed label it replaces. It is not called here for that reason.
//
// The venue's own controls were located too, and neither is a usable interval pin:
//   · `CQ-MENU.ciq-period` (ChartIQ's resolutions menu) drives that same inert `setPeriodicity` path;
//   · `p500-range-menu` / `div.range-item` (`5m 1H 5H 1D 1M 3M`) is a RANGE control, NOT an interval one —
//     measured: clicking its `1H` left `layout` at 900s and the spacing at 900000 ms.
//
// SO THE INTERVAL IS TREATED AS A MEASUREMENT RATHER THAN AN ASSERTION, and the 15-minute hole is closed
// separately in `bankChartBars`: the series' own bar spacing is read beside the layout, the two must AGREE
// before a row is written, and a 15m read is rolled up to 1h with `store.upsertAggBars` so the structure
// venue is refreshed at EVERY chart interval instead of only the ones that happen to map to 1h.
const CHART_UNIT_SEC = Object.freeze({ second: 1, minute: 60, hour: 3600, day: 86400 });

// ★ WHAT THE LAYOUT CLAIMS vs WHAT THE SERIES MEASURES. Pure, so the rule is pinned by a test instead of
// living inside a `page.evaluate`. `unmeasured` is NOT agreement — a chart whose spacing cannot be read has
// told us nothing, and treating silence as consent is how a guard goes inert (`chartIdentityVerdict`'s rule).
function chartIntervalVerdict({ layoutSec, measuredSec }) {
  if (layoutSec == null || measuredSec == null) return 'unmeasured';
  return Number(layoutSec) === Number(measuredSec) ? 'agree' : 'disagree';
}

// ★ THE SERIES' OWN SELF-REPORT, AND THE POINT OF THIS HEADER: `layout.interval` is a CLAIM the engine makes
// and cannot fail loudly on, so the interval is measured from the bar timestamps instead.
//
// IT IS PURE AND IT LIVES OUT HERE DELIBERATELY. A rule that can only be exercised inside a browser cannot
// be pinned by a test — the same reason `bucketChartBars` was extracted from the inline bucketing (GRD-5).
//
// ⚠ THE MINIMUM POSITIVE DELTA — NOT THE FIRST, AND NOT THE MEAN. A closed market leaves GAPS in the series,
// and a gap can only ever INFLATE a delta, so the smallest positive spacing IS the bar interval. The first
// delta would read a weekend as a wrong interval and manufacture a disagreement on a perfectly good chart;
// the MEAN would be worse still. Measured live on Gold at 15m, 1000 bars: 988 deltas of 900000 ms, 9 of
// 4500000 (session breaks), 2 of 177300000 (weekends) — a mean of ~1257s, which is neither real value.
function barSpacingSec(bars) {
  const list = Array.isArray(bars) ? bars : [];
  let min = null;
  for (let i = 1; i < Math.min(list.length, 30); i++) {
    const a = Number(list[i - 1] && list[i - 1].DT);
    const b = Number(list[i] && list[i].DT);
    const d = b - a;
    if (Number.isFinite(d) && d > 0 && (min == null || d < min)) min = d;
  }
  return min == null ? null : min / 1000;
}

// TRD-9 H: read the FULL bar series from the ChartIQ engine (masterData holds
// everything the chart currently displays — up to ~1000 bars at the chart's
// current timeframe). Verified live: 996x30m bars, continuous, no gaps.
async function readChartBars(page) {
  const read = await page.evaluate(() => {
    const containers = (typeof CIQ !== 'undefined' && CIQ.ChartEngine && CIQ.ChartEngine.registeredContainers)
      ? CIQ.ChartEngine.registeredContainers : {};
    let engine = null;
    for (const id of Object.keys(containers)) {
      const e = containers[id] && containers[id].stx;
      if (e && e.chart && e.chart.masterData && e.chart.masterData.length) { engine = e; break; }
    }
    if (!engine) return { bars: [], error: 'no_chart_engine' };
    const md = engine.chart.masterData || [];
    const layout = engine.layout || {};
    return {
      bars: md
        .filter((b) => b.Close != null)
        .map((b) => ({
          DT: b.DT, Open: b.Open, High: b.High, Low: b.Low, Close: b.Close,
          Volume: b.Volume != null ? b.Volume : null,
        })),
      // ⚠ THE LAYOUT'S RAW PAIR AND NOT ITS CONVERSION, AND THE REASON IS NOT TIDINESS. `CHART_UNIT_SEC` is a
      // NODE binding: `page.evaluate` serialises this function's SOURCE and runs it in the browser, where that
      // name does not exist. Referencing it here throws `ReferenceError: CHART_UNIT_SEC is not defined` on
      // EVERY read — and it is invisible to any test that stubs the page, because an in-process stub runs this
      // callback where the closure IS in scope. Found live 2026-09-25, after the stub-based tests passed.
      layoutInterval: layout.interval == null ? null : Number(layout.interval),
      layoutTimeUnit: layout.timeUnit == null ? null : String(layout.timeUnit),
      symbol: engine.chart.symbol,
    };
  });
  if (!read || read.error) return read || { bars: [], error: 'no_chart_engine' };
  // Converted HERE, on the Node side of the bridge, so the unit table has exactly one home. The `|| 60`
  // fallback matches what the page used to do inline: an unreadable unit is treated as minutes, which is what
  // `chartIntervalVerdict` then CHECKS against the series rather than silently trusting.
  const intervalSec = read.layoutInterval == null ? null : read.layoutInterval * (CHART_UNIT_SEC[read.layoutTimeUnit] || 60);
  // ★ MEASURED FROM THE SERIES THAT IS ACTUALLY STORED — `barSpacingSec` runs on the filtered bars, not the
  // raw buffer, because the claim being verified is about the rows this capture is about to write.
  return { ...read, intervalSec, measuredIntervalSec: barSpacingSec(read.bars) };
}

// Read the live ticket (Buy/Sell labels + 'Current buy/sell rate' blocks)
// from the currently-open instrument page. No navigation, no clicks — used
// by searchInstrument AND the TRD-12 burst capture (re-reads 2s apart).
async function readTicket(page) {
  return page.evaluate(() => {
    const labels = [];
    for (const b of document.querySelectorAll('button')) {
      const t = (b.textContent || '').trim().replace(/\s+/g, ' ');
      const m = t.match(/^(Buy|Sell)\s+([\d,]+(?:\.\d+)?)$/);
      if (m) labels.push({ side: m[1], value: m[2] });
    }
    const body = document.body ? document.body.innerText : '';
    const rates = {};
    for (const side of ['buy', 'sell']) {
      const re = new RegExp(`Current ${side} rate[\\s\\S]{0,40}?([\\d,]+(?:\\.\\d+)?)`, 'i');
      const m = body.match(re);
      if (m) rates[side] = m[1];
    }
    const titleEl = document.querySelector('P500-CHART-TITLE');
    return { labels, rates, closed: /market is closed/i.test(body), noResults: /no results/i.test(body), url: location.href, chartTitle: titleEl ? (titleEl.textContent || '').trim().replace(/\s+/g, ' ') : null };
  });
}

// TRD-EXE-18 (2026-10-01): ONE extraction of the ticket's live buy/sell, SHARED by every reader.
//
// ⚠ THIS EXISTS BECAUSE THE PRICE WAS COMPUTED AND THEN DROPPED ONE LAYER UP. `searchInstrument` reads the ticket,
// and when that read fails it ALREADY falls back to the loaded category table and returns a real price tagged
// `source: 'table'`. `openInstrument` then discarded `hit.buy`/`hit.sell` from its own return value, and
// `probeSession` — which calls `openInstrument` — re-ran the SAME ticket read that had just failed and got null.
//
// MEASURED LIVE 2026-10-01: every recorded `session_probe` event carried `venueMid: null` (2 of 2), so the venue
// price, the stop's own reference and EXE-15's "fresh price" all had no input at all. The countermeasures were not
// broken — the number never arrived. Three readers of the same element are also three chances to drift apart,
// which is why this is one function rather than three copies of the same regex.
function priceNum(s) {
  if (s == null || s === '') return null;
  const v = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

function ticketPrice(ticket) {
  if (!ticket || ticket.noResults) return { buy: null, sell: null, source: null };
  const lastSide = (side) => [...(ticket.labels || [])].reverse().find((l) => l.side === side);
  const b = lastSide('Buy');
  const s = lastSide('Sell');
  const buy = priceNum(b ? b.value : (ticket.rates && ticket.rates.buy));
  const sell = priceNum(s ? s.value : (ticket.rates && ticket.rates.sell));
  return { buy, sell, source: buy != null || sell != null ? 'ticket' : null };
}

// TRD-12 Phase 3 (#210): discover the app's LIVE href map — the link-first
// navigation groundwork. One evaluate, no clicks. Returns a compact map of
// the SPA's current route links (they shift after soft-kill resumes).
async function readHrefMap(page) {
  return page.evaluate(() => {
    const hrefs = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (!href.startsWith('/')) continue;
      if (!/^\/(trade|open-positions|open-orders|closed-positions|alerts|instruments|account|settings|help|insights)/i.test(href)) continue;
      hrefs.add(href.split('?')[0]);
    }
    return { at: new Date().toISOString(), url: location.href, hrefs: [...hrefs].slice(0, 100) };
  });
}

// AI-DISCOVERER probe (2026-09-10): does Plus500 list `query`? Reads the
// search dropdown result list and closes it with Escape — NO Enter, NO chart
// navigation (~1.5s/ticker). Returns the venue's own display name.
async function searchExists(page, query, _settings) {
  const box = page.getByRole('combobox', { name: /Search our Instruments/i }).first();
  await box.click().catch(() => {});
  await box.fill(query, { timeout: 15000 });
  await page.waitForSelector('[data-testid="AccountStatus.Search.ResultItem"]', { timeout: 8000 }).catch(() => { /* dropdown may be absent */ });
  await page.waitForTimeout(400 + Math.random() * 300);
  // TRD-36: class-aware — a plain spot probe must not be satisfied by an
  // OPTION row ("Oil" -> "Oil | Call 101 | Sep W2"). Same picker as the
  // search path; option rows are skipped unless the query is option-shaped.
  const itemTexts = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/[\u200e\u200f\u200b\u00a0]/g, '').trim().replace(/\s+/g, ' ');
    return [...document.querySelectorAll('[data-testid="AccountStatus.Search.ResultItem"]')].map((el) => clean(el.textContent));
  });
  const idx = classMatch.pickIndex(itemTexts, query);
  let found = null;
  if (idx !== -1) {
    const full = itemTexts[idx].slice(0, 120);
    // Result rows read like "D05.SGX | DBS Group" — the venue display name
    // is the part after the pipe.
    const name = full.includes('|') ? full.split('|').pop().trim().slice(0, 64) : full.slice(0, 64);
    found = { name, full };
  }
  await page.keyboard.press('Escape').catch(() => {});
  return { query, found: !!found, name: found ? found.name : null, full: found ? found.full : null };
}

// Search-bar lookup for an instrument, then read its live ticket.
// TRD-36 (2026-09-11): CLASS-AWARE. The venue search surfaces OPTION rows for
// plain spot queries (verified live: "Oil" -> "Oil | Call 101 | Sep W2"), so
// spot-intent callers (capture, executor, alerts) must never silently select
// one — an option selected here would bank option PREMIUMS into the spot
// symbol's tick stream. Option rows are skipped unless the caller opts in
// (opts.allowOptions) or the query itself is option-shaped; the chart-title
// check refuses a landed option page as belt-and-braces.
async function searchInstrument(page, query, _settings, opts = {}) {
  const wantOptions = !!opts.allowOptions || classMatch.isOptionName(query);
  const box = page.getByRole('combobox', { name: /Search our Instruments/i }).first();
  await box.click().catch(() => {});
  await box.fill(query, { timeout: 15000 });

  // Plus500's redesigned search (2026-09) puts an AUTO-SELECTED
  // "Search "X" with +AI" action item first in the dropdown. Pressing Enter
  // blindly now triggers an AI search instead of picking the instrument, and
  // synthetic clicks on result items are swallowed by the component.
  // PROVEN flow: type the keyword -> ArrowDown to the exact result -> Enter.
  await page.waitForSelector('[data-testid="AccountStatus.Search.ResultItem"]', { timeout: 10000 })
    .catch(() => { /* dropdown may be absent */ });
  await page.waitForTimeout(500 + Math.random() * 400);

  const itemTexts = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/[\u200e\u200f\u200b\u00a0]/g, '').trim().replace(/\s+/g, ' ');
    return [...document.querySelectorAll('[data-testid="AccountStatus.Search.ResultItem"]')].map((el) => clean(el.textContent));
  });
  const idx = classMatch.pickIndex(itemTexts, query, { allowOptions: wantOptions });

  if (idx === -1) {
    // No acceptable result — never let Enter hit the AI action item.
    await page.keyboard.press('Escape').catch(() => {});
    return { query, clicked: null, hit: null, reason: itemTexts.length ? 'no_class_match' : 'no_result_items' };
  }

  // One ArrowDown moves focus off the AI action item onto the first result.
  for (let i = 0; i <= idx; i++) await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300 + Math.random() * 300);
  await page.keyboard.press('Enter');

  // Wait for the instrument info DOM to load (chart title carries the name).
  // TRD-36: accept only a class-correct title; bail out early when the landed
  // page is an option for a spot query (never read that ticket).
  const deadline = Date.now() + 12000;
  const qLower = String(query).toLowerCase();
  let chartTitle = null;
  let optionTitleForQuery = false;
  while (Date.now() < deadline) {
    chartTitle = await readChartTitle(page);
    if (chartTitle) {
      const lower = chartTitle.toLowerCase();
      const isOpt = classMatch.isOptionName(chartTitle);
      optionTitleForQuery = !wantOptions && isOpt && lower.includes(qLower);
      if (lower.includes(qLower) && (wantOptions || !isOpt)) break;
      if (optionTitleForQuery) break; // wrong class — refuse below
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  if (optionTitleForQuery) {
    await page.keyboard.press('Escape').catch(() => {});
    return { query, clicked: null, hit: null, reason: 'class_mismatch', chartTitle };
  }

  const after = await readTicket(page);
  if (after.noResults) return { query, clicked: null, hit: null, reason: 'no_results' };

  const num = (s) => (s == null || s === '' ? null : parseFloat(String(s).replace(/,/g, '')));
  const last = (side) => [...after.labels].reverse().find((l) => l.side === side);
  const buy = num(last('Buy') ? last('Buy').value : after.rates.buy);
  const sell = num(last('Sell') ? last('Sell').value : after.rates.sell);

  if (buy == null && sell == null) {
    // Ticket not readable yet — try the loaded category table as a price source.
    const table = await readInstrumentTable(page);
    const row = matchRow(table.rows, query, { allowOptions: wantOptions });
    if (row) {
      return { query, clicked: query, hit: { name: row.name, buy: row.buy, sell: row.sell, closed: false }, url: after.url, chartTitle, source: 'table' };
    }
    return { query, clicked: null, hit: null, reason: 'no_ticket', chartTitle };
  }

  return {
    query,
    clicked: query,
    hit: { name: query, buy, sell, closed: after.closed },
    url: after.url,
    chartTitle,
    source: 'ticket',
  };
}

// Selector Health Check (A1): critical DOM must be present before ANY action.
// 2026-09-11 (owner patch): two distinct causes of a "not logged in" read that
// are NOT a logout — both used to count as selector failures, and 3-in-a-row
// latched the sticky UI Fallback Pause on a healthy session:
//   a) fresh browser/tab (about:blank after a Chrome relaunch) has no
//      app.plus500.com URL yet — prime the shared tab to the app; gotoPage
//      waits out the SPA boot (the body can read blank for seconds);
//   b) a transient EMPTY innerText sample mid-transition on the right URL
//      (live-caught: 0 chars once, full account banner 6s later).
// Recover once, re-sample; a real logout fails all of it.
const LOGIN_RESAMPLE_MS = 1500;
// SELECTOR HEALTH CHECK, WITH ONE REPAIR ATTEMPT.
//
// ★ THE DEADLOCK THIS FIXES (found live 2026-09-14, after a 2h26m tick outage).
//
// `captureOnce` gates on this check BEFORE it does anything, and its own first action is a
// navigation that REPAIRS the page:
//
//     const hc = await health.checkAndGate(userId, settings, page);
//     if (!hc.ok) return { captured: 0, reason: hc.reason, paused: hc.paused };   // <- aborts
//     ...
//     await page.goto(CATEGORY_URLS.cryptocurrencies)   // <- the page has a table again
//
// When the shared page drifts off the trade route — any manual navigation, a landed
// instrument ticket, a half-finished sweep — the trade DOM is absent, so the check fails, so
// the capture aborts, so it NEVER REACHES the navigation that would have fixed it. The page
// cannot recover on its own: 14 consecutive failures, `ui_fallback_pause`, `captured: 0` from
// 11:10:27 UTC, and every symbol's price frozen at its last value for 2.4 hours. The
// protection against acting on a broken page had become the reason the page stayed broken.
//
// THE REPAIR IS THE PATTERN ALREADY HERE FOR THE OTHER FAILURE: when the desk is signed out,
// this function does not just report — it navigates to the trade route and re-checks. Being
// signed in but off-route is the same shape of problem and gets the same treatment.
//
// SAFETY IS PRESERVED, which is why this is a repair rather than a relaxation: after the
// navigation the FULL check runs again, and `ok` still requires the trade DOM to be present.
// A page that is genuinely broken still fails this function and still trips the pause. What
// changes is that a page which is merely in the wrong place gets one chance to come back.
async function healthCheck(page, settings) {
  const out = { ok: false, checks: {} };
  try {
    out.checks.loggedIn = await isLoggedIn(page);
    if (!out.checks.loggedIn) {
      // ★ A BLANK PAGE IS NOT A SIGNED-OUT PAGE (fixed 2026-09-14). The old rule was: wrong URL ->
      // navigate to /trade; already on app.plus500.com -> just wait and re-read. But a DEAD RENDER
      // on the right URL has no content at all, so `isLoggedIn` (which needs the 'Available' and
      // 'Equity' labels) reports false no matter how long we wait, and the desk answered
      // `login_required` forever while the page was simply empty. `recoverTradePage` forces a fresh
      // render, which is the only thing that fixes it.
      const bodyLen = (await pageText(page, 120)).length;
      const blank = bodyLen <= 20;
      if (blank || !/app\.plus500\.com/.test(page.url())) {
        const rec = await recoverTradePage(page).catch((e) => ({ ok: false, reason: String(e.message || e) }));
        out.checks.blankPage = blank;
        out.checks.recovered = !!rec.ok;
      } else {
        await sleep(LOGIN_RESAMPLE_MS);
      }
      out.checks.loggedIn = await isLoggedIn(page);
      out.checks.loginRetried = true;
    }
    if (!out.checks.loggedIn) {
      out.reason = 'login_required';
      return out;
    }

    // Read the trade DOM. Split out so it can be run again after the repair navigation.
    //
    // ⚠ `!!(…) !== null` is ALWAYS true — `!!x` is a boolean, and a boolean is never null. So this probe
    // reported `instrumentTable: true` whether the table was found or not, which is the class-1 shape the
    // rest of this review is about: a check that cannot fail is not a check. Found by lint
    // (`no-constant-binary-expression`) on 2026-09-19 while reviewing TRD-67/TRD-83.
    // ★ 2026-10-05 (#1511, venue UI): navTrade used to be the literal string 'Open Positions' in body
    // text. The current Plus500 UI renders the nav as ICON BUTTONS — `NavigationBar` testids, with no
    // visible label text on most routes (measured live 2026-10-05: the string is ABSENT even on the
    // rich trade page, while the NavigationBar testids are present — including on the parked
    // /open-positions render). Text-only detection made every check fail from the parked route →
    // repair-navigations every cycle + a latched UI Fallback Pause. The testid presence IS the app
    // shell rendered; the text check stays as a fallback for older builds.
    const probeTradeDom = async () => ({
      navTrade: (await pageText(page)).includes('Open Positions')
        || await page.evaluate(() => !!document.querySelector('[data-testid^="NavigationBar"]')).catch(() => false),
      balance: (await readAccount(page, settings)).Available !== undefined,
      instrumentTable: (await readTable(page, ['Type / Instrument']).catch(() => null)) !== null,
    });

    Object.assign(out.checks, await probeTradeDom());

    // ONE repair attempt: logged in but the trade DOM is not rendered. A page on an
    // instrument ticket, or on any route that is not the trade list, has no nav and no table.
    if (!out.checks.navTrade && !out.checks.instrumentTable) {
      out.checks.repairAttempted = true;
      out.checks.beforeRepair = { navTrade: out.checks.navTrade, balance: out.checks.balance, instrumentTable: out.checks.instrumentTable };
      try {
        await gotoPage(page, 'trade');
        Object.assign(out.checks, await probeTradeDom());
        // ★ SECOND REPAIR — 2026-10-02, added after TWO entry lockouts in one day (02:55→04:12,
        // 05:35→…). `gotoPage(page,'trade')` navigates to `https://app.plus500.com/trade`, and THIS
        // SPA REDIRECTS that URL back to the remembered trade route. The mirror parks the shared tab
        // on `/open-positions` (routes.js parks there by design) and the desk reads positions via
        // `/closed-positions` and `/trade/alerts` — none of which carry the instrument table. From
        // those routes the first repair therefore bounces straight back: measured 2026-10-02, after
        // the repair AND after a full reload the tab was still `/open-positions`, and three
        // consecutive wake captures failed (`navTrade:false, instrumentTable:false`) → latch.
        //
        // The fallback navigates DIRECTLY to a category URL — a concrete route the SPA cannot
        // bounce. Safety is unchanged: the FULL check still runs afterwards, and a page that is
        // genuinely broken still fails and still trips the pause. What changes is that a tab parked
        // OFF the trade route can be brought back without a human.
        const stillMissing = !out.checks.instrumentTable && !(out.checks.navTrade && out.checks.balance);
        if (stillMissing) {
          out.checks.repairFallback = true;
          await page.goto(CATEGORY_URLS.cryptocurrencies, { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
          for (let i = 0; i < 20; i++) {
            const t = await pageText(page, 400);
            if (t.length >= 40) break;
            await sleep(500);
          }
          Object.assign(out.checks, await probeTradeDom());
        }
      } catch (e) {
        out.checks.repairError = String(e.message || e).slice(0, 120);
      }
    }

    // WHAT COUNTS AS "THE TRADE PAGE IS RENDERED" — corrected 2026-09-14 after the repair
    // above left the desk stuck on a page that was demonstrably FINE.
    //
    // The old rule was `navTrade && (balance || instrumentTable)`, i.e. the literal string
    // "Open Positions" was MANDATORY. Measured immediately after the repair navigation:
    //
    //     {"loggedIn":true,"navTrade":false,"balance":true,"instrumentTable":true}
    //
    // The account strip had rendered, the instrument table with its `Type / Instrument`
    // header was present — the trade page was healthy — and the capture still refused,
    // because the nav LABEL could not be found in the first 5000 characters of body text.
    // That is a gate stricter than the thing it protects: the table is DIRECT evidence of the
    // trade list, while the nav label is only indirect evidence that the app shell rendered.
    // A hard requirement on the weaker signal rejected the stronger one, and the desk stayed
    // paused with a working page.
    //
    // The rule is now: the instrument table IS the trade page. Otherwise fall back to the app
    // shell being rendered (nav + account strip). A blank, broken or wrong page has neither,
    // so the protection this check exists for is unchanged — what it no longer does is refuse
    // a page it can see is correct.
    out.ok = out.checks.instrumentTable || (out.checks.navTrade && out.checks.balance);
    if (!out.ok) out.reason = 'critical DOM missing: ' + JSON.stringify(out.checks);
  } catch (e) {
    out.reason = String(e.message || e).slice(0, 160);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trade actions (TRD-3). Implemented from the 2026-09-08 manual capture:
// open: instrument-row .button-buy/.button-sell -> ticket #amount-input + #trade-button;
// new position appears as [data-testid^="PositionRow."] in .positions-orders.
// close: /open-positions row [data-testid^="OpenPosition."] .buySellButton ->
// panel #closePositionBtn; closed fill read from .closed-position[data-position-id].
// ---------------------------------------------------------------------------
// ── TRD-TRL-3: THE TWO TICKET INTERACTIONS THE DESK DEPENDS ON, ONE HOME EACH ────────────────────────────────
// `clickInstrumentRow` turns a symbol + side into an open ticket; `toggleLimit` drives a `Set Limits` card. Both
// were closures inside `placeOrder`, which is why the trailing-stop read-back could not be MEASURED without
// copying them - and a diagnostic that reimplements the interaction it is diagnosing measures a DIFFERENT
// interaction. The bodies are the proven ones, extracted unchanged; `page` becomes explicit.
// ── EXE-14 S2 (2026-10-02): THE SAME EXTRACTION `clickInstrumentRow` AND `toggleLimit` ALREADY HAD ────────
//
// `fillRate` was a closure inside `placeOrder`, so a second caller could not reach it — and a diagnostic that
// reimplements the interaction it is diagnosing measures a DIFFERENT interaction (TRD-TRL-3's finding, one
// level up). The body is the proven one, extracted UNCHANGED; `page` becomes an explicit first argument.
//
// ⚠ IT WRITES A **2dp RATE**, NOT A COUNT. `Number(val).toFixed(2)` is the level twin; `fillPips` is the integer
// twin and the two are not interchangeable. `test/trailing-stop-dom.test.js` pins that the pip field never
// goes through this one.
//
// ⚠ AND IT COMPARES AT THE VENUE'S PRECISION (0.005), WHICH IS WHY S2 MUST NOT PASS A 4dp LEDGER LEVEL FOR
// VERIFICATION. `Trades.stopPrice` carries four decimals; the card shows two. Comparing the ledger value
// against the card read would fail on a write that is CORRECT, which is the trap `final-read-2026-10-01.md` §38
// names for this step.
async function fillRate(page, sel, val) {
  if (val == null) return;
  const want = Number(val).toFixed(2);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator(sel).first().fill(want, { timeout: 8000 }).catch(() => {});
    await jitterDelay(150, 300);
    const got = await page.evaluate((s) => {
      const el = document.querySelector(s);
      return el ? parseFloat(String(el.value || '').replace(/,/g, '')) : null;
    }, sel);
    if (got != null && Math.abs(got - Number(want)) < 0.005) return got;
    // fallback: native setter + events (the amount-input pattern)
    await page.evaluate(({ s, v }) => {
      const el = document.querySelector(s);
      if (!el) return;
      el.focus();
      const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      nativeSet.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    }, { s: sel, v: want });
  }
  const finalVal = await page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? parseFloat(String(el.value || '').replace(/,/g, '')) : null;
  }, sel);
  if (finalVal == null || Math.abs(finalVal - Number(want)) >= 0.005) {
    throw new Error(`ticket field did not accept value: ${sel} (wanted ${want}, got ${finalVal})`);
  }
  return finalVal;
}

async function clickInstrumentRow(page, { symbol, direction }) {
  return page.evaluate(({ sym, dir }) => {
    const rows = [...document.querySelectorAll('[data-testid^="InstrumentRow."]')];
    for (const row of rows) {
      const nameEl = row.querySelector('.name');
      if (!nameEl) continue;
      const name = (nameEl.textContent || '').replace(/[\u200e\u200f]/g, '').trim();
      if (name !== sym) continue;
      // Prefer the explicit testid button (proven on both spotlight and
      // category tables), then the legacy button wrapper, then the cell.
      const btn = row.querySelector(dir === 'buy' ? '[data-testid$=".Button.Buy"]' : '[data-testid$=".Button.Sell"]')
        || row.querySelector(dir === 'buy' ? '.button-buy' : '.button-sell')?.querySelector('plus500-trade-button, button')
        || row.querySelector(dir === 'buy' ? '.button-buy' : '.button-sell');
      if (!btn) continue;
      btn.click();
      return true;
    }
    return false;
  }, { sym: symbol, dir: direction });
}

async function toggleLimit(page, headerTestid, expandableTestid, inputSel) {
  const isExpanded = (testid) => page.evaluate((t) => {
    const el = document.querySelector(`[data-testid="${t}"]`);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && !!el.offsetParent;
  }, testid);
  // The expandable spinner (and its input) renders AFTER the switch
  // animation — filling too early sets a stale node that Vue replaces
  // with its default. Wait for the input to be visible + enabled first.
  const waitInput = (sel, timeout = 10000) => page.waitForFunction((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const cs = getComputedStyle(el);
    return !el.disabled && cs.display !== 'none' && cs.visibility !== 'hidden' && !!el.offsetParent;
  }, sel, { timeout }).catch(() => { throw new Error(`set-limits field did not enable: ${sel}`); });
  const clickHeader = (headerT) => page.evaluate((t) => {
    const h = document.querySelector(`[data-testid="${t}"]`);
    if (h) {
      h.scrollIntoView({ block: 'center' });
      h.click();
    }
  }, headerT);
  // Idempotent-by-observation toggle: expand if closed; if the wrapper
  // reports open but the input never appears (stuck half-open after a
  // previous session), collapse + re-expand. The card HEADER is the real
  // toggle — PLUS500-SWITCH is a passive indicator (verified live), but
  // a flake on 2026-09-10 showed the header click being swallowed, so the
  // switch element is now a fallback actuator too. Up to 3 expand cycles.
  const open = await isExpanded(expandableTestid);
  if (open === null) throw new Error(`set-limits card missing: ${expandableTestid}`);
  if (open) {
    try { await waitInput(inputSel, 4000); return; } catch { /* half-open: fix below */ }
    await clickHeader(headerTestid); // collapse
    await jitterDelay(500, 900);
  }
  const switchTestid = headerTestid.replace('Header', 'Switch');
  for (let attempt = 1; attempt <= 3; attempt++) {
    await clickHeader(headerTestid); // expand
    try {
      await waitInput(inputSel, 6000);
      return;
    } catch { /* swallowed click — try the switch actuator */ }
    await page.evaluate((t) => {
      const el = document.querySelector(`[data-testid="${t}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); el.click(); }
    }, switchTestid);
    try {
      await waitInput(inputSel, 6000);
      return;
    } catch { /* retry cycle */ }
    await jitterDelay(400, 800);
  }
  // Last resort: collapse fully, one clean expand.
  await page.evaluate((t) => {
    const el = document.querySelector(`[data-testid="${t}"]`);
    if (el) { el.scrollIntoView({ block: 'center' }); el.click(); el.click(); }
  }, headerTestid);
  await jitterDelay(600, 1000);
  await clickHeader(headerTestid);
  await waitInput(inputSel);
  await jitterDelay(200, 400);
}

// ⚠⚠ EXE-NG-1 (2026-10-02): REACHING THE TICKET AND WAITING FOR IT WERE ONE EXPRESSION, SO `placeOrder`'s two
// DIFFERENT failures arrived on the ledger as the same eight words.
//
// Measured from the journal — four Natural Gas attempts on 2026-10-01, TWO signatures, both recorded as
// `order ticket did not open` / `errorClass: "other"`:
//   · 27190ms, 26623ms, 26927ms  — the row/category clicks found nothing, the SEARCH path ran, and then
//                                  `#amount-input` never appeared (the 15s wait plus ~12s of prior work).
//   · 50158ms                    — the ticket DID open and `#trade-button` never became clickable in 30s.
// The desk could not tell them apart, so neither could anyone reading the row, and the one thing that WOULD
// have discriminated — WHICH PATH reached the click — was computed and then discarded.
//
// So the path is now returned, attached to the thrown error, and written into the journal: the next occurrence
// names its own cause instead of costing another forensics session.
//
// ⚠ IT IS EXTRACTED, NOT COPIED. `placeOrder` and the diagnostic probe both call this, so a probe cannot drift
// from the path it claims to be measuring (the defect class this workstream keeps re-finding).
async function openTicket(page, settings, { symbol, direction }) {
  let via = null;
  let rowClicked = await clickInstrumentRow(page, { symbol, direction });
  if (rowClicked) via = 'row';
  if (!rowClicked) {
    const cat = SYMBOL_CATEGORY[String(symbol).toLowerCase()];
    if (cat) {
      await withConnRetry(() => page.goto(CATEGORY_URLS[cat], { timeout: 45000, waitUntil: 'domcontentloaded' }));
      await waitForTable(page, 20000);
      rowClicked = await clickInstrumentRow(page, { symbol, direction });
      if (rowClicked) via = 'category';
      if (!rowClicked && CATEGORY_FALLBACKS[cat]) {
        await withConnRetry(() => page.goto(CATEGORY_FALLBACKS[cat], { timeout: 45000, waitUntil: 'domcontentloaded' }));
        await waitForTable(page, 20000);
        rowClicked = await clickInstrumentRow(page, { symbol, direction });
        if (rowClicked) via = 'category_fallback';
      }
    }
    if (!rowClicked) {
      // Generic fallback (2026-09-10, user ask): no category mapping needed — search for the instrument by name,
      // verify the chart title matches, then click its Buy/Sell button on the instrument page.
      try {
        await openInstrument(page, settings, symbol);
        await sleep(1200);
        const title = await readChartTitle(page).catch(() => null);
        const match = !title || String(title).toLowerCase().includes(String(symbol).toLowerCase());
        if (match) {
          rowClicked = await page.evaluate((dir) => {
            const btn = document.querySelector(dir === 'buy' ? '.button-buy' : '.button-sell')
              || document.querySelector(dir === 'buy' ? '[data-testid$=".Button.Buy"]' : '[data-testid$=".Button.Sell"]');
            if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return true; }
            return false;
          }, direction);
          if (rowClicked) via = 'search';
        }
      } catch { /* fall through to the clear error below */ }
    }
  }
  if (!rowClicked) throw new Error(`instrument not reachable for ${symbol} (row, category and search all failed)`);
  return { ok: true, via };
}

// WHAT THE TICKET ACTUALLY LOOKS LIKE, which is the half of the failure nobody could see. Read-only: it reads
// the DOM and clicks NOTHING.
async function ticketCensus(page) {
  return page.evaluate(() => {
    const clean = (s) => String(s || '').replace(/[\u200e\u200f\u200b\u00a0]/g, '').trim();
    const describe = (el) => ({
      tag: el.tagName, id: el.id || null, tid: el.getAttribute('data-testid'),
      type: el.getAttribute('type'), disabled: !!el.disabled,
      visible: !!el.offsetParent, value: el.value == null ? null : String(el.value).slice(0, 20),
    });
    const inputs = [...document.querySelectorAll('#buySellCfd input, #sidebar input, input')]
      .filter((el, i, a) => a.indexOf(el) === i).slice(0, 12).map(describe);
    const amount = document.querySelector('#amount-input');
    const submit = document.querySelector('#trade-button');
    // The unscoped global query the search fallback uses — reported beside how many matches it had to choose
    // from, because "which one did querySelector take" is exactly the question that could not be asked before.
    const buys = [...document.querySelectorAll('.button-buy')];
    const sells = [...document.querySelectorAll('.button-sell')];
    const firstBuy = buys[0] || null;
    return {
      url: String(location.href).slice(0, 160),
      amountInput: amount ? { present: true, ...describe(amount) } : { present: false },
      tradeButton: submit ? { present: true, ...describe(submit), text: clean(submit.textContent).slice(0, 20) } : { present: false },
      buyButtons: { count: buys.length, firstVisible: firstBuy ? !!firstBuy.offsetParent : null, firstInsideRow: !!(firstBuy && firstBuy.closest('[data-testid^="InstrumentRow."]')) },
      sellButtons: { count: sells.length },
      inputs,
      anyTicket: !!document.querySelector('#buySellCfd'),
    };
  }).catch((e) => ({ error: String(e && e.message).slice(0, 150) }));
}

async function placeOrder(page, settings, { symbol, direction, size, stopPrice = null, takeProfitPrice = null, trailingStop = null }) {
  const reach = await openTicket(page, settings, { symbol, direction });

  try {
    await page.waitForSelector('#amount-input', { timeout: 15000 });
  } catch {
    // ⚠ THE ERROR CARRIES THE TWO FACTS THAT WERE BEING DISCARDED: which path produced the click, and what the
    // page looked like when the ticket failed to appear. Without them this message took a forensics session.
    const e = new Error('order ticket did not open');
    e.ticketVia = reach.via;
    e.ticketCensus = await ticketCensus(page);
    throw e;
  }
  await jitterDelay(400, 1100); // human-like: read the ticket before typing

  const before = await page.evaluate(() =>
    [...document.querySelectorAll('.positions-orders [data-testid^="PositionRow."]')].map((el) => el.getAttribute('data-testid'))
  );

  await page.evaluate((val) => {
    const el = document.querySelector('#amount-input');
    el.focus();
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    nativeSet.call(el, String(val));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, size);

  // TRD-12 #204 (venue-native exits): attach STOP LOSS + TAKE PROFIT on the
  // ticket itself, so Plus500 closes at these levels even between agent
  // wakes. The fields live inside PLUS500-SWITCH-gated expandable cards
  // (verified live 2026-09-10): TradeSetLimits.CloseAtProfitSwitch /
  // CloseAtLossSwitch must be ON before #close-at-profit-rate /
  // #close-at-loss-rate accept values. Hidden-field fills are silently
  // ignored by the venue — the switch click is mandatory.
  // TRD-TRL-2 (#1485): `trailResult` is reported in the fill so the caller can persist it; it is null when no
  // trailing stop was asked for. See the trailing-stop block below for why a refusal here never blocks the entry.
  let trailResult = null;
  if (stopPrice != null || takeProfitPrice != null || (trailingStop && trailingStop.enabled === true)) {
    if (takeProfitPrice != null) {
      await toggleLimit(page, 'TradeSetLimits.CloseAtProfitHeader', 'TradeSetLimits.CloseAtProfitExpandable', '#close-at-profit-rate');
      await fillRate(page, '#close-at-profit-rate', takeProfitPrice);
    }
    if (stopPrice != null) {
      await toggleLimit(page, 'TradeSetLimits.CloseAtLossHeader', 'TradeSetLimits.CloseAtLossExpandable', '#close-at-loss-rate');
      await fillRate(page, '#close-at-loss-rate', stopPrice);
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════════════════
    // TRD-TRL-2 (#1485) — THE VENUE-NATIVE TRAILING STOP. TICKET-TIME ONLY: the venue also exposes it on the
    // post-entry `Edit` -> `Set Limits` path (owner dump 2026-09-30), but that path is NOT wired here.
    //
    // It is a FOURTH `Set Limits` card of the same shape as the two above, so `toggleLimit` is reused verbatim,
    // including its two documented traps (the switch click is MANDATORY; the input renders after the animation).
    //       header      TradeSetLimits.TrailingStopHeader        switch  TradeSetLimits.TrailingStopSwitch
    //       expandable  TradeSetLimits.TrailingStopExpandable     field   #trailing-stop-pips  <- INTEGER pips
    //       read-back   TradeSetLimits.TrailingStopCalc  ->  [data-currency] money, [data-percent] percent
    //
    // ⚠ `fillRate` CANNOT BE REUSED FOR THIS FIELD: it does `Number(v).toFixed(2)` and a pip count is a whole
    // number. `fillPips` below is the integer twin, and it verifies the venue ACCEPTED the count - a spinner that
    // clamps would otherwise invalidate the scaling silently.
    //
    // ⚠⚠ THE DESK NEVER LEARNS THE PIP SIZE, AND THIS CODE MUST NOT PRETEND TO. It sets a PROBE, reads the
    // consequence, and scales:  `pips* = probePips x distanceTarget / distanceRead`. The distance comes from the
    // PERCENT span, because `percent = P&L-if-triggered / position value`, which reduces to the P&L per unit over
    // the price - so `distanceFromPercent` needs NO fx rate and NO pip table. Measured 2026-09-30: a controlled
    // two-point pair on Bitcoin #1131 returned pip = 0.010004, a cent, with no assumption made.
    //
    // ⚠ NOTHING IS ARMED UNTIL `#trade-button` IS CLICKED, so probing on the ticket is inert. But that safety
    // cuts both ways: once the card HAS been engaged, a trail the desk cannot verify must NOT be submitted, and
    // the desk cannot confirm that clearing the field disarms it. So an unverifiable trail ABORTS THE ORDER
    // rather than being cleared and hoped over. Costing one entry is recoverable; an unwanted level is not.
    // ⚠ A REFUSAL, by contrast, happens BEFORE the card is touched and never blocks the entry - the venue stop is
    // the mandatory exit and the trail is an enhancement on top of it. The refusal is reported in `trailResult`.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════════
    if (trailingStop && trailingStop.enabled === true) {
      const readRate = () => page.evaluate(() => {
        const el = document.querySelector('#buySellCfd');
        const m = el ? (el.textContent || '').match(/Current Rate\s*([\d,]+(?:\.\d+)?)/i) : null;
        return m ? parseFloat(m[1].replace(/,/g, '')) : null;
      }).catch(() => null);

      // Money and percent are read in the SAME breath as the rate: the percent is denominated by the position's
      // value at the CURRENT price, so a stale rate turns a correct trail into a phantom mismatch.
      const readTrail = async () => {
        const spans = await page.evaluate((t) => {
          const boxes = [...document.querySelectorAll(`[data-testid="${t}"]`)];
          const box = boxes[0] || null;
          if (!box) return { boxes: 0 };
          const read = (sel, raw) => {
            const el = box.querySelector(sel);
            if (!el) return null;
            const s = String(el.textContent || '').replace(/[\u200e\u200f\u202a-\u202e]/g, '');
            if (raw) return s.trim().slice(0, 40);
            const m = s.match(/-?[\d,]+(?:\.\d+)?/);
            return m ? parseFloat(m[0].replace(/,/g, '')) : null;
          };
          return {
            boxes: boxes.length,
            money: read('[data-currency]'), percent: read('[data-percent]'),
            moneyRaw: read('[data-currency]', true), percentRaw: read('[data-percent]', true),
          };
        }, 'TradeSetLimits.TrailingStopCalc').catch(() => null);
        const price = await readRate();
        return {
          money: spans ? spans.money : null,
          // TRD-TRL-3: the RAW strings and the NODE COUNT are kept because a 140-char error string was the only
          // record of this path failing 8 times, and it could not say WHICH of the four boxes was read or what
          // the venue actually printed. `boxes > 1` means the selector is ambiguous and we may be reading the
          // wrong card's calc.
          moneyRaw: spans ? spans.moneyRaw : null,
          percentRaw: spans ? spans.percentRaw : null,
          boxes: spans ? spans.boxes : 0,
          percentFraction: spans && spans.percent != null ? spans.percent / 100 : null,
          price,
        };
      };

      // ⚠ TRD-TRL-3, AND THE `got === want` COMPARE WAS A REAL BUG. It stripped EVERY non-digit, so a field
      // showing `527.0` read as `5270` and never matched; and the FINAL read was thrown on without ever being
      // compared, so a field that DID take the count still aborted the order. Event 138278 is exactly that: the
      // message reads "wanted 100000, got 100000" - the value was RIGHT and the entry was refused anyway.
      const readPipField = () => page.evaluate(() => {
        // THE INPUT IS LOOKED UP INSIDE ITS OWN CARD FIRST. A global id can match a node in a panel that is not the
        // one driving this ticket, and the CARD is the thing the toggle just engaged.
        const exp = document.querySelector('[data-testid="TradeSetLimits.TrailingStopExpandable"]');
        const inside = exp ? [...exp.querySelectorAll('input')] : [];
        const byId = [...document.querySelectorAll('#trailing-stop-pips')];
        const el = inside[0] || byId[0] || null;
        const raw = el ? String(el.value || '') : null;
        const numeric = raw == null ? null : parseFloat(raw.replace(/[^\d.-]/g, ''));
        return {
          via: inside[0] ? 'card' : byId[0] ? 'id' : 'none',
          idNodes: byId.length, insideInputs: inside.length,
          raw, numeric: Number.isFinite(numeric) ? numeric : null,
        };
      });

      // ⚠⚠ TRD-TRL-3 — THE FIELD'S OWN VALUE WAS NEVER THE QUESTION, AND IT WAS TAKEN FOR THE ANSWER.
      //
      // Reading the INPUT back is what this did, and it PASSED: the field held our number on every one of the eight
      // refusals. The venue's arithmetic did not move, and the distance read back was the same on three Sugar
      // attempts that asked for 0.115, 0.095 and 0.125. A number the field displays and the venue never received is
      // NOT a failed fill and NOT a failed read - it is a WRITE THAT DID NOT LAND, and only the venue can testify
      // to that. So every method is judged by WHETHER THE VENUE'S CALCULATION CHANGED, and three are tried in order
      // of fidelity: real KEYSTROKES first, because `fill` sets the value and fires `input`, which a component
      // listening for key events will never see.
      const trailDiag = { fills: [] };
      // ⚠ THE METHOD ORDER IS MEASURED, NOT STYLISTIC. `keyboard.type` and Playwright's `fill` DO NOT REACH THE
      // VENUE'S MODEL on this control (measured 2026-09-30): the field displays the number and the calculation does
      // not follow it. Only the NATIVE value setter plus input/change/blur lands, and the tell is that the venue
      // re-renders the field with its own formatter (`10,000`). Native first; the others kept as a courtesy.
      const fillPips = async (val) => {
        const want = Math.round(Number(val));
        const expectedCount = distanceForCount({ symbol, count: want });
        // what the card MUST read if this count reached the venue. null on an instrument that was never measured -
        // there is nothing to be proportional TO, and the test degrades to "did the card move at all".
        const expected = expectedCount.ok ? expectedCount.distance : null;
        // ⚠⚠ TRD-TRL-7 (2026-10-01): ONE QUANTITY, ONE TOLERANCE.
        //
        // This landing check and `verifyReadback` measure the SAME thing — `readDistance` against `expected` —
        // and they used DIFFERENT tolerances: a hard-coded 5% here, and `risk.trailingStop.verifyTolerancePct`
        // (2) there. The gap between them is a DEAD ZONE: a write that lands 2-5% out PASSES this check, so the
        // code commits to it, and then FAILS the verification, so the entry falls into the fail-safe or aborts.
        // The abort message then names the 5% check while the decision came from the 2% one — which is how a
        // tolerance mismatch reads as an unexplained miss to whoever reads the log.
        //
        // ★ SO THE CONFIGURED TOLERANCE IS NOW THE ONLY KNOB. The owner's 2% is applied where it is configured
        // rather than silently widened to 5%, and the code no longer proceeds on a write it will go on to
        // reject. The absolute 0.05 floor is KEPT: a distance of a few cents sits below the display's own
        // resolution, and without it the check would be stricter than the venue can render.
        const configuredTol = Number(settings && settings.risk && settings.risk.trailingStop
          && settings.risk.trailingStop.verifyTolerancePct);
        const tolPct = Number.isFinite(configuredTol) && configuredTol > 0 ? configuredTol : 2;
        const before = await readTrail();
        let lastField = null;
        for (const how of ['native', 'fill', 'type']) {
          try {
            if (how === 'type') {
              const loc = page.locator('#trailing-stop-pips').first();
              await loc.click({ timeout: 5000 });
              await page.keyboard.press('Control+a');
              await page.keyboard.type(String(want), { delay: 20 });
              await page.keyboard.press('Tab');
            } else if (how === 'fill') {
              await page.locator('#trailing-stop-pips').first().fill(String(want), { timeout: 5000 });
            } else {
              await page.evaluate((v) => {
                const el = document.querySelector('#trailing-stop-pips');
                if (!el) return;
                el.focus();
                const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                nativeSet.call(el, v);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.blur();
              }, String(want));
            }
          } catch { /* try the next method */ }
          await jitterDelay(400, 650); // the SPA recomputes asynchronously: a read before it is a read of the past
          const field = await readPipField();
          lastField = field;
          if (field.numeric == null || Math.round(field.numeric) !== want) {
            trailDiag.fills.push({ val: want, how, held: false, field });
            continue;
          }
          const after = await readTrail();
          const moved = !!(before && after)
            && (before.money !== after.money || before.percentFraction !== after.percentFraction);
          // ⚠⚠ "THE CARD MOVED" IS NOT ENOUGH - AND THAT IS THE BUG BEING FIXED HERE. A fourth-decimal PRICE jitter
          // moves `money` without the count having landed, so a write the control IGNORED passed this test; the
          // read-back was then judged against a target it was never asked for and the entry was aborted with
          // `wanted 0.744, read 150.39`. The card must read what THIS COUNT MEANS, within a band that forgives
          // jitter (5c or 5%) and cannot forgive a clamp - the measured misses are 200x out, not 5%.
          // ⚠⚠ TRD-TRL-6 (2026-10-01): THE ANCHOR IS THE PRICE READ WITH THE PERCENT, NOT THE DECISION PRICE.
          //
          // On a ticket that has NOT BEEN SUBMITTED there is no entry yet, and the venue anchors its percent span
          // to the CURRENT PRICE. Measured on the read-only curve probe (Oil, 2026-10-01): distance is `percent x
          // price` EXACTLY, with the implied price constant at ~92.65 across the whole sweep —
          //     count  100  distance 1.06594  percent -1.15%  -> price 92.69
          //     count 1000  distance 10.07214 percent -10.87% -> price 92.66
          // so `entry` CANCELS ENTIRELY. Passing `entryGuess` therefore injects an error of exactly
          // `|entryGuess - after.price|` into every derived distance.
          //
          // ⚠ AND `entryGuess` IS THE DECISION PRICE, WHICH IS MEASURED 39-142 SECONDS STALE — the desk's ticks
          // come from its own position poll, so the newest tick at decision time is already that old. The error is
          // therefore the stale-price drift, which VARIES, which is why the failures never sat at one scale
          // factor (ratios 0.85, 1.10, 0.53, 0.53, 1.08) and why an anchor error was mistaken for a unit error.
          //
          // ⚠ AND THE MODULE ALREADY KNEW THIS. Its header states "`price` must be read at the SAME moment as the
          // money: ... a stale price turns a correct trail into a phantom mismatch". It read the price correctly
          // and then anchored the LEVEL on a different price anyway — the same "two different quantities" defect
          // this desk keeps finding, this time inside the reading that was supposed to catch it.
          const dist = after
            ? distanceFromPercent({ direction, entry: after.price, price: after.price, percentFraction: after.percentFraction })
            : { ok: false, reason: 'unreadable' };
          const readDistance = dist.ok ? dist.distance : null;
          const band = expected == null ? null : Math.max(0.05, Math.abs(expected) * (tolPct / 100));
          const proportional = (expected == null || readDistance == null)
            ? moved
            : Math.abs(readDistance - expected) <= band;
          trailDiag.fills.push({
            val: want, how, held: true, moved, proportional, expected, read: readDistance,
            via: field.via,
            beforePercent: before && before.percentRaw, afterPercent: after && after.percentRaw,
          });
          if (proportional) {
            return {
              pips: want, how, nodes: field.idNodes, value: field.raw, via: field.via,
              moved: true, read: readDistance, expected,
            };
          }
        }
        const fin = lastField || await readPipField();
        // ⚠ THE FIELD HELD IT AND THE VENUE DID NOT MOVE - that is a DIFFERENT fault from "the field refused", and
        // collapsing the two is what made eight refusals unreadable. Each says which it was.
        if (fin.numeric != null && Math.round(fin.numeric) === want) {
          const stuck = await readTrail();
          // ★★ TRD-TRL-6b (2026-10-02) — THE SITE THE ANCHOR FIX MISSED.
          //
          // TRL-6 replaced the anchor at the two sites that DECIDE (the tolerance check and the wide fallback) and
          // left this one, which only REPORTS. But the comment 38 lines above already says it: *"Passing
          // `entryGuess` therefore injects an error of exactly `|entryGuess - after.price|` into every derived
          // distance."* `entryGuess` is the DECISION price, measured 39-142 s stale.
          //
          // ⚠ WHY A DIAGNOSTIC MATTERS ENOUGH TO FIX. This is the message an operator reads when the trail
          // refuses — "the card reads X" — and X was computed with precisely the error that caused the four
          // production failures. A diagnostic that reproduces the defect it is reporting is the "surface that
          // looks authoritative and isn't" class, one layer down from the bug itself. The venue anchors to
          // CURRENT PRICE here, so `entry` must be the same reading as `price` and the drift term cancels.
          const stuckDist = stuck
            ? distanceFromPercent({ direction, entry: stuck.price, price: stuck.price, percentFraction: stuck.percentFraction })
            : { ok: false, reason: 'unreadable' };
          const e = new Error(`trailing stop: the pip field accepted ${want} but the venue's calculation did not `
            + `follow it (this count means a distance of ${expected == null ? 'an unmeasured size' : expected.toFixed(2)}, `
            + `the card reads ${stuckDist.ok ? stuckDist.distance.toFixed(2) : 'nothing readable'}; via ${fin.via}, `
            + `${fin.idNodes} node(s)) - refusing rather than accepting a trail the desk did not ask for`);
          e.trailDiag = trailDiag;
          throw e;
        }
        const e = new Error(`trailing stop: pip field did not take the count (wanted ${want}, got ${fin.raw} `
          + `across ${fin.idNodes} node(s) via ${fin.via})`);
        e.trailDiag = trailDiag;
        throw e;
      };

      // PLAN FIRST, BEFORE TOUCHING THE CARD, so every refusal below leaves the ticket exactly as it was.
      const rate0 = await readRate();
      // ⚠⚠ `entry` IS NOT TRUSTWORTHY JUST BECAUSE IT IS PRESENT. The executor computes `skipReason` for a
      // missing/zero decision price but DOES NOT RETURN ON IT — it is only reported later on the trade — so a
      // `0` can reach here. `0 != null` is true, so a plain null-check would accept it and `distanceFromPercent`
      // would derive a level from entry 0, which is garbage: the probe would not verify, the fail-safe would not
      // verify either, and a perfectly good entry would be ABORTED. Fall back to the live rate unless the value
      // is a real positive number.
      const entryGuess = Number(trailingStop.entry) > 0 ? Number(trailingStop.entry) : rate0;
      const trailPlan = planTrailingStop({ settings, direction, size, entry: entryGuess, price: rate0, stopPrice });

      if (!trailPlan.ok) {
        trailResult = { placed: false, reason: trailPlan.reason };
      } else {
        await toggleLimit(page, 'TradeSetLimits.TrailingStopHeader', 'TradeSetLimits.TrailingStopExpandable', '#trailing-stop-pips');
        // ⚠ THERE IS NO PROBE COUNT ANY MORE - see the long note below the read-back. The card is filled ONCE, with
        // a count computed from the measured unit table, because a second write to this control never lands.
        // ⚠⚠ TRD-TRL-3: THE READ-BACK IS THE THING THAT FAILED, AND IT LEFT NO EVIDENCE. Eight approved entries
        // were refused today on `wanted X, read Y`, where **Y did not depend on X at all**: three Sugar attempts
        // asking for 0.115 / 0.095 / 0.125 all read 31.55, and the value still moved slightly with the PRICE. A
        // reading that tracks the market but not our input is either (a) a count that never reached the venue's
        // model, or (b) a span that is not the trailing calc's. From the distance alone those are identical - so
        // the card is sampled BEFORE and AFTER the probe and the pair is recorded. One attempt now settles it.
        const preRead = await readTrail();
        // hoisted so that a fill failure ALSO carries the card's pre-fill state - the one datum that says whether
        // the count reached the venue at all
        const evidence = {
          cardBefore: preRead && { money: preRead.money, percent: preRead.percentFraction, raw: preRead.percentRaw, boxes: preRead.boxes },
          entryUsed: entryGuess,
          stopDist: trailPlan.stopDist, distanceTarget: trailPlan.distanceTarget,
        };
        const abort = (msg) => {
          const err = new Error(msg);
          err.trailEvidence = evidence;
          err.trailDiag = trailDiag;
          return err;
        };

        // ★★ THE PROBE MUST BE IN THE VENUE'S RANGE, AND THE DESK ASSUMED IT WAS - WHICH IS THE DEFECT.
        //
        // `pips* = probePips x target / distanceRead` is valid ONLY while the venue's response is LINEAR. 100,000
        // pips is a count the desk chose for itself; if the venue clamps it, the implied pip-per-count is wrong by
        // the clamp ratio, and that error then misses the target AND the fail-safe - the exact shape of all eight
        // refusals, whose `read` was the SAME on three different requested distances. So the range is TESTED rather
        // than assumed: read the distance at C and again at 2C and require it to double. A response that does not
        // double means C is outside the linear band, and the probe is halved and retried before anything is scaled
        // from it. The SEARCH only improves the first guess - `verifyReadback` is still the gate.
        // ★★ THE COUNT IS COMPUTED, NOT SCALED - AND THAT IS THE FIX FOR THIS ROW.
        //
        // This used to probe 100,000 pips and derive a pip-per-count from whatever came back. THE CONTROL CLAMPS:
        // the probe read the symbol's own MAXIMUM, the implied pip-per-count was wrong by the clamp ratio, and the
        // scaled count then missed the target AND the fail-safe - on Oil it asked for 62 pips where 82 was right,
        // and read back 150.39 when 0.744 was wanted. All eight refusals have that shape.
        //
        // ⚠ AND THE PROBE IS REMOVED, NOT MERELY CORRECTED. Measured 2026-09-30: the control COMMITS the first
        // count it is given and ignores every one after it, so probing first would make the real count a SECOND
        // write - the one that does not land. ONE CARD, ONE WRITE. The desk knows what a pip buys per instrument
        // (`PIP_UNITS`, measured on this very control), so the count is arithmetic and anything the control cannot
        // express is refused before a single keystroke.
        const pipsPlan = pipsForTarget({ symbol, distanceTarget: trailPlan.distanceTarget });
        evidence.pipsPlan = pipsPlan;
        if (!pipsPlan.ok) {
          // NOT AN ABORT: nothing has been written, so the ticket is exactly as it was found
          trailResult = { placed: false, reason: `unstateable_${pipsPlan.reason}`, detail: pipsPlan };
        } else {
          await fillPips(pipsPlan.pips);
          await jitterDelay(500, 800);
        }
        const final = pipsPlan.ok ? await readTrail() : null;
        evidence.cardAfterScaled = final && {
          money: final.money, percent: final.percentFraction, raw: final.percentRaw, boxes: final.boxes,
        };
        // ⚠ TRD-TRL-6: same anchor correction as the proportional check above — the ticket is still unsubmitted
        // here, so the venue's percent is relative to THIS price and `entryGuess` must not enter the derivation.
        const finalDist = final
          ? distanceFromPercent({ direction, entry: final.price, price: final.price, percentFraction: final.percentFraction })
          : { ok: false, reason: 'not_written' };
        evidence.finalDistance = finalDist.ok ? finalDist.distance : `unreadable:${finalDist.reason}`;
        const check = verifyReadback({
          distanceRead: finalDist.ok ? finalDist.distance : null,
          distanceTarget: trailPlan.distanceTarget,
          tolerancePct: trailPlan.tolerancePct,
        });
        // ★★ TRD-TRL-4: THE DISTANCE CHECK ABOVE CANNOT SEE WHERE THE TRAIL LANDED, AND ON TRADE #1164 IT LANDED
        // ON THE WRONG SIDE OF THE STOP. Measured 2026-10-01: requested 0.875, read back 0.8688 (drift 0.709%,
        // inside the 2% tolerance, so `check.ok === true`) - but the recorded stop was 89.595 and the level landed
        // at 89.6312, which for a buy is a TIGHTER stop by 0.0362, about 4% of the stop distance. The venue fires
        // the tighter level first, so the trail silently replaced the stop that every R multiple divides by.
        // The venue's pip grid and the price it applies the count to both sit between the request and the level,
        // and neither is visible from the distance. The REALISED LEVEL is what arbitrates, so it is what is checked.
        const levelCheck = finalDist.ok
          ? verifyStopRelationship({
            direction, stopPrice, trailLevel: finalDist.trailLevel,
            multiple: trailPlan.multiple,
            allowTighterThanStop: !!(settings && settings.risk && settings.risk.trailingStop
              && settings.risk.trailingStop.allowTighterThanStop === true),
            stopDistFromEntry: trailPlan.stopDistFromEntry,
            tolerancePct: trailPlan.tolerancePct,
          })
          : { ok: false, reason: 'level_unreadable' };
        evidence.levelCheck = levelCheck;
        evidence.trailLevelTarget = trailPlan.trailLevelTarget;
        evidence.trailLevelRead = finalDist.ok ? finalDist.trailLevel : null;
        if (check.ok && levelCheck.ok) {
          trailResult = {
            placed: true,
            pips: pipsPlan.pips,
            pipUnit: pipsPlan.pip,
            targetDistance: trailPlan.distanceTarget,
            distance: finalDist.distance,
            trailLevel: finalDist.trailLevel,
            trailLevelTarget: trailPlan.trailLevelTarget,
            tighterThanStop: levelCheck.tighter,
            read: { money: final.money, percent: final.percentFraction, price: final.price },
            driftPct: check.driftPct,
          };
        } else if (pipsPlan.ok) {
          // ⚠⚠ FAIL-SAFE, NOT FAIL-CLOSED, AND THE TENURE IS THE REASON. The card is already engaged, so simply
          // proceeding would carry whatever the venue is ACTUALLY holding - unverifiable and possibly tighter than
          // the stop. But aborting trades one risk for a worse one over a 19-day unattended run: if this path never
          // verifies, EVERY entry aborts and the desk goes SILENT with nobody at the screen to notice, which is
          // precisely the thing the tenure exists to observe.
          // So the fallback is a trail that is PROVABLY HARMLESS: set it WIDER than the venue stop, where the stop
          // fires first and nothing about the current behaviour changes. The ratchet is then simply absent, which
          // is a degradation rather than a hazard, and it is REPORTED as one.
          // ⚠ If even that cannot be verified, the read-back itself is unusable and nothing can be established -
          // then, and only then, the order is aborted.
          // ⚠ THE FAIL-SAFE'S COUNT COMES FROM THE SAME MODEL, under the same refusal rules: a fallback the
          // control cannot express is not a fallback. It exists for the case where the control did not HOLD the
          // request - not for the case where the desk cannot state one at all, which is handled before the card.
          let fallback = null;
          const wideTarget = 2 * trailPlan.stopDist;
          const widePlan = pipsForTarget({ symbol, distanceTarget: wideTarget });
          evidence.wideTarget = wideTarget;
          evidence.widePlan = widePlan;
          if (widePlan.ok) {
            const widePips = widePlan.pips;
            evidence.widePips = widePips;
            if (widePips > 0) {
              await fillPips(widePips);
              await jitterDelay(500, 800);
              const wide = await readTrail();
              evidence.cardAfterWide = wide && {
                money: wide.money, percent: wide.percentFraction, raw: wide.percentRaw, boxes: wide.boxes,
              };
              const wideDist = distanceFromPercent({
                direction, entry: wide.price, price: wide.price, percentFraction: wide.percentFraction,
              });
              evidence.wideDistance = wideDist.ok ? wideDist.distance : `unreadable:${wideDist.reason}`;
              const wideCheck = verifyReadback({
                distanceRead: wideDist.ok ? wideDist.distance : null,
                distanceTarget: wideTarget,
                tolerancePct: trailPlan.tolerancePct,
              });
              evidence.wideDriftPct = wideCheck.driftPct;
              if (wideCheck.ok) {
                fallback = {
                  pips: widePips, distance: wideDist.distance, trailLevel: wideDist.trailLevel,
                  driftPct: wideCheck.driftPct,
                };
              }
            }
          }
          if (!fallback) {
            throw abort(`trailing stop: the venue did not hold the requested distance (wanted `
              + `${trailPlan.distanceTarget}, read ${finalDist.ok ? finalDist.distance : 'unreadable'}) and the `
              + 'fail-safe could not be verified either - ABORTING, because a trail whose size the desk cannot '
              + 'state must not be submitted');
          }
          trailResult = {
            placed: true,
            degraded: true,
            reason: check.ok
              ? 'trail_landed_tighter_than_stop_fell_back_wider_than_stop'
              : 'verification_failed_fell_back_wider_than_stop',
            levelCheck,
            trailLevelTarget: trailPlan.trailLevelTarget,
            readLevel: finalDist.ok ? finalDist.trailLevel : null,
            requestedDistance: trailPlan.distanceTarget,
            readDistance: finalDist.ok ? finalDist.distance : null,
            pips: widePlan.ok ? widePlan.pips : null,
            ...fallback,
          };
        }
      }
    }
  }

  const submitRate = await page.evaluate(() => {
    const el = document.querySelector('#buySellCfd');
    const m = el ? (el.textContent || '').match(/Current Rate\s*([\d,]+(?:\.\d+)?)/i) : null;
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  }).catch(() => null);

  // ★ 2026-10-05: SPREAD-AT-SUBMIT TELEMETRY. The card is already open — ONE read of its own Buy/Sell labels
  // (NO navigation) makes the venue's round-trip spread at submit a recorded fact. `slippagePct` (executor) is
  // fill vs the desk's DECISION price; this is the market the order actually met. Best-effort: a failed read
  // yields nulls and changes nothing about the order.
  const pxAtSubmit = ticketPrice(await readTicket(page).catch(() => null));

  await jitterDelay(400, 1000); // human-like: pause before committing
  await page.click('#trade-button');

  const freshRaw = await page.waitForFunction(
    (prev) => {
      // Rejection surfaces in the ticket (e.g. "Insufficient Balance").
      const rejectEl = document.querySelector('#buySellCfd [data-testid="BuySell.FundsStatusText"], #buySellCfd .buy-sell-cfd__status-chip span');
      const reject = rejectEl ? (rejectEl.textContent || '').trim() : '';
      if (/insufficient|not enough|rejected/i.test(reject)) return JSON.stringify({ rejected: reject });
      // ⚠ TRD-EXE-1 (#1454) ITEM 4 IS NOT FIXED HERE, AND THIS IS WHY: the container `.positions-orders` holds
      // BOTH positions and QUEUED ORDERS, so a row anchored on `PositionRow.` cannot match a queued order and the
      // desk reports `ambiguous` for an order the venue has accepted. Classifying the other rows needs the venue's
      // ORDER-row testid prefix, and that cannot be observed from here — it only exists when a market is closed
      // and an order is genuinely queued, so GUESSING the prefix would be worse than the current state (it could
      // label a position a queued order). What this change does instead is make the next occurrence
      // SELF-DOCUMENTING: the scan below is unchanged in what it matches, but the failure path now reports WHAT
      // `.positions-orders` actually held. `present` distinguishes "nothing appeared" (genuinely ambiguous) from
      // "a row appeared and it is not a position" (a queued order, named), which is the distinction the record has
      // never carried. The classification fix can then be written against a real testid.
      const ids = [...document.querySelectorAll('.positions-orders [data-testid^="PositionRow."]')].map((el) => el.getAttribute('data-testid'));
      const id = ids.find((x) => !prev.includes(x));
      if (!id) return null;
      const el = document.querySelector(`[data-testid="${id}"]`);
      return JSON.stringify({ testid: id, text: el ? (el.textContent || '').replace(/\s+/g, ' ') : '' });
    },
    before,
    { timeout: 20000 }
  ).catch(() => null);
  const fresh = freshRaw ? JSON.parse(freshRaw) : null;
  if (fresh && fresh.rejected) throw new Error(`order rejected by venue: ${fresh.rejected}`);
  if (!fresh) {
    // EVIDENCE, NOT A VERDICT. `present` is every testid the container held at the moment of failure.
    const present = await page.evaluate(() => [...document.querySelectorAll('.positions-orders [data-testid]')]
      .map((el) => el.getAttribute('data-testid')).filter(Boolean)).catch(() => null);
    const shape = present == null ? 'could not be read'
      : present.length === 0 ? 'was EMPTY (nothing appeared — genuinely ambiguous)'
        : `held ${present.length} row(s): ${present.slice(0, 6).join(', ')}`;
    throw new Error(`position row did not appear after submit (order may have failed) — .positions-orders ${shape}`);
  }

  const posId = String(fresh.testid || '').replace('PositionRow.', '') || null;
  const valueM = (fresh.text || '').match(/Value:\s*\$?([\d,]+(?:\.\d+)?)/i);
  return {
    positionId: posId,
    units: 'Contracts',
    price: submitRate,
    value: valueM ? parseFloat(valueM[1].replace(/,/g, '')) : null,
    // 2026-10-05: spread telemetry (see the read above) — venue Buy/Sell at submit, for Trades.spreadSubmitPct.
    ticketBuy: pxAtSubmit.buy,
    ticketSell: pxAtSubmit.sell,
    ticketSource: pxAtSubmit.source,
    filledAt: new Date().toISOString(),
    // TRD-TRL-2 (#1485): null when no trail was asked for; `{ placed: false, reason }` when it was refused BEFORE
    // the card was touched; the verified placement otherwise. The order is placed in all three cases.
    trailingStop: trailResult,
  };
}

async function closePosition(page, settings, trade) {
  await withConnRetry(() => page.goto(URLS.positions, { timeout: 45000, waitUntil: 'domcontentloaded' }));
  await page.waitForFunction(
    () => document.querySelector('.position-group-title') || document.querySelector('[data-testid^="OpenPosition."]'),
    null,
    { timeout: 20000 }
  ).catch(() => {});
  await page.waitForTimeout(1500);
  const clicked = await page.evaluate(({ symbol, direction, positionId }) => {
    const clean = (s) => (s || '').replace(/[\u200e\u200f\u200b\u00a0]/g, '').trim();
    const rows = [...document.querySelectorAll('[data-testid^="OpenPosition."]')]
      .filter((r) => /^OpenPosition\.\d+$/.test(r.getAttribute('data-testid') || ''));
    const clickRow = (row) => {
      const btn = row.querySelector('[data-testid$=".Button.Close"], .buySellButton');
      if (!btn) return false;
      btn.click();
      return true;
    };
    // 1. EXACT positionId match (authoritative — names like "Soybean Oil"
    //    contain "Oil" and a substring match can close the wrong position).
    if (positionId) {
      const row = rows.find((r) => r.getAttribute('data-testid') === `OpenPosition.${positionId}`);
      if (row && clickRow(row)) return row.getAttribute('data-testid');
    }
    // 2. EXACT instrument name match (never substring).
    for (const row of rows) {
      const testid = row.getAttribute('data-testid') || '';
      let group = row.previousElementSibling;
      while (group && !group.classList.contains('position-group-title')) group = group.previousElementSibling;
      const nameEl = (group && group.querySelector('strong')) || row.querySelector('.name, strong.name');
      const name = nameEl ? clean(nameEl.textContent) : null;
      if (!name || clean(name) !== clean(symbol)) continue;
      const dirEl = row.querySelector('.position-direction, [data-testid$=".Direction"]');
      const dirText = dirEl ? clean(dirEl.textContent).toLowerCase() : null;
      if (direction && dirText !== direction) continue;
      if (clickRow(row)) return testid;
    }
    return null;
  }, { symbol: trade.symbol, direction: trade.direction, positionId: trade.plus500PositionId });
  if (!clicked) throw new Error(`open position not found for ${trade.symbol} ${trade.direction}`);

  const posId = String(clicked).split('.')[1];
  await page.waitForSelector('#closePositionBtn', { timeout: 15000 }).catch(() => { throw new Error('close panel did not open'); });
  await jitterDelay(400, 1000); // human-like: read the close panel before confirming
  await page.click('#closePositionBtn');

  await page.waitForFunction((id) => !document.querySelector(`[data-testid="OpenPosition.${id}"]`), posId, { timeout: 20000 })
    .catch(() => { /* row may linger briefly */ });

  const readClosed = (id) => page.evaluate((pid) => {
    const row = document.querySelector(`[data-position-id="${pid}"]`);
    if (!row) return null;
    const clean = (s) => (s || '').replace(/[\u200e\u200f\u200b\u00a0]/g, '').trim().replace(/\s+/g, ' ');
    const num = (s) => {
      const m = clean(s).match(/-?[\d,]+(?:\.\d+)?/);
      return m ? parseFloat(m[0].replace(/,/g, '')) : null;
    };
    const rates = [...row.querySelectorAll('.rates span')].map((s) => clean(s.textContent));
    const pnlEl = row.querySelector('.net-pl [data-currency], .net-pl span');
    return {
      price: rates[1] ? num(rates[1]) : null,        // closing rate
      openPrice: rates[0] ? num(rates[0]) : null,    // opening rate
      pnl: pnlEl ? num(pnlEl.textContent) : null,
    };
  }, id);

  let fill = await readClosed(posId);
  if (!fill) {
    await withConnRetry(() => page.goto(URLS.closedPositions, { timeout: 45000, waitUntil: 'domcontentloaded' }));
    await page.waitForSelector(`[data-position-id="${posId}"]`, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500); // lazy rows render
    fill = (await readClosed(posId)) || {};
  }
  return {
    positionId: posId,
    price: fill.price ?? null,
    pnl: fill.pnl ?? null,
    closedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Closed positions — the venue's own record of every close (2026-09-12).
// The desk now relies on VENUE-NATIVE SL/TP, so most positions are closed by
// Plus500 itself: those appear here as "Profit call" / "Loss call", and Oil /
// Silver also close at session end ("Market closed"). The mirror only ever
// noticed those as "position vanished" and flagged the row `phantom`, throwing
// away the close price, P&L, reason and time — which is why the Past table read
// as broken. This reads the real record. Rows carry `data-position-id`, the same
// id we store as plus500PositionId, so matching is exact.
async function readClosedPositions(page) {
  await withConnRetry(() => page.goto(URLS.closedPositions, { timeout: 45000, waitUntil: 'domcontentloaded' }));
  await page.waitForSelector('.closed-position[data-position-id]', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500); // rows render lazily
  // Walk the list to the bottom so a virtualised list is fully materialised.
  try {
    for (let i = 0; i < 8; i++) {
      const grew = await page.evaluate(() => {
        const row = document.querySelector('.closed-position[data-position-id]');
        let el = row && row.parentElement;
        while (el && el.scrollHeight <= el.clientHeight + 4) el = el.parentElement;
        const before = document.querySelectorAll('.closed-position[data-position-id]').length;
        if (el) el.scrollTop = el.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
        return before;
      });
      await page.waitForTimeout(400);
      const now = await page.evaluate(() => document.querySelectorAll('.closed-position[data-position-id]').length);
      if (now <= grew && i >= 2) break; // no new rows for two rounds -> done
    }
  } catch { /* scrolling is opportunistic */ }

  const items = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/[\u200e\u200f\u200b\u00a0]/g, '').trim().replace(/\s+/g, ' ');
    const num = (s) => { const m = clean(s).match(/-?[\d,]+(?:\.\d+)?/); return m ? parseFloat(m[0].replace(/,/g, '')) : null; };
    return [...document.querySelectorAll('.closed-position[data-position-id]')].map((row) => {
      const rates = [...row.querySelectorAll('.rates span')].map((s) => clean(s.textContent));
      const adj = [...row.querySelectorAll('.adjustments [data-currency]')].map((s) => clean(s.textContent));
      const plEl = row.querySelector('.net-pl [data-currency], .net-pl span');
      const nameEl = row.querySelector('.type .name');
      const dirEl = row.querySelector('.amount-and-direction span');
      return {
        positionId: row.getAttribute('data-position-id'),
        symbol: clean(nameEl && nameEl.textContent),
        direction: clean(dirEl && dirEl.textContent).toLowerCase(),
        amountText: clean((row.querySelector('.amount') || {}).textContent),
        netPnl: num(plEl && plEl.textContent),
        closeValue: num((row.querySelector('.value span') || {}).textContent),
        openRate: num(rates[0]),
        closeRate: num(rates[1]),
        adjustments: num(adj[0]),
        funding: num(adj[1]),
        closedAtText: clean((row.querySelector('.close-time') || {}).textContent),
        reason: clean((row.querySelector('.reason') || {}).textContent),
      };
    });
  });

  // "9/12/2026 1:00 AM" is on the VENUE's clock (the browser's local zone) — a
  // real instant, unlike our own closedAt guess. Parse it explicitly: the Date
  // constructor's string parsing for that format is locale-dependent.
  for (const it of items) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(it.closedAtText);
    if (!m) { it.closedAt = null; continue; }
    let h = Number(m[4]) % 12;
    if (/PM/i.test(m[6])) h += 12;
    it.closedAt = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), h, Number(m[5])).toISOString();
  }
  return { items, url: page.url() };
}

// ---------------------------------------------------------------------------
// Open an instrument in the chart (watchlist click-through, TRD-4).
// TRD-8: search-bar first (one SPA lookup, no category navigation), with the
// old category-page click as fallback.
// ---------------------------------------------------------------------------
async function openInstrument(page, settings, symbol) {
  const cat = SYMBOL_CATEGORY[String(symbol).toLowerCase()];
  const clickRow = () => page.evaluate((sym) => {
    const rows = [...document.querySelectorAll('[data-testid^="InstrumentRow."]')];
    for (const row of rows) {
      const nameEl = row.querySelector('.name');
      if (!nameEl) continue;
      const name = (nameEl.textContent || '').replace(/[\u200e\u200f]/g, '').trim();
      if (name !== sym) continue;
      const target = row.querySelector('.name') || row;
      target.click();
      return true;
    }
    return false;
  }, symbol);

  // Search-first: land once, find the instrument through the search bar.
  const search = await searchInstrument(page, symbol, settings).catch(() => null);
  if (search && search.hit) {
    await sleep(2000); // chart title updates after selection
    const chartTitle = await readChartTitle(page);
    // ★ TRD-EXE-18: CARRY THE PRICE THE SEARCH ALREADY PAID FOR. `searchInstrument` returns a real buy/sell here
    // — from the ticket, or from the category table when the ticket did not render — and every caller of
    // `openInstrument` used to lose it. `probeSession` lost it and then re-read the ticket, which is the read that
    // had just failed, which is why the venue price was null on every live observation.
    const buy = priceNum(search.hit.buy);
    const sell = priceNum(search.hit.sell);
    return {
      symbol, opened: true, category: cat || 'search', chartTitle, via: 'search',
      buy, sell, priceSource: buy != null || sell != null ? (search.source || 'search') : null,
    };
  }

  // Fallback: navigate to its category page and click the row.
  if (!cat) throw new Error(`no category mapping for ${symbol}`);
  await withConnRetry(() => page.goto(CATEGORY_URLS[cat], { timeout: 45000, waitUntil: 'domcontentloaded' }));
  await waitForTable(page, 20000);
  let clicked = await clickRow();
  if (!clicked && CATEGORY_FALLBACKS[cat]) {
    await withConnRetry(() => page.goto(CATEGORY_FALLBACKS[cat], { timeout: 45000, waitUntil: 'domcontentloaded' }));
    await waitForTable(page, 20000);
    clicked = await clickRow();
  }
  if (!clicked) throw new Error(`instrument row not found for ${symbol}`);
  await sleep(2500); // chart title updates after selection
  const chartTitle = await readChartTitle(page);
  // ⚠ THE CATEGORY PATH HAS NO SEARCH HIT, so the card the click has just opened is the only place a price can
  // come from. Reading it HERE rather than in each caller also means the read happens while the page is provably
  // still on this instrument, instead of after an extra round of sleeping in the caller.
  const catPx = ticketPrice(await readTicket(page).catch(() => null));
  return {
    symbol, opened: true, category: cat, chartTitle, via: 'category',
    buy: catPx.buy, sell: catPx.sell, priceSource: catPx.source,
  };
}

// ── TRD-TRL-3: THE READ-ONLY RESPONSE CURVE OF THE VENUE'S TRAILING-STOP CONTROL ──────────────────────────────
//
// WHY IT EXISTS. The first live capture (2026-09-30T09:30Z) proved the control COMMITS the first count it is given
// and IGNORES every one after it: 100000 committed -166.56%, and then 25000, 62 and 124 all read the SAME value
// while the PRICE kept moving it in the fourth decimal. "Probe, then scale" cannot work against a control in that
// state, and neither can the fail-safe, because its correction is itself a second write. What is unknown is the
// count RANGE where the control answers PROPORTIONALLY - and it is BELOW 62, since a 62-count write did not move it.
//
// ⚠⚠ IT MUST NOT BE FOUND BY SPENDING ENTRIES, which is what the eight refusals did. This walks the curve on a
// ticket that is NEVER SUBMITTED: nothing is armed until `#trade-button` is clicked, and this never clicks it.
//
// ⚠ FRESH TICKET PER COUNT, AND THAT IS THE METHOD. Re-using one card would measure the stale-value behaviour that
// is already known; a new ticket per count makes every measurement a FIRST write, which is the only kind this
// control honours, and therefore the only kind the desk can ever use.
//
// ⚠ THE READER IS DELIBERATELY ITS OWN, not the one `placeOrder` uses. A probe that reads through the code under
// test cannot detect a fault in that code, and this probe exists precisely because that reader passed while the
// venue was not responding. It reads the two panels the venue prints, as plainly as possible.
const DEFAULT_TRAIL_SWEEP = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 5000, 25000, 100000];

async function readTrailPanel(page) {
  const spans = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="TradeSetLimits.TrailingStopCalc"]');
    const num = (el) => {
      if (!el) return { v: null, raw: null };
      const s = String(el.textContent || '').replace(/[\u200e\u200f\u202a-\u202e]/g, '');
      const m = s.match(/-?[\d,]+(?:\.\d+)?/);
      return { v: m ? parseFloat(m[0].replace(/,/g, '')) : null, raw: s.trim().slice(0, 40) };
    };
    const money = box ? num(box.querySelector('[data-currency]')) : { v: null, raw: null };
    const pct = box ? num(box.querySelector('[data-percent]')) : { v: null, raw: null };
    const exp = document.querySelector('[data-testid="TradeSetLimits.TrailingStopExpandable"]');
    const inside = exp ? [...exp.querySelectorAll('input')] : [];
    const byId = [...document.querySelectorAll('#trailing-stop-pips')];
    const field = inside[0] || byId[0] || null;
    return {
      calcBoxes: box ? 1 : 0,
      money: money.v, moneyRaw: money.raw,
      percent: pct.v, percentRaw: pct.raw,
      fieldRaw: field ? String(field.value || '') : null, fieldVia: inside[0] ? 'card' : byId[0] ? 'id' : 'none',
      fieldNodes: byId.length,
    };
  }).catch(() => null);
  const price = await page.evaluate(() => {
    const el = document.querySelector('#buySellCfd');
    const m = el ? (el.textContent || '').match(/Current Rate\s*([\d,]+(?:\.\d+)?)/i) : null;
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  }).catch(() => null);
  return { ...(spans || {}), price, percentFraction: spans && spans.percent != null ? spans.percent / 100 : null };
}

async function probeTrailCurve(page, settings, { symbol, direction = 'buy', counts = DEFAULT_TRAIL_SWEEP, methods = null, stopPrice = null, size = null } = {}) {
  const cat = SYMBOL_CATEGORY[String(symbol).toLowerCase()];
  const rows = [];
  // ⚠ THE COUNT SWEEP AND THE METHOD SWEEP ANSWER DIFFERENT QUESTIONS, and the first run of this probe needed both.
  // MEASURED 2026-09-30 on Oil: `keyboard.type` and Playwright `fill` BOTH leave the venue's model untouched - every
  // count from 1 to 100,000 read back the card's own default -0.40% - while the NATIVE SETTER route (native value
  // setter + `input` + `change` + `blur`) MOVED it. The tell is the field itself: after the native write the venue
  // re-renders it as `10,000`, its own formatter having run, where the keystroke route leaves the raw digits sitting
  // there unformatted. So the count sweep defaults to the method that lands; sweeping counts with a method that does
  // not would have reported saturation where there was only a write that never arrived (which is exactly what the
  // first run reported).
  const steps = Array.isArray(methods) && methods.length
    ? methods.map((m) => ({ count: counts[0], method: String(m) }))
    : counts.map((c) => ({ count: c, method: 'native' }));
  for (const step of steps) {
    const count = step.count;
    const row = {
      count, method: step.method, ok: false, reason: null, defaultRaw: null, raw: null, money: null,
      distance: null, pip: null, fieldRaw: null, fieldVia: null, percentFraction: null, price: null, moved: null,
      stopPrice: null, size: null, ticketBuy: null, ticketSell: null,
    };
    try {
      const target = cat ? CATEGORY_URLS[cat] : URLS.trade;
      await withConnRetry(() => page.goto(target, { timeout: 45000, waitUntil: 'domcontentloaded' }));
      await waitForTable(page, 20000).catch(() => {});
      let clicked = await clickInstrumentRow(page, { symbol, direction });
      if (!clicked && cat && CATEGORY_FALLBACKS[cat]) {
        await withConnRetry(() => page.goto(CATEGORY_FALLBACKS[cat], { timeout: 45000, waitUntil: 'domcontentloaded' }));
        await waitForTable(page, 20000).catch(() => {});
        clicked = await clickInstrumentRow(page, { symbol, direction });
      }
      if (!clicked) { row.reason = 'instrument_row_not_found'; rows.push(row); continue; }
      await page.waitForSelector('#amount-input', { timeout: 15000 });
      await jitterDelay(300, 600);
      // TRD-TRL-8 (2026-10-08) — REPRODUCE THE TICKET STATE OF THE T2.5 ABORT, READ-ONLY.
      //
      // The failed Silver probe (2026-10-08T00:49Z) wrote its ONE table count on a ticket that ALSO carried a
      // filled size and an ENGAGED STOP-LOSS card; every clean sweep so far wrote the trail on a bare card. The
      // card read back 0.65 where the count's own law says 1.26 — and 0.65 is coincident with the STOP's distance
      // from price at that moment, so the stop card is the one state variable the sweeps never carried. These two
      // optional inputs reproduce it exactly. Both are TICKET-TIME inputs that feed `#trade-button` and commit
      // NOTHING until it is pressed — which this probe never does, the same safety argument as the count itself.
      row.size = Number(size) > 0 ? Number(size) : null;
      row.stopPrice = Number(stopPrice) > 0 ? Number(stopPrice) : null;
      if (row.size != null) {
        await page.evaluate((val) => {
          const el = document.querySelector('#amount-input');
          if (!el) return;
          el.focus();
          const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSet.call(el, String(val));
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }, row.size);
        await jitterDelay(200, 400);
      }
      if (row.stopPrice != null) {
        await toggleLimit(page, 'TradeSetLimits.CloseAtLossHeader', 'TradeSetLimits.CloseAtLossExpandable', '#close-at-loss-rate');
        await fillRate(page, '#close-at-loss-rate', row.stopPrice);
        await jitterDelay(200, 400);
      }
      // TRD-TRL-9 (2026-10-08): CAPTURE THE BOOK, at the same moment as the count's reading. The offset/price
      // correlation experiment needs the spread the venue was actually running, and the open ticket publishes it.
      const tk = await readTicket(page).catch(() => null);
      const tpx = ticketPrice(tk);
      row.ticketBuy = tpx.buy;
      row.ticketSell = tpx.sell;
      await toggleLimit(page, 'TradeSetLimits.TrailingStopHeader', 'TradeSetLimits.TrailingStopExpandable', '#trailing-stop-pips');
      const def = await readTrailPanel(page);
      row.defaultRaw = def.percentRaw;
      // THE COUNT GOES IN ONCE. This is the first write on a fresh card, and the first write is the only one this
      // control honours - which is exactly the property under measurement. The method is the variable when the
      // caller asks for a method sweep.
      if (step.method === 'fill') {
        await page.locator('#trailing-stop-pips').first().fill(String(count), { timeout: 8000 }).catch(() => {});
      } else if (step.method === 'native') {
        await page.evaluate((v) => {
          const el = document.querySelector('#trailing-stop-pips');
          if (!el) return;
          el.focus();
          const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSet.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur();
        }, String(count));
      } else {
        await page.locator('#trailing-stop-pips').first().click({ timeout: 5000 });
        await page.keyboard.press('Control+a');
        await page.keyboard.type(String(count), { delay: 25 });
        await page.keyboard.press('Tab');
      }
      await jitterDelay(700, 1000); // the SPA recomputes asynchronously
      const after = await readTrailPanel(page);
      row.raw = after.percentRaw;
      row.money = after.money;
      row.percentFraction = after.percentFraction;
      row.price = after.price;
      row.fieldRaw = after.fieldRaw;
      row.fieldVia = after.fieldVia;
      row.moved = !!(def && after) && (def.money !== after.money || def.percentFraction !== after.percentFraction);
      // `entry = price` ON PURPOSE: on a ticket there is no position yet and the venue denominates the percentage
      // by the value at the CURRENT price, so this isolates the CONTROL's response rather than a decision's entry.
      const d = distanceFromPercent({ direction, entry: after.price, price: after.price, percentFraction: after.percentFraction });
      if (!d.ok) { row.reason = d.reason; rows.push(row); continue; }
      row.distance = d.distance;
      row.pip = +(d.distance / count).toFixed(10);
      row.ok = true;
      rows.push(row);
    } catch (e) {
      row.reason = String(e.message || e).slice(0, 120);
      rows.push(row);
    }
  }
  return { symbol, direction, counts, methods, rows };
}

// TRD-EXE-16 (2026-10-01): FOCUS AN INSTRUMENT SO ITS SESSION BECOMES KNOWN — NAVIGATION ONLY.
//
// The venue publishes a session on `SingleTradeInstrument` when the page focuses an instrument, and the session
// feed harvests it. Nothing here touches the ticket: no size, no level, no field, no Buy/Sell button. It is the
// same navigation `placeOrder` falls back to, run earlier so the answer can still change the decision.
//
// ⚠ FAIL-OPEN, ALWAYS. It returns a reason rather than throwing, because its caller's correct behaviour when the
// probe fails is EXACTLY what happens today — the entry is refused for an unknown session. A probe that could
// throw would convert a coverage gap into a failed order path, which is a larger defect than the one it fixes.
async function probeSession(page, settings, symbol) {
  try {
    // ★ TRD-EXE-18: KEEP WHAT THE NAVIGATION FOUND. This was `await openInstrument(...)` with the result thrown
    // away, so the price the navigation had already obtained was discarded with it.
    const opened = (await openInstrument(page, settings, symbol)) || {};
    await sleep(1200);
    const chartTitle = await readChartTitle(page).catch(() => null);
    // ⚠ A TITLE MISMATCH DOES NOT MEAN THE PROBE FAILED, AND MEASURING IT LIVE PROVED THAT (2026-10-01): the
    // first real run returned `title_mismatch` while the session feed's verdict for the same symbol flipped to
    // `true` — the payload had arrived, the title simply had not rendered inside the window. So this flag reports
    // "the landing was not CONFIRMED", which is a weaker claim than "the page did not move". The caller must
    // decide on the FEED VERDICT, never on this flag, and the executor records both beside each other.
    const landed = !!chartTitle && String(chartTitle).toLowerCase().includes(String(symbol).toLowerCase());
    // ★★ TRD-EXE-17 / B1a (2026-10-01): THE SAME NAVIGATION ALSO YIELDS A PRICE THE DESK DID NOT DECIDE FROM.
    //
    // We are already standing on the instrument's page, and the ticket carries the venue's LIVE buy and sell —
    // the freshest price the desk can obtain, from a source it did NOT derive the decision price from. The
    // decision price is measured 39-142 SECONDS STALE (plus500 ticks come from the desk's own position poll), and
    // for an instrument the desk does not hold there is no fresh tick AT ALL — which is precisely the case this
    // probe runs in. So the one place with no price is also the one place we can now read one.
    //
    // ⚠ READ-ONLY AND OBSERVATIONAL. It records the number and changes NO LEVEL: the re-anchor and the stop
    // geometry are untouched, so this cannot void the frozen TRD-29 track and needs no gating decision. It exists
    // so the separating measurement — does the adverse skew collapse with a fresh reference? — can finally be made.
    //
    // ★ TRD-EXE-18: THE NAVIGATION'S PRICE FIRST, THE TICKET SECOND. `readTicket` is the read that was measured
    // returning nothing on the page this probe lands on, while `openInstrument` ALREADY knows how to obtain a
    // price when the ticket does not render (the search path's table fallback). Trying the failing read first is
    // precisely what made this field null on every live observation.
    let buy = priceNum(opened.buy);
    let sell = priceNum(opened.sell);
    let priceSource = buy != null || sell != null ? (opened.priceSource || 'navigation') : null;
    if (buy == null && sell == null) {
      const t = ticketPrice(await readTicket(page).catch(() => null));
      buy = t.buy;
      sell = t.sell;
      priceSource = t.source;
    }
    const mid = Number.isFinite(buy) && Number.isFinite(sell) ? +((buy + sell) / 2).toFixed(8) : null;
    return {
      focused: landed, chartTitle: chartTitle || null, reason: landed ? null : 'title_mismatch',
      buy: Number.isFinite(buy) ? buy : null, sell: Number.isFinite(sell) ? sell : null, venueMid: mid,
      // ⚠ WHICH SOURCE PRODUCED THE PRICE IS PART OF THE ANSWER. A null venue price and a price from a different
      // page are different facts, and without this the next live check cannot tell 'the read failed' from 'we
      // looked in the wrong place' — the distinction that cost this one two days.
      priceSource,
    };
  } catch (err) {
    return { focused: false, chartTitle: null, reason: `probe_failed: ${String(err && err.message).slice(0, 100)}`, buy: null, sell: null, venueMid: null, priceSource: null };
  }
}

// ★★ EXE-14 S1 (2026-10-01) — READ THE POST-ENTRY `Edit` -> `Set Limits` PATH. THIS FUNCTION WRITES NOTHING.
//
// WHY IT EXISTS. EXE-14 anchors the stop to the FILL, which means writing a level on a LIVE position after the
// order is placed. `placeOrder`'s comment documents that route from an owner dump (2026-09-30) and states plainly
// that it is NOT wired. The plan's first step is therefore not to USE it but to find out whether it is where the
// dump says — because if it is not, every later step would be written against a fiction.
//
// ⚠⚠ RECONNAISSANCE ALREADY FOUND THAT THE DUMP COVERS ONLY HALF THE PATH, WHICH IS WHY THERE ARE TWO PHASES.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// EXE-14 S2 — `setPositionLevels(page, settings, trade, { stopPrice, takeProfitPrice })`.
//
// The post-entry `Edit` → `Set Limits` path. Written against the S1 re-probe of 2026-10-02, which corrected
// three things the first reading of the dump had wrong:
//
// 1. ⚠⚠ **THE COMMIT CONTROL IS OUTSIDE THE CARD.** `#setLimitsCfd` contains **ZERO** buttons. The card is
//    committed by `#trade-button`, which S1 found carrying TWO names at once — `id="trade-button"` AND
//    `data-testid="BuySell.SubmitButton"` — living in `DIV[BuySell.Footer]` inside `#buySellCfd`, a SIBLING of
//    the card and not a child. That is exactly why the first dump, filtered to `[data-testid*="SetLimits"]`,
//    reported "no confirm control": the control exists, and the FILTER hid it.
//    ⇒ **A read-back taken without clicking it shows the value we TYPED while the venue still holds the OLD
//    level — a verification that LIES.** So this function never treats the input as evidence of anything.
//
// 2. ★ **THE CONTEXT IS AUDITABLE FOR FREE, AND THAT IS THE SAFETY PROPERTY.** On the entry ticket the same
//    `#trade-button` reads `Buy`/`Sell`; on the edit card it reads `Update`. The label is therefore an
//    assertion about which state the tab is in, and `setPositionLevels` REFUSES to click unless it says
//    `Update`. Without that guard a click meant as "commit the levels" is a click that could open a position.
//
// 3. ⚠ **PRECISION.** `Trades.stopPrice` holds 4dp; the venue shows 2dp (`fillRate` does `toFixed(2)`). Every
//    comparison here is made at the VENUE's precision, because comparing a 4dp ledger value against a 2dp read
//    fails on a write that is CORRECT — and that failure would trip the restore path this code exists to avoid.
//
// ⚠ SAFE IN THE ONE DIRECTION THAT MATTERS: the BEFORE read comes from the row's own
// `OpenPosition.<venueId>.LimitStop` text, which needs NO interaction at all (S1 sub-finding 2). So even if the
// card never opens, the function knows what the venue held and can put it back. It never reports success on a
// level it could not read back from the VENUE.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════

// The venue's own display precision (2dp). Half of the last digit it shows, with room for the thousands
// separator and a trailing rounding. A tighter epsilon would fail a correct write; a looser one would accept a
// moved stop as "close enough", which is the reading that gets a position closed at the wrong price.
const LEVEL_EPS = 0.005;

// Read a row's levels from the ROW, never from the card. `Limit:` is the take-profit and `Stop:` is the stop —
// the venue's own words, so the parse is against its format rather than against a number we hoped to see.
async function readRowLevels(page, venueId) {
  return page.evaluate((id) => {
    const clean = (s) => String(s || '').replace(/[\u200e\u200f\u200b\u00a0]/g, '').trim();
    const el = document.querySelector(`[data-testid="OpenPosition.${id}.LimitStop"]`);
    if (!el) return { found: false };
    const t = clean(el.textContent);
    const num = (label) => {
      const m = t.match(new RegExp(label + '\\s*:?\\s*([\\d,]+\\.?\\d*)', 'i'));
      return m ? parseFloat(m[1].replace(/,/g, '')) : null;
    };
    return { found: true, text: t, takeProfitPrice: num('Limit'), stopPrice: num('Stop') };
  }, venueId);
}

// Did the VENUE end up holding every level we asked for? Read from the row, at the venue's precision.
function levelsSettled(plan, levels) {
  if (!levels || !levels.found || !plan || !plan.length) return false;
  return plan.every((p) => {
    const got = p.which === 'profit' ? levels.takeProfitPrice : levels.stopPrice;
    return got != null && Math.abs(got - Number(p.want)) < LEVEL_EPS;
  });
}

async function setPositionLevels(page, settings, trade, { stopPrice = null, takeProfitPrice = null } = {}) {
  const venueId = trade && trade.plus500PositionId != null ? String(trade.plus500PositionId) : null;
  const out = {
    ok: false, venueId, requested: { stopPrice, takeProfitPrice },
    before: null, typed: null, after: null, submitLabel: null, reason: null, restored: null, restoreOk: null, error: null,
  };
  if (!venueId) { out.reason = 'no_venue_position_id'; return out; }
  if (stopPrice == null && takeProfitPrice == null) { out.reason = 'nothing_to_set'; return out; }

  try {
    if (!String(page.url()).includes('/open-positions')) {
      await withConnRetry(() => page.goto(URLS.positions, { timeout: 45000, waitUntil: 'domcontentloaded' }));
    }
    await page.waitForFunction(() => document.querySelector('[data-testid^="OpenPosition."]'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200);

    // BEFORE — taken from the row, so it survives a card that never opens, and it is the value the restore
    // path puts back. Read before any click so nothing the desk does can move it first.
    out.before = await readRowLevels(page, venueId);
    if (!out.before.found) { out.reason = 'row_not_found'; return out; }

    // Open the card. `OpenPosition.<id>.Button.Edit` is a DIRECT testid (S1 sub-finding), not a text heuristic.
    const opened = await page.evaluate((id) => {
      const el = document.querySelector(`[data-testid="OpenPosition.${id}.Button.Edit"]`);
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    }, venueId).catch(() => false);
    if (!opened) { out.reason = 'edit_control_not_found'; return out; }

    // Wait for the card AND for the submit to read `Update`. The card animates (the documented trap), and the
    // LABEL is the assertion that this is the edit path rather than the entry ticket.
    const ctx = await page.waitForFunction(() => {
      const b = document.querySelector('#trade-button');
      const card = document.querySelector('#setLimitsCfd');
      if (!b || !card) return false;
      return /^update$/i.test(String(b.textContent || '').trim()) ? true : false;
    }, null, { timeout: 12000 }).catch(() => false);
    if (!ctx) {
      out.reason = 'not_in_edit_context';
      out.submitLabel = await page.evaluate(() => { const b = document.querySelector('#trade-button'); return b ? String(b.textContent || '').trim().slice(0, 30) : null; }).catch(() => null);
      return out; // ⚠ NOT A CLICK. If it does not say Update, this is not the card we think it is.
    }
    out.submitLabel = 'Update';

    // `toggleLimit` is IDEMPOTENT BY OBSERVATION — it only clicks when the card is CLOSED — so on an edit card
    // whose level is already ON it is a no-op. (The S2 plan's worry that it would toggle an armed level OFF
    // does not apply: the guard is `isExpanded`, not a blind click. Recorded because the opposite was written
    // down after S1 and it would have justified a needless second function.)
    const plan = [];
    if (takeProfitPrice != null) plan.push({ which: 'profit', header: 'TradeSetLimits.CloseAtProfitHeader', expand: 'TradeSetLimits.CloseAtProfitExpandable', sel: '#close-at-profit-rate', want: Number(takeProfitPrice), had: out.before.takeProfitPrice });
    if (stopPrice != null) plan.push({ which: 'loss', header: 'TradeSetLimits.CloseAtLossHeader', expand: 'TradeSetLimits.CloseAtLossExpandable', sel: '#close-at-loss-rate', want: Number(stopPrice), had: out.before.stopPrice });

    for (const p of plan) {
      await toggleLimit(page, p.header, p.expand, p.sel);
      p.filled = await fillRate(page, p.sel, p.want);
    }
    out.typed = plan.map((p) => ({ which: p.which, want: p.want, filled: p.filled }));

    // ⚠ THE ONLY WRITE IN THIS FUNCTION. Everything above only filled inputs, which commits nothing.
    await page.click('#trade-button', { timeout: 15000 });

    // Verify against the ROW. Re-navigate once if the row has not re-rendered, because an unchanged row is not
    // evidence of an unchanged LEVEL — it may simply not have refreshed.
    let after = null;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1000);
      after = await readRowLevels(page, venueId);
      if (levelsSettled(plan, after)) break;
      if (i === 3) {
        await page.goto(URLS.positions, { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(1500);
      }
    }
    out.after = after;
    if (levelsSettled(plan, after)) { out.ok = true; return out; }

    // ⚠⚠ THE READ-BACK DID NOT CONFIRM, SO PUT BACK WHAT THE VENUE HELD. A position must never be left holding a
    // stop the desk cannot state. The card is still open (we just committed from it), so the restore re-fills
    // and commits again.
    out.reason = 'readback_mismatch';
    try {
      const back = [];
      if (takeProfitPrice != null && out.before.takeProfitPrice != null) back.push({ which: 'profit', header: 'TradeSetLimits.CloseAtProfitHeader', expand: 'TradeSetLimits.CloseAtProfitExpandable', sel: '#close-at-profit-rate', want: out.before.takeProfitPrice });
      if (stopPrice != null && out.before.stopPrice != null) back.push({ which: 'loss', header: 'TradeSetLimits.CloseAtLossHeader', expand: 'TradeSetLimits.CloseAtLossExpandable', sel: '#close-at-loss-rate', want: out.before.stopPrice });
      for (const p of back) {
        await toggleLimit(page, p.header, p.expand, p.sel);
        await fillRate(page, p.sel, p.want);
      }
      if (back.length) await page.click('#trade-button', { timeout: 15000 });
      await page.waitForTimeout(2500);
      out.restored = await readRowLevels(page, venueId);
      out.restoreOk = levelsSettled(back, out.restored);
    } catch (e) {
      out.restoreOk = false;
      out.restoreError = String((e && e.message) || e).slice(0, 160);
    }
    return out;
  } catch (err) {
    out.error = String((err && err.message) || err).slice(0, 200);
    return out;
  } finally {
    // The documented way out of the card, and it only ever closes. Never leaves the shared tab holding a
    // half-open dialog for the mirror poller to read as a stuck page.
    await page.keyboard.press('Escape').catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// TRD-TRL-9 (2026-10-08) — `setPositionTrail(page, settings, trade, { trailDistance, stopPrice, commit })`.
//
// The POST-ENTRY trail engage: the second half of the lock075_t15 policy (lock at +0.75R on touch, then a
// trailing stop 0.15R behind the peak). The wake-side decider (`agent/trailEngage.js`) computes WHEN; this
// function is HOW, on the same Edit -> Set Limits card `setPositionLevels` already drives.
//
// ⚠ THE CARD IS INERT UNTIL `#trade-button` (readable as `Update` in this context) IS PRESSED — so every path
// below except the single `commit` click writes NOTHING, and `commit: false` is a fully read-only verification of
// the whole mechanism against a live position (the mode the staged rollout runs first).
//
// ⚠ THE COUNT IS COMPUTED FROM THE MEASURED TABLE, never probed: `pipsForTarget` refuses an instrument without a
// measured row, and the count is checked against the venue's OWN reading before anything is committed — the
// venue's calculation is the only witness that a write reached its model (TRD-TRL-3's lesson, re-learned live on
// 2026-10-08 when Silver's stale offset refused a trail pre-write; the offset was re-measured the same night).
//
// ⚠ AN UNVERIFIABLE COUNT IS A REFUSAL, NOT A COMMIT. `proportional: false` closes the card and returns
// `trail_not_verified_before_commit` — the position keeps the stop-only state it had. After a commit the venue
// holds the trail: a failed post-commit read-back is therefore reported as `committed_unverified` (with whatever
// the venue did hold), never silently passed.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function setPositionTrail(page, settings, trade, { trailDistance, stopPrice = null, commit = false } = {}) {
  const venueId = trade && trade.plus500PositionId != null ? String(trade.plus500PositionId) : null;
  const symbol = trade ? trade.symbol : null;
  const direction = trade && trade.direction === 'sell' ? 'sell' : 'buy';
  const out = {
    ok: false, commitRequested: !!commit, venueId, symbol, direction,
    requested: { trailDistance, stopPrice }, plan: null, before: null, card: null, typed: null,
    committed: false, after: null, trailAfter: null, submitLabel: null, reason: null, error: null,
  };
  if (!venueId) { out.reason = 'no_venue_position_id'; return out; }

  const plan = pipsForTarget({ symbol, distanceTarget: trailDistance });
  out.plan = plan;
  if (!plan.ok) { out.reason = `unstateable_${plan.reason}`; return out; }

  try {
    if (!String(page.url()).includes('/open-positions')) {
      await withConnRetry(() => page.goto(URLS.positions, { timeout: 45000, waitUntil: 'domcontentloaded' }));
    }
    await page.waitForFunction(() => document.querySelector('[data-testid^="OpenPosition."]'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200);

    out.before = await readRowLevels(page, venueId);
    if (!out.before.found) { out.reason = 'row_not_found'; return out; }

    const opened = await page.evaluate((id) => {
      const el = document.querySelector(`[data-testid="OpenPosition.${id}.Button.Edit"]`);
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    }, venueId).catch(() => false);
    if (!opened) { out.reason = 'edit_control_not_found'; return out; }

    // The label is the assertion that this is the edit context rather than the entry ticket (same guard, same
    // reason, as setPositionLevels — no click unless it reads Update).
    const ctx = await page.waitForFunction(() => {
      const b = document.querySelector('#trade-button');
      const card = document.querySelector('#setLimitsCfd');
      if (!b || !card) return false;
      return /^update$/i.test(String(b.textContent || '').trim()) ? true : false;
    }, null, { timeout: 12000 }).catch(() => false);
    if (!ctx) {
      out.reason = 'not_in_edit_context';
      out.submitLabel = await page.evaluate(() => { const b = document.querySelector('#trade-button'); return b ? String(b.textContent || '').trim().slice(0, 30) : null; }).catch(() => null);
      return out; // ⚠ NOT A CLICK.
    }
    out.submitLabel = 'Update';

    // the lock, when the policy asks to move the stop — same helpers, same idempotence as setPositionLevels
    if (stopPrice != null && Number(stopPrice) > 0) {
      await toggleLimit(page, 'TradeSetLimits.CloseAtLossHeader', 'TradeSetLimits.CloseAtLossExpandable', '#close-at-loss-rate');
      out.typed = { stopFilled: await fillRate(page, '#close-at-loss-rate', Number(stopPrice)) };
    }

    // the trail card — the SAME fourth card shape as the ticket-time one (owner dump 2026-09-30); idempotent toggle
    await toggleLimit(page, 'TradeSetLimits.TrailingStopHeader', 'TradeSetLimits.TrailingStopExpandable', '#trailing-stop-pips');
    const pre = await readTrailPanel(page);
    out.card = { pre: pre && { money: pre.money, percentRaw: pre.percentRaw, price: pre.price, fieldRaw: pre.fieldRaw, fieldVia: pre.fieldVia, calcBoxes: pre.calcBoxes } };
    if (!pre || pre.price == null || pre.fieldRaw == null) { out.reason = 'trail_card_not_found'; return out; }

    // ── THE WRITE THAT COMMITS NOTHING: one count, native setter only (keyboard.type and fill never reach this
    // control's model — measured 2026-09-30; the tell is the venue re-rendering the field with its own formatter).
    const want = plan.pips;
    const expected = distanceForCount({ symbol, count: want });
    out.expectedDistance = expected.ok ? expected.distance : null;
    await page.evaluate((v) => {
      const el = document.querySelector('#trailing-stop-pips');
      if (!el) return;
      el.focus();
      const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      nativeSet.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    }, String(want));
    await jitterDelay(500, 800); // the SPA recomputes asynchronously: a read before it is a read of the past

    const post = await readTrailPanel(page);
    const fieldNum = post && post.fieldRaw != null ? parseFloat(String(post.fieldRaw).replace(/[^\d.-]/g, '')) : null;
    const dist = post
      ? distanceFromPercent({ direction, entry: post.price, price: post.price, percentFraction: post.percentFraction })
      : { ok: false, reason: 'unreadable' };
    const readDistance = dist.ok ? dist.distance : null;
    const tolPct = (settings && settings.risk && settings.risk.trailingStop && Number(settings.risk.trailingStop.verifyTolerancePct)) || 2;
    const band = out.expectedDistance == null ? null : Math.max(0.05, Math.abs(out.expectedDistance) * (tolPct / 100));
    const held = fieldNum != null && Math.round(fieldNum) === want;
    const proportional = held && readDistance != null && band != null && Math.abs(readDistance - out.expectedDistance) <= band;
    out.card.post = post && { money: post.money, percentRaw: post.percentRaw, price: post.price, fieldRaw: post.fieldRaw, fieldVia: post.fieldVia, readDistance, expectedDistance: out.expectedDistance, band };

    if (!held) { out.reason = `pip_field_did_not_take_count (raw ${post && post.fieldRaw})`; return out; } // nothing committed
    if (!proportional) { out.reason = 'trail_not_verified_before_commit'; return out; }                        // nothing committed

    if (!commit) { out.ok = true; out.reason = 'verified_read_only'; return out; } // the staged-rollout mode

    // ── THE ONLY WRITE IN THIS FUNCTION IS THIS CLICK.
    await page.click('#trade-button', { timeout: 15000 });
    out.committed = true;

    // POST-COMMIT VERIFICATION — against the venue, never against our own typing.
    // 1) the row's stop, when one was moved.
    let after = null;
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1000);
      after = await readRowLevels(page, venueId);
      if (stopPrice == null || (after.found && after.stopPrice != null && Math.abs(after.stopPrice - Number(stopPrice)) < LEVEL_EPS)) break;
      if (i === 3) {
        await page.goto(URLS.positions, { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(1500);
      }
    }
    out.after = after;
    const stopVerified = stopPrice == null || Number(stopPrice) <= 0
      ? true
      : !!(after && after.found && after.stopPrice != null && Math.abs(after.stopPrice - Number(stopPrice)) < LEVEL_EPS);

    // 2) the trail card, reopened from scratch — the venue's own record of what it now holds.
    let trailAfter = null;
    try {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(800);
      const reopened = await page.evaluate((id) => {
        const el = document.querySelector(`[data-testid="OpenPosition.${id}.Button.Edit"]`);
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      }, venueId);
      if (reopened) {
        const ok2 = await page.waitForFunction(() => {
          const b = document.querySelector('#trade-button');
          return b ? /^update$/i.test(String(b.textContent || '').trim()) : false;
        }, null, { timeout: 10000 }).catch(() => false);
        if (ok2) {
          await toggleLimit(page, 'TradeSetLimits.TrailingStopHeader', 'TradeSetLimits.TrailingStopExpandable', '#trailing-stop-pips');
          await page.waitForTimeout(600);
          const back = await readTrailPanel(page);
          const backNum = back && back.fieldRaw != null ? parseFloat(String(back.fieldRaw).replace(/[^\d.-]/g, '')) : null;
          trailAfter = back && { fieldRaw: back.fieldRaw, fieldNum: backNum, percentRaw: back.percentRaw, money: back.money, price: back.price };
        }
      }
    } catch (e) { trailAfter = { error: String((e && e.message) || e).slice(0, 160) }; }
    out.trailAfter = trailAfter;
    const trailVerified = !!(trailAfter && trailAfter.fieldNum != null && Math.round(trailAfter.fieldNum) === want);

    if (stopVerified && trailVerified) { out.ok = true; out.reason = null; return out; }
    out.reason = 'committed_unverified';
    out.detail = { stopVerified, trailVerified, want };
    return out;
  } catch (err) {
    out.error = String((err && err.message) || err).slice(0, 200);
    return out;
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
  }
}

// Every `TradeSetLimits.*` testid in this repo belongs to the TICKET-TIME card, and the dump says that same card is
// reused post-entry — consistent, and testable. But the ROW's `Edit` control, the thing you must click to reach
// the card after a fill, has NO recorded testid anywhere in the repo; the only trace is the body-text signal
// `\bEdit\b`, which detects the WORD and not the element. So phase one CLICKS NOTHING and simply reports what is
// actually there.
//
//   1. discovery (default) — dump the per-row action elements (testid, class, text) and every edit-ish testid on
//      the page. No click of any kind.
//   2. verify ({ edit: true }) — click that row's Edit control, read the card's level fields and switch states,
//      then press Escape. STILL NO WRITE: no size, no level, no switch toggle, no confirm.
//
// ⚠ SAFE BY CONSTRUCTION, ON THE SAME ARGUMENT `probeTrailCurve` GIVES. Nothing is committed until a Save/Confirm
// is pressed and no path here presses one. Escape is the documented way out, and closing a card we opened is the
// only direction this can move the venue.
//
// ⚠⚠ EXE-14 S2 (2026-10-02): THAT FIRST SENTENCE WAS AN ASSUMPTION, NOT AN OBSERVATION — and the `--edit` dump
// could not test it. `nodes` is filtered to `[data-testid*="SetLimits"]`, so a CONFIRM/APPLY control living in a
// shared footer OUTSIDE the card is invisible to it. If one exists and is not pressed, a read-back shows the
// TYPED value while the venue still holds the OLD level — a verification that LIES, which is the defect class
// this workstream keeps re-finding. `commitControls` below closes that gap: it reports every button-like element
// INSIDE the card and every apply-shaped control anywhere on the page, whatever its testid.
async function probePositionLevels(page, settings, { edit = false, rowIndex = 0 } = {}) {
  const out = { phase: edit ? 'verify' : 'discovery', urlBefore: String(page.url()).slice(0, 200), rowCount: 0, discovery: null, card: null, error: null };
  try {
    if (!String(page.url()).includes('/open-positions')) {
      await withConnRetry(() => page.goto(URLS.positions, { timeout: 45000, waitUntil: 'domcontentloaded' }));
    }
    // Wait for a ROW to exist, not for the shell. A shell-only page has testids and no positions, and reading it
    // as "no rows" is the mistake `orderBookEval` and the sidebar probe both had to be fixed for.
    await page.waitForFunction(() => document.querySelector('[data-testid^="OpenPosition."]'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    out.url = String(page.url()).slice(0, 200);

    // ---- PHASE 1: DISCOVERY. No click. ----
    out.discovery = await page.evaluate((idx) => {
      const rows = [...document.querySelectorAll('[data-testid^="OpenPosition."]')];
      const clean = (s) => String(s || '').replace(/[\u200e\u200f\u200b\u00a0]/g, '').trim().replace(/\s+/g, ' ');
      const describe = (el) => ({
        tag: el.tagName,
        tid: el.getAttribute('data-testid'),
        cls: el.className ? String(el.className).slice(0, 70) : null,
        text: clean(el.textContent).slice(0, 45),
      });
      const scan = (root) => [...root.querySelectorAll('button, a, [role="button"], svg, [data-testid]')]
        .map(describe)
        .filter((d) => d.tid || /\b(edit|set limits|limits|close|modify|cancel)\b/i.test(d.text))
        .slice(0, 30);
      const groups = [...document.querySelectorAll('[data-testid^="OpenPositions.Group."]')];
      return {
        contentType: 'positions',
        rowCount: rows.length,
        groupCount: groups.length,
        bodyHasEditWord: /\bEdit\b/i.test(document.body ? document.body.innerText : ''),
        // Every testid on the page that even looks like an edit entry point, in case it lives OUTSIDE the row.
        editishTestids: [...new Set([...document.querySelectorAll('[data-testid]')]
          .map((e) => e.getAttribute('data-testid'))
          .filter((t) => /edit|setlimit|set-limit|limit/i.test(t || '')))].slice(0, 40),
        setLimitsTestids: [...new Set([...document.querySelectorAll('[data-testid]')]
          .map((e) => e.getAttribute('data-testid'))
          .filter((t) => /TradeSetLimits/i.test(t || '')))].slice(0, 40),
        firstRow: rows[idx] ? { tid: rows[idx].getAttribute('data-testid'), descendants: scan(rows[idx]) } : null,
        firstGroup: groups[idx] ? { tid: groups[idx].getAttribute('data-testid'), descendants: scan(groups[idx]) } : null,
      };
    }, rowIndex).catch((e) => ({ error: String(e && e.message).slice(0, 120) }));

    // ---- PHASE 2: VERIFY. One click, one read, one Escape. ----
    if (edit) {
      const clicked = await page.evaluate((idx) => {
        const clean = (s) => String(s || '').replace(/[\u200e\u200f\u200b\u00a0]/g, '').trim();
        const rows = [...document.querySelectorAll('[data-testid^="OpenPosition."]')];
        const row = rows[idx];
        if (!row) return { ok: false, reason: 'no_row' };
        const group = row.closest('[data-testid^="OpenPositions.Group."]') || row;
        // Prefer an explicitly-named control, then the word Edit, then a bare button in the action cell.
        const cands = [...group.querySelectorAll('button, a, [role="button"], [data-testid]')];
        const byTid = cands.find((e) => /edit|setlimit|set-limit/i.test(e.getAttribute('data-testid') || ''));
        const byText = cands.find((e) => /^(edit|edit position|set limits)$/i.test(clean(e.textContent)));
        const el = byTid || byText;
        if (!el) return { ok: false, reason: 'no_edit_control_found', candidates: cands.map((e) => ({ tid: e.getAttribute('data-testid'), text: clean(e.textContent).slice(0, 30) })).slice(0, 25) };
        el.click();
        return { ok: true, via: byTid ? 'testid' : 'text', tid: el.getAttribute('data-testid'), text: clean(el.textContent).slice(0, 30) };
      }, rowIndex).catch((e) => ({ ok: false, reason: `click_threw: ${String(e && e.message).slice(0, 100)}` }));
      out.clicked = clicked;

      if (clicked && clicked.ok) {
        await page.waitForTimeout(1800); // the card animates; the dump documents this trap
        // ⚠ READ-ONLY READ OF WHATEVER CARD APPEARED. Nothing is filled, toggled or confirmed.
        out.card = await page.evaluate(() => {
          const clean = (s) => String(s || '').replace(/[\u200e\u200f\u200b\u00a0]/g, '').trim();
          const nodes = [...document.querySelectorAll('[data-testid*="SetLimits"], [id^="close-at"], [id*="trailing-stop"]')]
            .slice(0, 40)
            .map((el) => ({
              tid: el.getAttribute('data-testid'), id: el.id || null, tag: el.tagName,
              value: el.value != null && el.value !== '' ? String(el.value).slice(0, 24) : null,
              text: clean(el.textContent).slice(0, 50) || null,
              checked: typeof el.checked === 'boolean' ? el.checked : null,
            }));
          return {
            nodeCount: nodes.length, nodes,
            // The DOCUMENTED testids, read by name so the answer is a direct yes/no against the dump.
            byKnownTid: Object.fromEntries(['TradeSetLimits.CloseAtProfitHeader', 'TradeSetLimits.CloseAtProfitExpandable',
              'TradeSetLimits.CloseAtLossHeader', 'TradeSetLimits.CloseAtLossExpandable',
              'TradeSetLimits.TrailingStopHeader', 'TradeSetLimits.TrailingStopExpandable'].map((t) => [t, !!document.querySelector(`[data-testid="${t}"]`)])),
            stoppedAt: Object.fromEntries(['#close-at-profit-rate', '#close-at-loss-rate', '#trailing-stop-pips'].map((s) => {
              const el = document.querySelector(s);
              return [s, el ? { value: el.value, readOnly: !!el.readOnly, visible: !!(el.offsetParent) } : null];
            })),
            anyDialog: (() => { const d = document.querySelector('[role="dialog"], [data-testid*="Dialog"]'); return d ? { tid: d.getAttribute('data-testid'), text: clean(d.textContent).slice(0, 200) } : null; })(),
            // ★ EXE-14 S2. The one question the filtered `nodes` list could not answer.
            commitControls: (() => {
              const isBtn = (e) => e.tagName === 'BUTTON' || e.tagName === 'PLUS500-BUTTON' ||
                e.getAttribute('role') === 'button' || /button/i.test(e.getAttribute('data-testid') || '');
              const card = document.querySelector('#setLimitsCfd') || document.querySelector('[data-testid="BuySell.TradeSetLimits"]');
              const describe = (e, insideCard) => ({
                tag: e.tagName, tid: e.getAttribute('data-testid'), id: e.id || null,
                text: clean(e.textContent).slice(0, 40),
                visible: !!e.offsetParent, disabled: !!e.disabled, insideCard,
              });
              // 1. EVERY button-like element inside the card, regardless of its testid.
              const inCard = card ? [...card.querySelectorAll('*')].filter(isBtn).map((e) => describe(e, true)).slice(0, 25) : [];
              // 2. Every apply-shaped control ANYWHERE on the page, so a shared footer cannot hide.
              const applyish = [...document.querySelectorAll('button, [role="button"], plus500-button, a')]
                .filter((e) => /^(apply|save|confirm|submit|set|done|ok|update|apply changes)$/i.test(clean(e.textContent)) ||
                  /apply|save|confirm|submit/i.test(e.getAttribute('data-testid') || ''))
                .map((e) => describe(e, !!(card && card.contains(e)))).slice(0, 25);
              // 3. AN UNFILTERED INVENTORY of every button-shaped element actually on screen. The two lists above
              //    are filtered by TEXT and by CARD MEMBERSHIP, so an icon-only commit — or one that is a SIBLING
              //    of the card rather than a child — could still hide. This list cannot.
              const allVisible = [...document.querySelectorAll('button, [role="button"], plus500-button, [data-testid*="utton"]')]
                .filter((e) => !!e.offsetParent)
                .map((e) => describe(e, !!(card && card.contains(e)))).slice(0, 40);
              // 4. WHAT IS `BuySell.SubmitButton`? It is referenced NOWHERE in the repo, and on the edit card it
              //    reads "Update" while the entry ticket submits through `#trade-button` — a DIFFERENT element. So
              //    "Update commits the card" is an INFERENCE from a label, and clicking an unidentified control on
              //    a LIVE position is exactly what S1 exists to prevent. Record its ancestry, its attributes and
              //    whether `#trade-button` also exists, so the claim can be checked before anything clicks it.
              const ancestry = (el) => {
                const chain = []; let n = el;
                for (let i = 0; i < 6 && n && n.tagName; i++) {
                  chain.push(`${n.tagName}${n.id ? '#' + n.id : ''}${n.getAttribute && n.getAttribute('data-testid') ? '[' + n.getAttribute('data-testid') + ']' : ''}`);
                  n = n.parentElement;
                }
                return chain;
              };
              const sub = document.querySelector('[data-testid="BuySell.SubmitButton"]');
              const tradeBtn = document.querySelector('#trade-button');
              return {
                cardFound: !!card, cardId: card ? (card.id || card.getAttribute('data-testid')) : null,
                inCardButtons: inCard, applyishAnywhere: applyish, allVisibleButtons: allVisible,
                tradeButtonPresent: !!tradeBtn,
                tradeButtonText: tradeBtn ? clean(tradeBtn.textContent).slice(0, 30) : null,
                submitDetail: sub ? {
                  text: clean(sub.textContent).slice(0, 40),
                  attrs: [...sub.attributes].map((a) => `${a.name}="${String(a.value).slice(0, 60)}"`).slice(0, 20),
                  ancestry: ancestry(sub),
                  html: String(sub.outerHTML || '').slice(0, 300),
                } : null,
              };
            })(),
          };
        }).catch((e) => ({ error: String(e && e.message).slice(0, 150) }));
      }
    }
  } catch (err) {
    out.error = String(err && err.message).slice(0, 200);
  }
  return out;
}

module.exports = {
  URLS, DEFAULT_SELECTOR_MAP, selectorMap, CONN_ERROR_TEXT,
  CATEGORY_URLS, CATEGORY_FALLBACKS, SYMBOL_CATEGORY,
  gotoPage, withConnRetry, isLoggedIn, waitForLogin, assertDemo, recoverTradePage, readAccount, readAccountStatus, readTable,
  readPositions, readOrders, readTradeInstruments, readChartTitle, readChartBars, readInstrumentTable, waitForTable, matchRow, searchInstrument, searchExists, healthCheck, readTicket, readHrefMap,
  // 2026-10-05 (#1511): the app-button park (client-side route change, no document load — "soft navigation").
  softParkOpenPositions,
  readOrderBookShape,
  // EXE-14 S1: read the post-entry Edit -> Set Limits path. WRITES NOTHING (see the function's own header).
  probePositionLevels,
  // EXE-14 S2: move a position's levels through the post-entry Edit card, and VERIFY against the venue row.
  // The commit control is `#trade-button` (a SIBLING of the card), and this refuses to click unless it reads
  // `Update` — so it cannot press a Buy button by mistake. See the function's header for the S1 corrections.
  setPositionLevels, readRowLevels, levelsSettled, LEVEL_EPS,
  // TRD-TRL-9 (2026-10-08): the POST-ENTRY trail engage (lock075_t15's second half). `commit:false` is a fully
  // read-only verification against a live position; the commit click is the only write and never fires unverified.
  setPositionTrail,
  // TRD-PRU-3 (2026-10-08): the read-only candidate screen — category pages, instrument rows, live spreads.
  probeInstrumentPages,
  // TRD-PRU-3b (2026-10-08): the read-only per-symbol chart backfill (series + interval verdict fields).
  probeInstrumentBars,
  // EXE-NG-1 (2026-10-02): the ticket-reach path, extracted so `placeOrder` and the diagnostic probe cannot
  // drift, plus the read-only census that makes an "order ticket did not open" row explain itself.
  openTicket, ticketCensus,
  // TRD-TRL-3: the read-only response curve of the trailing-stop control, and the sweep it walks by default.
  probeTrailCurve, DEFAULT_TRAIL_SWEEP,
  // The chart-interval verdict (2026-09-25): `layout.interval` is a CLAIM the engine makes before it
  // attempts a reload and cannot report a failure for, so the series is measured beside it.
  CHART_UNIT_SEC, chartIntervalVerdict, barSpacingSec,
  placeOrder, closePosition, openInstrument, readInstrumentAlerts, createPriceAlert, readPlus500Alerts, readPositionsLive, readInstrumentSentiment,
  readClosedPositions,
  // TRD-EXE-16: navigation-only instrument focus, so a session can be learned before a decision depends on it.
  probeSession,
};
