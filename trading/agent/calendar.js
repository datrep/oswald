// trading/agent/calendar.js — economic calendar import (TRD-2).
// Sources official pages that don't block scripts. Currently: the Federal
// Reserve's FOMC meeting calendar (federalreserve.gov).
//
// ★ EACH MEETING DAY BECOMES A `macro` ROW, NOT A `halt` (corrected 2026-09-15).
//
// The row used to be eventType='halt', symbol='*', and the comment above it said what that was MEANT to
// mean: "global halt for NEW entries; existing positions keep their stop logic". But `halt` already had a
// meaning — a VENUE CLOSURE — and it had exactly one enforcing consumer, `sessions.sessionState`, which
// read it as `state:'closed'` and skipped the entire wake. So the only thing the row actually did was the
// one thing it was never supposed to do, and nothing anywhere implemented "no new entries".
//
// The venue is genuinely OPEN on an FOMC day; New York trades normally. `macro` now says what the row
// means, and `sessions` turns it into `no_entry` — the wake runs, new entries are locked, exits are
// allowed. The intent and the enforcement finally point the same way.
'use strict';

const https = require('https');
const { getPool, sql } = require('../db');

const FOMC_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const MONTHS = '(January|February|March|April|May|June|July|August|September|October|November|December)';
const MONTH_NUM = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

function getHtml(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`calendar http ${res.statusCode} for ${url}`)); }
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      }
    );
    req.on('timeout', () => req.destroy(new Error('calendar timeout')));
    req.on('error', reject);
  });
}

const dayKey = (d) => d.toISOString().slice(0, 10);

// Parse "YYYY FOMC Meetings" sections: month + day-range pairs -> dates.
function parseFomcSections(html) {
  const meetings = [];
  const sectionRe = /(\d{4})\s+FOMC\s+Meetings([\s\S]*?)(?=\d{4}\s+FOMC\s+Meetings|Future Year|$)/g;
  let sec;
  while ((sec = sectionRe.exec(html)) !== null) {
    const year = Number(sec[1]);
    const text = sec[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const pairRe = new RegExp(`${MONTHS}\\s+(\\d{1,2})-(\\d{1,2})`, 'g');
    let m;
    while ((m = pairRe.exec(text)) !== null) {
      const month = MONTH_NUM[m[1].toLowerCase()];
      const start = Number(m[2]);
      const end = Number(m[3]);
      for (let d = start; d <= end; d++) {
        meetings.push({ year, month, day: d });
      }
    }
  }
  return meetings;
}

// FOMC meeting days from now through `days` days ahead (UTC).
async function fetchFomcEvents({ days = 14 } = {}) {
  const html = await getHtml(FOMC_URL);
  const meetings = parseFomcSections(html);
  if (!meetings.length) throw new Error('calendar: no FOMC meetings parsed');
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(from.getTime() + Math.max(1, days) * 86400000);
  const seen = new Set();
  const events = [];
  for (const mt of meetings) {
    const date = new Date(Date.UTC(mt.year, mt.month - 1, mt.day));
    if (date < from || date > to) continue;
    const key = dayKey(date);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ eventDate: key, note: 'FOMC meeting day (federalreserve.gov)' });
  }
  return { from, to, events };
}

// ★ THE EVENT TYPE IS THE WHOLE 2026-09-15 OUTAGE, and it is one string literal inside a bulk-insert
// loop where no test can reach it. So the row building is extracted PURE and the type is a named
// constant: 'halt' means the venue is SHUT, 'macro' means the venue is OPEN and new entries are locked.
const EVENT_TYPE = 'macro';

function fomcRows(userId, events = []) {
  return (events || []).map((ev) => [userId, '*', 'plus500', EVENT_TYPE, ev.eventDate, ev.note, 'federalreserve']);
}

async function importCalendar(userId, { days = 14 } = {}) {
  const { from, to, events } = await fetchFomcEvents({ days });
  const pool = await getPool();

  // Idempotent: clear previous federalreserve rows in this window, then re-insert.
  //
  // ★ ANY eventType, not just the one being written. Restricting the delete to the current type left the
  // OLD rows behind on a re-import: the 2026-09-15 `halt` rows would have survived this change forever,
  // still closing the venue, while the new `macro` rows sat beside them looking correct.
  await pool.request()
    .input('userId', sql.Int, userId)
    .input('from', sql.Date, from)
    .input('to', sql.Date, to)
    .query("DELETE FROM CorporateEvents WHERE userId = @userId AND source = 'federalreserve' AND eventDate BETWEEN @from AND @to");

  if (events.length) {
    const table = new sql.Table('CorporateEvents');
    table.create = false;
    table.columns.add('userId', sql.Int, { nullable: false });
    table.columns.add('symbol', sql.NVarChar(64), { nullable: false });
    table.columns.add('venue', sql.NVarChar(32), { nullable: false });
    table.columns.add('eventType', sql.NVarChar(32), { nullable: false });
    table.columns.add('eventDate', sql.Date, { nullable: false });
    table.columns.add('note', sql.NVarChar(255), { nullable: true });
    table.columns.add('source', sql.NVarChar(32), { nullable: false });
    for (const row of fomcRows(userId, events)) table.rows.add(...row);
    await pool.request().bulk(table);
  }

  return { imported: events.length, window: { from: dayKey(from), to: dayKey(to) }, events };
}

