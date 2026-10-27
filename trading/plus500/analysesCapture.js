// trading/plus500/analysesCapture.js — TRD-PRM-1 P1 (2026-10-04): sweep the Plus500 premium analyses
// into the WRITE-ONLY ledger (AnalysesNotes + AnalysisLevels; migration 047). NO consumer, nothing
// chair-visible; the study that may one day read this ledger is separately pre-registered (brief
// Rev 2 §2 P3). Lock: pageLock.tryAcquire('analyses') — the SKIP class (pageLock.js flow policy:
// ticket/capture WAIT; mirror/watchdog SKIP) — a busy tab is skipped and retried next tick.
// Park: always back to /open-positions in the finally (the 4.12 idiom).
//
// v0→v1 (first live run, 2026-10-04): the deep-link returned a shell and tab clicks landed on the
// side menu — the sweep stored ONE no_levels row and reported NAMED failures. v1: settle on
// networkidle, discover the nav, signature-gate every store, RETURN per-step diagnostics.
// ★ v1.3 (2026-10-04, final): THE ANALYSES ARE ONE (CROSS-ORIGIN) IFRAME DEEP. The entry is
// CLIENT-SIDE: /action/inter/marketanalysis?product=CFD hosts www.plus500.com/<lang>/premiumhub/*
// as an iframe — /premiumhub/weekly = the Weekly Newsletter; clicking "Instrument Analyses" INSIDE
// the frame navigates it to /premiumhub/daily/<slug> = the instrument intraday views. The outer
// page's innerText is a ~300-char shell and can NEVER contain the content (hard loads render a
// public language-select shell entirely) — that is why v0-v1.2 read nothing. v1.3 reads and drives
// the FRAME (weekly first, then the Instrument Analyses tab + the five instrument tabs), dismisses
// the platform blocking dialog before any interaction, and adds the owner-directed VISION LANE
// (per-view screenshot -> LLM extraction, stored separately as source='capture-vision').
/* global document */ // page.evaluate callbacks run in the browser context
'use strict';

const store = require('../store');
const parser = require('../agent/analysesParser');

const BASE_URL = 'https://app.plus500.com/';
const TRADE_URL = 'https://app.plus500.com/trade/gold';
const ANALYSES_ROUTE = '/action/inter/marketanalysis?product=CFD';
const PREMIUMHUB_FRAME = /www\.plus500\.com\/.+\/premiumhub\//;
const PARK_URL = 'https://app.plus500.com/open-positions';
const INSTRUMENTS = ['Oil', 'Natural Gas', 'Nasdaq 100', 'Gold', 'Germany 40'];
const URL_SETTLE_MS = 2500;
const TAB_SETTLE_MS = 3000;
const FRAME_WAIT_MS = 25000;
// The sweep visits up to 7 views + vision calls — its budget is its own (the 90 s capture budget is
// for ONE view). ANALYSES_TIMEOUT_MS caps the whole sweep.
const ANALYSES_TIMEOUT_MS = 300000;
const QUIET_MS = 8000;
const MIN_TEXT = 200;
const RAW_CAP = 200000; // rawText is evidence, not a mirror — cap generously, name the cap here

// A view is stored only when its text carries the analyses' own signature — the guard against a
// mid-render shell or a side-menu dump passing a bare length check.
const WEEKLY_SIG = /weekly newsletter|breaking down the week|market analyses|week ahead/i;
const INSTRUMENT_SIG = /intraday|outlook|key (resistance|support)|downside|upside/i;

let inCycle = false;

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function readBodyText(page) {
  try { return await page.evaluate(() => (document.body ? document.body.innerText : '')); } catch { return ''; }
}

// Best-effort: let the SPA finish its async loads (v0 read mid-hydration).
async function quiet(page) {
  try { await page.waitForLoadState('networkidle', { timeout: QUIET_MS }); } catch { /* best-effort */ }
}

// A platform alert dialog (e.g. "We're open right now!") intercepts ALL real pointer events while
// it is up; dismiss it before interacting. Fixed-position elements report offsetParent === null, so
// the visibility check uses getClientRects().
async function dismissBlockingDialog(page) {
  try {
    const dlg = await page.evaluate(() => {
      const vis = (e) => e.getClientRects().length > 0;
      const d = [...document.querySelectorAll('plus500-dialog')].find(vis);
      if (!d) return { present: false };
      const btn = [...d.querySelectorAll('button, [role="button"], a')].find((x) => vis(x) && /continue|ok|got it|close|understood/i.test(x.innerText || ''))
        || [...d.querySelectorAll('button, [role="button"], a')].find(vis);
      if (!btn) return { present: true, button: false, text: (d.innerText || '').replace(/\s+/g, ' ').slice(0, 120) };
      btn.setAttribute('data-analyses-dlg', '1');
      return { present: true, button: true };
    });
    if (dlg.present && dlg.button) {
      try { await page.locator('[data-analyses-dlg="1"]').click({ timeout: 5000 }); dlg.how = 'real'; }
      catch { await page.evaluate(() => { const b = document.querySelector('[data-analyses-dlg="1"]'); if (b) b.click(); }); dlg.how = 'synthetic'; }
      await settle(1200);
    }
    return dlg;
  } catch { return { present: false, error: 'dialog_check_failed' }; }
}

