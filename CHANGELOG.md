# Changelog

All notable changes to MCP Agent Trace Inspector will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- End-to-end verification harness (`npm run verify:e2e`) that runs the real built
  stdio and HTTP servers and writes evidence under `docs/evidence/`.
- Chrome/CDP screenshot capture (`npm run screenshots`) for the generated dashboard at
  desktop and mobile viewports, plus a responsive card-style mobile timeline.
- HTTP integration tests covering sequential stateless requests, authentication,
  rate limiting, 405/404 handling, parse errors, and body-size limits.
- `MCP_AUDIT_LOG_PATH`, `MCP_SLACK_WEBHOOK`, and `MCP_ALERT_WEBHOOK` environment
  variables (documented in `.env.example`).
- `--http-host` flag, defaulting to `127.0.0.1`.
- Regression tests for trace lifecycle validation, idempotent `trace_end`, custom
  pricing, OTLP export, alert evaluation, audit date filtering, and version reporting.

### Fixed

- **HTTP transport was unusable after the first request.** A single MCP `Server` was
  reused across transports, and the SDK rejects that with "Already connected to a
  transport". HTTP now creates a fresh stateless server/transport per POST.
- HTTP errors no longer return Express HTML/stack traces; clients receive JSON-RPC
  errors for parse failures, payload limits, and internal errors.
- `--pricing-table` was loaded and discarded. The active table is now passed to
  `get_trace_summary`, audit cost estimation, and custom models; custom entries merge
  over built-in rates.
- `configure_alerts` saved rules that were never evaluated. Alerts are now evaluated
  on `trace_end`, returned in the response, and sent to configured webhooks with a
  bounded request timeout.
- `trace_step` now rejects steps for a completed trace, and repeated `trace_end` calls
  are idempotent instead of moving `ended_at`.
- Validation now rejects negative/fractional token counts, negative latency, array
  input/output payloads, fractional `list_traces` limits, malformed alert rules,
  invalid webhook schemes, invalid date filters, and unknown export formats.
- Audit log writes no longer turn a successful `trace_step` into a tool error when the
  log path is unavailable; `MCP_AUDIT_LOG_PATH` is honoured, the log is created with
  mode `0600`, and date-only `to_date` filters include the whole day.
- `export_otel` now emits a standard OTLP/JSON document (`resourceSpans → scopeSpans →
  spans`) instead of a custom `{traceId, spans}` shape. Non-hex IDs are hashed into
  valid lowercase hex IDs.
- Server version was hard-coded as `0.2.0` while the package was `1.0.0`; it now reads
  `package.json` and is verified by tests and the E2E run.
- Token counting switched from `js-tiktoken` to `gpt-tokenizer`, eliminating
  pathological multi-hundred-millisecond runs on long whitespace-free strings.
  Automatic payloads above 128 KiB use a chars/4 estimate to bound latency.
- `openDatabase(":memory:")` no longer creates a literal file named `:memory:`.
- Tests no longer write to the real home directory: audit logs use temp directories and
  the tilde-path test is hermetic, so the suite passes with a read-only HOME.

### Security

- HTTP binds to loopback by default, applies DNS-rebinding Host validation, limits JSON
  bodies to 10 MB, and documents the reverse-proxy Host requirement.
- JWT verification now requires `alg: HS256`, checks `nbf`, and rejects malformed
  claims; API-key comparison uses a timing-safe comparison.
- Rate-limit keying only trusts an API key that matches `MCP_API_KEY`, preventing
  header-rotation bypasses, and prunes idle client windows.
- Removed a bogus required `YOUR_API_KEY` entry from `server.json`.

### Changed

- CI runs Prettier checks and the real-process E2E harness; the pre-release workflow uses
  Node 22 (Node 20 cannot load `node:sqlite`). `package.json` now declares `node >=22.13.0`, the first release where
  `node:sqlite` is unflagged.
- Documentation rewritten to match verified behavior, including HTTP mode, auth,
  limitations, retention semantics, alerts, and screenshot evidence.


## [1.0.0] - 2026-03-23

### Changed

