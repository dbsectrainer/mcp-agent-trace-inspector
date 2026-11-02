import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getTrace, getSteps, listTraces, TraceRow, StepRow } from "./db.js";
import { getPackageVersion } from "./version.js";

export interface OTLPSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number | boolean>;
  status: { code: number; message?: string };
}

export interface OTLPTrace {
  traceId: string;
  spans: OTLPSpan[];
}

/**
 * Convert an identifier to a fixed-width lowercase hex ID.
 *
 * UUIDs are used directly (hyphens removed). Arbitrary IDs are hashed so the
 * exported values are always valid for OTLP consumers.
 */
function toHexId(id: string, hexLength: number): string {
  const compact = id.replace(/-/g, "").toLowerCase();
  if (new RegExp(`^[0-9a-f]{${hexLength}}$`).test(compact)) return compact;
  return createHash("sha256").update(id).digest("hex").slice(0, hexLength);
}

/** Convert a UUID-like string to a 32-hex-char trace ID (no hyphens) */
function toTraceId(id: string): string {
  return toHexId(id, 32);
}

/** Convert a UUID-like string to a 16-hex-char span ID (no hyphens) */
function toSpanId(id: string): string {
  return toHexId(id, 16);
}

function msToNano(ms: number): string {
  return (BigInt(Math.floor(ms)) * 1_000_000n).toString();
}

function traceRowToRootSpan(trace: TraceRow): OTLPSpan {
  const endMs = trace.ended_at ?? trace.started_at;
  // OTLP status codes: 0 = unset, 1 = OK, 2 = ERROR. A running trace is
  // neither successful nor failed yet.
  const statusCode =
    trace.status === "completed" ? 1 : trace.status === "running" ? 0 : 2;

  const attributes: Record<string, string | number | boolean> = {
    "trace.name": trace.name,
    "trace.status": trace.status,
  };

  if (trace.metadata) {
    try {
      const meta = JSON.parse(trace.metadata) as Record<string, unknown>;
      for (const [k, v] of Object.entries(meta)) {
        if (
          typeof v === "string" ||
          typeof v === "number" ||
          typeof v === "boolean"
        ) {
          attributes[`trace.metadata.${k}`] = v;
        }
      }
    } catch {
      // ignore malformed metadata
    }
  }

  return {
    traceId: toTraceId(trace.id),
    spanId: toSpanId(trace.id),
    name: trace.name,
    startTimeUnixNano: msToNano(trace.started_at),
    endTimeUnixNano: msToNano(endMs),
    attributes,
    status: { code: statusCode, message: trace.status },
  };
}

function stepRowToSpan(
  step: StepRow,
  traceId: string,
  parentSpanId: string,
): OTLPSpan {
  const endMs = step.created_at + (step.latency_ms ?? 0);

  const attributes: Record<string, string | number | boolean> = {
    "step.tool_name": step.tool_name,
    "step.trace_id": step.trace_id,
  };

  if (step.token_count !== null && step.token_count !== undefined) {
    attributes["step.token_count"] = step.token_count;
  }
  if (step.latency_ms !== null && step.latency_ms !== undefined) {
    attributes["step.latency_ms"] = step.latency_ms;
  }

  // Check for error in output
  let statusCode = 1; // OK
  try {
    const output = JSON.parse(step.output_json) as Record<string, unknown>;
    if (output.error || output.isError === true) {
      statusCode = 2; // ERROR
      if (typeof output.error === "string") {
        attributes["error.message"] = output.error;
      }
    }
  } catch {
    // ignore
  }

  return {
    traceId: toTraceId(traceId),
    spanId: toSpanId(step.id),
    parentSpanId,
    name: step.tool_name,
    startTimeUnixNano: msToNano(step.created_at),
    endTimeUnixNano: msToNano(endMs),
    attributes,
    status: { code: statusCode },
  };
}

export function exportToOTLP(db: DatabaseSync, traceId: string): OTLPTrace {
  const trace = getTrace(db, traceId);
  if (!trace) {
    throw new Error(`Unknown trace_id: ${traceId}`);
  }

  const steps = getSteps(db, traceId);
  const rootSpan = traceRowToRootSpan(trace);
  const stepSpans = steps.map((s) =>
    stepRowToSpan(s, traceId, rootSpan.spanId),
  );

  return {
    traceId: toTraceId(traceId),
    spans: [rootSpan, ...stepSpans],
  };
}

export function exportAllOTLP(db: DatabaseSync): OTLPTrace[] {
  const traces = listTraces(db);
  return traces.map((t) => exportToOTLP(db, t.id));
}

// ---------------------------------------------------------------------------
// OTLP/JSON export document
// ---------------------------------------------------------------------------

export interface OTLPAttributeValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}

export interface OTLPAttribute {
  key: string;
  value: OTLPAttributeValue;
}

export interface OTLPDocumentSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OTLPAttribute[];
  status: { code: number; message?: string };
}

export interface OTLPExportDocument {
  resourceSpans: Array<{
    resource: { attributes: OTLPAttribute[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OTLPDocumentSpan[];
    }>;
  }>;
}

function toAttributeValue(
  value: string | number | boolean,
): OTLPAttributeValue {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  return { stringValue: value };
}

function toAttributes(
  attributes: Record<string, string | number | boolean>,
): OTLPAttribute[] {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: toAttributeValue(value),
  }));
}

function toDocumentSpan(span: OTLPSpan): OTLPDocumentSpan {
  const documentSpan: OTLPDocumentSpan = {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    attributes: toAttributes(span.attributes),
    status: span.status,
  };
  if (span.parentSpanId !== undefined) {
    documentSpan.parentSpanId = span.parentSpanId;
  }
  return documentSpan;
}

/**
 * Build an OTLP/JSON export document (resourceSpans → scopeSpans → spans)
 * suitable for sending to an OTLP-compatible backend or collector.
 *
 * When `traceId` is omitted all traces are exported. Exported span IDs are
 * stable hashes of the local trace/step IDs; no runtime state is inferred.
 */
export function exportOtlpDocument(
  db: DatabaseSync,
  traceId?: string,
): OTLPExportDocument {
  const traces =
    traceId !== undefined ? [exportToOTLP(db, traceId)] : exportAllOTLP(db);

  const spans = traces.flatMap((trace) => trace.spans.map(toDocumentSpan));
  const version = getPackageVersion();

  return {
    resourceSpans: [
      {
        resource: {
          attributes: toAttributes({
            "service.name": "mcp-agent-trace-inspector",
            "service.version": version,
            "telemetry.sdk.name": "mcp-agent-trace-inspector",
            "telemetry.sdk.language": "nodejs",
          }),
        },
        scopeSpans: [
          {
            scope: {
              name: "mcp-agent-trace-inspector",
              version,
            },
            spans,
          },
        ],
      },
    ],
  };
}
