// listings/parser.js — extracts FACTS from a pasted Carousell listing (LST-6).
//
// mode 'listing' (own listing): returns facts + the full description.
// mode 'comp'    (competitor) : returns facts ONLY — description/prose is
//                 discarded (never stored), per the agreed ethics split.
//
// The Carousell paste is plain-ish markdown text, so this is best-effort
// keyword/regex extraction tuned to that shape (title heading, "### S$…",
// Condition/Brand/Category/Listed fields, "Full Specifications" bullets).
'use strict';

const KEY_TO_TYPE = {
  cpu: 'cpu', gpu: 'gpu', ram: 'ram', storage: 'storage',
  motherboard: 'motherboard', psu: 'psu', optical: 'optical', case: 'case',
  os: 'other', ports: 'other', cooling: 'other', cables: 'other', other: 'other',
};

function num(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/[,$\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function firstHeading(text) {
  const m = text.match(/^\s*#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function price(text) {
  const m = text.match(/(?:^|\n)#{1,6}\s*S\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (m) return num(m[1]);
  const any = text.match(/S\$\s*([\d,]+(?:\.\d{1,2})?)/);
  return any ? num(any[1]) : null;
}

function deliveryFee(text) {
  const m = text.match(/S\$\s*([\d,]+(?:\.\d{1,2})?)[^\n]{0,50}delivery/i);
  return m ? num(m[1]) : null;
}

function field(text, label) {
  const m = text.match(new RegExp('\\b' + label + '\\b\\s*\\n\\s*([^\\n]+)', 'i'));
  return m ? m[1].trim() : null;
}

function specs(text) {
  const out = {};
  const re = /^\s*[-*]\s*(CPU|GPU|RAM|Storage|Motherboard|PSU|Optical(?:\s+Drive)?|Case|OS|Ports|Cooling|Cables|Other)\s*:\s*(.+)$/gim;
  let m;
  while ((m = re.exec(text))) {
    let key = m[1].toLowerCase();
    if (key.startsWith('optical')) key = 'optical';
    out[key] = m[2].trim();
  }
  return out;
}

function description(text) {
  const m = text.match(/\bDescription\b[^\n]*\n([\s\S]*?)(?=\nDeal method|\nMeet the seller|\nReviews for|$)/i);
  return m ? m[1].trim() : null;
}

function listed(text) {
  const m = text.match(/\bListed\b\s*\n\s*([^\n]+)/i);
  return m ? m[1].trim() : null;
}

function parseListingText(text, { mode = 'listing' } = {}) {
  const t = String(text || '');
  const title = firstHeading(t);
  const specMap = specs(t);
  const listedLine = listed(t);
  const seller = (listedLine && (listedLine.match(/by\s+(@?\w+)/i) || [])[1]) || null;
  const likes = (t.match(/(\d+)\s+likes?\b/i) || [])[1];
  const wantCount = (t.match(/(\d+)\s+people also want this/i) || [])[1];
  const categoryRaw = field(t, 'Category');

  return {
    title,
    sellingPrice: price(t),
    deliveryFee: deliveryFee(t),
    condition: field(t, 'Condition'),
    brand: field(t, 'Brand'),
    category: categoryRaw ? categoryRaw.replace(/^in\s+/i, '') : null,
    listed: listedLine,
    seller,
    likes: likes ? Number(likes) : null,
    wantCount: wantCount ? Number(wantCount) : null,
    specs: specMap,
    parts: Object.entries(specMap).map(([k, v]) => ({ partType: KEY_TO_TYPE[k] || 'other', partName: v })),
    specSummary: Object.entries(specMap).map(([k, v]) => `${k.toUpperCase()}: ${v}`).join(' · '),
    description: mode === 'listing' ? description(t) : null, // comps: facts only
  };
}

module.exports = { parseListingText };
