'use strict';
// scripts/era-trend.js — 2026-10-18 (owner: "past data almost doesn't matter... this is what I mean to
// collect more data off, the continuation of the trend upon improvements").
//
// A READ-ONLY forward tracker for the CURRENT code. It segments closed trades by BEHAVIOURAL boundary
// (each registered change gets its own segment; provenance-only changes are marked and do not split the
// sample) and reports the current segment's trend as it accumulates.
//
// WHY THIS EXISTS: every conclusion drawn from 09-10..10-09 data was drawn about code that no longer runs.
// The only honest sample about today's desk is the segment after the LAST behavioural change — which on
// 2026-10-18 is the post-reopen session. This script makes that segment accumulate visibly instead of
// requiring a manual cut each time.
//
// USAGE
//   node scripts/era-trend.js                 # print + write logs/era-trend.json
//   node scripts/era-trend.js --telegram      # also send the digest (daily task uses this)
//   node scripts/era-trend.js --since ISO     # override the segment start (ad-hoc)
//
// BOUNDARIES: edit BOUNDARIES when a feature changes BEHAVIOUR (prices, exits, sizing, when the desk may
// act). Provenance-only changes (e.g. sessionClass stamping) must NOT split the sample — set behavior:false.
const path = require('path');
const fs = require('fs');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require(path.join(__dirname, '..', 'trading', 'db'));

const BOUNDARIES = [
  { at: '2026-10-08T00:45:50.735Z', id: 't2-freeze-lift', label: 'T2: prune, chairs off, EXI floor 0.2', behavior: true, major: true },
  { at: '2026-10-09T06:00:00Z', id: 'outage', label: 'desk off (7-day outage)', behavior: true, major: true },
  { at: '2026-10-16T12:12:00Z', id: 'reopen', label: 'reopen: kill off, live entries', behavior: true, major: true },
  // MINOR behavioural changes ANNOTATE the running era instead of restarting the sample: they widen when the
  // desk may act without touching prices, exits, sizing or the instrument set. `--strict` restarts anyway.
  { at: '2026-10-18T11:34:00Z', id: 'crypto-24-7-sessions', label: 'crypto 24/7 sessions (weekend wakes allowed)', behavior: true, major: false },
  { at: '2026-10-18T11:50:00Z', id: 'weekend-session-class', label: 'sessionClass stamping (provenance only)', behavior: false, major: false },
  // The engage-verification fix changes a path that is DISABLED at deploy (`engageOnTouch.enabled:false`), so it
  // does not alter any live decision — annotated, never a boundary. It becomes one only when the trail is armed.
  { at: '2026-10-18T15:45:00Z', id: 'trail-engage-verify', label: 'trail engage verification anchored to entry (INERT)', behavior: false, major: false },
  // Instrument-set change, same class as the T2 prune: Soybeans entries paused (scope []), journal #269255 at
  // 16:14:23Z. Prices, exits and sizing are untouched, but the tradable SET changed, so pooled rows after this
  // point are not comparable with rows before it for per-symbol questions -> a MAJOR boundary, fresh sample.
  { at: '2026-10-18T16:14:23Z', id: 'soybeans-pause', label: 'Soybeans entries paused (instrument set change)', behavior: true, major: true },
  // ★ THE STOP-WIDTH ERA (2026-10-18T19:18:10Z, settings journal #271364): atrStopMultiple 2 -> 4 and the
  // adverse cap 1.5% -> 2.5% so the cap stops overriding the dial. Every stop is ~2x wider in price terms, so
  // no per-trade expectancy question can pool rows across this line - MAJOR. Pre-registration, gates and kill
  // rule: trading/docs/stop-width-prereg-2026-10-19.md.
  { at: '2026-10-18T19:18:10Z', id: 'stop-width-4x', label: 'stop width 2x -> 4x ATR (cost-in-R halves)', behavior: true, major: true },
  // ★ THE TRAIL ERA (2026-10-19T22:02:12Z, settings journal #288318): engageOnTouch armed — a position that
  // touches +0.75R gets a venue lock there plus a 0.15R trail. Exit decisions move from the desk signal to the
  // venue for those positions, so rows either side are not poolable for exit or give-back questions. Pre-reg and
  // frozen baselines: trading/docs/trail-decision-2026-10-19.md.
  { at: '2026-10-19T22:02:12Z', id: 'trail-armed', label: 'trail armed (lock 0.75R, trail 0.15R)', behavior: true, major: true },
];

