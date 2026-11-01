import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
const ANALYZE_TRACE_PROMPT = `You are an expert in analyzing AI agent workflow traces.

Given the trace data for trace_id: {{trace_id}}, please perform a thorough investigation:

1. **Overview**: Summarize what the agent was trying to accomplish based on the tool names and inputs.

2. **Performance Analysis**:
   - Identify the slowest steps (highest latency_ms) and explain potential causes.
   - Highlight any steps with unusually high token consumption.
   - Calculate and comment on the total cost if pricing data is available.

3. **Error Detection**:
   - Flag any steps where the output contains an error field or isError flag.
   - Suggest remediation for each error found.

4. **Reasoning Chain**:
   - Detect if the agent follows a prompt→reasoning→action pattern.
   - Assess whether the reasoning steps appear logically sound given the inputs.

5. **Optimization Opportunities**:
   - Identify redundant steps (same tool called multiple times with similar inputs).
   - Suggest steps that could be parallelized.
   - Recommend caching opportunities.

6. **Overall Assessment**:
   - Rate the trace quality (1–5) on: efficiency, error handling, and goal completion.
   - Provide 3 specific, actionable recommendations to improve this workflow.

Use the get_trace_summary tool with trace_id={{trace_id}} to fetch the data before beginning your analysis.`;
export function handleListPrompts() {
    return {
        prompts: [
            {
                name: "analyze-trace",
                description: "Guide an investigation of a completed agent trace — surfaces performance bottlenecks, errors, reasoning chains, and optimization opportunities.",
                arguments: [
                    {
                        name: "trace_id",
                        description: "The ID of the trace to analyze.",
                        required: true,
                    },
                ],
            },
        ],
    };
}
export function handleGetPrompt(name, args) {
    if (name !== "analyze-trace") {
        throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
    }
    const traceId = args?.trace_id ?? "<trace_id>";
    const promptText = ANALYZE_TRACE_PROMPT.replace(/{{trace_id}}/g, traceId);
    return {
        description: "Analyze an agent trace for performance, errors, reasoning chains, and optimization opportunities.",
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: promptText,
                },
            },
        ],
    };
}
