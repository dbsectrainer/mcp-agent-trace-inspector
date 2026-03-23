import { DatabaseSync } from "node:sqlite";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { listTraces, computeSummary } from "./db.js";

export function handleListResources(db: DatabaseSync): {
  resources: Array<{
    uri: string;
    name: string;
    description: string;
    mimeType: string;
  }>;
} {
  const traces = listTraces(db);
  return {
    resources: traces.map((t) => ({
      uri: `trace://${t.id}`,
      name: t.name,
      description: `Agent trace "${t.name}" — status: ${t.status}, started: ${new Date(t.started_at).toISOString()}`,
      mimeType: "application/json",
    })),
  };
}

export function handleReadResource(
  db: DatabaseSync,
  uri: string,
): {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
} {
  const match = uri.match(/^trace:\/\/(.+)$/);
  if (!match) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Unsupported resource URI: ${uri}`,
    );
  }
  const traceId = match[1];
  const summary = computeSummary(db, traceId);
  if (!summary) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown trace: ${traceId}`);
  }

  const { trace, stepCount, totalTokens, totalLatencyMs, steps } = summary;
  const durationMs =
    trace.ended_at != null
      ? trace.ended_at - trace.started_at
      : Date.now() - trace.started_at;

  const content = {
    trace_id: trace.id,
    name: trace.name,
    status: trace.status,
    started_at: trace.started_at,
    ended_at: trace.ended_at,
    duration_ms: durationMs,
    step_count: stepCount,
    total_tokens: totalTokens,
    total_latency_ms: totalLatencyMs,
    steps: steps.map((s) => ({
      id: s.id,
      tool_name: s.tool_name,
      token_count: s.token_count,
      latency_ms: s.latency_ms,
      created_at: s.created_at,
    })),
  };

  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(content, null, 2),
      },
    ],
  };
}
