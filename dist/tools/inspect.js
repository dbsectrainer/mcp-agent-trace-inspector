import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { computeSummary, listTraces } from "../db.js";
import { DEFAULT_PRICING, estimateCost } from "../pricing.js";
/**
 * Detect prompt→reasoning→action patterns in step tool names.
 * Returns true if the sequence contains at least one instance of the pattern.
 */
function detectReasoningChain(toolNames) {
    const PROMPT_PATTERNS = /prompt|input|query|ask|request/i;
    const REASONING_PATTERNS = /reason|think|plan|reflect|analyz|consider/i;
    const ACTION_PATTERNS = /action|execute|run|call|invoke|output|respond|answer/i;
    const patterns = [];
    for (let i = 0; i < toolNames.length - 2; i++) {
        const a = toolNames[i];
        const b = toolNames[i + 1];
        const c = toolNames[i + 2];
        if (PROMPT_PATTERNS.test(a) &&
            REASONING_PATTERNS.test(b) &&
            ACTION_PATTERNS.test(c)) {
            patterns.push(`${a} → ${b} → ${c}`);
        }
    }
    // Also flag standalone reasoning steps even without the full triple
    const standaloneReasoning = toolNames.filter((t) => REASONING_PATTERNS.test(t));
    return {
        detected: patterns.length > 0 || standaloneReasoning.length > 0,
        patterns: patterns.length > 0 ? patterns : standaloneReasoning.map((t) => t),
    };
}
export function handleGetTraceSummary(db, args) {
    const { trace_id, model } = args;
    if (!trace_id || typeof trace_id !== "string") {
        throw new McpError(ErrorCode.InvalidParams, "trace_id must be a non-empty string");
    }
    try {
        const summary = computeSummary(db, trace_id);
        if (!summary) {
            throw new McpError(ErrorCode.InvalidParams, `Unknown trace_id: ${trace_id}`);
        }
        const { trace, stepCount, totalTokens, totalLatencyMs, steps } = summary;
        const durationMs = trace.ended_at != null
            ? trace.ended_at - trace.started_at
            : Date.now() - trace.started_at;
        // Cost estimation
        const pricingModel = model ?? "claude-sonnet-4-6";
        const estimatedCost = totalTokens > 0
            ? estimateCost(totalTokens, pricingModel, DEFAULT_PRICING)
            : null;
        // Reasoning chain detection
        const toolNames = steps.map((s) => s.tool_name);
        const reasoningResult = detectReasoningChain(toolNames);
        const costLine = estimatedCost !== null
            ? `  Est. Cost:  $${estimatedCost.toFixed(6)} (model: ${pricingModel})`
            : `  Est. Cost:  N/A (model "${pricingModel}" not in pricing table)`;
        const reasoningLine = reasoningResult.detected
            ? `  Reasoning:  DETECTED — ${reasoningResult.patterns.join("; ")}`
            : `  Reasoning:  No prompt→reasoning→action pattern detected`;
        const text = [
            `Trace Summary: ${trace.name}`,
            `  ID:         ${trace.id}`,
            `  Status:     ${trace.status}`,
            `  Started:    ${new Date(trace.started_at).toISOString()}`,
            `  Ended:      ${trace.ended_at ? new Date(trace.ended_at).toISOString() : "—"}`,
            `  Duration:   ${durationMs}ms`,
            `  Steps:      ${stepCount}`,
            `  Total Tokens: ${totalTokens}`,
            `  Total Latency: ${totalLatencyMs}ms`,
            costLine,
            reasoningLine,
            "",
            "Steps:",
            ...steps.map((s, i) => `  ${i + 1}. ${s.tool_name}` +
                (s.latency_ms != null ? ` [${s.latency_ms}ms]` : "") +
                (s.token_count != null ? ` [${s.token_count} tokens]` : "")),
        ].join("\n");
        const json = {
            trace_id: trace.id,
            name: trace.name,
            status: trace.status,
            started_at: trace.started_at,
            ended_at: trace.ended_at,
            duration_ms: durationMs,
            step_count: stepCount,
            total_tokens: totalTokens,
            total_latency_ms: totalLatencyMs,
            estimated_cost_usd: estimatedCost,
            cost_model: pricingModel,
            reasoning_chain_detected: reasoningResult.detected,
            reasoning_patterns: reasoningResult.patterns,
            steps: steps.map((s) => ({
                id: s.id,
                tool_name: s.tool_name,
                token_count: s.token_count,
                latency_ms: s.latency_ms,
                created_at: s.created_at,
            })),
        };
        return {
            content: [
                { type: "text", text },
                { type: "text", text: "\n\nJSON:\n" + JSON.stringify(json, null, 2) },
            ],
        };
    }
    catch (err) {
        if (err instanceof McpError)
            throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new McpError(ErrorCode.InternalError, `Failed to get trace summary: ${message}`);
    }
}
export function handleListTraces(db, args) {
    const { limit } = args;
    if (limit !== undefined && (typeof limit !== "number" || limit < 1)) {
        throw new McpError(ErrorCode.InvalidParams, "limit must be a positive integer");
    }
    try {
        const traces = listTraces(db, limit);
        const lines = [
            `Found ${traces.length} trace(s):`,
            ...traces.map((t) => {
                const started = new Date(t.started_at).toISOString();
                const ended = t.ended_at
                    ? new Date(t.ended_at).toISOString()
                    : "running";
                return `  [${t.status.toUpperCase()}] ${t.name} (${t.id})\n    Started: ${started}  Ended: ${ended}`;
            }),
        ];
        const json = traces.map((t) => ({
            id: t.id,
            name: t.name,
            status: t.status,
            started_at: t.started_at,
            ended_at: t.ended_at,
        }));
        return {
            content: [
                { type: "text", text: lines.join("\n") },
                { type: "text", text: "\n\nJSON:\n" + JSON.stringify(json, null, 2) },
            ],
        };
    }
    catch (err) {
        if (err instanceof McpError)
            throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new McpError(ErrorCode.InternalError, `Failed to list traces: ${message}`);
    }
}
