# MCP Agent Trace Inspector

npm `mcp-agent-trace-inspector` package

Local-first, MCP-native observability for agent workflows. Every tool call, prompt transformation, latency, and token count is recorded in a local SQLite database — no cloud account, no API key, no traces leaving your machine. Built specifically for MCP rather than bolted onto a generic LLM proxy.

[Tool reference](#tools) | [Configuration](#configuration) | [Contributing](#contributing) | [Troubleshooting](#troubleshooting) | [Design principles](#design-principles)

## Key features

- **Tool call tracing**: Captures inputs, outputs, latency, and token usage for every step in a workflow.
- **Persistent storage**: Traces survive session restarts; stored locally in SQLite with no external dependencies.
- **HTML dashboard**: Generates a self-contained single-file dashboard with an interactive step timeline.
- **Token cost estimation**: Calculates USD cost per trace using a configurable model pricing table — no API calls required.
- **Trace comparison**: Diff two traces side by side to measure the impact of prompt or tool changes.
- **Low overhead**: Adds less than 5ms per step; never becomes the bottleneck.

## Why this over LangSmith / AgentOps?

|                 | mcp-agent-trace-inspector                        | LangSmith / AgentOps                          |
| --------------- | ------------------------------------------------ | --------------------------------------------- |
| Data location   | Local SQLite — never leaves your machine         | Cloud-hosted; traces sent to external servers |
| Setup           | `npx` one-liner, zero config                     | Account signup, API key, SDK instrumentation  |
| MCP-aware       | Native — records tool calls as first-class steps | Generic LLM proxy; MCP structure is opaque    |
| Run diffs       | Built-in `compare_traces` diff                   | Separate paid feature or manual export        |
| Cost estimation | Offline tiktoken + configurable pricing table    | Requires live API traffic through their proxy |
| Overhead        | &lt;5ms per step                                 | Network round-trip per event                  |

If your traces contain sensitive tool outputs, proprietary prompts, or data that must stay on-device, this is the right tool. If you need cross-team trace sharing or a managed SaaS, use LangSmith.

## Disclaimers

`mcp-agent-trace-inspector` stores tool call inputs and outputs locally in a SQLite database. Traces may contain sensitive information passed to or returned from your tools. Review trace contents before sharing dashboard exports. Traces are not automatically transmitted; optional alert webhooks are available.

## Requirements

- Node.js v22.5.0 or newer.
- npm.

## Getting started

Add the following config to your MCP client:

```json
{
  "mcpServers": {
    "trace-inspector": {
      "command": "npx",
      "args": ["-y", "mcp-agent-trace-inspector@latest"]
    }
  }
}
```

To set a custom storage path:

```json
{
  "mcpServers": {
    "trace-inspector": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-agent-trace-inspector@latest",
        "--db=~/traces/my-project.db"
      ]
    }
  }
}
```

### MCP Client configuration

Amp · Claude Code · Cline · Cursor · VS Code · Windsurf · Zed

## Your first prompt

Enter the following in your MCP client to verify everything is working:

```
Start a trace called "test-run", then list the files in the current directory, then end the trace and show me the summary.
```

Your client should return a summary showing step count, total tokens, and latency.

## Tools

### Trace lifecycle (3 tools)

- `trace_start` — begin a new trace; returns a `trace_id` for subsequent calls
- `trace_step` — record one tool call step (inputs, outputs, optional token count and latency)
- `trace_end` — mark a trace as completed

### Inspection (4 tools)

- `list_traces` — list stored traces with names, statuses, and timestamps
- `get_trace_summary` — token totals, step count, latency, and cost estimate for a trace
- `compare_traces` — diff two traces side by side (step counts, tokens, latency)
- `extract_reasoning_chain` — extract only reasoning/thinking steps from a trace

### Export (3 tools)

- `export_dashboard` — generate a self-contained single-file HTML dashboard with latency waterfall
- `export_otel` — export one or all traces in OpenTelemetry OTLP JSON span format
- `export_compliance_log` — export the compliance audit log as JSON or CSV, with optional date range filtering

### Operations (3 tools)

- `configure_alerts` — configure alert rules on latency, error rate, or cost; fire to Slack or generic webhooks
- `set_retention_policy` — set how many days to keep traces (in-memory; must be called before `apply_retention`)
- `apply_retention` — archive traces older than the configured threshold; delete traces past 2x the threshold

## Configuration

### `--db` / `--db-path`

Path to the SQLite database file used to store traces.

Type: `string`
Default: `~/.mcp/traces.db`

### `--retention-days`

Automatically delete traces older than N days. Set to `0` to disable.

Type: `number`
Default: `0`

### `--pricing-table`

Path to a JSON file containing custom model pricing ($/1K tokens). Overrides the built-in table.

Type: `string`

### `--no-token-count`

Disable tiktoken-based token counting. Traces will omit token usage metrics.

Type: `boolean`
Default: `false`

Pass flags via the `args` property in your JSON config:

```json
{
  "mcpServers": {
    "trace-inspector": {
      "command": "npx",
      "args": ["-y", "mcp-agent-trace-inspector@latest", "--retention-days=30"]
    }
  }
}
```

## Design principles

- **Append-only traces**: Steps are immutable once recorded. Trust requires integrity.
- **Local-first**: All core functionality works without a network connection.
- **Portable dashboards**: HTML exports are always single-file; no server required to view them.

## Verification

Before publishing a new version, verify the server with MCP Inspector to confirm all tools are exposed correctly and the protocol handshake succeeds.

**Interactive UI** (opens browser):

```bash
npm run build && npm run inspect
```

**CLI mode** (scripted / CI-friendly):

```bash
# List all tools
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list

# List resources and prompts
npx @modelcontextprotocol/inspector --cli node dist/index.js --method resources/list
npx @modelcontextprotocol/inspector --cli node dist/index.js --method prompts/list

# Call a tool (example — replace with a relevant read-only tool for this plugin)
npx @modelcontextprotocol/inspector --cli node dist/index.js \
  --method tools/call --tool-name list_traces

# Call a tool with arguments
npx @modelcontextprotocol/inspector --cli node dist/index.js \
  --method tools/call --tool-name list_traces --tool-arg key=value
```

Run before publishing to catch regressions in tool registration and runtime startup.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for full contribution guidelines.

```bash
npm install && npm test
```

## MCP Registry & Marketplace

This plugin is available on:

- [MCP Registry](https://registry.modelcontextprotocol.io)
- [MCP Market](https://mcpmarket.com)

Search for `mcp-agent-trace-inspector`.
