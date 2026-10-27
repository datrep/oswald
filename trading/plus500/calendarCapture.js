// trading/plus500/calendarCapture.js — 2026-10-26. Economic calendar sweep into CalendarEvents. NO CONSUMER.
//
// SOURCE: the authenticated Plus500 WebTrader, route `/action/inter/economiccalendar?product=CFD`. The page is a
// ~300-char shell and the calendar is ONE CROSS-ORIGIN IFRAME DEEP at
// `www.plus500.com/<lang>/economiccalendar?isInAppView=True` — the same lesson the premium-analyses capture learned
// (TRD-PRM-1: public hard loads of `/action/inter/*` render a language select). There is NO XHR to intercept: the
// rows are server-rendered into that frame, verified 2026-10-26 by recording every JSON response during a load and
// finding nothing calendar-shaped.
//
// THE STRUCTURE, READ OFF THE LIVE PAGE (2026-10-26), not inferred:
//
//   section.financial-events
//     div.event-header  > span                 "Today" / "Tomorrow" / an absolute date   <- the day group
//     div.event-row
//       div.event-time > div.event-time-location > span.event-time-solo    "08:00"
//       div.event-impact.impact-low|medium|high   (aria-label also carries Low/Medium/High)
//         span.circle-impact  x3                 <- ⚠ ALWAYS THREE, see below
//       div.event-details
//         div.event-title (> span.description)   the event name
//         div.event-extras
//           div.event-predictions                "actual forecast previous"
//           div.event-related-instruments        "UK 100"
//
// ⚠ THE DOTS DO NOT COUNT THE GRADE, AND COUNTING THEM WOULD HAVE CALLED EVERYTHING HIGH. An `impact-low` row
// carries THREE `span.circle-impact` elements; the count is the track, not the rating. The grade lives in the
// class and in `aria-label` — both are read, and the row is flagged when they disagree, because a label that
// disagrees with itself is the one case where neither can be trusted.
//
// ⚠ AND THE TIME IS BROWSER-LOCAL WITH NO MARKER. 08:00 on the page is 00:00Z on this desk (UTC+8). The offset is
// captured with every row so `eventAt` stays reproducible, and `resolveEventAt` is PURE so the arithmetic is
// testable without a browser.
'use strict';

const crypto = require('crypto');
const { getPool, sql } = require('../db');

const CAL_ROUTE = 'https://app.plus500.com/action/inter/economiccalendar?product=CFD';
const FRAME_RE = /www\.plus500\.com\/.+\/economiccalendar/i;
const PARK_URL = 'https://app.plus500.com/open-positions';
const SOURCE = 'plus500_dowjones';
const SETTLE_MS = 20000;
const FRAME_WAIT_MS = 30000;

