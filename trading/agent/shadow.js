// trading/agent/shadow.js — TRD-SHW-1 (2026-09-14).
//
// THE SHADOW CALL. Ask the model what it sees in MARKET STRUCTURE, with the desk
// own signal deliberately absent, and record the answer. No order, no size, no
// influence on any trading path. See docs/trading-chair-economy-plan-2026-09-14.md
// §3 for why this is the only honest day-one form.
//
// ★ THE STRIP IS A CONSTRUCTION, NOT A SUBTRACTION. `stripContext` builds a NEW
// object containing only whitelisted fields — it never copies a desk bundle and
// deletes keys. That matters because a subtraction leaks: `buildBundle` renders
// "no signal — <flat>" for a symbol with no signal, which is itself a desk
// conclusion, so stripping the signal line would still tell the model that there
// was no signal. You cannot leak what you never emit, so the rule is: the shadow
// prompt is assembled from raw structure only, and a test asserts the assembled
// text contains none of the desk's verdict vocabulary.
//
// WHY THE CIRCULARITY TRAP IS WORTH THIS MUCH CARE: a chair bundle carries the
// desk's own entry/no-entry line. Asked "is a move starting before the confirmation
// would register it?", a model holding that line can paraphrase it and look
// prescient for free. The strip is what makes the question answerable at all.
//
// Q1 ONLY. Q2 (what the gates screen out) needs the gates present and is frozen
// with Q3 (is the regime consistent) — neither may enter v1, and neither may be
// redefined once v1's results exist.
'use strict';

// Frozen at first deployment. A row's promptVersion is how a later reader knows
// which question produced it; editing the text without bumping the version is the
// thing this constant exists to make impossible to do quietly.
const PROMPT_VERSION = 'q1-v1';

// Fixed BEFORE collection (plan §3.3). A 1h signal series, so 24 bars = one day.
const HORIZON_BARS = 24;

const QUESTION_V1 = [
  'You are shown MARKET STRUCTURE ONLY for one instrument.',
  'The desk own entry signal is NOT shown in this bundle, and neither is its verdict',
  'on the gates. Do not assume a signal exists, and do not predict what a rule would say.',
  '',
  'Question: from the structure shown, is a directional move starting BEFORE the 1h',
  'Donchian/ADX confirmation would register it?',
  '',
  'Answer with a single JSON object exactly in this shape:',
  '{"evidence":"yes|no","direction":"buy|sell|none","confidence":0.0,"basis":"one short sentence"}',
  '"no" is a valid and expected answer — say so when the structure does not support a',
  'call. `direction` must be "none" when evidence is "no".',
].join('\n');

// The whitelist. Everything the model is allowed to see, named once.
const KEPT_CONTEXT_KEYS = ['session', 'pulse', 'congress', 'digest', 'alert', 'venueCosts', 'bigPicture'];

function num(v, dp = 4) {
  // ★ GUARD ABSENCE BEFORE COERCION — the SHW-4 `rOf` shape (shadowScore.js). `Number(null) === 0` and
  // `Number('') === 0`, so testing `Number.isFinite` AFTER coercing turns "not measured" into a legitimate
  // 0: `structureRow({price:null, atr14:''})` reported `price=0 ATR14=0` — an instrument at zero with zero
  // volatility, which is a FABRICATED structure row rather than a missing one. Only `undefined` was correct
  // already, which is why the defect survived. §11.3 / §12.3. A GENUINE 0 still survives (`adx14 = 0`).
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10 ** dp) / 10 ** dp;
}

// Market structure for ONE symbol — price, volatility, trend, range, regime. All of
// it is computable from bars and none of it is a verdict.
function structureRow(s) {
  if (!s || typeof s !== 'object') return null;
  const dc = s.donchian || null;
  return {
    symbol: s.symbol || null,
    venue: s.venue || null,
    status: s.status || null,
    price: num(s.price),
    prevPrice: num(s.prevPrice),
    atr14: num(s.atr14),
    adx14: num(s.adx14),
    regime: s.regime || null,
    regimeDir: s.regimeDir || null,
    donchianBands: dc ? { lower: num(dc.lower), upper: num(dc.upper) } : null,
    bars: Array.isArray(s.series) ? s.series.length : null,
  };
}

// ★ THE STRIP. Returns a NEW object holding ONLY the fields the model may see.
// Note what is NOT here and must never be added: signal, flat, quantVotes,
// strategyStats, proposal(s). Those are the desk's conclusions.
function stripContext({ quantResult, session, pulse, congress, digest, alert, venueCosts } = {}) {
  const symbols = ((quantResult && quantResult.symbols) || [])
    .map(structureRow)
    .filter(Boolean);
  const ctx = {
    promptVersion: PROMPT_VERSION,
    horizonBars: HORIZON_BARS,
    symbols,
  };
  // Kept context, copied by value through a whitelist. `bigPicture` is per-symbol and
  // already rides on the structure row via quantResult; the rest are desk context
  // that is not a signal statement.
  void KEPT_CONTEXT_KEYS;
  if (session) ctx.session = { state: session.state || null, detail: session.detail || null };
  if (pulse) ctx.pulse = typeof pulse === 'string' ? pulse.slice(0, 1200) : pulse;
  if (congress) ctx.congress = typeof congress === 'string' ? congress.slice(0, 600) : congress;
  if (digest) ctx.digest = typeof digest === 'string' ? digest.slice(0, 800) : digest;
  if (alert) ctx.alert = alert;
  if (venueCosts) ctx.venueCosts = venueCosts;
  return ctx;
}

