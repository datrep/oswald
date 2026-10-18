// trading/agent/log.js — DESIGN BIBLE v1 · Phase A: the shared log envelope.
// Every TradingEvents entry carries the envelope fields INSIDE its payload:
//   stream, level, actor, action, correlationId, causationId, sequence,
//   redacted (list of removed field names)
// Enrichment is ADDITIVE + idempotent: legacy payload fields are never
// moved or renamed, so all existing consumers keep working unchanged.
'use strict';

const crypto = require('crypto');

// Legacy kind -> stream (design bible §5). Unlisted kinds default to 'app'.
const STREAM_BY_KIND = {
  // act.* — mutations by any actor
  wake: 'act', decision: 'act', trade_opened: 'act', trade_closed: 'act',
  order_rejected: 'act', position_review: 'act', paper_trade: 'act',
  paper_reset: 'act', ask: 'act', alert: 'act', alert_crossed: 'act',
  central: 'act', phantom_fill: 'act',
  // sec.* — auth, kill switch, config, risk alerts
  kill: 'sec', system: 'sec', budget_warn: 'sec', divergence_alert: 'sec',
  // F19 (2026-09-18): the hard tier's auto-close is a safety action of the same family as the tier that
  // asks for it, so it belongs in the same stream — the one the operator filters on when asking "what did
  // the kill switch do?".
  kill_auto_close: 'sec',
  black_swan: 'sec', watchdog_login_death: 'sec', parity_check: 'sec',
  strategy_retired: 'sec',
  // err.*
  error: 'err',
  // state.* — canonical-state deltas
  account: 'state', day_start: 'state', llm_usage: 'state', bars_built: 'state',
  multi_signal: 'state', meta: 'state', congress_signal: 'state', pulse: 'state',
  whitepaper: 'state', autopsy: 'state', digest: 'state', hwm_baseline: 'state',
  // market.* — incoming data
  provider_snapshot: 'market', provider_backfill: 'market', congress: 'market',
  // app.* — server internals
  telemetry: 'app', watchdog_login_recovered: 'app', watchdog_waker_stale: 'app',
  // v1.2 (2026-09-12 audit): kinds the codebase writes that were unmapped —
  // config-drift events belong in sec.*, watchlist/order mutations in act.*,
  // equity/fill state in state.*, backfills in market.*.
  tune: 'sec', tune_revert: 'sec', llm_model_mismatch: 'sec',
  // ★ TRD-RSK-8 (2026-09-28): a settings write is config drift like any other, and until this row the desk had
  // NO event kind for one at all — `TradingSettings` was the only live input with no journal. A dashboard save
  // left nothing behind but a nullable `updatedAt`.
  settings_write: 'sec',
  order_attempt: 'act', discover_signal: 'act', politician_alert: 'act',
  alternatives: 'act', trd26_gate: 'act',
  // TRD-52: an unknown order outcome is a mutation-of-state like any other, and `order_recovered` is
  // how the desk recognises its OWN queued order instead of adopting it as a stranger.
  order_unconfirmed: 'act', order_recovered: 'act', order_unconfirmed_expired: 'act',
  // TRD-RSK-9: an adoption that suspects the position was the desk's own, mis-sized. Same stream as the
  // rest of the order path, because it is a statement about what the desk holds.
  order_adopt_suspect: 'act',
  order_blocked: 'act',
  fill_telemetry: 'state', account_switch: 'state', goal50_reached: 'state',
  trd26_check: 'app', trd26_report: 'app',
  multi_tf_backfill: 'market',
};

const streamFor = (kind) => STREAM_BY_KIND[String(kind)] || 'app';
// v1.2 (2026-09-12 audit): warn is now emitted where the semantics warrant it
// (order rejections, fills, account switches, budget/divergence) — the emitter
// writes info | warn | error; trace/debug/fatal are reserved, not emitted.
// TRD-52: `order_unconfirmed` joins the warn set and `order_rejected` KEEPS it — an unknown outcome
// deserves at least as much visibility as a refusal, it is simply no longer counted as one.
const WARN_KINDS = new Set(['order_rejected', 'order_unconfirmed', 'order_unconfirmed_expired', 'phantom_fill', 'order_adopt_suspect', 'account_switch', 'budget_warn', 'divergence_alert']);
const levelFor = (kind) => {
  const k = String(kind);
  if (k === 'error') return 'error';
  return WARN_KINDS.has(k) ? 'warn' : 'info';
};

