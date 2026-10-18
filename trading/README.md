# Trading Agent (OSWALD · policy 52)

A separate service in the OSWALD monorepo that automates **Plus500 WebTrader (demo)** with a
deterministic quant/risk engine and a single DeepSeek LLM "chair". It never holds API keys for
real money and refuses to act unless the venue is confirmed demo.

```
trading/                     service root (HTTPS :8114 + health :8115)
  server.js                  Express boot, login proxy, self-check (migrations 024-032 required)
  routes.js                  REST API (/api/trading/*)
  store.js                   SQL Server access (TradingSettings, TradingEvents, TradingPrompts,
                             Trades, PaperTrades, PriceTicks, PriceBars, BacktestRuns, CorporateEvents,
                             TradingAlerts, QuarantinedTicks, EquitySnapshots)
  store/                     typed repos: ticks.js (quarantine), bars.js (flagged-bar rebuild)
  auth.js / config.js        shared JWT auth + live config (config.json + env overrides)
  lib/                       http helpers, Telegram pager, human-like pacing
  plus500/                   the bridge (Chrome CDP :9224, persistent profile .chrome-profile)
    browser.js               spawn/attach real Chrome, chromeAlive()
    webtrader.js             page objects: tables, search, placeOrder, closePosition, href-map
    capture.js               SEARCH-BAR price capture (lands once, searches per symbol, burst re-reads)
    health.js                A1 selector health gate + UI fallback pause
  connector/                 TRD-12 venue abstraction (quotes/orders/positions/account/session)
    browser.js / paper.js / fake.js   Chrome bridge, paper broker, test double
  agent/                     the brain (deterministic, no LLM except chair/digest/whitepaper)
    waker.js                 wake loop: schedule/alert/manual triggers (soft pause via wake.paused)
    wakePipeline.js          step-timed wake orchestration (session->capture->floor->bars->providers
                             ->quant->risk->telemetry->deliberate->execute; GET /pipeline mirror)
    quant.js / risk.js       Turtle Ultimate signals + indicator snapshot + deterministic risk gate
                             (exposure cap, daily-loss halt, trailing HWM, take-profit exits)
    chair.js / deepseek.js   LLM chairs (1-3, weighted) + fail-secure adapter
    aggregator.js            bundles telemetry, weighted deliberation (panel + chairs), executes decisions
    executor.js              order open/close/reconcile + circuit breaker
    killswitch.js            off | soft | hard (disaster floor + autoClose + Telegram paging)
    watchdog.js              TRD-8 zombie watchdog (login-death + waker-stale Telegram paging)
    providers.js             Binance/OKX/Yahoo public market data + kline backfill (TRD-5/TRD-9)
      providers/yahoo.js     Yahoo chart API: quotes + 15m/1h/1d bars, incremental backfill
    backtest.js / bars.js    Turtle backtester (walk-forward + buy-and-hold benchmark) + bar maintenance
    paper.js                 sim broker (spread/slippage/swap, calendar nights, 3xATR take-profit)
    whitepaper.js            yearly/monthly/weekly market white paper (reasoner + chat fallback)
    budget.js                daily LLM token budget (per-consumer caps, Telegram warn)
    autopsy.js               post-trade autopsy (MFE/MAE/holding/slippage + LLM write-up)
    analytics.js             equity curve, per-strategy stats, drift vs backtest
    divergence.js            sim-vs-demo P&L divergence monitor (Telegram once/day)
    context.js               shared position/desk/central context builders
  scripts/                   browser-probe, discover-instruments, smoke.js
  public/                    dashboard UI (dark, Chart.js 4.4.1 CDN)
```

## Run

```powershell
cd trading; node server.js            # HTTPS on :8114 (cert from fileserver/certs)
# or from the OSWALD dashboard -> Services -> Trading Agent (Start / Auto-start toggle)
node scripts/smoke.js                 # offline smoke suite (isolated ports, no browser)
```

