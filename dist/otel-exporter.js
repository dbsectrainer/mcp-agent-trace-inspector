import { getTrace, getSteps, listTraces } from "./db.js";
/** Convert a UUID-like string to a 32-hex-char trace ID (no hyphens) */
function toTraceId(id) {
  return id.replace(/-/g, "").padEnd(32, "0").slice(0, 32);
}
/** Convert a UUID-like string to a 16-hex-char span ID (no hyphens) */
function toSpanId(id) {
  return id.replace(/-/g, "").padEnd(16, "0").slice(0, 16);
}
function msToNano(ms) {
  return (BigInt(Math.floor(ms)) * 1000000n).toString();
}
function traceRowToRootSpan(trace) {
  const endMs = trace.ended_at ?? trace.started_at;
  const statusCode = trace.status === "completed" ? 1 : 2; // 1=OK, 2=ERROR
  const attributes = {
    "trace.name": trace.name,
    "trace.status": trace.status,
  };
  if (trace.metadata) {
    try {
      const meta = JSON.parse(trace.metadata);
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
function stepRowToSpan(step, traceId, parentSpanId) {
  const endMs = step.created_at + (step.latency_ms ?? 0);
  const attributes = {
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
    const output = JSON.parse(step.output_json);
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
export function exportToOTLP(db, traceId) {
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
export function exportAllOTLP(db) {
  const traces = listTraces(db);
  return traces.map((t) => exportToOTLP(db, t.id));
}