const IMPACT_BY_CLASS = { 'impact-low': 1, 'impact-medium': 2, 'impact-high': 3 };
const IMPACT_BY_ARIA = { low: 1, medium: 2, high: 3 };

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// PURE: relative day label + local time -> UTC instant.
//
// `tzOffsetMin` is `Date.prototype.getTimezoneOffset()` from the browser: minutes to ADD to local to reach UTC.
// On this desk it is -480 (UTC+8), so 08:00 local => 08:00 - 8h = 00:00Z.
//
// Returns { eventAt: Date|null, parseStatus, resolvedDay, note }. NEVER guesses: a day label it cannot read gives
// a null instant and a named status, the same rule `NewsItems.publishedAt` follows. A fabricated date is worse
// than a missing one because it silently joins a study.
// ---------------------------------------------------------------------------------------------
function resolveEventAt({ dayLabel, timeLabel, tzOffsetMin, now = new Date() } = {}) {
  const tz = Number(tzOffsetMin);
  if (!Number.isFinite(tz)) return { eventAt: null, parseStatus: 'no_tz', resolvedDay: null, note: 'timezone offset missing' };
  const tm = /^(\d{1,2}):(\d{2})$/.exec(String(timeLabel || '').trim());
  if (!tm) return { eventAt: null, parseStatus: 'no_time', resolvedDay: null, note: `unreadable time "${timeLabel}"` };
  const hh = Number(tm[1]); const mm = Number(tm[2]);
  if (hh > 23 || mm > 59) return { eventAt: null, parseStatus: 'no_time', resolvedDay: null, note: `out of range "${timeLabel}"` };

  // the browser's own calendar day, derived rather than assumed
  const localNow = new Date(now.getTime() - tz * 60000);
  const ly = localNow.getUTCFullYear(); const lm = localNow.getUTCMonth(); const ld = localNow.getUTCDate();

  const label = String(dayLabel || '').replace(/\s+/g, ' ').trim();
  let y; let m; let d; let resolvedDay = null;
  if (/^today$/i.test(label) || label === '') { y = ly; m = lm; d = ld; resolvedDay = 'today'; }
  else if (/^tomorrow$/i.test(label)) { const t = new Date(Date.UTC(ly, lm, ld + 1)); y = t.getUTCFullYear(); m = t.getUTCMonth(); d = t.getUTCDate(); resolvedDay = 'tomorrow'; }
  else if (/^yesterday$/i.test(label)) { const t = new Date(Date.UTC(ly, lm, ld - 1)); y = t.getUTCFullYear(); m = t.getUTCMonth(); d = t.getUTCDate(); resolvedDay = 'yesterday'; }
  else {
    // ⚠ THE ABSOLUTE FORM THE PAGE ACTUALLY USES FOR FUTURE DAYS IS `DD/MM/YYYY` — measured 2026-10-26: the rows
    // beyond tomorrow are headed `28/10/2026`, and the first capture stored 212 rows as unreadable because this
    // parser only knew "30 October 2026". Daily-separator dates are parsed DD/MM (the frame is en-sg), which is
    // unambiguous here because the page never emits a first component above 31 in the MM slot.
    const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(label);
    if (dmy) {
      d = Number(dmy[1]); m = Number(dmy[2]) - 1; y = Number(dmy[3]);
      if (m < 0 || m > 11 || d < 1 || d > 31) {
        return { eventAt: null, parseStatus: 'no_event_at', resolvedDay: null, note: `out-of-range date "${label}"` };
      }
      resolvedDay = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    } else {
      // absolute forms with a month name: "30 October 2026", "Mon, 30 October", "30 Oct 2026"
      const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const am = /(\d{1,2})\s+([A-Za-z]{3,})\.?\s*(\d{4})?/.exec(label);
      if (!am) return { eventAt: null, parseStatus: 'no_event_at', resolvedDay: null, note: `unreadable day label "${label}"` };
      const mon = MON[am[2].slice(0, 3).toLowerCase()];
      if (mon == null) return { eventAt: null, parseStatus: 'no_event_at', resolvedDay: null, note: `unknown month in "${label}"` };
      d = Number(am[1]); m = mon; y = am[3] ? Number(am[3]) : ly;
      resolvedDay = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  // local wall-clock built as if UTC, then shifted by the offset
  const eventAt = new Date(Date.UTC(y, m, d, hh, mm) + tz * 60000);
  return { eventAt, parseStatus: 'ok', resolvedDay, note: null };
}

// PURE: one raw row -> the values the ledger stores. Kept separate from the browser so it can be tested.
function normalizeRow(raw, { tzOffsetMin, now = new Date(), tab = 'data_releases' } = {}) {
  const t = resolveEventAt({ dayLabel: raw.dayLabel, timeLabel: raw.timeLabel, tzOffsetMin, now });
  const byClass = IMPACT_BY_CLASS[String(raw.impactClass || '').trim()] ?? null;
  const byAria = IMPACT_BY_ARIA[String(raw.impactAria || '').trim().toLowerCase()] ?? null;
  // ⚠ A DISAGREEMENT IS RECORDED, NOT RESOLVED. The class is what the stylesheet shows the operator; the aria-label
  // is what a screen reader says. If they differ, one of them is wrong and there is no basis to prefer either.
  const impact = byClass ?? byAria;
  const impactRaw = [
    raw.impactClass ? `class=${raw.impactClass}` : null,
    raw.impactAria ? `aria=${raw.impactAria}` : null,
    raw.impactDots != null ? `dots=${raw.impactDots}` : null,
    byClass != null && byAria != null && byClass !== byAria ? 'MISMATCH' : null,
  ].filter(Boolean).join(' ');

  const preds = Array.isArray(raw.predictions) ? raw.predictions : String(raw.predictions || '').trim().split(/\s+/);
  const val = (i) => {
    const v = preds[i] == null ? null : String(preds[i]).trim();
    return !v || v === '-' || v === '\u2014' ? null : v.slice(0, 40);
  };
  return {
    eventAt: t.eventAt,
    dayLabel: raw.dayLabel ? String(raw.dayLabel).slice(0, 40) : null,
    timeLabel: raw.timeLabel ? String(raw.timeLabel).slice(0, 12) : null,
    tzOffsetMin: Number.isFinite(Number(tzOffsetMin)) ? Number(tzOffsetMin) : null,
    impact: impact == null ? null : Number(impact),
    impactRaw: impactRaw || null,
    event: String(raw.event || '').trim().slice(0, 200),
    actual: val(0), forecast: val(1), previous: val(2),
    relatedInstruments: raw.related ? String(raw.related).replace(/\s+/g, ' ').trim().slice(0, 400) : null,
    tab,
    source: SOURCE,
    rawText: raw.rowText ? String(raw.rowText).replace(/\s+/g, ' ').trim().slice(0, 800) : null,
    // ⚠ THE HASH USES THE RESOLVED INSTANT WHEN THERE IS ONE, so the SAME event does not duplicate when the page
    // moves it from "Today" to "Yesterday" overnight. Only an unresolvable row falls back to its relative label.
    parseStatus: t.parseStatus,
    rowHash: crypto.createHash('sha256').update([
      t.eventAt ? t.eventAt.toISOString() : `label:${raw.dayLabel}`,
      String(raw.timeLabel || ''), String(raw.event || '').trim(), tab,
    ].join('|')).digest('hex'),
    note: t.note,
  };
}

// ---------------------------------------------------------------------------------------------
// BROWSER: read the frame. Runs one evaluate; all the shape knowledge lives in this one function so a layout
// change has exactly one place to fail.
// ---------------------------------------------------------------------------------------------
async function readRows(frame) {
  return frame.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const out = [];
    for (const tabPane of document.querySelectorAll('section.financial-events, .financial-events')) {
      let currentDay = null;
      const kids = [...tabPane.children];
      for (const el of kids) {
        const cls = String(el.className || '');
        if (/\bevent-header\b/.test(cls)) { currentDay = norm(el.innerText) || currentDay; continue; }
        if (!/\bevent-row\b/.test(cls)) continue;
        const timeEl = el.querySelector('.event-time-solo');
        const impactEl = el.querySelector('.event-impact');
        const titleEl = el.querySelector('.event-title span.description') || el.querySelector('.event-title');
        const predsEl = el.querySelector('.event-predictions');
        const relEl = el.querySelector('.event-related-instruments');
        const impactCls = impactEl
          ? (String(impactEl.className).match(/impact-(low|medium|high)/) || [])[0] || null
          : null;
        out.push({
          dayLabel: currentDay,
          timeLabel: timeEl ? norm(timeEl.innerText) : null,
          impactClass: impactCls,
          impactAria: impactEl ? impactEl.getAttribute('aria-label') : null,
          impactDots: impactEl ? impactEl.querySelectorAll('.circle-impact').length : null,
          event: titleEl ? norm(titleEl.innerText) : null,
          predictions: predsEl ? norm(predsEl.innerText) : '',
          related: relEl ? norm(relEl.innerText) : null,
          rowText: norm(el.innerText),
        });
      }
    }
    return out;
  });
}

