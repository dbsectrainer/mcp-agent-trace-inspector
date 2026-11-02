import { DatabaseSync } from "node:sqlite";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { computeSummary } from "../db.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { safeNotify } from "../notifications.js";

export interface ExportDashboardArgs {
  trace_id: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

function isErrorOutput(outputJson: string): boolean {
  try {
    const parsed = JSON.parse(outputJson) as unknown;
    if (typeof parsed !== "object" || parsed === null) return false;
    const obj = parsed as Record<string, unknown>;
    if (obj.error !== undefined) return true;
    if (obj.isError === true) return true;
    return false;
  } catch {
    return false;
  }
}

export async function handleExportDashboard(
  db: DatabaseSync,
  args: ExportDashboardArgs,
  server?: Server,
  progressToken?: string | number,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { trace_id } = args;
  if (!trace_id || typeof trace_id !== "string") {
    throw new McpError(
      ErrorCode.InvalidParams,
      "trace_id must be a non-empty string",
    );
  }

  // Progress notifications are only valid when the client supplied a
  // progress token with the request; never invent one.
  if (server && progressToken !== undefined) {
    await safeNotify(server, {
      method: "notifications/progress",
      params: {
        progressToken,
        progress: 0,
        total: 100,
      },
    });
  }

  try {
    const summary = computeSummary(db, trace_id);
    if (!summary) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown trace_id: ${trace_id}`,
      );
    }

    const { trace, stepCount, totalTokens, totalLatencyMs, steps } = summary;
    const durationMs =
      trace.ended_at != null
        ? trace.ended_at - trace.started_at
        : Date.now() - trace.started_at;

    const statusColor =
      trace.status === "completed"
        ? "#22c55e"
        : trace.status === "running"
          ? "#f59e0b"
          : "#ef4444";

    // Calculate max latency for waterfall proportions
    const maxLatency = steps.reduce(
      (max, s) => Math.max(max, s.latency_ms ?? 0),
      0,
    );

    const stepsRows = steps
      .map((s, i) => {
        let inputStr = "";
        let outputStr = "";
        try {
          inputStr = JSON.stringify(JSON.parse(s.input_json), null, 2);
        } catch {
          inputStr = s.input_json;
        }
        try {
          outputStr = JSON.stringify(JSON.parse(s.output_json), null, 2);
        } catch {
          outputStr = s.output_json;
        }
        const latency =
          s.latency_ms != null ? formatDuration(s.latency_ms) : "—";
        const tokens = s.token_count != null ? s.token_count.toString() : "—";
        const ts = new Date(s.created_at).toISOString();
        const hasError = isErrorOutput(s.output_json);
        const rowStyle = hasError ? ' style="background:#3b0a0a;"' : "";
        const errorBadge = hasError
          ? ' <span class="error-badge">ERROR</span>'
          : "";

        // Waterfall bar width as percentage
        const waterfallWidth =
          maxLatency > 0 && s.latency_ms != null
            ? Math.max(1, Math.round((s.latency_ms / maxLatency) * 100))
            : 0;
        const waterfallBar =
          waterfallWidth > 0
            ? `<div class="waterfall-bar" style="width:${waterfallWidth}%;"></div>`
            : `<div class="waterfall-empty">—</div>`;

        return `
        <tr${rowStyle}>
          <td class="step-num" data-label="#">${i + 1}</td>
          <td class="tool-name" data-label="Tool">${escapeHtml(s.tool_name)}${errorBadge}</td>
          <td class="ts" data-label="Timestamp">${escapeHtml(ts)}</td>
          <td class="latency" data-label="Latency">
            ${escapeHtml(latency)}
            ${waterfallBar}
          </td>
          <td class="tokens" data-label="Tokens">${escapeHtml(tokens)}</td>
          <td data-label="Input">
            <details>
              <summary>View<span class="sr-only"> input for step ${i + 1}</span></summary>
              <pre class="json-block">${escapeHtml(inputStr)}</pre>
            </details>
          </td>
          <td data-label="Output">
            <details>
              <summary>View<span class="sr-only"> output for step ${i + 1}</span></summary>
              <pre class="json-block${hasError ? " error-output" : ""}">${escapeHtml(outputStr)}</pre>
            </details>
          </td>
        </tr>`;
      })
      .join("\n");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <title>Trace Dashboard: ${escapeHtml(trace.name)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      line-height: 1.6;
      padding: 2rem;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 1.5rem 2rem;
      margin-bottom: 1.5rem;
    }
    header h1 {
      font-size: 1.75rem;
      font-weight: 700;
      color: #f1f5f9;
      margin-bottom: 0.5rem;
      overflow-wrap: anywhere;
    }
    .badge {
      display: inline-block;
      padding: 0.2rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.8rem;
      font-weight: 600;
      color: #0f172a;
      background: ${statusColor};
      margin-left: 0.5rem;
      vertical-align: middle;
    }
    .error-badge {
      display: inline-block;
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      font-size: 0.7rem;
      font-weight: 700;
      color: #fff;
      background: #ef4444;
      margin-left: 0.4rem;
      vertical-align: middle;
    }
    .meta {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 0.5rem 1.5rem;
      font-size: 0.875rem;
      color: #94a3b8;
      margin-top: 0.75rem;
    }
    .meta span strong { color: #cbd5e1; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .stat-card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 10px;
      padding: 1rem 1.25rem;
      text-align: center;
    }
    .stat-card .value {
      font-size: 1.75rem;
      font-weight: 700;
      color: #60a5fa;
    }
    .stat-card .label {
      font-size: 0.75rem;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-top: 0.25rem;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 1.5rem;
    }
    .table-scroll {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .table-scroll table {
      min-width: 760px;
    }
    .card-header {
      padding: 1rem 1.5rem;
      border-bottom: 1px solid #334155;
      font-weight: 600;
      font-size: 1rem;
      color: #f1f5f9;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    th {
      background: #0f172a;
      padding: 0.75rem 1rem;
      text-align: left;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #64748b;
      font-weight: 600;
    }
    td {
      padding: 0.75rem 1rem;
      border-top: 1px solid #1e293b;
      vertical-align: top;
      color: #cbd5e1;
    }
    tr:hover td { background: #162032; }
    tr[style*="background:#3b0a0a"] td { background: #3b0a0a; }
    tr[style*="background:#3b0a0a"]:hover td { background: #4c1010; }
    .step-num { color: #64748b; font-weight: 600; width: 3rem; }
    .tool-name { font-family: monospace; color: #7dd3fc; font-weight: 600; }
    .ts { color: #64748b; font-size: 0.8rem; white-space: nowrap; }
    .latency { color: #86efac; font-family: monospace; }
    .tokens { color: #fcd34d; font-family: monospace; }
    .waterfall-bar {
      height: 6px;
      background: #60a5fa;
      border-radius: 3px;
      margin-top: 4px;
      min-width: 2px;
      transition: width 0.3s ease;
    }
    .waterfall-empty { color: #64748b; font-size: 0.75rem; margin-top: 4px; }
    details summary {
      cursor: pointer;
      color: #60a5fa;
      font-size: 0.8rem;
      user-select: none;
    }
    details summary:hover { color: #93c5fd; }
    .json-block {
      margin-top: 0.5rem;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 6px;
      padding: 0.75rem;
      font-family: "Fira Code", "Cascadia Code", monospace;
      font-size: 0.75rem;
      color: #94a3b8;
      overflow-x: auto;
      white-space: pre;
      max-height: 300px;
      overflow-y: auto;
    }
    .json-block.error-output {
      border-color: #ef4444;
      background: #1a0505;
      color: #fca5a5;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    @media (max-width: 640px) {
      body { padding: 1rem; }
      header { padding: 1rem 1.25rem; }
      header h1 { font-size: 1.4rem; }
      .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .stat-card { padding: 0.75rem; }
      .stat-card .value { font-size: 1.4rem; }

      /* Render each timeline row as a compact card instead of forcing the
         seven-column table to scroll horizontally. */
      .table-scroll table { min-width: 0; }
      .table-scroll thead { display: none; }
      .table-scroll table,
      .table-scroll tbody,
      .table-scroll tr,
      .table-scroll td {
        display: block;
        width: 100%;
      }
      .table-scroll tr {
        border-top: 1px solid #334155;
        padding: 0.75rem 1rem;
      }
      .table-scroll tr:first-child { border-top: none; }
      .table-scroll td {
        border: 0;
        padding: 0.2rem 0;
      }
      .table-scroll td::before {
        content: attr(data-label);
        display: inline-block;
        min-width: 4.5rem;
        color: #64748b;
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .table-scroll td.empty::before { content: none; }
      .table-scroll td.tool-name { font-size: 1rem; }
      .table-scroll .ts { white-space: normal; overflow-wrap: anywhere; }
      .table-scroll .waterfall-bar { max-width: 100%; }
    }
    footer {
      text-align: center;
      font-size: 0.75rem;
      color: #334155;
      margin-top: 2rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>${escapeHtml(trace.name)}<span class="badge">${escapeHtml(trace.status)}</span></h1>
      <div class="meta">
        <span><strong>Trace ID:</strong> ${escapeHtml(trace.id)}</span>
        <span><strong>Started:</strong> ${escapeHtml(new Date(trace.started_at).toISOString())}</span>
        <span><strong>Ended:</strong> ${trace.ended_at ? escapeHtml(new Date(trace.ended_at).toISOString()) : "—"}</span>
        <span><strong>Duration:</strong> ${escapeHtml(formatDuration(durationMs))}</span>
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="value">${stepCount}</div>
        <div class="label">Total Steps</div>
      </div>
      <div class="stat-card">
        <div class="value">${totalTokens.toLocaleString()}</div>
        <div class="label">Total Tokens</div>
      </div>
      <div class="stat-card">
        <div class="value">${escapeHtml(formatDuration(totalLatencyMs))}</div>
        <div class="label">Total Latency</div>
      </div>
      <div class="stat-card">
        <div class="value">${escapeHtml(formatDuration(durationMs))}</div>
        <div class="label">Wall Duration</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">Step Timeline</div>
      <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Tool</th>
            <th scope="col">Timestamp</th>
            <th scope="col">Latency / Waterfall</th>
            <th scope="col">Tokens</th>
            <th scope="col">Input</th>
            <th scope="col">Output</th>
          </tr>
        </thead>
        <tbody>
          ${stepsRows || '<tr><td class="empty" colspan="7" style="text-align:center;color:#64748b;padding:2rem;">No steps recorded</td></tr>'}
        </tbody>
      </table>
      </div>
    </div>

    <footer>
      Generated by mcp-agent-trace-inspector &bull; ${new Date().toISOString()}
    </footer>
  </div>
</body>
</html>`;

    // Emit progress: done
    if (server && progressToken !== undefined) {
      await safeNotify(server, {
        method: "notifications/progress",
        params: {
          progressToken,
          progress: 100,
          total: 100,
        },
      });
    }

    return {
      content: [{ type: "text", text: html }],
    };
  } catch (err) {
    if (err instanceof McpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to export dashboard: ${message}`,
    );
  }
}