// Client-side navigation to the inter route (hard loads show the public shell — see the v1.3 note).
// A crafted anchor + REAL click hands the navigation to the running SPA's own click interception;
// then poll for the premiumhub iframe (it boots a few seconds after the route mounts).
async function openAnalysesRoute(page, steps) {
  await page.goto(TRADE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await quiet(page);
  await settle(URL_SETTLE_MS);
  steps.push({ step: 'trade-base', url: page.url(), len: (await readBodyText(page)).length });
  const dlg = await dismissBlockingDialog(page);
  if (dlg.present) steps.push({ step: 'dialog', ...dlg });
  await page.evaluate((href) => {
    let a = document.querySelector('#analyses-probe-anchor');
    if (a) a.remove();
    a = document.createElement('a');
    a.href = href; a.id = 'analyses-probe-anchor'; a.textContent = 'probe';
    a.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999;background:#fff;color:#000;padding:2px;font-size:10px';
    document.body.appendChild(a);
  }, ANALYSES_ROUTE);
  try { await page.locator('#analyses-probe-anchor').click({ timeout: 6000 }); steps.push({ step: 'route-click', how: 'real' }); }
  catch { await page.evaluate(() => { const a = document.querySelector('#analyses-probe-anchor'); if (a) a.click(); }); steps.push({ step: 'route-click', how: 'synthetic' }); }
  const t0 = Date.now();
  let frame = null;
  while (Date.now() - t0 < FRAME_WAIT_MS) {
    await settle(1500);
    frame = page.frames().find((f) => PREMIUMHUB_FRAME.test(f.url()));
    if (frame) break;
  }
  steps.push({ step: 'frame', found: !!frame, url: frame ? frame.url() : null });
  return frame;
}

async function readFrame(frame) {
  try { return await frame.evaluate(() => (document.body ? document.body.innerText : '')); } catch { return ''; }
}

async function clickInFrame(frame, text, { exact = true } = {}) {
  try {
    await frame.getByText(text, { exact }).first().click({ timeout: 8000 });
    return { clicked: true };
  } catch (e) { return { clicked: false, error: String(e.message || e).slice(0, 120) }; }
}

// One sweep: weekly view + each instrument tab, EVERY view stored as its own note (append-only);
// failures NAMED per view; the run is logged as one `analyses_capture` telemetry event.
async function captureOnce(userId, settings, { page: providedPage } = {}) {
  const pageLock = require('./pageLock');
  if (inCycle) return { skipped: 'overlap' };
  if (settings && settings.bridge && settings.bridge.parked) return { skipped: 'parked' };
  if (!pageLock.tryAcquire('analyses')) return { skipped: 'bridge_busy', heldBy: pageLock.status().holder };
  inCycle = true;
  let page = null;
  const notes = [];
  const failed = [];
  const steps = [];
  try {
    const browser = require('./browser');
    if (!(await browser.chromeAlive())) return { skipped: 'chrome_off' };
    page = providedPage || (await browser.newPage());
    const { withTimeout } = require('./capture');
    return await withTimeout((async () => {
      const storeView = async ({ view, symbol, text, note, urlAfter }) => {
        const p = parser.parseAnalysis(text, { view });
        const w = await store.insertAnalysesNote(userId, {
          kind: p.kind, symbol, title: p.title, url: urlAfter || ANALYSES_ROUTE, source: 'capture',
          rawText: text.slice(0, RAW_CAP), parseStatus: p.parseStatus,
          note: p.reason ? `capture: ${p.reason}` : note,
        });
        // ⚠ LEVELS ONLY ON A REAL INSERT. A suppressed note stored its levels against the ORIGINAL row; passing the
        // null id would write orphans, and re-inserting against the original would duplicate them.
        if (w.inserted && p.levels.length) await store.insertAnalysisLevels(userId, w.id, p.levels);
        const rec = {
          id: w.id, inserted: w.inserted, view, kind: p.kind,
          levels: w.inserted ? p.levels.length : 0, parseStatus: p.parseStatus,
        };
        notes.push(rec);
        // VISION LANE (owner-directed 2026-10-04) — best-effort, never blocks the text lane.
        try {
          const { runView } = require('../agent/analysesVision');
          rec.vision = await runView(userId, settings, { page, view, symbol });
        } catch (e) { rec.vision = { error: String(e.message || e).slice(0, 140) }; }
      };

      // STEP 1 — client-side route to the inter page; the analyses load in a cross-origin frame.
      const frame = await openAnalysesRoute(page, steps);
      let weeklyText = '';
      if (!frame) {
        failed.push({ view: 'weekly', reason: 'frame_missing' });
        failed.push({ view: 'instrument-loop', reason: 'frame_missing' });
      } else {
        // STEP 2 — weekly newsletter (the frame lands on /premiumhub/weekly).
        for (let i = 0; i < 6; i++) {
          weeklyText = await readFrame(frame);
          if (weeklyText.length >= MIN_TEXT && WEEKLY_SIG.test(weeklyText)) break;
          await settle(1500);
        }
        if (weeklyText && weeklyText.length >= MIN_TEXT && WEEKLY_SIG.test(weeklyText)) {
          await storeView({ view: 'weekly', symbol: null, text: weeklyText, note: 'capture (weekly view)', urlAfter: frame.url() });
        } else {
          failed.push({ view: 'weekly', reason: !weeklyText || weeklyText.length < MIN_TEXT ? 'frame_empty' : 'no_analysis_signature' });
        }

        // STEP 3 — Instrument Analyses tab (navigates the SAME frame to /premiumhub/daily/<slug>),
        // then each instrument tab IN-FRAME. Tab clicks touch only the frame's own router.
        const tab = await clickInFrame(frame, 'Instrument Analyses', { exact: false });
        steps.push({ step: 'click-instrument-tab', ...tab });
        if (tab.clicked) await settle(TAB_SETTLE_MS);

        const seen = new Set();
        if (weeklyText) seen.add(weeklyText.replace(/\s+/g, ' ').slice(0, 4000));
        for (const name of INSTRUMENTS) {
          const c = await clickInFrame(frame, name, { exact: true });
          if (!c.clicked) { failed.push({ view: name, reason: 'tab_not_found' }); continue; }
          await settle(TAB_SETTLE_MS);
          const t = await readFrame(frame);
          const digest = t.replace(/\s+/g, ' ').slice(0, 4000);
          if (!t || t.length < MIN_TEXT) { failed.push({ view: name, reason: 'frame_empty_after_tab' }); continue; }
          if (seen.has(digest)) { failed.push({ view: name, reason: 'tab_did_not_change_page' }); continue; }
          seen.add(digest);
          if (!INSTRUMENT_SIG.test(t)) { failed.push({ view: name, reason: 'no_analysis_signature' }); continue; }
          await storeView({ view: name, symbol: name, text: t, note: `capture (${name})`, urlAfter: frame.url() });
        }
      }

      const out = { notes: notes.length, failed: failed.length, details: notes, failedDetails: failed, steps };
      await store.logEvent(userId, 'telemetry', { source: 'analyses_capture', notes: notes.length, failed: failed.length, details: notes }).catch(() => {});
      return out;
    })(), ANALYSES_TIMEOUT_MS, 'analyses_capture');
  } catch (e) {
    const err = String(e.message || e).slice(0, 200);
    await store.logEvent(userId, 'telemetry', { source: 'analyses_capture', error: err, notes: notes.length, failed: failed.length }).catch(() => {});
    return { error: err, notes: notes.length, failed: failed.length, details: notes, failedDetails: failed, steps };
  } finally {
    try {
      if (page) await page.goto(PARK_URL, { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
    } catch { /* park is best-effort; the finally must never throw */ }
    pageLock.release('analyses');
    inCycle = false;
  }
}

// Scheduled entry: at most once per ~20 h (the analyses update daily-ish; one navigation set per day
// by design). The throttle reads the LEDGER (capturedAt), not process memory, so a restart cannot
// cause a double sweep inside the window.
async function runScheduled(userId, settings, { minHours = 20 } = {}) {
  try {
    const recent = await store.countRecentAnalyses(userId, minHours);
    if (recent > 0) return { skipped: 'throttled', recent };
    return await captureOnce(userId, settings, {});
  } catch (e) {
    return { skipped: 'error', error: String(e.message || e).slice(0, 160) };
  }
}

module.exports = { captureOnce, runScheduled, ANALYSES_ROUTE, TRADE_URL, BASE_URL, INSTRUMENTS };