async function insertRows(userId, rows) {
  if (!rows.length) return { inserted: 0, duplicates: 0 };
  const pool = await getPool();
  let inserted = 0; let duplicates = 0;
  for (const r of rows) {
    if (!r.event) { duplicates += 1; continue; }
    const res = await pool.request()
      .input('userId', sql.Int, userId)
      .input('eventAt', sql.DateTime2, r.eventAt)
      .input('dayLabel', sql.NVarChar(40), r.dayLabel)
      .input('timeLabel', sql.NVarChar(12), r.timeLabel)
      .input('tzOffsetMin', sql.Int, r.tzOffsetMin)
      .input('impact', sql.TinyInt, r.impact)
      .input('impactRaw', sql.NVarChar(60), r.impactRaw)
      .input('event', sql.NVarChar(200), r.event)
      .input('actual', sql.NVarChar(40), r.actual)
      .input('forecast', sql.NVarChar(40), r.forecast)
      .input('previous', sql.NVarChar(40), r.previous)
      .input('relatedInstruments', sql.NVarChar(400), r.relatedInstruments)
      .input('tab', sql.NVarChar(24), r.tab)
      .input('source', sql.NVarChar(32), r.source)
      .input('rawText', sql.NVarChar(800), r.rawText)
      .input('parseStatus', sql.NVarChar(32), r.parseStatus)
      .input('rowHash', sql.Char(64), r.rowHash)
      .query(`INSERT INTO CalendarEvents
                (userId, eventAt, dayLabel, timeLabel, tzOffsetMin, impact, impactRaw, event, actual, forecast,
                 previous, relatedInstruments, tab, source, rawText, parseStatus, rowHash)
              SELECT @userId, @eventAt, @dayLabel, @timeLabel, @tzOffsetMin, @impact, @impactRaw, @event, @actual,
                     @forecast, @previous, @relatedInstruments, @tab, @source, @rawText, @parseStatus, @rowHash
               WHERE NOT EXISTS (SELECT 1 FROM CalendarEvents WHERE userId = @userId AND rowHash = @rowHash)`);
    if (res.rowsAffected && res.rowsAffected[0] > 0) inserted += 1; else duplicates += 1;
  }
  return { inserted, duplicates };
}

