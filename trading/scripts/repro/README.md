# Reproduction scripts

The measurement + settings scripts behind `trading/docs/STRATEGY_AMENDMENT_REPORT.md`.
These were originally written under `temp/`, which is **gitignored** (`.gitignore` line 6),
so the report's numbers were not reproducible from the repo. They live here instead.

All of them run **from the repo root**. Some talk to the running trading service on
`https://172.22.160.3:8114` with a short-lived owner JWT; the two analysis scripts connect
to `DB_Oswald` directly and will run even when the service is down (usefully — they were
written during an outage).

| Script | What it does | Writes? |
|---|---|---|
| `early-mfe.js` | Reconstructs each trade's intra-trade excursion path from `PriceTicks` — MFE over 15/30/60/120-min windows, time-to-peak, `peakFrac`. Produced finding F3 (losers peak early, winners hold) which is the sole basis for amendment A1. | read-only |
| `fix-capture-metrics.js` | `POST /api/trading/autopsy/backfill {force:true}` — recomputes MFE/MAE/holding/slippage for every closed trade. Required once to repair rows written before the three S2 defects were fixed (inverted for shorts, window past the close, under-sampled peak). | yes — `Trades` metric columns |
| `set-risk-sizing.js` | Sets `maxEquityPerPositionPct` / `exposureCapPct` through the UI's own settings path (deep-merge). Prints the resulting risk envelope, including the reminder that a modelled stop-out assumes fills **at** the stop. | yes — `TradingSettings` |
| `set-parity-gate.js` | Flips `learning.parityValidated`. `true` → `runInFactor 1` (full size, live tuning allowed); `false` → `runInFactor 0.5` (half size, live-desk tuning blocked). The one-setting exposure step-down for S4. | yes — `TradingSettings` |
| `set-kill-tier.js` | Sets the kill switch tier (`off` / `soft` / `hard`) with a reason, through the API. Used to clear the hand-latched hard kill before the Sunday reopen. Prints the resulting state. | yes — kill state |
| `exit-policy-study.js` | Counterfactual R-multiple replay over closed trades, comparing the desk's actual exits against rule families (venue-only, follow-through, MFE-failure, max-hold). Filters by the trade's own `venue`; truncates venue-closed trades at their real close. Produced §10.5, which contradicts amendment A1. | read-only |
| `threshold-evidence.js` | Whether the desk's three evidence thresholds (**20 / 10 / 50**) are defensible: where each came from, the desk's own R distribution with t-based intervals, what each n buys, the arrival rate derived from the data, and the false-retire probability of the current parity rule vs the proposed expectancy rule. Feeds `trading/docs/EVIDENCE_THRESHOLDS.md`. | read-only |

## Usage

```bash
node trading/scripts/repro/early-mfe.js
node trading/scripts/repro/fix-capture-metrics.js
node trading/scripts/repro/set-risk-sizing.js 40 80      # maxPos%, exposureCap%
node trading/scripts/repro/set-parity-gate.js false      # half size, no live tuning
node trading/scripts/repro/set-kill-tier.js off "reason"
node trading/scripts/repro/exit-policy-study.js          # counterfactual exit rules
node trading/scripts/repro/threshold-evidence.js         # the 20/10/50 evidence report
```

`early-mfe.js` selects trades by hard-coded id list (the 2026-09-11 closes). Edit
`IDS` for another set.

## Why these exist at all

Every number in the report is derived from them, and each one answered a question the
UI could not:

- **`early-mfe.js`** exists because `autopsy` stores only terminal MFE/MAE, which
  cannot distinguish "went our way at minute 5" from "went our way at minute 200".
- **`set-risk-sizing.js` / `set-parity-gate.js`** exist because the two dials that
  actually set live exposure are not the ones the UI labels as risk:
  `riskPerTradePct` is **inert** while the notional cap binds, so
  `effective risk = maxEquityPerPositionPct × stopDistance% × runInFactor`.

## Caveats

- These mutate live settings when run with write arguments. Prefer reading the
  settings first (`GET /api/trading/settings`) and be aware the trading service must
  be running.
- The service must be restarted (`temp\restart-trading.ps1`) only for **code** changes;
  settings changes here take effect immediately.
