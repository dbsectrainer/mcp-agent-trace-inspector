# Changelog

All notable changes to MCP Agent Trace Inspector will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
