// trading/agent/newsDigest.js — S2 of the news aggregator (open-work §4.19 / TRD-NEW-1).
//
// The DETERMINISTIC digest. Given stored NewsItems rows it produces the per-symbol view the panel
// renders — and later (S3, separately gated) the chair-bundle section. There is NO model here and no
// invented scalar: the ordering rule is the whole intelligence, and it is pinned by test:
//
//   1. items WITH a publication date first, newest first;
//   2. then items with NO date, by engine score (desc), then id (desc) — stable, never random;
//   3. ≤ N per symbol; symbols in alphabetical order so the panel cannot reshuffle between refreshes.
//
// WHY NULL DATES RANK LAST RATHER THAN BEING DROPPED: searxng engines omit dates unevenly, and an
// undated item is UNKNOWN-age, not old. Dropping them would silently shrink coverage; ranking them
// after dated items is honest and deterministic. `ageMin` is computed at READ time and reported as
// null when the date is absent — never fabricated from `createdAt` (the fetch time is not the
// publication time, and this desk does not fudge clocks).
'use strict';

const CAP_DEFAULT = 3;

function timeOf(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

// Deterministic order: dated first (desc), then undated by score desc, then id desc.
function orderItems(items) {
  return [...items].sort((a, b) => {
    const ta = timeOf(a.publishedAt);
    const tb = timeOf(b.publishedAt);
    if (ta != null && tb != null && ta !== tb) return tb - ta;
    if (ta != null && tb == null) return -1;
    if (ta == null && tb != null) return 1;
    const sa = Number.isFinite(Number(a.score)) ? Number(a.score) : -Infinity;
    const sb = Number.isFinite(Number(b.score)) ? Number(b.score) : -Infinity;
    if (sa !== sb) return sb - sa;
    return (Number(b.id) || 0) - (Number(a.id) || 0);
  });
}

function toItem(r, now) {
  const t = timeOf(r.publishedAt);
  return {
    id: r.id,
    title: String(r.title || ''),
    url: String(r.url || ''),
    source: r.source || null,
    engine: r.engine || null,
    publishedAt: t == null ? null : new Date(t).toISOString(),
    ageMin: t == null ? null : Math.max(0, Math.round((now - t) / 60000)),
    score: Number.isFinite(Number(r.score)) ? Number(r.score) : null,
  };
}

function buildDigest(rows, { perSymbol = CAP_DEFAULT, sinceHours = 48, now = new Date() } = {}) {
  const bySymbol = new Map();
  for (const r of rows || []) {
    const sym = String((r && r.symbol) || '').trim();
    if (!sym) continue;
    if (!bySymbol.has(sym)) bySymbol.set(sym, []);
    bySymbol.get(sym).push(r);
  }
  const t = now instanceof Date ? now.getTime() : Number(now);
  const symbols = [...bySymbol.keys()].sort((a, b) => a.localeCompare(b)).map((sym) => {
    const ordered = orderItems(bySymbol.get(sym));
    return { symbol: sym, items: ordered.slice(0, perSymbol).map((r) => toItem(r, t)), total: ordered.length };
  });
  return {
    asOf: new Date(t).toISOString(),
    windowHours: sinceHours,
    perSymbol,
    totals: {
      items: (rows || []).length,
      symbols: symbols.length,
      shown: symbols.reduce((n, s) => n + s.items.length, 0),
    },
    symbols,
  };
}

// The Telegram toast line (brief §8): CONTENT-FREE on purpose — no headline, snippet or verdict may
// ever ride it (a lock-screen headline is a headline out of context). The second count is SYMBOLS,
// not "high-relevance": relevance scoring is the classification step's job (its own pre-registration)
// — inventing a proxy here would be exactly the fabricated scalar the brief bans.
function toastLine(summary) {
  const n = Number(summary && summary.inserted) || 0;
  const m = Number(summary && summary.symbols) || 0;
  return `news updated · ${n} new item${n === 1 ? '' : 's'} · ${m} symbol${m === 1 ? '' : 's'}`;
}

module.exports = { buildDigest, toastLine, orderItems };