// Render the stripped context as the prompt the model actually receives.
function buildPrompt(stripped, symbol) {
  const lines = [`--- SHADOW CALL (Q1, ${PROMPT_VERSION}) — no order will be placed ---`, QUESTION_V1, ''];
  const rows = symbol ? (stripped.symbols || []).filter((s) => s.symbol === symbol) : (stripped.symbols || []);
  lines.push('--- MARKET STRUCTURE (desk signal withheld) ---');
  if (!rows.length) lines.push('(no symbol)');
  for (const r of rows) {
    const dc = r.donchianBands ? `[${r.donchianBands.lower}..${r.donchianBands.upper}]` : 'n/a';
    lines.push(`${r.symbol} (${r.venue}): price=${r.price} prev=${r.prevPrice} ATR14=${r.atr14} ADX14=${r.adx14} ` +
      `regime=${r.regime || 'n/a'}${r.regimeDir ? ' ' + r.regimeDir : ''} Donchian20=${dc} bars=${r.bars}`);
  }
  if (stripped.session) lines.push('', `Session: ${stripped.session.state}${stripped.session.detail ? ' (' + stripped.session.detail + ')' : ''}`);
  if (stripped.pulse) lines.push('', 'Pulse/news:', String(stripped.pulse));
  if (stripped.congress) lines.push('', 'Congress:', String(stripped.congress));
  if (stripped.digest) lines.push('', 'Digest:', String(stripped.digest));
  if (stripped.venueCosts) lines.push('', 'Venue costs:', JSON.stringify(stripped.venueCosts));
  return lines.join('\n');
}

// Parse the model's reply. Tolerant of prose around the JSON, strict about what it
// accepts as an answer — and it NEVER invents a direction.
function parseAnswer(raw) {
  const text = String(raw == null ? '' : raw);
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, reason: 'no_json', evidence: null, direction: null, confidence: null, basis: null };
  let obj;
  try { obj = JSON.parse(m[0]); } catch (e) { return { ok: false, reason: 'bad_json', evidence: null, direction: null, confidence: null, basis: null }; }

  const yes = obj.evidence === true || /^y(es)?$/i.test(String(obj.evidence || ''));
  const no = obj.evidence === false || /^no?$/i.test(String(obj.evidence || ''));
  if (!yes && !no) return { ok: false, reason: 'evidence_not_boolean', evidence: null, direction: null, confidence: null, basis: null };

  const basis = obj.basis == null ? null : String(obj.basis).slice(0, 400);
  if (!yes) return { ok: true, evidence: false, direction: null, confidence: null, basis };

  // Claiming evidence REQUIRES a direction. A yes with no direction is unusable and
  // must not be silently coerced into a trade-able call.
  const dir = String(obj.direction || '').toLowerCase();
  if (dir !== 'buy' && dir !== 'sell') {
    return { ok: false, reason: 'direction_invalid', evidence: true, direction: null, confidence: null, basis };
  }
  let conf = Number(obj.confidence);
  if (!Number.isFinite(conf)) conf = null;
  if (conf != null) conf = Math.max(0, Math.min(1, conf));
  return { ok: true, evidence: true, direction: dir, confidence: conf, basis };
}

// The scored population (plan §3.5/§3.7): calls that produced a DIRECTION. A
// no-evidence row is recorded (it is the denominator for the yes rate) but never
// scored, because B and C have nothing to compare it against.
function isDirectional(parsed) {
  return !!(parsed && parsed.ok && parsed.evidence === true && (parsed.direction === 'buy' || parsed.direction === 'sell'));
}

// Scheduled-event flag for the call day. SOURCE: CorporateEvents, which the desk
// already populates from federalreserve.gov (FOMC meeting days, symbol '*') and
// with halts. NOTE (rev 4 correction): FOMC IS covered — CPI/NFP are not, so this
// catches the macro meeting-day case but not every macro release.
function scheduledEventFor(events, at) {
  const day = new Date(at || Date.now());
  if (!Array.isArray(events) || Number.isNaN(day.getTime())) return null;
  const key = day.toISOString().slice(0, 10);
  const hit = events.find((e) => {
    if (!e || !e.eventDate) return false;
    const d = new Date(e.eventDate);
    if (Number.isNaN(d.getTime())) return false;
    return d.toISOString().slice(0, 10) === key;
  });
  if (!hit) return null;
  return String(hit.note || hit.eventType || 'scheduled event').slice(0, 64);
}

module.exports = {
  PROMPT_VERSION, HORIZON_BARS, QUESTION_V1, KEPT_CONTEXT_KEYS,
  stripContext, structureRow, buildPrompt, parseAnswer, isDirectional, scheduledEventFor,
};