Env (`trading/.env` or root `.env`): `JWT_SECRET` (shared with dashboard), `DEEPSEEK_API_KEY`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, optional `TRADING_PORT`, `TRADING_TLS=0`, `TRADING_STUB_LLM=1`.
`TRADING_SMOKE=1` boots the service without the wake loop/watchdog (tests only).

## Safety model (demo-only, fail-closed)

| Gate | Behavior |
|---|---|
| Demo guard | Every action re-checks "Switch to Real Money" is visible; if not, order refused |
| Kill switch | `off` → `soft` (no new entries) → `hard` (no entries + auto-close all) |
| Disaster floor | Equity drawdown vs `risk.initialEquity` past `kill.disasterFloorPct` auto-trips HARD |
| Circuit breaker | 5 rejected orders / 30 min → soft kill |
| Caps | `risk.maxPositions`, `risk.maxNewTradesPerDay` (phantom rows excluded) |
| Health gate (A1) | 3 consecutive selector/connection failures → UI fallback pause (no new entries) |
| Watchdog (TRD-8) | Detects Plus500 login-death + stuck wake loop; pages via Telegram (human-readable) |

## API (auth: dashboard JWT; `services.manage`/`tasks.manage` perms)

| Route | Purpose |
|---|---|
| `GET /api/trading/ping` | SQL + DeepSeek + browser self-check |
| `POST /api/trading/login` | Dashboard login proxy (sets `oswald_trading_token`) |
| `GET/PUT /api/trading/settings` | Live settings (deep-merged with defaults) |
| `POST /api/trading/wake` | Manual wake; `GET /status` waker + watchdog state |
| `POST /api/trading/wake/pause` | TRD-9 H soft pause: scheduled wakes stop, manual wakes still work |
| `GET/POST /api/trading/kill` | Kill switch tier (manual `alert:false` suppresses Telegram) |
| `POST /api/trading/orders/open|close`, `/reconcile`, `/monitor` | Execution (demo) |
| `POST /api/trading/capture`, `GET /bridge` | Search-bar price capture + bridge state |
| `GET /api/trading/watchlist`, `POST .../toggle|confirm|discover|open` | Curated watchlist |
| `GET /api/trading/bars`, `POST /bars/build` | Price bars (15m/1h/4h/1d) |
| `POST /api/trading/providers/snapshot|backfill`, `GET /providers/status` | Binance/OKX/Yahoo |
| `POST /api/trading/providers/backfill-all`, `GET /providers/coverage` | Bulk download + bar coverage (TRD-9) |
| `POST /api/trading/backtest`, `GET /backtests` | Turtle backtester (walk-forward + buy-and-hold benchmark) |
| `GET /api/trading/trades|prompts|wakes|events|alerts|digest` | Ledgers |
| `GET /api/trading/watchdog`, `POST /watchdog/run` | Watchdog status / run now |
| `GET /api/trading/calendar`, `POST /calendar/import` | Economic calendar halts |
| `GET /api/trading/pipeline` | TRD-12 wake step timeline (live + last run) |
| `GET /api/trading/quarantine`, `POST /bars/rebuild` | Bad-tick audit + flagged-bar rebuild |
| `GET /api/trading/equity`, `GET /analytics/strategies` | Equity curve + per-strategy stats/drift |
| `GET /api/trading/equity/live` | Live equity strip history (kind 'account' rows, ≥30s) — the fine-grained chart series |
| `POST /api/trading/autopsy/backfill` | Backfill autopsy metrics on closed trades |
| `GET /api/trading/whitepaper`, `POST /whitepaper/generate` | Market white paper tiers |
| `POST /api/trading/alternatives`, `GET /alternatives` | Alternative-proxy agent: correlated tradable suggestions for an unevaluable symbol + scoped pulse on the best |
| `GET/PUT /api/trading/budget` | Daily LLM token budget (usage, caps, boost) |
| `GET /api/trading/bridge/hrefmap`, `GET /divergence` | Link map + sim-vs-demo divergence |

## Ops notes