// ---------------------------------------------------------------------------------------------
// NAVIGATION: the menu path, NOT the URL.
//
// ⚠ `page.goto('/action/inter/economiccalendar?product=CFD')` RETURNS 200 AND THEN BOUNCES. The URL becomes the
// calendar route for a frame or two, the SPA's router sends it straight back to /open-positions, and no calendar
// frame is ever attached — measured twice, then reproduced every attempt. The route is CLIENT-SIDE ONLY, the same
// class the premium-analyses capture documented for `/action/inter/*`.
//
// The working path is the one an operator uses (owner, 2026-10-26: "open tab, tools, economic calender"): open the
// account flyout, expand Tools, click Economic Calendar. Two details that each cost a wrong turn:
//   · the flyout is TOGGLED OPEN by clicking `MoreMenu.Item.tools.Button.Toggle`, and clicking the wrapper `li`
//     CLOSES the whole flyout instead;
//   · the sub-items are rendered LAZILY — `MoreMenu.Item.tools.Expandable` is empty until the toggle is clicked,
//     so a lookup without the expand step always finds nothing;
//   · and `MoreMenu.SubItem.economiccalendar` is a CONTAINER whose own innerText is empty. Clicking it is a no-op
//     that looks like a broken menu item. The handler is on `.Button.Open`.
//
// Every click is dispatched in-page: a transparent `div.new-search-overlay` in the header intercepts Playwright's
// coordinate clicks on that flyout ("element is visible, enabled and stable ... intercepts pointer events"), so
// `elementHandle.click()` retries until it times out.
async function navigateToCalendar(page) {
  const hasFrame = () => page.frames().some((f) => FRAME_RE.test(f.url()));
  // ⚠ `frame: true` ON THIS PATH TOO. The first version returned `{ navigated: false, reason: 'already_open' }`
  // with no `frame` key, and the caller — which decides on `nav.frame` — read that as a failure and aborted a run
  // whose frame was already present. A result shape that has to be re-read per branch is how that happens.
  if (hasFrame()) return { navigated: false, frame: true, reason: 'already_open' };

  const clickSel = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }, sel);

  // ⚠ START FROM A KNOWN STATE. The flyout's open/closed state survives between runs, and the menu path only works
  // from the state an operator is in when they start: a freshly loaded page, parked, with the account flyout
  // already expanded. Two attempts failed because the flyout had been left closed by an earlier probe while the
  // Tools toggle element still existed — so the click found its target and the sub-items were never rendered.
  // A full load costs a few seconds and removes the branch entirely.
  await page.goto(PARK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch { /* best-effort */ }
  await settle(2500);
  const flyoutOpen = await page.evaluate(() => /Account\s+Tools\s+Help/.test(String(document.body ? document.body.innerText : '').replace(/\s+/g, ' ')))
    .catch(() => false);
  if (!flyoutOpen) {
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="MoreMenu"] button, [data-testid="MoreMenu"] [role="button"], [aria-label*="menu" i]');
      if (el) el.click();
    }).catch(() => {});
    await settle(2000);
  }

  const toggled = await clickSel('[data-testid="MoreMenu.Item.tools.Button.Toggle"]');
  if (!toggled) return { navigated: false, reason: 'tools_toggle_missing' };

  // the sub-items are lazily rendered: poll for the calendar button rather than assuming it exists
  let opened = false;
  for (let i = 0; i < 8 && !opened; i++) {
    await settle(700);
    opened = await clickSel('[data-testid="MoreMenu.SubItem.economiccalendar.Button.Open"]');
  }
  if (!opened) return { navigated: false, reason: 'calendar_item_missing' };

  for (let waited = 0; waited < FRAME_WAIT_MS && !hasFrame(); waited += 2000) await settle(2000);
  return { navigated: true, frame: hasFrame(), url: page.url() };
}

