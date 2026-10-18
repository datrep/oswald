// trading/agent/analysesParser.js — TRD-PRM-1 P1 (2026-10-04): pure parser for the Plus500 premium
// analyses pages (open-work §4.24; brief §2 P1). NO LLM: number+label regex pairs, keyword
// classification, completeness check, NAMED failure statuses (the F1 dead-feed discipline). Every
// level keeps its raw snippet for audit; the full rawText is stored alongside regardless of parse
// outcome, so a parser revision can re-read history without touching the ledger's append-only rule.
'use strict';

// Role classification, matching the ledger seed's convention (migration 047 / analyses-ledger-seed.sql):
// "September 28th high" -> resistance, "September 29th low" -> support (the raw words are kept in `label`).
function classifyLevel(label) {
  const L = String(label || '').toLowerCase();
  if (/bollinger|mid-?average|mid average|pivot/.test(L)) return 'pivot';
  if (/support/.test(L)) return 'support';
  if (/resist/.test(L)) return 'resistance';
  if (/target/.test(L)) return 'target';
  if (/high/.test(L)) return 'resistance';
  if (/low/.test(L)) return 'support';
  return 'level';
}

// The analyses state the timeframe inline ("4-hour chart", "daily"). Extracted, never assumed.
function timeframeHint(label) {
  const L = String(label || '');
  const m = L.match(/(\d+)\s*[- ]?\s*(hour|hr|h)\b/i);
  if (m) return `${m[1]}h`;
  if (/\bdaily\b|\bday chart\b/i.test(L)) return '1d';
  if (/\bweekly\b|\bweek chart\b/i.test(L)) return '1w';
  return null;
}

const HAS_ROLE_WORD = /bollinger|mid-?average|support|resist|high|low|target|pivot/i;

// "N (label)" pairs — the pattern the analyses use for every level ("88.55 (September 29th low)",
// "91.70 (4-hour chart) Bollinger Mid-Average"). The tail after the parenthesis is appended ONLY
// when the parenthesis itself carries no role word (the Bollinger case), so labels stay clean.
function extractLevels(text, symbol) {
  const out = [];
  const seen = new Set();
  const rx = /(\d[\d,]*(?:\.\d+)?)\s*\(([^()]{2,90})\)/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const price = Number(String(m[1]).replace(/,/g, ''));
    if (!Number.isFinite(price) || price <= 0.0001 || price > 1000000) continue;
    const paren = String(m[2]).replace(/\s+/g, ' ').trim();
    let label = paren;
    if (!HAS_ROLE_WORD.test(paren)) {
      const after = text.slice(rx.lastIndex, rx.lastIndex + 70).replace(/\s+/g, ' ').trim();
      const tail = after.split(/[;\n]/)[0].split(/\.\s/)[0].trim();
      if (tail) label = `${paren} ${tail}`.slice(0, 90);
    }
    const kind = classifyLevel(label);
    const key = `${Math.round(price * 10000)}|${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const snippet = text.slice(m.index, Math.min(rx.lastIndex + 70, text.length)).replace(/\s+/g, ' ').trim().slice(0, 220);
    out.push({ symbol, price, levelKind: kind, label: label.slice(0, 200), timeframeHint: timeframeHint(label), snippet });
    if (out.length >= 12) break;
  }
  return out;
}

function extractTitle(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pick = lines.find((l) => /intraday|analysis|outlook|breaking down|week ahead/i.test(l) && l.length <= 140);
  if (pick) return pick.slice(0, 200);
  return lines.length ? lines[0].slice(0, 200) : null;
}

// parseAnalysis(rawText, { view }) -> { kind, symbol, title, levels, parseStatus, reason }
// parseStatus: 'ok' | 'no_levels' | 'page_missing'   (named — never silent)
function parseAnalysis(rawText, { view = null } = {}) {
  const text = String(rawText || '');
  // ★ v1.2 (2026-10-04): the FIRST LIVE SWEEP caught this — the premiumhub FRAME carries its own
  // tab bar ("Weekly Newsletter Instrument Analyses") in EVERY instrument view's text, so the old
  // heuristic classified every instrument as weekly and skipped level extraction. An explicit
  // `view` now decides: only the 'weekly' view (or no view at all with the weekly wording) is weekly.
  const isWeekly = view ? view === 'weekly' : /breaking down the week ahead|weekly newsletter/i.test(text);
  const kind = isWeekly ? 'weekly' : 'instrument';
  const symbol = isWeekly ? null : (view || null);
  if (text.replace(/\s+/g, ' ').trim().length < 120) {
    return { kind, symbol, title: null, levels: [], parseStatus: 'page_missing', reason: 'text_too_short' };
  }
  const title = extractTitle(text);
  const levels = isWeekly ? [] : extractLevels(text, symbol);
  if (isWeekly) return { kind, symbol, title, levels, parseStatus: 'ok', reason: null };
  if (levels.length < 3) return { kind, symbol, title, levels, parseStatus: 'no_levels', reason: `levels_found=${levels.length}` };
  return { kind, symbol, title, levels, parseStatus: 'ok', reason: null };
}

module.exports = { parseAnalysis, extractLevels, classifyLevel, timeframeHint, extractTitle };
