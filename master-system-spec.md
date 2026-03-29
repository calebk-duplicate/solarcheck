# Master System Spec

## 1. Goal

This system collects near-real-time solar inverter power-flow data, stores it locally, and exposes API endpoints plus a dashboard UI for monitoring energy flow and estimating electricity cost. The implemented outcome is operational visibility into PV generation, household load, grid import/export, and bill impact over selectable time windows.

Today, the system is a single deployable Node.js service that both ingests inverter data and serves API + static frontend assets, plus a React dashboard that can run separately in Vite dev mode. The primary operational objective is to keep local, queryable time-series data current while supporting tariff-aware summaries and backfill of archive energy buckets.

## 2. System overview

Major components:

- Server runtime (Express + SQLite): polling, archive backfill, persistence, aggregation, API surface, optional SPA static hosting. Source: apps/server/server.js.
- Local SQLite database: readings, 5-minute energy buckets, daily aggregates, and settings. Source: apps/server/server.js.
- Dashboard frontend (React/Vite): calls server APIs, renders live status, history chart, bill estimate, rates editor, and archive backfill controls. Sources: apps/dashboard/src/pages/Dashboard.tsx, apps/dashboard/src/api/client.ts.
- Inverter boundary (external): Fronius HTTP endpoints queried by server polling/backfill. Source: apps/server/server.js.

ASCII interaction diagram:

```text
[Fronius Inverter API]
   |  (GET realtime + archive)
   v
[Node/Express Service: apps/server/server.js]
   |-- writes/reads --> [SQLite: solarcheck.db]
   |-- serves /api/* --> [Dashboard UI]
   '-- serves static dist (if built) --> [Browser]
```

Ownership boundaries:

- Server owns acquisition, persistence, aggregation, validation of incoming requests, and API responses.
- Frontend owns presentation, periodic fetches, and client-side form validation/UX.
- Inverter owns raw telemetry/archive payload semantics (server parses/normalizes but does not control source contract).

## 3. Runtime architecture

Processes/services:

- Single Node.js process for server (`node apps/server/server.js`) with Express router under /api. Source: apps/server/package.json, apps/server/server.js.
- Optional Vite dev server for frontend (`npm run dev` in apps/dashboard) with /api proxy to localhost:8080. Source: apps/dashboard/package.json, apps/dashboard/vite.config.ts.

Timers/schedulers:

- Live poll scheduler: immediate poll + recurring setInterval every POLL_SECONDS seconds. Source: apps/server/server.js (startPolling, pollOnce).
- Automatic archive backfill scheduler: immediate run + recurring setInterval every ARCHIVE_BACKFILL_MINUTES minutes. Source: apps/server/server.js (startArchiveBackfill, backfillArchiveOnce).
- Frontend live refresh: fetch /api/live every 5 seconds; connectivity heartbeat every 1 second. Source: apps/dashboard/src/pages/Dashboard.tsx.
- Frontend manual-backfill status polling: fetch /api/archive/backfill/status every 2 seconds while running. Source: apps/dashboard/src/components/BackfillPanel.tsx.

Request/response flow:

- Browser calls server /api endpoints via same-origin fetch in production or Vite proxy in dev. Source: apps/dashboard/src/api/client.ts, apps/dashboard/vite.config.ts.
- Server returns JSON for all API routes and basic error envelopes for invalid requests/internal errors. Source: apps/server/server.js.

Event flow:

- Poll success -> parsed reading -> INSERT OR IGNORE into readings -> per-day aggregate recompute for affected day.
- Archive backfill success -> upsert energy_5m buckets.
- Manual backfill request -> async background job updates in-memory progress state, queryable via status endpoint.

Execution ownership:

- Polling/backfill execution is server-owned and in-process only (no external job runner).
- UI does not execute domain calculations except display/selection helpers; billing math is server-owned.

## 4. Core components

### 4.1 API and application host

- Purpose: expose operational API and optionally serve dashboard static assets.
- Responsibilities:
  - Mount /api routes.
  - Redirect /health to /api/health.
  - Serve dashboard dist folder when present; otherwise non-API paths return 503 JSON.
  - Global JSON 500 handler.
- Important files:
  - apps/server/server.js
- Important invariants:
  - API always mounted at /api.
  - Non-API route behavior depends on dashboard build presence.
- Not owned:
  - Frontend build pipeline internals.

### 4.2 Polling + Fronius parsing

