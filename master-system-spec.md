# Master System Spec

## 1. Goal

Solarcheck is a local solar monitoring and billing-estimation system. It polls a Fronius inverter for live power flow, backfills historical archive buckets, persists the resulting time series in SQLite, and serves a dashboard plus JSON API for operational visibility.

The implemented operational outcome is ongoing visibility into PV generation, household load, grid import/export, and tariff-based cost over selectable time windows. The server is the execution owner for data acquisition and billing logic; the dashboard is a read/write client for display and settings.

## 2. System overview

Major components:

- Server runtime (Node + Express + better-sqlite3): polling, archive ingestion, persistence, aggregation, and API hosting. Source: apps/server/server.js.
- SQLite state store: readings, 5-minute energy buckets, daily aggregates, and settings. Source: apps/server/server.js.
- Dashboard (React + Vite): live metrics, history chart, billing views, rate editor, and manual backfill controls. Sources: apps/dashboard/src/pages/Dashboard.tsx and apps/dashboard/src/components/\*.tsx.
- External boundary: Fronius inverter HTTP endpoints used by polling and archive fetch. Source: apps/server/server.js.

ASCII diagram:

```text
Browser
  | (fetch /api/*)
  v
Express server (apps/server/server.js)
  |-- read/write --> SQLite (apps/server/solarcheck.db)
  |-- GET realtime/archive --> Fronius inverter API
  '-- optional static SPA hosting --> apps/dashboard/dist
```

Ownership boundaries:

- Server owns ingestion scheduling, parsing, validation, persistence, and all billing math.
- Dashboard owns presentation, user input, and API calls.
- Inverter API owns upstream payload shape/content; server normalizes but does not control that contract.

## 3. Runtime architecture

Processes/services:

- One Node process for the server (apps/server/server.js) started via apps/server/package.json.
- Optional Vite dev process for the dashboard (apps/dashboard/package.json) with proxy /api -> http://localhost:8080 (apps/dashboard/vite.config.ts).

Timers/schedulers:

- Polling scheduler: startPolling() calls pollOnce() immediately, then repeats every POLL_SECONDS.
- Automatic archive scheduler: startArchiveBackfill() calls backfillArchiveOnce() immediately, then repeats every ARCHIVE_BACKFILL_MINUTES.
- Dashboard live refresh: /api/live every 5 seconds.
- Dashboard connection heartbeat: local 1-second timer for stale/live indicator.
- Backfill status polling in UI: /api/archive/backfill/status every 2 seconds while running.

Request/response flow:

- API routes are mounted at /api (app.use('/api', api)).
- GET /health redirects (307) to /api/health.
- If apps/dashboard/dist exists, non-API paths are served from static files/SPA index; otherwise non-API paths return 503 JSON with expected index file path.

Event flow:

- Poll success -> parseFroniusPayload() -> insert reading (INSERT OR IGNORE) -> recomputeDailyAggForRange() for affected day.
- Automatic archive run -> fetchArchiveDetail() -> normalize channel data -> upsert energy_5m buckets.
- Manual backfill request -> validation -> async runManualArchiveBackfillJob() -> in-memory progress updated and queryable.

Execution ownership:

- All ingestion and billing execution runs inside the server process.
- No external queue, workflow engine, or separate worker service is present.

## 4. Core components

### 4.1 HTTP host and routing

- Purpose: expose API and optional dashboard static hosting.
- Responsibilities:
  - Mount /api routes.
  - Redirect /health to /api/health.
  - Serve static dashboard build when present.
  - Return JSON errors through a process-level Express error handler.
- Important source files:
  - apps/server/server.js
- Important invariants:
  - API is always under /api.
  - SPA serving depends on apps/dashboard/dist presence.
- Does not own:
  - Frontend build generation itself.

### 4.2 Polling and live reading normalization

- Purpose: collect near-real-time power flow.
- Responsibilities:
  - GET /solar_api/v1/GetPowerFlowRealtimeData.fcgi.
  - Enforce request timeout (8s AbortController).
  - Convert payload into canonical fields ts_utc, pv_w, load_w, grid_import_w, grid_export_w.
  - Track in-memory poll state and warnings.
- Important source files:
  - apps/server/server.js
- Important invariants:
  - Only one poll runs at a time (pollingInProgress guard).
  - load_w is normalized to absolute non-negative watts.
  - Duplicate timestamps are deduped by readings.ts_utc PK + INSERT OR IGNORE.
- Does not own:
  - Upstream inverter data quality.