- `@modelcontextprotocol/sdk` upgraded from `^1.0.0` to `^1.12.0`.
- `@types/node` upgraded from `^22.x` to `^24.12.0` (Node 24 LTS).
- `eslint` upgraded from `^9.x` to `^10.0.3`; `eslint-config-prettier` from `^9.x` to `^10.1.8`.
- `yargs` upgraded from `^17.x` to `^18.0.0`.
- Added `author`, `repository`, and `homepage` fields to `package.json` for npm registry and marketplace metadata.
- Added `.env.example` documenting `MCP_API_KEY` and `MCP_JWT_SECRET`.

### Fixed

- Removed two unused function references (`checkAndAlert`, `loadAlertRules`) from `src/server.ts`.
- Prefixed unused test helper variables with `_` in `tests/auth.test.ts` and `tests/trace.test.ts` to satisfy `no-unused-vars` lint rule.

### Security

- Resolved **GHSA-67mh-4wv8-2f99** (`esbuild` ≤ 0.24.2 dev-server cross-origin exposure) by upgrading `vitest` and `@vitest/coverage-v8` to `^4.1.0`. Affects local development only; not a production runtime concern.

## [0.2.0] - 2026-03-23

### Added

- **Alerting** (`src/alerting.ts`): configurable alert rules on latency, error rate, and total cost. Fires to Slack webhooks or generic HTTP endpoints. Alert rules persist to SQLite between restarts.
- **Audit log** (`src/audit-log.ts`): append-only JSONL audit trail written to `~/.mcp/trace-inspector-audit.jsonl`; queryable by time range via `export_compliance_log`.
- **JWT / API-key auth middleware** (`src/auth.ts`): HTTP transport protected via `MCP_API_KEY` (X-API-Key header) or `MCP_JWT_SECRET` (HMAC-SHA256 Bearer token). stdio transport is unaffected.
- **Per-client rate limiter** (`src/rate-limiter.ts`): sliding-window request throttle on the HTTP transport.
- **OpenTelemetry exporter** (`src/otel-exporter.ts`): export traces to any OTLP-compatible backend (Jaeger, Grafana Tempo, etc.). Supports single-trace and all-traces export with `format=json`.
- **Retention policy** (`src/retention.ts`): archive or delete trace records older than a configurable number of days. Archives traces past the threshold; deletes archived traces past 2× the threshold.
- **New tools**: `configure_alerts`, `set_retention_policy`, `apply_retention`, `export_otel`, `export_compliance_log`.
- **`npm run inspect` script**: launches MCP Inspector (`npx @modelcontextprotocol/inspector node dist/index.js`) for interactive pre-publish verification.
- MCP Inspector verification instructions added to README.
- Tests for alerting, audit log, auth, OpenTelemetry exporter, rate limiter, and retention.

### Fixed

- `export_compliance_log` was always returning an empty array. The shared `AuditLog` instance was never written to because `trace_step` did not call `record()`. Fixed by creating a single `AuditLog` instance in `server.ts` and calling `_auditLog.record()` from the `trace_step` handler. Audit entries are now correctly appended to `~/.mcp/trace-inspector-audit.jsonl` on every recorded step.
- `apply_retention` now returns a clear error (`InvalidParams`) when called before `set_retention_policy` has been invoked in the current session, rather than silently operating on a null policy.

## [0.1.0] - 2026-03-12

### Added

- Initial public release of `mcp-agent-trace-inspector`.
- `trace_start`, `trace_step`, and `trace_end` tools for full trace lifecycle management.
- `get_trace_summary`, `list_traces`, and `compare_traces` inspection tools.
- `export_dashboard` tool generating a self-contained single-file HTML dashboard.
- Persistent SQLite storage with configurable path via `--db`.
- Token cost estimation using a built-in model pricing table (no external API calls required).
- Automatic trace retention via `--retention-days`.
- Custom pricing table support via `--pricing-table`.
- `--no-token-count` flag to disable token counting.
- Streamable HTTP transport via `--http-port` flag (default: disabled, uses stdio).
- GitHub Actions CI workflow running build, test, and lint on push/PR to `main`.
- Vitest test suite with coverage via `@vitest/coverage-v8`.
