import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { insertTrace, endTrace, insertStep, getTrace } from "../db.js";
import { encode } from "gpt-tokenizer/encoding/cl100k_base";
// Automatic token counting is synchronous and therefore blocks the MCP event
// loop. gpt-tokenizer is fast, but pathological multi-hundred-KiB payloads can
// still take tens to hundreds of milliseconds. Above this size we use the
// standard chars/4 estimate to keep step recording bounded. Callers can always
// pass an exact token_count explicitly.
const MAX_AUTO_TOKEN_COUNT_CHARS = 128 * 1024;
/**
 * Compute an offline token count for a text using the cl100k_base encoding.
 *
 * gpt-tokenizer is used instead of js-tiktoken because js-tiktoken's BPE
 * implementation becomes pathologically slow (hundreds of milliseconds) on
 * long runs without whitespace, which are common in JSON payloads (base64
 * blobs, URLs, minified values). The resulting counts are identical.
 *
 * Falls back to the char/4 approximation for very large payloads or if
 * encoding fails.
 */
function computeTokenCount(text) {
    if (text.length > MAX_AUTO_TOKEN_COUNT_CHARS) {
        return Math.ceil(text.length / 4);
    }
    try {
        return encode(text).length;
    }
    catch {
        return Math.ceil(text.length / 4);
    }
}
function validateObject(value, field) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new McpError(ErrorCode.InvalidParams, `${field} must be an object`);
    }
}
function generateAutoName() {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const uuidPrefix = crypto.randomUUID().slice(0, 8);
    return `trace-${ts}-${uuidPrefix}`;
}
export function handleTraceStart(db, args) {
    const raw = args.name;
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
        throw new McpError(ErrorCode.InvalidParams, "name must be a string when provided");
    }
    // Auto-generate name if empty, whitespace-only, or "auto"
    const isAuto = !raw ||
        typeof raw !== "string" ||
        raw.trim() === "" ||
        raw.trim().toLowerCase() === "auto";
    const name = isAuto ? generateAutoName() : raw.trim();
    try {
        const traceId = crypto.randomUUID();
        insertTrace(db, traceId, name);
        console.error(`[trace_start] Started trace "${name}" with id=${traceId}`);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        trace_id: traceId,
                        name,
                        status: "running",
                    }),
                },
            ],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new McpError(ErrorCode.InternalError, `Failed to start trace: ${message}`);
    }
}
export function handleTraceStep(db, args, noTokenCount) {
    const { trace_id, tool_name, input, output, token_count, latency_ms } = args;
    if (!trace_id || typeof trace_id !== "string") {
        throw new McpError(ErrorCode.InvalidParams, "trace_id must be a non-empty string");
    }
    if (!tool_name || typeof tool_name !== "string") {
        throw new McpError(ErrorCode.InvalidParams, "tool_name must be a non-empty string");
    }
    validateObject(input, "input");
    validateObject(output, "output");
    if (token_count !== undefined) {
        if (typeof token_count !== "number" ||
            !Number.isFinite(token_count) ||
            !Number.isInteger(token_count) ||
            token_count < 0) {
            throw new McpError(ErrorCode.InvalidParams, "token_count must be a non-negative integer");
        }
    }
    if (latency_ms !== undefined) {
        if (typeof latency_ms !== "number" ||
            !Number.isFinite(latency_ms) ||
            latency_ms < 0) {
            throw new McpError(ErrorCode.InvalidParams, "latency_ms must be a finite, non-negative number");
        }
    }
    const trace = getTrace(db, trace_id);
    if (!trace) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown trace_id: ${trace_id}`);
    }
    if (trace.status === "completed") {
        throw new McpError(ErrorCode.InvalidParams, `Trace ${trace_id} has already ended; cannot record new steps`);
    }
    try {
        // Compute token count offline using tiktoken when not provided by caller
        let resolvedTokenCount = null;
        if (!noTokenCount) {
            if (token_count !== undefined) {
                resolvedTokenCount = token_count;
            }
            else {
                const text = JSON.stringify(input) + JSON.stringify(output);
                resolvedTokenCount = computeTokenCount(text);
            }
        }
        const stepId = crypto.randomUUID();
        insertStep(db, {
            id: stepId,
            trace_id,
            tool_name,
            input_json: JSON.stringify(input),
            output_json: JSON.stringify(output),
            token_count: resolvedTokenCount,
            latency_ms: latency_ms ?? null,
        });
        console.error(`[trace_step] Recorded step "${tool_name}" for trace ${trace_id}, step id=${stepId}`);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        step_id: stepId,
                        trace_id,
                        tool_name,
                        token_count: resolvedTokenCount,
                        latency_ms: latency_ms ?? null,
                    }),
                },
            ],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new McpError(ErrorCode.InternalError, `Failed to record step: ${message}`);
    }
}
export function handleTraceEnd(db, args) {
    const { trace_id } = args;
    if (!trace_id || typeof trace_id !== "string") {
        throw new McpError(ErrorCode.InvalidParams, "trace_id must be a non-empty string");
    }
    const trace = getTrace(db, trace_id);
    if (!trace) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown trace_id: ${trace_id}`);
    }
    // Ending an already-completed trace is idempotent: do not move ended_at or
    // re-run alert evaluation for a retried request.
    if (trace.status === "completed" && trace.ended_at != null) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        trace_id,
                        status: "completed",
                        duration_ms: trace.ended_at - trace.started_at,
                        already_completed: true,
                    }),
                },
            ],
        };
    }
    try {
        endTrace(db, trace_id);
        const durationMs = trace.ended_at != null
            ? trace.ended_at - trace.started_at
            : Date.now() - trace.started_at;
        console.error(`[trace_end] Ended trace ${trace_id} (duration ~${durationMs}ms)`);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        trace_id,
                        status: "completed",
                        duration_ms: durationMs,
                    }),
                },
            ],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new McpError(ErrorCode.InternalError, `Failed to end trace: ${message}`);
    }
}