- Purpose: ingest live power-flow snapshots.
- Responsibilities:
  - Call GetPowerFlowRealtimeData.fcgi with timeout.
  - Parse payload into canonical ts_utc, pv_w, load_w, grid_import_w, grid_export_w.
  - Track poll state (last success/error/timestamps), warning heuristics.
- Important files:
  - apps/server/server.js
- Important invariants:
  - Only one poll run at a time (pollingInProgress guard).
  - load_w normalized to non-negative absolute value.
  - Duplicate ts_utc readings are ignored by DB PK + INSERT OR IGNORE.
- Not owned:
  - Upstream inverter firmware/API correctness.

### 4.3 Archive backfill (automatic + manual)

- Purpose: ingest historical 5-minute import/export energy buckets.
- Responsibilities:
  - Scheduled lookback backfill over recent days.
  - Manual month-range backfill job triggered via API.
  - Parse archive detail payload and upsert energy_5m.
  - Expose manual job status/progress.
- Important files:
  - apps/server/server.js
  - apps/dashboard/src/components/BackfillPanel.tsx
  - apps/dashboard/src/api/client.ts
- Important invariants:
  - Automatic and manual backfill do not run concurrently.
  - Manual job runs asynchronously in process and reports progress via memory state.
  - Bucket upsert keyed by ts_utc.
- Not owned:
  - Durable job queue/history beyond current in-memory status.

### 4.4 Billing/rates engine

- Purpose: apply tariff periods and fixed daily charges to estimate costs.
- Responsibilities:
  - Validate tariff schedules/timezone.
  - Resolve applicable import/export rates by local day group/time.
  - Aggregate bill from energy_5m when available, fallback to readings.
- Important files:
  - apps/server/server.js
  - apps/dashboard/src/components/RatesEditor.tsx
- Important invariants:
  - Rate periods must be non-empty arrays; end > start; cents_per_kwh >= 0.
  - Timezone must be valid IANA zone.
  - If overlapping periods exist, server logs warning and first matching period is used.
- Not owned:
  - Utility billing true-up beyond modeled rates/charges.

### 4.5 Dashboard UI

- Purpose: render operational view and controls for rates/backfill.
- Responsibilities:
  - Show live metrics/status/error/connectivity.
  - Show 24-hour history and daily summary.
  - Show bill estimate by date presets/custom range.
  - Submit rates updates and manual backfill trigger.
- Important files:
  - apps/dashboard/src/pages/Dashboard.tsx
  - apps/dashboard/src/components/\*.tsx
  - apps/dashboard/src/api/client.ts
  - apps/dashboard/src/types.ts
- Important invariants:
  - Live connectivity indicator considers data stale after 10 seconds without successful live fetch.
  - Frontend defaults to real API mode (USE_MOCK = false).
- Not owned:
  - Data persistence and cost computation logic.

## 5. Contracts and data models

Implemented API endpoints (all in apps/server/server.js):

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
- POST /api/archive/backfill
- GET /api/archive/backfill/status

Canonical DTOs used by frontend (apps/dashboard/src/types.ts):

- LiveResponse: ts_utc, pv_w, load_w, grid_import_w, grid_export_w, grid_net_w, self_consumed_w, optional explanation.
- HistoryPoint/HistoryResponse: time-series power points.
- DailyResponse: day-level kWh values plus optional cost fields.
- RatesResponse with RatePeriod[]: daily_fixed_cents, timezone, import/export period arrays.
- BillResponse: summary totals + per-day rows.
- Energy5mResponse: from/to/count/data where data items include ts_utc, import_wh, export_wh.

Request body contracts:

- PUT /api/rates accepts partial/object fields among:
  - daily_fixed_cents (number >= 0)
  - timezone (valid IANA timezone string)
  - import_periods/export_periods (validated period arrays)
- POST /api/archive/backfill expects:
  - start_month: YYYY-MM
  - months: integer 1..24 (current hard-coded validation bound)

Validation rules grounded in code:

- parseRange validates from/to parseable and from <= to.
- validateRatePeriods validates object shape, days enum (all|weekday|weekend), time format HH:mm (24:00 allowed for end only), non-empty arrays, and non-negative cents.
- Rate overlap is not rejected; warning only.
- Body for PUT /rates and POST /archive/backfill must be JSON object.

Versioning:

- No explicit API versioning is implemented (no /v1 path, no version header contract).

Canonical executable contract vs metadata:

- Executable contract is the server route code and parser/validator functions in apps/server/server.js.
- Frontend TypeScript interfaces in apps/dashboard/src/types.ts summarize expected payload shapes but do not enforce server behavior at runtime.

Identifiers/targeting rules:

