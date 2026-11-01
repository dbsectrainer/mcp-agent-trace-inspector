import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { insertTrace, endTrace, insertStep, getTrace } from "../db.js";
import { getEncoding } from "js-tiktoken";
/**
 * Compute offline token count for a text using tiktoken (cl100k_base).
 * Falls back to the char/4 approximation if tiktoken fails.
 */
function computeTokenCount(text) {
    try {
        const enc = getEncoding("cl100k_base");
        return enc.encode(text).length;
    }
    catch {
        return Math.ceil(text.length / 4);
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
    if (typeof input !== "object" || input === null) {
        throw new McpError(ErrorCode.InvalidParams, "input must be an object");
    }
    if (typeof output !== "object" || output === null) {
        throw new McpError(ErrorCode.InvalidParams, "output must be an object");
    }
    const trace = getTrace(db, trace_id);
    if (!trace) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown trace_id: ${trace_id}`);
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