const ARTIFACT = path.join(__dirname, '..', 'logs', 'era-trend.json');
const MILESTONES = [10, 25, 50, 100, 150, 230];

const r4 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10000) / 10000);
const r2 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 100) / 100);

function stats(rows) {
  const n = rows.length;
  if (!n) return { n: 0 };
  const Rs = rows.map((t) => t.R).filter((x) => x != null);
  const net = rows.reduce((s, t) => s + t.net, 0);
  const wins = rows.filter((t) => t.net > 0);
  const losses = rows.filter((t) => t.net < 0);
  const gw = wins.reduce((s, t) => s + t.net, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.net, 0));
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  // 90% bootstrap CI on mean R — the number that decides whether anything is established.
  let ci = null;
  if (Rs.length >= 8) {
    const boots = [];
    for (let i = 0; i < 6000; i += 1) {
      let s = 0;
      for (let j = 0; j < Rs.length; j += 1) s += Rs[Math.floor(Math.random() * Rs.length)];
      boots.push(s / Rs.length);
    }
    boots.sort((a, b) => a - b);
    ci = [r4(boots[Math.floor(0.05 * boots.length)]), r4(boots[Math.floor(0.95 * boots.length)])];
  }
  return {
    n,
    netSgd: r2(net),
    meanR: r4(mean(Rs)),
    meanRci90: ci,
    winRate: r2(wins.length / n),
    payoff: wins.length && losses.length ? r2((gw / wins.length) / (gl / losses.length)) : null,
    pf: gl > 0 ? r2(gw / gl) : null,
    avgHoldMin: r2(mean(rows.map((t) => t.holdMin).filter((x) => x != null))),
  };
}

function telegram(text) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chat) return;
    const body = JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true });
    const req = https.request({ host: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10000 }, (res) => res.resume());
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  } catch { /* best-effort */ }
}