// The scheduled sweep. Never throws: it is called from a timer.
async function runOnce(userId, settings = null) {
  const pageLock = require('./pageLock');
  const store = require('../store');
  const conf = (settings && settings.calendarCapture) || {};
  if (conf.enabled === false) return { skipped: 'disabled' };
  if (!pageLock.tryAcquire('calendar')) return { skipped: 'bridge_busy', heldBy: pageLock.status().holder };

  let page = null;
  const summary = { ok: false, rows: 0, inserted: 0, duplicates: 0, unreadable: 0, reason: null, tzOffsetMin: null };
  try {
    const b = require('./browser');
    // ★★ ONE PLUS500 TAB, EVER (owner, 2026-10-26: "do not use more than one tab for the plus500 website, it will
    // constantly log switch both of the tabs. use only one, it is a limitation").
    //
    // ⚠ THIS REPLACES A SECOND TAB AND IS THE WHOLE REASON THE FIRST VERSIONS OF THIS CAPTURE FAILED. Opening a
    // sibling tab looked safer — it cannot disturb the parked tab a ticket is on — but the venue treats a second
    // tab as a session conflict and signs one of them out. Measured consequences that were previously blamed on
    // other things: `frame_not_found` twice in a row, then `frame.evaluate: Target page, context or browser has
    // been closed`, and before that a genuine sign-out at 20:39Z with a 4h45m entry block. A capture must therefore
    // share the desk's tab and hold the page lock while it does, exactly as `analysesCapture` does.
    page = await b.newPage();
    page.setDefaultTimeout(30000);
    const nav = await navigateToCalendar(page);
    summary.nav = nav;
    if (!nav.frame) { summary.reason = nav.reason || 'frame_not_found'; return summary; }

    const frame = page.frames().find((f) => FRAME_RE.test(f.url()));
    try { await frame.waitForLoadState('networkidle', { timeout: SETTLE_MS }); } catch { /* best-effort */ }
    await settle(2000);

    const tzOffsetMin = await frame.evaluate(() => new Date().getTimezoneOffset());
    summary.tzOffsetMin = tzOffsetMin;
    const raw = await readRows(frame);
    summary.rows = raw.length;
    const now = new Date();
    const rows = raw.map((r) => normalizeRow(r, { tzOffsetMin, now, tab: 'data_releases' }));
    summary.unreadable = rows.filter((r) => r.parseStatus !== 'ok').length;
    const ins = await insertRows(userId, rows);
    summary.inserted = ins.inserted;
    summary.duplicates = ins.duplicates;
    summary.ok = true;
    return summary;
  } catch (e) {
    summary.reason = (e && e.message ? e.message : String(e)).slice(0, 200);
    return summary;
  } finally {
    if (page) {
      // ⚠ PARK IT, NEVER CLOSE IT. `page` IS the desk's only Plus500 tab now, so closing it would leave the desk
      // with no venue page at all — the exact state that produced a 33-minute blind spell earlier today when the
      // tab was closed by hand. And park only if it is not already parked: navigating to the URL it is already on
      // reloads the SPA for no gain, and that reload is a window in which a waiting ticket flow sees a half-rendered
      // page. `pageLock` makes a ticket WAIT rather than fail, but a needless reload still costs it seconds.
      try {
        if (!/\/open-positions/.test(page.url())) {
          await page.goto(PARK_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
        }
      } catch { /* best-effort */ }
    }
    pageLock.release('calendar');
    await store.logEvent(userId, 'calendar_capture', summary).catch(() => {});
  }
}

module.exports = { runOnce, navigateToCalendar, readRows, normalizeRow, resolveEventAt, insertRows, CAL_ROUTE, SOURCE };