- **Editing the dashboard (`trading/public/**`) — the required check.** ESLint ignores `public/**`, and
  `node --check trading/public/js/app.js` **lies**: it parses the file as CommonJS and passes on broken ESM.
  The reliable check is a `.mjs` copy:
  ```
  Copy-Item trading\public\js\app.js temp\app-check.mjs -Force; node --check temp\app-check.mjs
  ```
  A single bad character in that file blinds the whole dashboard — the page still loads, no JS runs, and
  every panel shows `—`, which reads like a sick desk rather than a broken file. Two traps that have each
  cost a live outage: a `//` comment containing **backticks** inside a template literal (it terminates the
  template), and a misplaced brace that silently nests one function inside another.
- **Deliberation (TRD-9 H)**: `settings.deliberation` = quant panel (turtle/adx/rsi voters,
  weighted) + 1-3 LLM chairs (id/model/temperature/weight). Weights normalize per group;
  groups split the verdict 50/50. Chair transport/parse failures ABSTAIN (never read as "no");
  if every chair is offline, entries are blocked (fail-secure) and exits fall back to the panel.
  Exception (deliberation.chairDegraded): chairs offline due to BUDGET CAP only
  -> quant-only entry at a reduced size (default 50%), flagged in the decision.
  Empty chairs array = pure-quant mode. Dashboard Deliberation tab edits the config.
- **Chart bars**: every capture banks the venue's own chart series (ChartIQ masterData,
  venue `plus500_chart`, up to ~1000 bars at the chart's current timeframe; odd intervals
  like 30m aggregate into 1h). The chair bundle includes Bollinger/RSI/MACD/Stoch/SMA from
  stored 1h bars.
- **Data providers (TRD-9)**: `binance`/`okx` (crypto spot) + `yahoo` (crypto USD pairs,
  futures proxies for commodities, SG `.SI` / HK `.HK` equities — covers ~88 of the 94
  Plus500 universe instruments; SHEIN/Seatrium/Crypto 10 Index etc. stay Plus500-only).
  Yahoo = mid price only (no bid/ask), unofficial endpoint: 300ms pacing, backoff on 429,
  incremental pulls (never re-downloads stored history). Span limits (empirical): 15m ≤ 59d,
  1h ≤ 729d, 1d ≤ 20y. 4h bars are aggregated from 1h (no native Yahoo 4h).
- **Backtest ranges**: `1w / 1m / 1y / all` with a refresh-data toggle (on = re-pull latest
  window first, off = frozen "set in stone" runs on stored bars). A consistency panel
  compares P&L across repeated runs of the same symbol/venue/timeframe.
- **Bridge Chrome**: dedicated real Chrome on debug port 9224, profile `trading/.chrome-profile`.
  Never close it while the agent runs — the watchdog will page you on login-death.
- **Telegram paging**: kill trips, Plus500 sign-outs and stuck-loop alerts are sent as plain
  sentences (what happened / why / what to do). Creds in `.env`; absent creds = silent no-op.
- **DeepSeek**: JSON mode requires the word "json" in the prompt. HTTP 402 = API balance empty
  (account issue, not a bug); the agent fails safe to `decision none`.
- **Capture**: search-bar based. The full category sweep runs only when the universe is empty,
  a search misses, or `capture.universeRefreshHours` (default 24) elapsed.
- **Smoke**: `node trading/scripts/smoke.js` — boots the service on isolated ports with
  `TRADING_SMOKE=1` (no wake loop, no watchdog, no browser, no Telegram) and checks the API
  surface. `npm test` at the repo root runs dashboard smoke + fileserver smoke + trading smoke.
- **Signal engine (implied goal, 2026-09-10)**: signals run on the **1h bar series**
  (yahoo -> binance -> okx -> plus500_chart -> plus500) — the same data the backtester
  consumes, so live/backtest parity is real. Tick mids are used only for the latest
  executable price and stop/take-profit checks. Staleness = 4h (1h bar cadence).
- **Chairs skip when flat**: no proposal + no agent positions = deterministic flat with
  zero LLM tokens. Chairs still deliberate when positions are open.
