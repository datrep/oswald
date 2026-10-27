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

// ⚠⚠ RANK, DO NOT TAKE THE FIRST MATCH. The first version scanned for ONE pattern and took the earliest matching
// line, and every page of the premium hub opens with chrome:
//
//     1  Premium Market Analyses
//     2  Your gateway to in-depth analysis and weekly trends.   <- contains "analysis", matched, PICKED
//     3  Weekly Newsletter
//     4  Instrument Analyses
//     5  Breaking down the week ahead                           <- the actual heading
//
// Measured 2026-10-27 over the ledger: 80 of 163 rows carried that tagline as their title (58 instrument view, 22
// weekly), and an instrument view put its real heading at line 7 ("Nasdaq 100 Intraday: Key Resistance Focus
// 29787"). This is not cosmetic — `title` is the only identity an append-only analyses ledger has, and 58 rows
// carrying 45 DIFFERENT analyses under one title is a corpus that cannot be partitioned.
//
// So the patterns are ranked. A strong marker (`intraday`, `outlook`, the weekly column name) always wins; the bare
// word `analysis` is a fallback for a page whose heading uses no stronger word. ⚠ The venue's copy is NOT hardcoded:
// a renamed tagline would simply stop matching, which is the correct failure, whereas a blacklist would rot silently.
//
// ⚠⚠ AND RANKING ALONE WAS NOT ENOUGH — the first version of this fix still failed its own test. When NO strong marker
// exists there are two weak candidates, and the tagline is still first, so first-match-wins returns it again. The
// discriminator that does not hardcode anything: **a heading is not a sentence.** The tagline ends in a full stop and
// runs to nine words; every real heading in the captured corpus ends without sentence punctuation. Applied to the WEAK
// tier only, and only as a preference — if every weak candidate reads as prose, the first is still returned rather than
// nothing, because "thin page" is a fact `rawText` and `parseStatus` should carry, not one to hide behind a null.
const TITLE_STRONG = /intraday|outlook|breaking down|week ahead/i;
const TITLE_WEAK = /analysis/i;
const READS_AS_PROSE = /[.!?]\s*$/;

// ⚠⚠ THE STORED TITLES CANNOT BE REPAIRED BY RE-RUNNING THIS, AND THAT WAS MEASURED BEFORE ANYONE TRIED IT.
// After the ranking fix the obvious next step is "re-derive the 80 bad titles from `rawText`" — the text is intact
// and this function is pure. Measured 2026-10-27 over all 163 stored rows: re-deriving would change **156 of them**
// and leave ONE unchanged. That is not a repair, it is a rewrite of the whole corpus by a heuristic, and two classes
// come out demonstrably WRONG:
//
//   · 5 of 40 `weekly` rows whose `rawText` is actually an INSTRUMENT page — the capture stored the wrong view's
//     text. Re-derivation then titles a weekly row with an instrument heading: more informative than the tagline it
//     replaced, and still wrong. `parseAnalysis` cannot notice, because an explicit `view` DECIDES the kind (see the
//     v1.2 note below), so the content never gets a vote.
//   · single-line owner-screenshot text, where every "line" is the whole paragraph: the title becomes a 140-char
//     prose slice, worse than the hand-written title that was stored.
//
// SO: NO BACKFILL (AGENTS.md §4 makes the ledger append-only anyway) AND NO `titleFor(row)` READ-TIME HELPER. Such a
// helper would encode a rule that is wrong for both classes, and there is no consumer to justify it — the only reader
// of this table is `store.countRecentAnalyses`, which returns `COUNT(*)` and never touches a title. If a consumer
// ever needs these titles it must handle the two cases above, and that is a CAPTURE-TARGET question, not a parsing
// one: the fix is in what the weekly sweep navigates to, not in this function.
function extractTitle(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const short = lines.filter((l) => l.length <= 140);
  const strong = short.find((l) => TITLE_STRONG.test(l));
  if (strong) return strong.slice(0, 200);
  const weak = short.filter((l) => TITLE_WEAK.test(l));
  const heading = weak.find((l) => !READS_AS_PROSE.test(l));
  if (heading) return heading.slice(0, 200);
  if (weak.length) return weak[0].slice(0, 200);
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
