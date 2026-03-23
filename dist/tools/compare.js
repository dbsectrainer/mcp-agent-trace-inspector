import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { computeSummary } from "../db.js";
export function handleCompareTraces(db, args) {
  const { trace_id_a, trace_id_b } = args;
  if (!trace_id_a || typeof trace_id_a !== "string") {
    throw new McpError(
      ErrorCode.InvalidParams,
      "trace_id_a must be a non-empty string",
    );
  }
  if (!trace_id_b || typeof trace_id_b !== "string") {
    throw new McpError(
      ErrorCode.InvalidParams,
      "trace_id_b must be a non-empty string",
    );
  }
  try {
    const summaryA = computeSummary(db, trace_id_a);
    if (!summaryA) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown trace_id_a: ${trace_id_a}`,
      );
    }
    const summaryB = computeSummary(db, trace_id_b);
    if (!summaryB) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown trace_id_b: ${trace_id_b}`,
      );
    }
    const stepCountDiff = summaryB.stepCount - summaryA.stepCount;
    const tokenDiff = summaryB.totalTokens - summaryA.totalTokens;
    const latencyDiff = summaryB.totalLatencyMs - summaryA.totalLatencyMs;
    // Build tool name sets for step-by-step comparison
    const toolsA = summaryA.steps.map((s) => s.tool_name);
    const toolsB = summaryB.steps.map((s) => s.tool_name);
    const setA = new Set(toolsA);
    const setB = new Set(toolsB);
    const onlyInA = toolsA.filter((t) => !setB.has(t));
    const onlyInB = toolsB.filter((t) => !setA.has(t));
    const inBoth = toolsA.filter((t) => setB.has(t));
    // Per-position diff (for steps that exist in both by index)
    const minLen = Math.min(summaryA.steps.length, summaryB.steps.length);
    const stepDiffs = [];
    for (let i = 0; i < minLen; i++) {
      const sA = summaryA.steps[i];
      const sB = summaryB.steps[i];
      const sameTool = sA.tool_name === sB.tool_name;
      const tDiff =
        sA.token_count != null && sB.token_count != null
          ? sB.token_count - sA.token_count
          : null;
      const lDiff =
        sA.latency_ms != null && sB.latency_ms != null
          ? sB.latency_ms - sA.latency_ms
          : null;
      stepDiffs.push({
        index: i + 1,
        tool_a: sA.tool_name,
        tool_b: sB.tool_name,
        same_tool: sameTool,
        token_diff: tDiff,
        latency_diff: lDiff,
      });
    }
    const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
    const lines = [
      `Trace Comparison`,
      ``,
      `  Trace A: ${summaryA.trace.name} (${trace_id_a})`,
      `  Trace B: ${summaryB.trace.name} (${trace_id_b})`,
      ``,
      `Aggregate Diff (B - A):`,
      `  Steps:    ${sign(stepCountDiff)} (A=${summaryA.stepCount}, B=${summaryB.stepCount})`,
      `  Tokens:   ${sign(tokenDiff)} (A=${summaryA.totalTokens}, B=${summaryB.totalTokens})`,
      `  Latency:  ${sign(latencyDiff)}ms (A=${summaryA.totalLatencyMs}ms, B=${summaryB.totalLatencyMs}ms)`,
      ``,
      `Tool Coverage:`,
      `  In both:  ${inBoth.length > 0 ? inBoth.join(", ") : "(none)"}`,
      `  Only in A: ${onlyInA.length > 0 ? onlyInA.join(", ") : "(none)"}`,
      `  Only in B: ${onlyInB.length > 0 ? onlyInB.join(", ") : "(none)"}`,
      ``,
      `Step-by-Step (overlapping positions):`,
      ...stepDiffs.map((d) => {
        const toolPart = d.same_tool
          ? `  ${d.index}. ${d.tool_a} [same]`
          : `  ${d.index}. ${d.tool_a} → ${d.tool_b} [DIFFERENT]`;
        const extras = [];
        if (d.token_diff !== null) extras.push(`tokens ${sign(d.token_diff)}`);
        if (d.latency_diff !== null)
          extras.push(`latency ${sign(d.latency_diff)}ms`);
        return toolPart + (extras.length ? `  (${extras.join(", ")})` : "");
      }),
    ];
    const json = {
      trace_a: {
        id: trace_id_a,
        name: summaryA.trace.name,
        step_count: summaryA.stepCount,
        total_tokens: summaryA.totalTokens,
        total_latency_ms: summaryA.totalLatencyMs,
      },
      trace_b: {
        id: trace_id_b,
        name: summaryB.trace.name,
        step_count: summaryB.stepCount,
        total_tokens: summaryB.totalTokens,
        total_latency_ms: summaryB.totalLatencyMs,
      },
      diff: {
        step_count: stepCountDiff,
        total_tokens: tokenDiff,
        total_latency_ms: latencyDiff,
      },
      tools_only_in_a: onlyInA,
      tools_only_in_b: onlyInB,
      tools_in_both: inBoth,
      step_diffs: stepDiffs,
    };
    return {
      content: [
        { type: "text", text: lines.join("\n") },
        { type: "text", text: "\n\nJSON:\n" + JSON.stringify(json, null, 2) },
      ],
    };
  } catch (err) {
    if (err instanceof McpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to compare traces: ${message}`,
    );
  }
}