### 4.3 Archive ingestion and backfill orchestration

- Purpose: populate 5-minute import/export energy data.
- Responsibilities:
  - Automatic lookback backfill scheduler.
  - Manual backfill start/status API.
  - Archive payload parsing (channel probing, normalization of absolute vs delta channels).
  - UPSERT into energy_5m by ts_utc.
  - Diagnostics state (selected channels, warnings, node/channel summaries).
- Important source files:
  - apps/server/server.js
  - apps/dashboard/src/components/BackfillPanel.tsx
  - apps/dashboard/src/api/client.ts
- Important invariants:
  - Automatic and manual runs are mutually exclusive.
  - Manual progress is process-memory state only.
  - Manual request months are validated 1..24 in buildManualArchiveBackfillRange().
- Does not own:
  - Durable backfill job history across process restarts.

### 4.4 Rates and billing engine

- Purpose: convert measured energy/power into tariff-based costs.
- Responsibilities:
  - Validate rate periods and timezone.
  - Resolve effective rate by local time/day group.
  - Compute bill summaries from readings or energy_5m.
  - Compute 5-minute interval-level cost output for energy_5m.
- Important source files:
  - apps/server/server.js
  - apps/dashboard/src/components/RatesEditor.tsx
  - apps/dashboard/src/components/BillEstimate.tsx
- Important invariants:
  - Rate arrays must be non-empty.
  - Time format is HH:mm; only end supports 24:00.
  - cents_per_kwh must be non-negative.
  - Overlap is allowed but warned; first matching period wins.
- Does not own:
  - Retailer invoice reconciliation beyond modeled fields.

### 4.5 Dashboard UI

- Purpose: operational interface for live state, history, billing, rates, and manual backfill.
- Responsibilities:
  - Render live metrics/status from /api/live.
  - Render 24-hour history chart from /api/history.
  - Render daily and interval billing from /api/bill and /api/bill-intervals.
  - Edit rates via PUT /api/rates.
  - Trigger and monitor manual backfill via /api/archive/backfill and /api/archive/backfill/status.
- Important source files:
  - apps/dashboard/src/pages/Dashboard.tsx
  - apps/dashboard/src/components/BillEstimate.tsx
  - apps/dashboard/src/components/RatesEditor.tsx
  - apps/dashboard/src/components/BackfillPanel.tsx
  - apps/dashboard/src/api/client.ts
  - apps/dashboard/src/types.ts
- Important invariants:
  - Live connection badge treats data as stale after 10 seconds without successful /api/live.
  - USE_MOCK is currently false by default.
- Does not own:
  - Persistence and server-side aggregation logic.

## 5. Contracts and data models

Authoritative executable contracts are server routes and validator/parser functions in apps/server/server.js.

Implemented API endpoints:

- GET /api/health
- GET /api/settings
- GET /api/live
- GET /api/rates
- PUT /api/rates
- GET /api/history?from=<ISO>&to=<ISO>
- GET /api/energy5m?from=<ISO>&to=<ISO>
- GET /api/energy-hourly?from=<ISO>&to=<ISO>
- GET /api/daily?from=<ISO>&to=<ISO>
- GET /api/bill?from=<ISO>&to=<ISO>&source=readings|energy_5m
- GET /api/bill-intervals?from=<ISO>&to=<ISO>&source=energy_5m
- POST /api/archive/backfill
- GET /api/archive/backfill/status
- GET /api/archive/diagnostics?from=<ISO>&to=<ISO>

Primary request contracts:

- PUT /api/rates:
  - Body must be a JSON object.
  - Supports updating any subset of: daily_fixed_cents, timezone, import_periods, export_periods.
  - daily_fixed_cents must be >= 0.
  - timezone must be valid IANA zone.
  - periods validated by validateRatePeriods().
- POST /api/archive/backfill:
  - Body must be JSON object.
  - start_month format YYYY-MM.
  - months integer 1..24.

Primary response models (as used in code):

- Live envelope:
  - No reading yet: { data: null, message, data_warning, explanation }.
  - Reading present: { data: { ...reading + derived values + cost/hour }, data_warning, explanation }.
- History response: { from, to, count, data: readings[] }.
- Energy 5-minute response: { from, to, count, data: { ts_utc, import_kwh, export_kwh }[] }.
- Bill response: { summary, days, source }.
- Bill interval response: { summary, intervals, source: 'energy_5m', archive_warnings }.
- Manual backfill status response: { running, started_at_utc, completed_at_utc, last_error, range, progress }.