- **Re-entry cooldown**: `risk.reentryCooldownBars` (default 6h) blocks re-entering the
  same symbol/direction after a close (whipsaw protection).
- **Micro-wakes**: `wake.microWake` — when price drifts within 25% of the remaining
  stop/TP distance, a fast wake (no capture) fires; 2-min minimum gap.
- **Mean reversion**: `meanrev` strategy (RSI+Bollinger fade, exits at mid-band) votes
  only when the meta regime is `range`; half turtle risk. Enable via
  `strategies.enabled`.
- **Run-in factor + parity harness**: `learning.parityValidated=false` halves position
  risk until the weekly parity check (>=10 closed trades; negative expectancy or >20pp
  win-rate lag vs backtest retires the strategy with a Telegram page).
- **Data quality (TRD-12)**: every stored tick is validated (non-finite/non-positive, ask<bid,
  spread >20%, 12x-MAD jumps); rejects land in `QuarantinedTicks` with a reason. Structurally
  invalid bars are `flagged=1`, skipped by quant/backtest, and removable via `/bars/rebuild`.
- **Learning loop (TRD-12)**: closed trades get autopsy metrics (MFE/MAE, holding time,
  slippage) + an LLM write-up on 3%+ losers; `/analytics/strategies` compares live win rate
  vs the newest backtest and flags drift. Equity snapshots (demo + sim) feed the curve card
  and the trailing high-water baseline; a daily-loss halt (default 3%) blocks new entries.
- **Budget (TRD-12)**: LLM spend is capped per consumer (chair/central/review/pulse/digest/
  whitepaper/ask/autopsy) and daily total; 80% triggers a once-a-day Telegram warn and capped
  consumers fail secure (abstain/decline).
- **White paper (TRD-12)**: yearly/monthly/weekly market-state sections written from desk
  facts by deepseek-reasoner (chat fallback when the reasoner returns empty); injected into
  chair/review/central contexts and refreshed on black-swan events (10% daily gaps, halts).
- **Sim desk (TRD-12)**: paper broker charges spread + slippage + per-calendar-night swap;
  entries carry a 3xATR take-profit enforced by the wake (mirrors the demo desk); the
  sim-vs-demo divergence monitor pages Telegram on >1% same-day drift.
- **Alternative-proxy agent (2026-09-11)**: when a watched instrument cannot be evaluated (insufficient/stale data, venue-only), the desk proposes correlated ALTERNATIVES from the provider-mapped Plus500 universe — scored by log-return correlation over stored bars (1d, 1h fallback), filtered to what it can actually evaluate, with one deep 90-day pull for the best pick if its hourly series is short — then creates a scoped PULSE on that alternative so there is immediate context. Triggers: automatically from the wake pipeline (first `insufficient_data` scout) and the discoverer (unviable AI symbols, before eviction), or manually via the route. Deduped per target (12h); logged as an `alternatives` event (`POST /api/trading/alternatives {symbol, pulse?, force?}`).
- **Href map (TRD-12 partial)**: each dynamic capture discovers the app's live anchor map
  (`settings.bridge.hrefMap`, GET `/bridge/hrefmap`) — groundwork for link-first navigation.
- **AI watchlist discoverer (2026-09-10)**: every `discover.intervalHours` (12h) the desk
  ranks feeds it already consumes (multi-factor, congress, pulse) and probes Plus500 for
  each candidate, auto-adding matches tagged `source:'ai'` (max `discover.maxAiSymbols`,
  oldest-first eviction, manual entries never touched). Two rails keep it honest:
  the multi-TF backfill pulls a **90-day 1h window** (exchange-hours instruments need
  ~7h/day of history to clear `quant.MIN_BARS`=30 — the old 3-day window left HK/SGX
  equities stuck at "flat · insufficient data" forever), and a **viability gate**
  (grace 12h) evicts any aged AI symbol that still cannot reach 30 hourly bars from any
  venue. Skip conditions: kill HARD, bridge paused, paper mode.
