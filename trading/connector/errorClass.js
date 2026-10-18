// trading/connector/errorClass.js — what actually went wrong with an order (TRD-42 / workstream E).
//
// WHY THIS EXISTS. The original classifier was BINARY:
//
//     return LIFECYCLE_RE.test(msg) ? 'lifecycle' : 'other';
//
// so `other` meant "not a page.goto problem" and swallowed everything else. On the desk's own
// event log that made `other` the LARGEST failure bucket — 5 of 7 failures across 2026-09-10/11 —
// which is a label that carries no information at all. Worse, `classifyBridgeError` ignored
// `err.code`, so a preflight failure that had already set `code: 'preflight'` was journalled as
// `other` anyway. The caller knew more than the classifier used.
//
// Reading the actual failure texts out of TradingEvents shows `other` was hiding four distinct
// conditions that need four DIFFERENT responses:
//
//   state_stale  "open position not found for Bitcoin buy" (x4)
//                The desk tried to CLOSE something the venue no longer has — a venue-side TP/SL
//                already closed it, or the position was never there. This is NOT a bridge
//                failure: retrying re-fails, and the correct response is reconciliation. It is
//                corroborated by 38 `phantom_fill` events with `missing_on_venue`.
//
//   dom_state    "set-limits field did not enable: #close-at-loss-rate" (x2),
//                "instrument row not visible for Sugar (category page missing too)" (x2)
//                A selector/DOM problem. `plus500/pageLock.js` already exists to stop the
//                mirror's 60s poll navigating mid-ticket (order_rejected 6289) — that is this
//                class, and it recurred at least once after the lock.
//
//   ambiguous    "position row did not appear after submit (order may have failed)" (x1)
//                THE OUTCOME IS UNKNOWN. This is a RISK event, not a reliability event: it
//                demands reconciliation, and averaging it into "we couldn't act" understates
//                the one failure class that can leave an unmanaged position. It gets its own
//                name precisely so it cannot be averaged away.
//
//   lifecycle    page.goto timeout / ERR_ABORTED / context destroyed — retryable once the
//                session feed recreates the bridge page. The only class worth retrying.
//
// PRECEDENCE: an explicit `err.code` beats pattern matching. Retry policy is unchanged
// (lifecycle only), so this is additive diagnostics — it cannot alter order behaviour.
'use strict';

const LIFECYCLE_RE = /ERR_ABORTED|execution context was destroyed|target closed|session closed|net::|protocol error|page\.goto/i;
const STATE_STALE_RE = /open position not found|position not found|no open position|already closed|not held/i;
// checked BEFORE dom_state: "row did not appear after submit" is ambiguous, whereas
// "row did not appear" alone is a selector problem — the submit outcome is the distinction.
const AMBIGUOUS_RE = /did not appear after submit|may have failed|outcome unknown|unconfirmed/i;
const DOM_STATE_RE = /did not enable|not visible|did not appear|category page missing|selector|not found in the table/i;

const CODES = {
  policy_violation: 'policy',
  preflight: 'preflight',
};

function classifyBridgeError(e) {
  const code = e && e.code != null ? String(e.code) : '';
  if (CODES[code]) return CODES[code];
  const msg = String((e && e.message) || e || '');
  if (STATE_STALE_RE.test(msg)) return 'state_stale';
  if (AMBIGUOUS_RE.test(msg)) return 'ambiguous';
  if (LIFECYCLE_RE.test(msg)) return 'lifecycle';
  if (DOM_STATE_RE.test(msg)) return 'dom_state';
  return 'other';
}

// ONLY lifecycle is worth retrying: a state_stale close re-fails, a dom_state failure is
// deterministic until something changes, and an ambiguous outcome must never be blindly
// retried — that is how you end up with two positions instead of one.
const RETRYABLE = new Set(['lifecycle']);
const isRetryable = (cls) => RETRYABLE.has(cls);

// Classes that require a human or a reconciliation rather than a retry.
const NEEDS_RECONCILIATION = new Set(['ambiguous', 'state_stale']);

module.exports = { classifyBridgeError, isRetryable, RETRYABLE, NEEDS_RECONCILIATION, LIFECYCLE_RE };
