# Architecture decisions

Binding records, not notes. An **accepted** decision here is enforced by `test/architecture-conformance.test.js`,
which fails the suite in both directions: a new violation, or an allowlist entry that no longer violates (the list
must shrink). If a decision is superseded, say so here and update the test in the same change — a rule that exists
only in this file is a wish.

Why this file exists at all: a model writing code from a context window cannot see that it has already answered a
question elsewhere. Measured on 2026-10-27, per-instrument facts had **six producers and five shapes**, the risk
dials were read in **eleven modules**, and one bridge latch was written by four. None of that was a bug in any
single commit; it was the absence of an external memory. This is that memory.

---

## ADR-0001 — Settings are owned, not shared

**Status:** accepted 2026-10-27.

**Context.** `TradingSettings` is one flat JSON blob that both the operator and the desk write to. The journal
(4 days to 2026-10-27) shows the machine overwriting itself constantly, and overwriting operator intent with it:

| key | writes | owner in practice |
|---|---|---|
| `bridge.consecutiveFails` | 22 | machine, per failure |
| `bridge.pausedAt` | 12 | machine, per failure |
| `kill.initialEquity` | 10 | machine |
| `watchlist.universe` | 3 | machine, daily |

`watchlist.universe` shrank by 494 characters on the 2026-10-25 write — a list the operator may have curated,
replaced by a discovery sweep. "My edits keep getting reset" was literally true and no one had broken a rule,
because there was no rule.

**Decision.** Every settings key has exactly ONE writer class:

- **Operator-owned** — `risk.*`, `deliberation.*`, `budget.*`. The machine never writes these. The UI may.
- **Machine-owned** — `bridge.*` runtime fields (`paused`, `pausedSince`, `lastFailAt`, `pausedAlertAt`,
  `consecutiveFails`, `lastSweepAt`), `kill.initialEquity`, `watchlist.universe`, `watchlist.candidates`,
  `discovery.*`. The operator never edits these; the UI should not offer them as editable.
- **Co-owned by ENTRY** — `watchlist.symbols`. ⚠ THIS BULLET USED TO CLASSIFY IT WHOLLY OPERATOR-OWNED, WHICH WAS
  WRONG: it is one array carrying the operator's manual picks AND the discoverer's `source: 'ai'` picks, and
  `agent/discoverer.js` rewrites it every cycle while preserving every manual entry verbatim. A machine write may
  add, change or drop AI entries only. **Order is not ownership** — the array is rebuilt as
  `[...manual, ...ai]` on every run, so a rule comparing positions would fire constantly with nothing lost.
- **Derived** — read-only projections (`riskResolved.*`). Never written by anyone; recomputed on read.

**Consequences.** A machine writer must target only its own namespace. A new key is not "wherever the caller
happened to put it". If a value would need writing by both, it is two values with different names.

**Status update, 2026-10-27.** The convention is now a registry: `trading/store/ownership.js` holds the rules,
`saveSettings(userId, patch, { by })` classifies every write, and a crossing is recorded as its own
`settings_scope_violation` event. It does not refuse — a classification question must not fail a live save, which is
the same trade `reportDeadScopeWrite` declined. The write churn is also fixed: `plus500/health.js` keeps the failure
streak in process and persists on transitions and checkpoints, so `bridge.consecutiveFails` no longer writes on
nearly every poll.

**Known gap, CLOSED 2026-10-27.** `ownership.RULES` did not contain `budget.*` or `discovery.*`, although this ADR
classifies them, so a machine write to either was classified `shared` and raised nothing — the registry was narrower
than the decision. Both are now in `RULES` (`budget` operator, `discovery` machine), and `AGENTS.md` §2 names them,
because `test/ownership-doc-sync.test.js` enforces the two directions against each other. That coupling is why the gap
was recorded rather than patched quietly: closing it required changing the document too, which is the point of the
check rather than an obstacle to it.

---

## ADR-0002 — The bridge latch has one writer

**Status:** accepted 2026-10-27. Enforced (invariant B).

**Context.** A UI Fallback Pause is a latch: only a manual `resume()` clears it. Four modules touched it —
`plus500/health.js` decided and wrote, `agent/aggregator.js` enforced it, `agent/selfHealth.js` printed its age from
`b.pausedAt`, `agent/killswitch.js` documented the transition-only alert rule. Because `pausedAt` was rewritten on
every failure, the age printed by `selfHealth` was the time since the *last failure*, not since the pause began. On
2026-10-25 the desk sat latched from 15:13 to 21:14 — nearly six hours, 7 entries refused — after one alert, and
the health panel showed a pause minutes old throughout.

**Decision.** `plus500/health.js` is the only writer of the latch. It records two separate facts: `pausedSince` (set
once, on the transition, never while latched) and `lastFailAt` (every failure). `pausedAt` is kept equal to
`pausedSince` so existing readers are correct without being changed. `resume()` clears all four fields together.

**Alerting.** On the transition, **and** while the state is held beyond `REALERT_AFTER_MS` (1 h) when no page has
gone out in that window. Transition-only alerting for a persistent condition is a receipt, not a notification. The
verdict is pure (`pauseAlertVerdict`) and tested without Telegram.

**Consequences.** Anything else that wants to report or enforce the pause reads the settings; it does not write them.

---

## ADR-0003 — Per-instrument facts have one producer; per-instrument policy has one resolver

**Status:** accepted 2026-10-27. Facts invariant enforced with a ratchet; the policy resolver does not exist yet.

**Context.** Three different questions were all called "per-symbol":

| question | examples | kind |
|---|---|---|
| what is true about this instrument? | min size, unit step, leverage, margin rate, cost basis, quote currency, funding clock | **fact** |
| which dials apply to this instrument? | stop multiple, adverse cap, target R, lock/trail distances | **policy** |
| what is the account's state right now, keyed by symbol? | fx factor, point value of the open book | **state** |

Facts were answered in six places: `instruments.resolve`, `accountCurrency.instrumentCurrencyOf`,
`backtest.costCfgFor`, `risk.fxFactorFor`, an inline `pointValueBySymbol` in `aggregator`, and `clocks[symbol]` in
`venueClose`. Policy does not exist at all — every dial is global.

**Decision.**

- **Facts** — `agent/instruments.js` only. Nothing else may build a per-symbol fact table.
- **Policy** — a new `agent/symbolPolicy.js`, pure, no DB: `symbolPolicy(settings, symbol)` resolves
  `DEFAULT → settings.risk → settings.risk.bySymbol[symbol]`. The resolved block is **carried on the decision
  record**, so the eleven current readers read a recorded value instead of resolving settings themselves. That is
  what stops the split re-forming.
- **State** — sampled once per wake and passed down. It is not a property of the instrument.

**Consequences and current debt.** The ratchet's `INVARIANT_A_KNOWN` lists nine runtime violators. The one that
matters most is `agent/stopPolicy.js`: it calls `backtest.costCfgFor(symbol)` **on the live decision path**, so the
live stop-cap floor is computed from the backtest's static basis with no cross-check. Measured 2026-10-27,
`InstrumentQuotes` had not been captured since **2026-10-01**, so `instruments.venueCostFacts` returns a NULL spread
for every symbol and the live basis is unverifiable. **Per-symbol policy work must not start until that is resolved**
— otherwise every per-symbol delta is measured against a cost the desk may not be paying.

**Not done.** No big-bang refactor of the eleven dial readers. New work goes through the resolver; the existing
producers migrate when they are next touched. A ratchet, not a spike.