// Redaction denylist (design bible §5): applied at the LOGGING boundary,
// before serialization. Recursive, depth-limited, never throws.
//
// `token` is deliberately UNBOUNDED. An earlier fix narrowed it to `(?<![a-z])token` to stop it matching
// the token COUNTERS (completionTokens, promptTokens, ...), but that created a worse problem: it also
// stopped matching every camelCase secret - `sessionToken`, `accessToken`, `refreshToken`, `userToken` -
// which is a FALSE NEGATIVE, and a false negative here leaks a credential silently. A false positive
// only loses telemetry, which is visible and fixable. So the pattern stays broad and the COUNTERS are
// excluded by value instead (see COUNT_KEY below). Erring toward redaction is the correct direction.
const DENYLIST_KEY = /(password|passwd|token|secret|api[_-]?key|signature|authorization|cookie|sessionid|credential)/i;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i;

// ★ THE SWEEP THAT FOUND THIS (2026-09-15): 945 of 1002 llm_usage events stored "[REDACTED]" for
// completionTokens/promptTokens. budget.todayUsage() reads them with Number(...) || 0, so the LLM budget
// metered ZERO - /api/trading/budget reported total: 0 and used: 0 for every consumer while the desk was
// making chair, review, shadow and pulse calls. A cap that cannot be reached is not a cap.
//
// THE EXCEPTION IS NARROW ON PURPOSE: a finite number is treated as a COUNT only when the key also ends
// in a count word. That keeps every counter intact (`tokens`, `completionTokens`, `inputTokens`,
// `promptCacheHitTokens`, `tokenCount`) while still redacting `token: 123456` - which a blanket "numbers
// are counts" rule would have let through, and which could be a numeric session id or an OTP.
const isCount = (v) => typeof v === 'number' && Number.isFinite(v);
const COUNT_KEY = /(tokens|count|size|length)$/i;

// Verified 2026-09-15: nothing in trading/ puts a bare number on a denylisted key. The only denylist-named
// fields are string credentials (`congress.token`, `Authorization` headers, `cookie`) and nulls, so the
// exception applies to counters only. If a future call site logs a numeric credential, it must be named
// so that it does NOT end in a count word - and the honest limitation is that a numeric field whose
// token-ish name ends in something else (e.g. `tokensPerBar`) is still redacted. That direction is the
// safe one: it costs a metric, not a secret.
function redact(value, depth = 0) {
  const removed = [];
  const walk = (v, d) => {
    if (v == null || d > 6) return v;
    if (typeof v === 'string') return BEARER_RE.test(v) ? '[REDACTED]' : v;
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, d + 1));
    if (typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (DENYLIST_KEY.test(k) && !(isCount(val) && COUNT_KEY.test(k))) {
          removed.push(k);
          out[k] = '[REDACTED]';
        } else {
          out[k] = walk(val, d + 1);
        }
      }
      return out;
    }
    return v;
  };
  const walked = walk(value, depth);
  return { value: walked, removed: [...new Set(removed)] };
}

// Build the enveloped payload. Idempotent: existing envelope fields win, so
// store-level enrichment can re-run safely after call-site enrichment.
function enrich(kind, payload, ctx = {}) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const red = redact(raw);
  const p = { ...red.value };
  if (p.stream === undefined) p.stream = ctx.stream || streamFor(kind);
  if (p.level === undefined) p.level = ctx.level || levelFor(kind);
  if (p.actor === undefined) p.actor = ctx.actor || 'system';
  if (p.action === undefined) p.action = ctx.action || kind;
  if (p.correlationId === undefined) p.correlationId = ctx.correlationId || null;
  if (p.causationId === undefined) p.causationId = ctx.causationId ?? null;
  if (p.sequence === undefined) p.sequence = ctx.sequence ?? null;
  if (red.removed.length) p.redacted = [...new Set([...(p.redacted || []), ...red.removed])];
  return p;
}

// correlationId: timestamp-prefixed, collision-safe enough for one desk.
function corrId(prefix = 'op') {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

// Awaitable write (act/sec/err paths).
async function write(userId, kind, payload, ctx = {}) {
  return require('../store').logEvent(userId, kind, enrich(kind, payload, ctx));
}

// Fire-and-forget (app/market paths) — logging never blocks trading.
function fire(userId, kind, payload, ctx = {}) {
  write(userId, kind, payload, ctx).catch(() => {});
}

// Structured error entry (design bible §5): {where, error, code} + envelope.
async function error(userId, where, err, ctx = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  return write(userId, 'error', {
    where: String(where).slice(0, 64),
    error: String(e.message || e).slice(0, 300),
    code: ctx.code || e.code || 'system_error',
    ...(ctx.fields || {}),
  }, { level: 'error', ...ctx });
}

module.exports = { streamFor, levelFor, enrich, redact, corrId, write, fire, error, STREAM_BY_KIND };
