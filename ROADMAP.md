# Roadmap — MCP Agent Trace Inspector

## Phase 1: MVP ✅ Complete

### Goal

Ship a working trace server that records tool calls and produces a readable summary and HTML dashboard — enough to replace manual debugging of agent workflows.

### MCP Protocol Compliance

- [x] Implement stdio transport (required baseline for all MCP servers)
- [x] Strict JSON Schema definitions for all tool inputs — `trace_start` requires `name: string`, `trace_step` requires `trace_id`, `tool_name`, `input`, `output`
- [x] Tool annotations: `trace_start`/`trace_step`/`trace_end` marked `destructiveHint: false`, `readOnlyHint: false` (they write state); inspection tools marked `readOnlyHint: true`
- [x] Proper MCP error codes: `invalid_params` for unknown `trace_id`, `internal_error` for storage failures
- [x] Verified with MCP Inspector before publish
- [x] `package.json` with correct `bin`, `files`, `keywords: ["mcp", "mcp-server", "observability", "tracing"]`

### Features

- [x] `trace_start` / `trace_step` / `trace_end` core lifecycle tools
- [x] SQLite storage with schema: traces, steps, metadata
- [x] `get_trace_summary` — token totals, step count, latency (respects `--db` flag)
- [x] `list_traces` — list stored traces with timestamps
- [x] Console text summary output
- [x] Self-contained HTML dashboard artifact (no external CDN)
- [x] `--db` / `--retention-days` / `--no-token-count` flags wired up
- [x] TypeScript strict mode
- [x] Basic Jest/Vitest test suite
- [x] `CHANGELOG.md` initialized
- [x] Semantic versioning from first release
- [x] Publish to npm

---

## Phase 2: Polish & Adoption ✅ Complete

### Goal

Make traces rich enough to diagnose real bugs in production agent workflows, and easy enough to share that teams adopt them by default.

### MCP Best Practices

- [x] Progress notifications (`notifications/progress`) when generating large dashboard exports
- [x] Cancellation support (`notifications/cancelled`) — abort a long `export_dashboard` call cleanly
- [x] MCP logging (`notifications/message`) — emit debug-level events for each step recorded
- [x] Streamable HTTP transport (MCP 2025 spec) — run the trace server remotely (e.g. shared team instance)
- [x] MCP Resources primitive: expose individual traces as browsable resources (`trace://{id}`)
- [x] MCP Prompts primitive: `analyze-trace` prompt template to guide investigation of a completed trace
- [x] Tool description strings include parameter examples (improves LLM tool selection)

### Features

- [x] `export_dashboard` — shareable single-file HTML with interactive step timeline and latency waterfall
- [x] `compare_traces` — diff two traces side by side (before/after a prompt or tool change)
- [x] Token cost estimation with configurable pricing table (`--pricing-table` flag)
- [x] Error highlighting — surface failed tool calls and exceptions prominently in the dashboard
- [x] Reasoning chain extraction (detect prompt → reasoning → action patterns)
- [x] Automatic trace naming from workflow context when no name is provided
- [x] `--pricing-table` custom JSON override wired up
- [x] ESLint + Prettier enforced in CI
- [x] 90%+ test coverage
- [x] GitHub Actions CI (lint, test, build on every PR)
- [x] Listed on MCP Registry
- [x] Listed on MCP Market

---

## Phase 3: Enterprise & Compliance ✅ Partially Complete

### Goal

Serve teams that need shared trace history, cross-developer alerting, and compliance-grade audit logs.

### MCP Enterprise Standards

- [x] Rate limiting on the HTTP transport (per-client sliding window)
- [x] API key and JWT authentication for the HTTP transport (`MCP_API_KEY`, `MCP_JWT_SECRET`)
- [x] Structured trace export in OpenTelemetry format (interop with Jaeger, Grafana Tempo, etc.)
- [x] Multi-transport: stdio for local use, Streamable HTTP for remote/team use (`--http-port`)
- [ ] OAuth 2.0 authorization (MCP 2025 spec) — not yet implemented

### Features

- [x] Alerting — notify on latency regression, error rate spike, or cost threshold breach via Slack or generic webhook (`configure_alerts`)
- [x] Retention policies — archive/delete traces after N days (`set_retention_policy` + `apply_retention`; also `--retention-days` at startup)
- [x] Compliance export — append-only JSONL audit trail of every `trace_step` call; export as JSON or CSV with date range filtering (`export_compliance_log`)
- [x] Webhook integration — push alert events to Slack or generic HTTP endpoints
- [ ] Cloud dashboard — share traces with teammates via link (not yet implemented; all traces are local only)
- [ ] Team trace library with search and filtering
- [ ] SSO / SAML for enterprise team access

---

## Guiding Principles

- **Append-only traces** — steps are never edited after recording; trust requires integrity
- **Local-first** — all core functionality works without a network connection
- **Low overhead** — tracing adds <5ms per step; never the bottleneck
- **Portable dashboards** — HTML exports are always single-file; no server required to view them
- **MCP-native** — uses MCP Resources and Prompts primitives where they add value, not just Tools