// ★ A SCHEDULED SYNC (2026-10-25). BEFORE THIS, `importCalendar` HAD NO SCHEDULED CALLER AT ALL — it was
// reachable only from a manual UI button and a route, so in practice nobody ran it. Measured on 2026-10-25:
// `CorporateEvents` held **2 rows, both 2026-09-15/16**, i.e. the import had not run in the five and a half
// weeks since. The mechanism below was correct the whole time and simply unplugged.
//
// ⚠ WHAT THIS DOES *NOT* RESTORE IS A VETO, and the distinction has to be stated because it is easy to get
// backwards. `sessions.js` was deliberately revised on 2026-09-15: a `macro` row is CONTEXT handed to the
// deliberating chairs as `scheduledEvents`, NOT an entry lock. So the five-week gap did not leave the desk
// trading "unguarded" through FOMC days — there was nothing to guard — what it left was the chairs being
// told nothing at all about an approaching meeting. That is the defect this fixes.
//
// THE CLOCK IS AN EVENT, following `newsAggregator`'s convention rather than inventing a second one: one
// `calendar_sync` row IS the throttle. That makes the schedule survive restarts and downtime without a timer
// in memory, and it means the record of what ran is the same record used to decide whether to run.
const SYNC_KIND = 'calendar_sync';
const SYNC_DEFAULTS = { enabled: true, intervalHours: 12, daysAhead: 21 };

async function lastSyncAt(userId) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`SELECT TOP 1 createdAt FROM TradingEvents
             WHERE userId = @userId AND kind = '${SYNC_KIND}'
             ORDER BY id DESC`);
  return r.recordset[0] ? r.recordset[0].createdAt : null;
}

// Returns { skipped } / { ok: true, imported, window } / { ok: false, error }. Never throws: this is called
// from a timer, and a rejection there is an unhandled rejection that can take the process down.
async function syncScheduled(userId, settings = null) {
  const c = (settings && settings.calendar) || {};
  if (c.enabled === false) return { skipped: 'disabled' };

  const intervalHours = Number(c.intervalHours) > 0 ? Number(c.intervalHours) : SYNC_DEFAULTS.intervalHours;
  const daysAhead = Number(c.daysAhead) > 0 ? Number(c.daysAhead) : SYNC_DEFAULTS.daysAhead;

  const last = await lastSyncAt(userId).catch(() => null);
  if (last && Date.now() - last.getTime() < intervalHours * 3600000) {
    return { skipped: 'throttled', lastSyncAt: last.toISOString(), intervalHours };
  }

  let result = null;
  let error = null;
  try {
    result = await importCalendar(userId, { days: daysAhead });
  } catch (e) {
    error = (e && e.message) || String(e);
  }

  // ⚠ THE ATTEMPT IS RECORDED EITHER WAY. This import can fail for reasons that leave the table looking
  // perfectly healthy — a 403 from federalreserve.gov, a re-worded calendar page that parses to zero
  // meetings, a DNS failure. A sync that writes nothing on failure is the silent-dead-feed class this repo
  // has already paid for twice, so the event carries `ok` and the error text.
  const payload = {
    ok: !error,
    error,
    imported: result ? result.imported : null,
    window: result ? result.window : null,
    daysAhead,
    intervalHours,
  };
  await require('../store').logEvent(userId, SYNC_KIND, payload).catch(() => {});
  return error ? { ok: false, error } : { ok: true, imported: result.imported, window: result.window };
}

// Upcoming scheduled events for the dashboard/UI.
async function upcomingHaltEvents(userId, { days = 14 } = {}) {
  const pool = await getPool();
  const from = new Date(); from.setUTCHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + Math.max(1, days) * 86400000);
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('from', sql.Date, from)
    .input('to', sql.Date, to)
    .query(`SELECT id, symbol, venue, eventType, eventDate, note, source
            FROM CorporateEvents
            WHERE userId = @userId AND eventDate BETWEEN @from AND @to
            ORDER BY eventDate, note`);
  return r.recordset;
}

module.exports = { fetchFomcEvents, importCalendar, upcomingHaltEvents, fomcRows, syncScheduled, lastSyncAt, EVENT_TYPE, SYNC_KIND };