Canonical domain fields:

- Reading fields: ts_utc, pv_w, load_w, grid_import_w, grid_export_w.
- Derived reading fields: grid_net_w, self_consumed_w.
- Identity fields: ts_utc for readings/energy_5m; day/day_local for daily groupings.

Supported versions:

- No API versioning layer exists (no versioned route prefix or version negotiation).

Canonical contract vs metadata summary:

- Canonical executable behavior is in apps/server/server.js.
- apps/dashboard/src/types.ts is consumer-side typing and may lag server behavior.

## 6. State, persistence, and reconciliation

Persistence/state stores:

- SQLite file at apps/server/solarcheck.db.
- SQLite pragmas at init: journal_mode=WAL, synchronous=NORMAL.
- In-memory server state object for health, warnings, archive diagnostics, and manual job progress.

Persisted entities:

- readings(ts_utc TEXT PK, pv_w, load_w, grid_import_w, grid_export_w)
- energy_5m(ts_utc TEXT PK, import_wh REAL, export_wh REAL)
- daily_agg(day TEXT PK, pv_kwh, load_kwh, import_kwh, export_kwh, self_kwh)
- settings(key TEXT PK, value TEXT JSON)

Lifecycle tracking:

- Poll fields: lastPollAtUtc, lastSuccessAtUtc, lastError, lastReadingTsUtc, pollingInProgress.
- Archive fields: lastArchiveBackfillAtUtc, lastArchiveBackfillSuccessAtUtc, lastArchiveBackfillError, archiveBackfillInProgress.
- Manual backfill fields: running, startedAtUtc, completedAtUtc, lastError, range, progress counters.

Reconciliation behavior:

- Polling dedupe: INSERT OR IGNORE on readings.ts_utc.
- Archive dedupe/update: UPSERT on energy_5m.ts_utc.
- Billing source selection in /api/bill:
  - explicit source=readings or source=energy_5m respected.
  - otherwise readings are preferred when at least two rows exist.
  - energy_5m used as fallback when available.
- daily_agg is recomputed after new reading insert but /api/daily currently computes from readings in-range and does not read daily_agg.

Key join/identity fields:

- ts_utc is the cross-cutting identity for time-series joins.
- Local day keys are derived from ts_utc + timezone in billing paths.

## 7. Execution and safety model

Execution model:

- Ingestion and backfill run as in-process async jobs, scheduled with setInterval.
- Manual backfill runs asynchronously after API acceptance and reports status from memory.

Schema/contract validation layers:

- Startup validation for required/positive integer env vars.
- Request validation:
  - parseRange() validates date parsing and ordering.
  - validateRatePeriods() validates period structure/times/rates/day group.
  - buildManualArchiveBackfillRange() validates start_month/months and no future start.

Runtime safety guardrails:

- Concurrency guards prevent overlapping poll runs and overlapping automatic/manual archive runs.
- Outbound HTTP timeouts: realtime 8s, archive 15s.
- Numeric sanitization uses safeNumber() and non-negative clamps.
- Data warnings are emitted for suspicious combinations (for example simultaneous import/export > 0).

Idempotency/retries/dedupe:

- Idempotency and dedupe rely on timestamp PKs plus INSERT OR IGNORE / UPSERT.
- No explicit retry-with-backoff loop exists; next scheduler interval acts as retry.

Failure handling:

- Poll/backfill errors are logged and stored in state fields; process continues.
- API returns:
  - 400 for validation/contract errors.
  - 409 for busy backfill conflicts.
  - 500 for uncaught route errors via Express error middleware.

Compatibility and defaults:

- ensureDefaultSettings() seeds default timezone and default import/export period schedules.
- /api/bill includes source fallback logic for mixed data availability.

## 8. Configuration

Environment variables used by server:

- INVERTER_BASE_URL (required).
- POLL_SECONDS (default 15).
- PORT (default 8080).
- ARCHIVE_BACKFILL_MINUTES (default 30).
- ARCHIVE_LOOKBACK_DAYS (default 2).
- MANUAL_ARCHIVE_MAX_MONTHS (default 24, validated at startup).
- MANUAL_ARCHIVE_CHUNK_DAYS (default 2).
- ARCHIVE_DEBUG_LOG (default enabled unless set to 0).

Persisted configurable settings (settings table):

- daily_fixed_cents
- timezone
- import_periods_json
- export_periods_json

Frontend configuration inputs:

- USE_MOCK flag in apps/dashboard/src/api/client.ts (currently false).
- Vite dev proxy for /api in apps/dashboard/vite.config.ts.

## 9. Observability

Implemented operator visibility:

- Console logs for startup, poll lifecycle, parsed payload data, insert/upsert outcomes, archive diagnostics, and errors.
- Health and status endpoints:
  - /api/health
  - /api/settings
  - /api/archive/backfill/status
  - /api/archive/diagnostics

Diagnostic artifacts:

- archiveDiagnostics in memory tracks selected channels, available channels, node summaries, and warnings from archive parsing.

Missing observability layers:

- Metrics backend: UNKNOWN (not implemented in repo).
- Distributed tracing and correlation IDs: UNKNOWN (not implemented in repo).
- Persistent audit event stream: UNKNOWN (not implemented in repo).

## 10. Validation and workflows

Build/run/lint commands present:

- Root package.json:
  - npm start
  - npm dev
- apps/server/package.json:
  - npm run start
- apps/dashboard/package.json:
  - npm run dev
  - npm run build
  - npm run preview
  - npm run lint

Automated tests and fixtures:

- No test/spec files were found in the repository.
- No fixture-generation scripts were found.

CI/CD workflows:

- No .github/workflows files were found.
- Authoritative validation in this repo is local command execution and runtime behavior checks.

## 11. Setup and operation

Practical setup from repository evidence:

1. Install dependencies from repository root (workspace-based npm install).
2. Ensure apps/server/.env defines INVERTER_BASE_URL (required by startup guard).
3. Start server from root (npm start) or directly in apps/server (npm run start).
4. Optional dashboard dev mode:
   - run apps/dashboard npm run dev.
   - Vite serves the UI and proxies /api to localhost:8080.
5. Optional single-service UI hosting:
   - run apps/dashboard npm run build.
   - run server; it serves apps/dashboard/dist when present.

Operational behavior:

- Server binds 0.0.0.0:PORT.
- If dashboard dist is absent, API still operates and non-API paths return 503 with expected build path.

## 12. Known gaps or intentional limitations

- No automated tests are present.
- No CI workflow files are present.
- API is unversioned.
- API authentication/authorization is not implemented.
- MANUAL_ARCHIVE_MAX_MONTHS is validated at startup but manual request validation currently uses a hard-coded upper bound of 24 in buildManualArchiveBackfillRange().
- daily_agg is maintained but not used by /api/daily.
- Manual backfill status/progress is in-memory and is lost on process restart.
- apps/dashboard/README.md states USE_MOCK default true, but apps/dashboard/src/api/client.ts sets USE_MOCK = false.

## 13. Source-of-truth evidence

Runtime and API behavior:

- apps/server/server.js
- apps/server/package.json

Frontend behavior and API consumption:

- apps/dashboard/src/main.tsx
- apps/dashboard/src/App.tsx
- apps/dashboard/src/pages/Dashboard.tsx
- apps/dashboard/src/api/client.ts
- apps/dashboard/src/types.ts
- apps/dashboard/src/components/BillEstimate.tsx
- apps/dashboard/src/components/RatesEditor.tsx
- apps/dashboard/src/components/BackfillPanel.tsx
- apps/dashboard/src/components/HistoryChart.tsx
- apps/dashboard/src/components/EnergyChart.tsx
- apps/dashboard/src/components/MetricCard.tsx
- apps/dashboard/src/components/StatusBadge.tsx
- apps/dashboard/src/utils/format.ts

Build and configuration:

- package.json
- apps/dashboard/package.json
- apps/dashboard/vite.config.ts
- apps/dashboard/tsconfig.json
- apps/dashboard/index.html
- apps/dashboard/src/index.css
- .gitignore

Documentation:

- apps/dashboard/README.md
- master-system-spec.md (previous revision, reconciled against code)

## Appendix: spec generation notes

- Existing docs/specs reused:
  - apps/dashboard/README.md for local run/dev descriptions and intended dashboard behavior.
  - Prior master-system-spec.md structure as a template, with behavior revalidated against code.
- Existing docs/specs outdated or conflicting:
  - apps/dashboard/README.md claims mock mode default is true; code sets USE_MOCK = false.
  - Prior master-system-spec.md omitted /api/bill-intervals and /api/archive/diagnostics from endpoint inventory.
- Areas marked UNKNOWN because repo evidence was insufficient:
  - Production deployment topology beyond local scripts.
  - External monitoring/alerting stack.
  - Trace/correlation ID strategy.
  - Formal API compatibility governance process.