- Primary time identity keys are ts_utc (ISO string) for readings and energy_5m, and day/day_local for aggregates.
- Query targeting for most endpoints is time-range based via from/to ISO timestamps.

## 6. State, persistence, and reconciliation

State stores:

- SQLite file apps/server/solarcheck.db (WAL mode).
- In-memory process state object for poll/backfill health and manual backfill progress.

Tables/entities (apps/server/server.js):

- readings(ts_utc PK, pv_w, load_w, grid_import_w, grid_export_w)
- energy_5m(ts_utc PK, import_wh, export_wh)
- daily_agg(day PK, pv_kwh, load_kwh, import_kwh, export_kwh, self_kwh)
- settings(key PK, value JSON string)

Lifecycle/state tracking:

- Poll lifecycle fields: lastPollAtUtc, lastSuccessAtUtc, lastError, lastReadingTsUtc, pollingInProgress.
- Archive lifecycle fields: lastArchiveBackfillAtUtc, lastArchiveBackfillSuccessAtUtc, lastArchiveBackfillError, archiveBackfillInProgress.
- Manual backfill lifecycle: running, started/completed timestamps, lastError, range, progress counters.

Reconciliation behavior:

- Reading dedupe: INSERT OR IGNORE by ts_utc prevents duplicate poll insertions.
- energy_5m reconciliation: UPSERT by ts_utc updates existing bucket values.
- Bill reconciliation path: /api/bill prefers energy_5m if available, otherwise computes from readings; caller can force source via query param.
- Daily reconciliation:
  - /api/daily computes directly from readings in request range.
  - daily_agg table is recomputed for day(s) on new reading insert but is not used by /api/daily.

Key join/identity fields:

- ts_utc links live/history data and energy bucket timelines.
- Local-day keys (day/day_local) are derived for daily summaries and billing grouping.

## 7. Execution and safety model

Action execution:

- Poll and archive backfill execute as in-process async tasks on intervals.
- Manual archive backfill executes asynchronously after API trigger and returns 202 immediately.

Guardrails and runtime safety checks:

- Startup guards: required INVERTER_BASE_URL; numeric envs must be positive integers.
- Concurrency guards:
  - pollingInProgress prevents overlapping polls.
  - archiveBackfillInProgress + manualArchiveBackfill.running prevent overlapping auto/manual backfills.
- External call timeouts:
  - Realtime poll request aborts after 8s.
  - Archive request aborts after 15s.

Schema/contract validation vs runtime safety:

- Contract validation:
  - Request body shape and query range checks.
  - Rates and timezone validation.
  - Archive manual range validation.
- Runtime safety:
  - Defensive numeric parsing/sanitization (safeNumber, Math.max clamps).
  - Warning generation for suspicious live data combinations.
  - Error capture into in-memory state + API/console visibility.

Idempotency/dedupe/retries:

- Idempotency via DB keys and insert/upsert semantics on timestamp keys.
- No explicit retry loop/backoff is implemented for failed inverter calls; next interval run is the retry opportunity.

Failure handling:

- Poll/backfill failures update state.lastError fields and log errors; service continues running.
- API errors return 400 for validation/contract issues, 409 for backfill busy conflicts, 500 for uncaught route errors.

Compatibility/rollout-safe defaults:

- Settings defaults are seeded in DB on first run (daily fixed cents, timezone, default import/export periods).
- /api/bill source fallback behavior is compatibility-oriented (energy_5m preferred when present).

## 8. Configuration

Environment variables read by server (apps/server/server.js):

- INVERTER_BASE_URL (required): base URL for Fronius API (trailing slash stripped).
- POLL_SECONDS (default 15): live poll interval seconds.
- PORT (default 8080): bind port.
- ARCHIVE_BACKFILL_MINUTES (default 30): automatic archive backfill interval.
- ARCHIVE_LOOKBACK_DAYS (default 2): automatic archive lookback window.
- MANUAL_ARCHIVE_MAX_MONTHS (default 24): parsed and validated at startup.
- MANUAL_ARCHIVE_CHUNK_DAYS (default 2): manual backfill chunk size.

Persisted runtime settings (SQLite settings table):

- daily_fixed_cents
- timezone
- import_periods_json
- export_periods_json

Frontend runtime toggle:

- USE_MOCK constant in apps/dashboard/src/api/client.ts (currently false).

Dev proxy config:

- Vite proxies /api to http://localhost:8080 in apps/dashboard/vite.config.ts.

## 9. Observability

Logs:

- Server logs startup, polling start/parsing/results, duplicate insert skips, archive backfill outcomes, and parse failures.
- Manual archive logs chunk progress including upserts and duration.

Health/diagnostics endpoints:

- /api/health returns uptime and last poll/archive status fields.
- /api/settings includes archive backfill last attempt/success/error and in_progress flags.
- /api/archive/backfill/status provides manual job progress counters and timestamps.

Metrics/tracing/audit:

- No metrics backend, tracing IDs, or persistent audit log pipeline is implemented.
- Correlation IDs are UNKNOWN (not present in current code).

Replay artifacts:

- Historical replay is possible by querying persisted readings/energy_5m time ranges.

## 10. Validation and workflows

Build/test commands present:

- Root scripts:
  - npm start -> runs apps/server start
  - npm dev -> runs apps/server start
  - Source: package.json
- Dashboard scripts:
  - npm run dev, npm run build, npm run preview, npm run lint
  - Source: apps/dashboard/package.json
- Server scripts:
  - npm run start
  - Source: apps/server/package.json

Automated tests:

- No component/integration/unit test files were found in repository source folders.
- No explicit replay/fixture generation scripts were found.

CI workflows / PR checks:

- No files found under .github/workflows in current repository snapshot.
- Authoritative validation currently appears to be local/manual run + lint/build commands.

## 11. Setup and operation

Practical local operation (grounded in scripts/config):

1. Configure server env in apps/server/.env with at least INVERTER_BASE_URL (and optionally POLL_SECONDS/PORT/other interval vars).
2. Install dependencies:
   - npm install at repo root for workspaces, or install per app directory.
3. Start server:
   - npm start (root) or npm --workspace apps/server run start.
4. Start dashboard dev UI (optional, separate shell):
   - cd apps/dashboard
   - npm run dev
   - Vite serves UI and proxies /api to server on port 8080.
5. Production-style single-host mode:
   - build dashboard (apps/dashboard npm run build), then run server; server serves apps/dashboard/dist if present.

Operational notes:

- Server binds 0.0.0.0:PORT.
- If dashboard dist is missing, API still works but non-API routes return 503 JSON indicating missing build.

## 12. Known gaps or intentional limitations

- No automated test suite is present in repository source; regression detection is primarily manual/lint/build.
- No CI/CD workflow files are present under .github/workflows.
- API is unversioned; contract changes are not isolated by explicit version boundary.
- Authentication/authorization is not implemented for API endpoints.
- Manual backfill max-month request validation is hard-coded to 24 in buildManualArchiveBackfillRange, not tied to MANUAL_ARCHIVE_MAX_MONTHS env variable.
- daily_agg table is maintained on poll inserts but currently not used by /api/daily responses (which recompute from readings).
- In-memory manual backfill status is process-local and non-durable across restarts.
- README in apps/dashboard states mock mode default true, but current code sets USE_MOCK = false.

## 13. Source-of-truth evidence

Server runtime, API, persistence, schedulers:

- apps/server/server.js
- apps/server/package.json
- apps/server/.env

Frontend entrypoints, API client, UI behavior/contracts:

- apps/dashboard/src/main.tsx
- apps/dashboard/src/App.tsx
- apps/dashboard/src/pages/Dashboard.tsx
- apps/dashboard/src/api/client.ts
- apps/dashboard/src/types.ts
- apps/dashboard/src/components/RatesEditor.tsx
- apps/dashboard/src/components/BillEstimate.tsx
- apps/dashboard/src/components/BackfillPanel.tsx
- apps/dashboard/src/components/HistoryChart.tsx
- apps/dashboard/src/components/EnergyChart.tsx
- apps/dashboard/src/utils/format.ts

Build/dev configuration:

- package.json
- apps/dashboard/package.json
- apps/dashboard/vite.config.ts
- apps/dashboard/tsconfig.json
- apps/dashboard/tailwind.config.js
- apps/dashboard/postcss.config.js
- .gitignore

Documentation reviewed:

- apps/dashboard/README.md

## Appendix: spec generation notes

- Existing docs/specs reused:
  - apps/dashboard/README.md for developer setup context and stated API intent.
- Existing docs/specs outdated or conflicting:
  - apps/dashboard/README.md says mock mode is default true; implemented code in apps/dashboard/src/api/client.ts sets USE_MOCK = false.
- Areas marked UNKNOWN due insufficient repository evidence:
  - Any production deployment topology beyond local run scripts.
  - Any external monitoring/alerting stack.
  - Any tracing/correlation ID standard.
  - Any governance policy for API versioning/backward compatibility.