(async () => {
  const args = process.argv.slice(2);
  const sinceArg = args.includes('--since') ? new Date(args[args.indexOf('--since') + 1]) : null;
  const pool = await getPool();
  const q = await pool.request().query(`
    SELECT id, symbol, direction, strategyId, origin, openPrice, closePrice, stopPrice, grossPnl, fees, fundingCost,
           note, closeSource, openAt, closeAt, holdingMinutes, status
    FROM Trades WHERE userId = 1 AND status = 'closed' AND openAt >= '2026-10-05T00:00:00' ORDER BY openAt ASC`);
  const rows = q.recordset.map((t) => {
    const dir = String(t.direction || '').toLowerCase();
    const px = t.closePrice != null && t.openPrice != null
      ? (dir === 'buy' ? Number(t.closePrice) - Number(t.openPrice) : Number(t.openPrice) - Number(t.closePrice)) : null;
    const D = (t.stopPrice != null && t.openPrice != null) ? Math.abs(Number(t.openPrice) - Number(t.stopPrice)) : null;
    return {
      id: t.id, symbol: t.symbol, origin: t.origin || '(none)', openAt: new Date(t.openAt),
      R: px != null && D ? px / D : null,
      net: (Number(t.grossPnl) || 0) + (Number(t.fundingCost) || 0) - (Number(t.fees) || 0),
      holdMin: t.holdingMinutes, note: String(t.note || ''),
    };
  }).filter((t) => t.origin !== 'venue'); // options the OWNER placed are equity, never strategy

  const behavior = BOUNDARIES.filter((b) => b.behavior).map((b) => ({ ...b, t: new Date(b.at) })).sort((a, b) => a.t - b.t);
  // The headline era is the last MAJOR boundary (a change to prices, exits, sizing or the instrument set).
  // Minor changes are annotated on the curve, not used to reset the sample — otherwise a widening of the
  // weekend window would throw away the only forward data the desk has.
  const majors = behavior.filter((b) => b.major);
  const strict = args.includes('--strict');
  const current = strict ? behavior[behavior.length - 1] : majors[majors.length - 1];
  const since = sinceArg || current.t;
  const annotations = behavior.filter((b) => b.t > since).map((b) => ({ id: b.id, label: b.label, at: b.t.toISOString() }));

  const segments = [];
  for (let i = 0; i < behavior.length; i += 1) {
    const a = behavior[i].t;
    const b = i + 1 < behavior.length ? behavior[i + 1].t : new Date('2100-01-01T00:00:00Z');
    const rs = rows.filter((t) => t.openAt >= a && t.openAt < b);
    segments.push({ id: behavior[i].id, label: behavior[i].label, from: a.toISOString(), n: rs.length, stats: stats(rs) });
  }

  const era = rows.filter((t) => t.openAt >= since);
  const eraStats = stats(era);
  const bySymbol = {};
  for (const sym of [...new Set(era.map((t) => t.symbol))].sort()) bySymbol[sym] = stats(era.filter((t) => t.symbol === sym));

  // cumulative net curve and rolling 20-trade mean R — the "continuation of the trend" view
  let cum = 0;
  const curve = era.map((t) => { cum += t.net; return { id: t.id, cum: r2(cum) }; });
  const rolling = [];
  for (let i = 0; i < era.length; i += 1) {
    const w = era.slice(Math.max(0, i - 19), i + 1).map((t) => t.R).filter((x) => x != null);
    rolling.push({ at: era[i].id, meanR20: r4(w.length ? w.reduce((s, x) => s + x, 0) / w.length : null) });
  }

  const milestone = MILESTONES.find((m) => eraStats.n < m) || MILESTONES[MILESTONES.length - 1];
  const artifact = {
    generatedAt: new Date().toISOString(),
    currentSegment: { id: current.id, label: current.label, since: since.toISOString(), strict },
    annotations,
    era: eraStats,
    bySymbol,
    segments,
    curve,
    rolling,
    nextMilestone: { n: milestone, remaining: Math.max(0, milestone - eraStats.n) },
  };
  fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
  fs.writeFileSync(ARTIFACT, JSON.stringify(artifact, null, 2));

  console.log(`=== CURRENT ERA: ${current.label} (since ${since.toISOString()}) ===`);
  console.log(JSON.stringify(eraStats, null, 1));
  if (annotations.length) console.log('annotations inside the era:', annotations.map((a) => `${a.at.slice(0, 16)} ${a.id}`).join(', '));
  console.log('=== by symbol ===');
  for (const [sym, s] of Object.entries(bySymbol)) console.log(` ${sym}: n=${s.n} net=${s.netSgd} meanR=${s.meanR} win=${s.winRate} pf=${s.pf}`);
  console.log('=== segments (behavioural boundaries) ===');
  for (const s of segments) console.log(` ${s.from.slice(0, 16)} ${s.id}: n=${s.n} net=${s.stats.netSgd} meanR=${s.stats.meanR ?? '-'}`);
  console.log(`=== next milestone: n=${milestone} (${artifact.nextMilestone.remaining} to go) ===`);

  if (args.includes('--telegram')) {
    const ci = eraStats.meanRci90 ? ` CI90 [${eraStats.meanRci90.join(', ')}]` : '';
    const syms = Object.entries(bySymbol).map(([s, v]) => `${s} ${v.n}/${v.netSgd}`).join(', ');
    telegram(`Oswald era trend (${current.label})\n`
      + `n=${eraStats.n} net=${eraStats.netSgd} SGD meanR=${eraStats.meanR}${ci} win=${eraStats.winRate} pf=${eraStats.pf}\n`
      + `symbols: ${syms}\n`
      + `next milestone n=${milestone} (${artifact.nextMilestone.remaining} to go)`);
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
