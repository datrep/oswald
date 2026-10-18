// trading/settingsDiff.js — TRD-RSK-8: what a settings write actually CHANGED.
//
// WHY THIS EXISTS AS A PURE MODULE. `TradingSettings` is the one live input on this desk with no record of its
// own: there is no settings-write event kind, so a save leaves nothing behind but a nullable `updatedAt`, which
// cannot say what changed, when, or by whom. Measured 2026-09-28: `risk.maxAdversePct` moved 0.3 -> 1.5 at
// 06:51:16.553Z and nothing recorded it — the chair was told "0.3%" by the prompt 54 seconds earlier and "1.5%"
// by the next one, and the switch is not reconstructible from the log afterwards.
//
// The diff belongs in a module of its own, with no database and no logger, for the same reason
// `scopeResolution.js` and `unconfirmed.js` are separate: the rule is then testable directly, and `store.js`
// keeps only the wiring. `store.saveSettings` is the ONE chokepoint every writer shares — the route, the
// discoverer, the tuner, `accountPoller` and `bindingApply`'s widener — which is the argument TRD-116 used to
// put `reportDeadScopeWrite` there, and TRD-103 is why it matters (an automated writer reverted a human's
// change twelve minutes later; a route-level guard would not have seen it).
'use strict';

// ⚠ SECRETS ARE NEVER COPIED INTO THE JOURNAL. Settings carry credentials (the Congress/Quiver token among
// them). A journal that recorded before/after VALUES would move a secret into `TradingEvents`, which is read by
// the dashboard, the digest and every report — a worse leak than the one it fixes. A credential-looking KEY
// records that it CHANGED and never what to.
const SECRET_KEY_RE = /token|secret|password|passphrase|api[_-]?key|credential/i;

// ⚠ BOUNDED. The first save of a fresh install writes the whole tree; without a cap the event carries the entire
// settings object. The count of changes is always the TRUE count, and the truncation is stated, so a reader can
// tell a small write from a clipped one.
const JOURNAL_MAX_KEYS = 40;

// Flatten a before/after pair into one entry per LEAF whose value differs.
// Arrays are compared as whole values on purpose: a watchlist reorder is one fact, not N.
function diffSettings(before, after, prefix = '', out = []) {
  const b = before && typeof before === 'object' ? before : {};
  const a = after && typeof after === 'object' ? after : {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const k of keys) {
    const path = prefix ? prefix + '.' + k : k;
    const bv = b[k];
    const av = a[k];
    const bObj = bv && typeof bv === 'object' && !Array.isArray(bv);
    const aObj = av && typeof av === 'object' && !Array.isArray(av);
    if (bObj || aObj) {
      diffSettings(bObj ? bv : {}, aObj ? av : {}, path, out);
      continue;
    }
    if (JSON.stringify(bv) === JSON.stringify(av)) continue;
    if (SECRET_KEY_RE.test(k)) {
      // the change is reported, the value is not
      out.push({ key: path, redacted: true, present: av != null && av !== '' ? 'set' : 'cleared' });
      continue;
    }
    out.push({ key: path, before: bv === undefined ? null : bv, after: av === undefined ? null : av });
  }
  return out;
}

// The payload for a `settings_write` event, or null when nothing changed.
// ⚠ A NO-OP SAVE PRODUCES NO EVENT. The desk's convention is that an event is a SIGNAL and not a stream, and
// `accountPoller` writes settings whenever it sees a new position — a state-based journal would log forever.
function settingsWriteEvent(before, after) {
  let changes;
  try { changes = diffSettings(before, after); } catch { return null; }
  if (!changes.length) return null;
  const shown = changes.slice(0, JOURNAL_MAX_KEYS);
  return {
    changed: changes.length,
    truncated: changes.length - shown.length,
    keys: shown.map((c) => c.key),
    changes: shown,
  };
}

module.exports = { diffSettings, settingsWriteEvent, SECRET_KEY_RE, JOURNAL_MAX_KEYS };
