# Contributing to MCP Agent Trace Inspector

Thank you for your interest in contributing to `mcp-agent-trace-inspector`!

## Getting Started

Requires Node.js 22.13 or newer (for unflagged `node:sqlite`).

```bash
git clone https://github.com/<org>/mcp-agent-trace-inspector.git
cd mcp-agent-trace-inspector
npm ci
npm run verify
```

`npm run verify` runs ESLint, Prettier, TypeScript, and the Vitest suite. All checks
must pass before submitting a pull request. Use `npm run verify:e2e` after a build to
exercise the real stdio and HTTP servers; it writes evidence under `docs/evidence/`.

## Project Layout

```
src/
  tools/           # MCP tool handlers (trace.ts, inspect.ts, export.ts, compare.ts)
  db.ts            # SQLite schema, query helpers, and database initialisation
  server.ts        # MCP Server setup: tool/resource/prompt registration and request dispatch
  index.ts         # Entry point — CLI argument parsing and transport selection (stdio / HTTP)
  alerting.ts      # Alert rule evaluation and webhook delivery (Slack, generic HTTP)
  audit-log.ts     # Append-only JSONL audit trail (MCP_AUDIT_LOG_PATH or ~/.mcp/...)
  auth.ts          # HTTP transport auth middleware (API key and HS256 JWT)
  http-server.ts   # Stateless Streamable HTTP transport (--http-port flag)
  notifications.ts # Best-effort logging/progress notification delivery
  otel-exporter.ts # Standard OTLP/JSON document export
  pricing.ts       # Model pricing table and cost estimation
  rate-limiter.ts  # Per-client sliding-window rate limiter for the HTTP transport
  resources.ts     # MCP Resources primitive (trace:// URIs)
  prompts.ts       # MCP Prompts primitive (analyze-trace template)
  retention.ts     # Trace archiving and deletion logic
  version.ts       # Reads the package version for MCP serverInfo / --version
scripts/           # E2E verification and screenshot capture (not published)
docs/evidence/     # Verification report, test/build logs, and real screenshots
tests/             # Vitest test suite (one file per module)
```

Tool handlers live in `src/tools/`. Each handler function receives the `DatabaseSync` instance and validated arguments. Add a corresponding test file in `tests/` for any new tool or module.

## How to Contribute

### Bug Reports

Open a GitHub issue with:

- Steps to reproduce.
- Expected vs. actual behavior.
- Node.js version and OS.

### Feature Requests

Open an issue describing the use case before writing code. This avoids duplicate effort and ensures alignment with project goals.

### Pull Requests

1. Fork the repository and create a branch from `main`.
2. Write or update tests for any changed behavior.
3. Run `npm run verify` and ensure every check passes.
4. Follow the existing code style (`npm run lint`, `npm run format:check`).
5. Add integration coverage for HTTP/tool behavior when changing those paths.
6. Keep pull requests focused: one feature or fix per PR.
7. Reference the relevant issue number in the PR description.

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(tools): add p95 latency metric to trace summary
fix(db): handle missing retention-days flag gracefully
docs: clarify --pricing-table flag in README
```

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). Please read it before contributing.
