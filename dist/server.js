import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, McpError, ErrorCode, } from "@modelcontextprotocol/sdk/types.js";
import { handleTraceStart, handleTraceStep, handleTraceEnd, } from "./tools/trace.js";
import { handleGetTraceSummary, handleListTraces } from "./tools/inspect.js";
import { handleExportDashboard } from "./tools/export.js";
import { handleCompareTraces } from "./tools/compare.js";
import { handleListResources, handleReadResource } from "./resources.js";
import { handleListPrompts, handleGetPrompt } from "./prompts.js";
import { computeSummary } from "./db.js";
import { saveAlertRules, initAlertRulesTable, loadAlertRules, checkAndAlert, } from "./alerting.js";
import { applyRetentionPolicy } from "./retention.js";
import { AuditLog } from "./audit-log.js";
import { DEFAULT_PRICING, estimateCost } from "./pricing.js";
import { getPackageVersion } from "./version.js";
import { safeNotify } from "./notifications.js";
import { exportOtlpDocument } from "./otel-exporter.js";
// Retention policy storage (in-memory; persisted across calls in the same process)
let _retentionDays = null;
// Alert channels storage. Rules are persisted in SQLite; channel URLs are
// process configuration (or environment variables) and are never persisted.
let _alertChannels = {
    slackWebhook: process.env.MCP_SLACK_WEBHOOK,
    genericWebhook: process.env.MCP_ALERT_WEBHOOK,
};
function createDefaultAuditLog() {
    try {
        return new AuditLog();
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[warn] Audit logging is unavailable: ${message}`);
        return null;
    }
}
function validateWebhookUrl(value, field) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || value.trim() === "") {
        throw new McpError(ErrorCode.InvalidParams, `${field} must be a non-empty http(s) URL when provided`);
    }
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new McpError(ErrorCode.InvalidParams, `${field} must be a valid http(s) URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new McpError(ErrorCode.InvalidParams, `${field} must use http or https`);
    }
    return value;
}
export function createServer(options) {
    const { db, noTokenCount } = options;
    const pricing = options.pricing ?? DEFAULT_PRICING;
    const auditLog = options.auditLog === null
        ? null
        : (options.auditLog ?? createDefaultAuditLog());
    let auditWarningLogged = false;
    const recordAudit = (entry) => {
        if (!auditLog)
            return;
        try {
            auditLog.record(entry);
        }
        catch (err) {
            if (!auditWarningLogged) {
                auditWarningLogged = true;
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[warn] Audit log write failed (${message}); tracing will continue`);
            }
        }
    };
    const server = new Server({ name: "mcp-agent-trace-inspector", version: getPackageVersion() }, { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} } });
    // ---- Resources ----
    server.setRequestHandler(ListResourcesRequestSchema, async () => handleListResources(db));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const uri = request.params.uri;
        return handleReadResource(db, uri);
    });
    // ---- Prompts ----
    server.setRequestHandler(ListPromptsRequestSchema, async () => handleListPrompts());
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        const { name, arguments: promptArgs } = request.params;
        return handleGetPrompt(name, promptArgs);
    });
    // ---- Tools ----
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "trace_start",
                description: 'Begin a new agent workflow trace. Returns a trace_id to use with subsequent calls. Example: { "name": "My Search Workflow" }. Pass "auto" or leave name blank for an auto-generated name.',
                annotations: {
                    destructiveHint: false,
                    readOnlyHint: false,
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string",
                            description: 'Human-readable name for this trace/workflow run. Example: "Product Search Workflow 2024-01-15". Pass "auto" to auto-generate.',
                        },
                    },
                    required: ["name"],
                    additionalProperties: false,
                },
            },
            {
                name: "trace_step",
                description: 'Record a single step within a running trace. Captures tool name, input, output, optional token count and latency. Steps cannot be added after trace_end. Example: { "trace_id": "abc-123", "tool_name": "web_search", "input": {"query": "hello"}, "output": {"results": ["a","b"]}, "token_count": 50, "latency_ms": 320 }',
                annotations: {
                    destructiveHint: false,
                    readOnlyHint: false,
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        trace_id: {
                            type: "string",
                            description: 'ID of the trace to record this step under. Example: "abc-123-def-456"',
                        },
                        tool_name: {
                            type: "string",
                            description: 'Name of the tool or action that was executed. Example: "web_search" or "llm_call"',
                        },
                        input: {
                            type: "object",
                            description: 'Input payload passed to the tool. Example: { "query": "weather in Paris" }',
                        },
                        output: {
                            type: "object",
                            description: 'Output/result returned by the tool. Example: { "result": "Sunny, 22°C" }. Add "error" field or "isError": true to flag errors.',
                        },
                        token_count: {
                            type: "number",
                            description: "Optional number of tokens consumed in this step. Example: 150",
                        },
                        latency_ms: {
                            type: "number",
                            description: "Optional wall-clock latency of this step in milliseconds. Example: 450",
                        },
                    },
                    required: ["trace_id", "tool_name", "input", "output"],
                    additionalProperties: false,
                },
            },
            {
                name: "trace_end",
                description: 'Mark a trace as completed and evaluate the currently configured alert rules. Further trace_step calls for this trace are rejected. Example: { "trace_id": "abc-123" }',
                annotations: {
                    destructiveHint: false,
                    readOnlyHint: false,
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        trace_id: {
                            type: "string",
                            description: 'ID of the trace to complete. Example: "abc-123-def-456"',
                        },
                    },
                    required: ["trace_id"],
                    additionalProperties: false,
                },
            },
            {
                name: "get_trace_summary",
                description: 'Retrieve a summary of a trace including step count, total tokens, total latency, cost estimate, and reasoning chain detection. Example: { "trace_id": "abc-123", "model": "claude-sonnet-4-6" }',
                annotations: {
                    destructiveHint: false,
                    readOnlyHint: true,
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        trace_id: {
                            type: "string",
                            description: 'ID of the trace to summarize. Example: "abc-123-def-456"',
                        },
                        model: {
                            type: "string",
                            description: 'Model name for cost estimation. Example: "claude-sonnet-4-6". Defaults to "claude-sonnet-4-6".',
                        },
                    },
                    required: ["trace_id"],
                    additionalProperties: false,
                },
            },
            {
                name: "list_traces",
                description: 'List all stored traces with their names, statuses, and timestamps. Example: { "limit": 10 } to get the 10 most recent traces.',
                annotations: {
                    destructiveHint: false,
                    readOnlyHint: true,
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        limit: {
                            type: "number",
                            description: "Maximum number of traces to return (most recent first). Example: 20. Omit for all.",
                        },
                    },
                    additionalProperties: false,
                },
            },
            {
                name: "export_dashboard",
                description: 'Generate a self-contained HTML dashboard for a trace with error highlighting and latency waterfall visualization. Returns the full HTML as a string. Example: { "trace_id": "abc-123" }',
                annotations: {
                    destructiveHint: false,
                    readOnlyHint: true,
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        trace_id: {
                            type: "string",
                            description: 'ID of the trace to export. Example: "abc-123-def-456"',
                        },
                    },
                    required: ["trace_id"],
                    additionalProperties: false,
                },
            },
            {
                name: "compare_traces",
                description: 'Compare two traces side by side: step counts, tokens, latency, and step-by-step differences. Example: { "trace_id_a": "abc-123", "trace_id_b": "def-456" }',
                annotations: {
                    destructiveHint: false,
                    readOnlyHint: true,
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        trace_id_a: {
                            type: "string",
                            description: 'ID of the first trace (baseline). Example: "abc-123"',
                        },
                        trace_id_b: {
                            type: "string",
                            description: 'ID of the second trace (to compare against). Example: "def-456"',
                        },
                    },
                    required: ["trace_id_a", "trace_id_b"],
                    additionalProperties: false,
                },
            },
            {
                name: "extract_reasoning_chain",
                description: 'Extract only the reasoning/thinking steps from a trace. Returns steps whose tool_name matches reasoning patterns (reason, think, plan, reflect, analyz, consider) or whose input/output content includes the word "think". Example: { "trace_id": "abc-123" }',
                annotations: {
                    destructiveHint: false,
                    readOnlyHint: true,
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        trace_id: {
                            type: "string",
                            description: 'ID of the trace to extract reasoning from. Example: "abc-123-def-456"',
                        },
                    },
                    required: ["trace_id"],
                    additionalProperties: false,
                },
            },
            {
                name: "export_otel",
                description: 'Export trace(s) as an OTLP/JSON document (resourceSpans → scopeSpans → spans) suitable for an OTLP collector or backend. Omit trace_id to export all traces. Example: { "format": "json" } or { "trace_id": "abc-123", "format": "json" }',
                annotations: {
                    destructiveHint: false,
                    readOnlyHint: true,
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        trace_id: {
                            type: "string",
                            description: "Optional trace ID to export. Omit to export all traces.",
                        },
                        format: {
                            type: "string",
                            enum: ["json"],
                            description: 'Export format. Currently only "json" is supported.',
                        },
                    },
                    required: ["format"],
                    additionalProperties: false,
                },
            },
            {
                name: "configure_alerts",
                description: 'Persist alert rules for latency, error rate, or cost thresholds. Rules are evaluated on trace_end; optional Slack or generic webhooks deliver fired alerts. Example: { "rules": [{"type":"latency","threshold":1000}], "slack_webhook": "https://hooks.slack.com/..." }',
                annotations: {
                    destructiveHint: false,
                    readOnlyHint: false,
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        rules: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    type: {
                                        type: "string",
                                        enum: ["latency", "error_rate", "cost"],
                                    },
                                    threshold: { type: "number" },
                                },
                                required: ["type", "threshold"],
                            },
                            description: "Array of alert rules to configure.",
                        },
                        slack_webhook: {
                            type: "string",
                            description: "Optional Slack webhook URL for Slack block notifications.",
                        },
                        webhook_url: {
                            type: "string",
                            description: "Optional generic webhook URL for JSON POST notifications.",
                        },
                    },
                    required: ["rules"],
                    additionalProperties: false,
                },
            },
            {
                name: "set_retention_policy",
                description: 'Set the trace retention policy (how many days to keep traces before archiving). Example: { "retention_days": 30 }',
                annotations: {
                    destructiveHint: false,
                    readOnlyHint: false,
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        retention_days: {
                            type: "number",
                            description: "Number of days to retain traces before archiving. Must be > 0.",
                        },
                    },
                    required: ["retention_days"],
                    additionalProperties: false,
                },
            },
            {
                name: "apply_retention",
                description: "Apply the current in-process retention policy: archives traces older than retention_days and deletes archived traces past 2× threshold. Call set_retention_policy first. Example: {}",
                annotations: {
                    destructiveHint: true,
                    readOnlyHint: false,
                },
                inputSchema: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
            },
            {
                name: "export_compliance_log",
                description: 'Export the compliance audit log as JSON or CSV. Example: { "format": "json" } or { "format": "csv", "from_date": "2025-01-01", "to_date": "2025-12-31" }',
                annotations: {
                    destructiveHint: false,
                    readOnlyHint: true,
                },
                inputSchema: {
                    type: "object",
                    properties: {
                        from_date: {
                            type: "string",
                            description: "Optional ISO date string to filter entries from (inclusive).",
                        },
                        to_date: {
                            type: "string",
                            description: "Optional ISO date string to filter entries to (inclusive).",
                        },
                        format: {
                            type: "string",
                            enum: ["json", "csv"],
                            description: 'Output format: "json" or "csv".',
                        },
                    },
                    required: ["format"],
                    additionalProperties: false,
                },
            },
        ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const safeArgs = (args ?? {});
        try {
            switch (name) {
                case "trace_start": {
                    const result = handleTraceStart(db, {
                        name: safeArgs.name,
                    });
                    const startData = JSON.parse(result.content[0].text);
                    await safeNotify(server, {
                        method: "notifications/message",
                        params: {
                            level: "info",
                            logger: "trace_start",
                            data: `Trace started: name="${startData.name}" trace_id=${startData.trace_id}`,
                        },
                    });
                    return result;
                }
                case "trace_step": {
                    const result = handleTraceStep(db, {
                        trace_id: safeArgs.trace_id,
                        tool_name: safeArgs.tool_name,
                        input: safeArgs.input,
                        output: safeArgs.output,
                        token_count: safeArgs.token_count !== undefined
                            ? safeArgs.token_count
                            : undefined,
                        latency_ms: safeArgs.latency_ms !== undefined
                            ? safeArgs.latency_ms
                            : undefined,
                    }, noTokenCount);
                    // Emit debug notification for each recorded step
                    const stepData = JSON.parse(result.content[0].text);
                    await safeNotify(server, {
                        method: "notifications/message",
                        params: {
                            level: "debug",
                            logger: "trace_step",
                            data: `Step recorded: tool="${stepData.tool_name}" step_id=${stepData.step_id}`,
                        },
                    });
                    // Record to the compliance audit log using the effective token count
                    // (either caller-supplied or computed by the token counter).
                    const tokenCount = stepData.token_count ?? 0;
                    const costUsd = tokenCount > 0
                        ? (estimateCost(tokenCount, "claude-sonnet-4-6", pricing) ?? 0)
                        : 0;
                    recordAudit({
                        timestamp: new Date().toISOString(),
                        trace_id: safeArgs.trace_id,
                        tool_name: safeArgs.tool_name,
                        user_id: "",
                        token_count: tokenCount,
                        cost_usd: Math.round(costUsd * 1e6) / 1e6,
                    });
                    return result;
                }
                case "trace_end": {
                    const result = handleTraceEnd(db, {
                        trace_id: safeArgs.trace_id,
                    });
                    const endData = JSON.parse(result.content[0].text);
                    // Evaluate persisted alert rules once, on the transition to
                    // completed. Evaluation failures must not fail trace recording.
                    let fired = [];
                    if (!endData.already_completed) {
                        try {
                            const rules = loadAlertRules(db);
                            if (rules.length > 0) {
                                fired = await checkAndAlert(db, rules, _alertChannels);
                            }
                        }
                        catch (err) {
                            const message = err instanceof Error ? err.message : String(err);
                            console.error(`[warn] Alert evaluation failed: ${message}`);
                        }
                    }
                    await safeNotify(server, {
                        method: "notifications/message",
                        params: {
                            level: "info",
                            logger: "trace_end",
                            data: `Trace completed: trace_id=${endData.trace_id} duration=${endData.duration_ms}ms alerts_fired=${fired.length}`,
                        },
                    });
                    if (fired.length > 0) {
                        await safeNotify(server, {
                            method: "notifications/message",
                            params: {
                                level: "warning",
                                logger: "alerting",
                                data: `Alerts fired: ${fired.map((a) => `${a.rule.type}=${a.value.toFixed(2)}`).join(", ")}`,
                            },
                        });
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    ...endData,
                                    alerts_fired: fired.length,
                                    alerts: fired.map((a) => ({
                                        type: a.rule.type,
                                        threshold: a.rule.threshold,
                                        value: a.value,
                                        message: a.message,
                                    })),
                                }),
                            },
                        ],
                    };
                }
                case "get_trace_summary":
                    return handleGetTraceSummary(db, {
                        trace_id: safeArgs.trace_id,
                        model: safeArgs.model !== undefined
                            ? safeArgs.model
                            : undefined,
                    }, pricing);
                case "list_traces":
                    return handleListTraces(db, {
                        limit: safeArgs.limit !== undefined
                            ? safeArgs.limit
                            : undefined,
                    });
                case "export_dashboard":
                    return handleExportDashboard(db, {
                        trace_id: safeArgs.trace_id,
                    }, server, request.params._meta?.progressToken);
                case "compare_traces": {
                    const result = handleCompareTraces(db, {
                        trace_id_a: safeArgs.trace_id_a,
                        trace_id_b: safeArgs.trace_id_b,
                    });
                    await safeNotify(server, {
                        method: "notifications/message",
                        params: {
                            level: "info",
                            logger: "compare_traces",
                            data: `Traces compared: a=${safeArgs.trace_id_a} b=${safeArgs.trace_id_b}`,
                        },
                    });
                    return result;
                }
                case "extract_reasoning_chain": {
                    const traceId = safeArgs.trace_id;
                    if (!traceId || typeof traceId !== "string") {
                        throw new McpError(ErrorCode.InvalidParams, "trace_id must be a non-empty string");
                    }
                    const summary = computeSummary(db, traceId);
                    if (!summary) {
                        throw new McpError(ErrorCode.InvalidParams, `Unknown trace_id: ${traceId}`);
                    }
                    const REASONING_PATTERNS = /reason|think|plan|reflect|analyz|consider/i;
                    const reasoningSteps = summary.steps.filter((s) => {
                        if (REASONING_PATTERNS.test(s.tool_name))
                            return true;
                        // Also check input/output content for "think"
                        const content = s.input_json + " " + s.output_json;
                        return /think/i.test(content);
                    });
                    await safeNotify(server, {
                        method: "notifications/message",
                        params: {
                            level: "info",
                            logger: "extract_reasoning_chain",
                            data: `Extracted ${reasoningSteps.length} reasoning step(s) from trace_id=${traceId}`,
                        },
                    });
                    const json = {
                        trace_id: traceId,
                        reasoning_step_count: reasoningSteps.length,
                        steps: reasoningSteps.map((s, i) => ({
                            index: i + 1,
                            step_id: s.id,
                            tool_name: s.tool_name,
                            input: (() => {
                                try {
                                    return JSON.parse(s.input_json);
                                }
                                catch {
                                    return s.input_json;
                                }
                            })(),
                            output: (() => {
                                try {
                                    return JSON.parse(s.output_json);
                                }
                                catch {
                                    return s.output_json;
                                }
                            })(),
                            token_count: s.token_count,
                            latency_ms: s.latency_ms,
                            created_at: s.created_at,
                        })),
                    };
                    const textLines = [
                        `Reasoning Chain for trace: ${summary.trace.name}`,
                        `  Trace ID: ${traceId}`,
                        `  Reasoning steps: ${reasoningSteps.length} / ${summary.stepCount} total`,
                        "",
                        ...reasoningSteps.map((s, i) => `  ${i + 1}. [${s.tool_name}]` +
                            (s.latency_ms != null ? ` ${s.latency_ms}ms` : "") +
                            (s.token_count != null ? ` ${s.token_count} tokens` : "")),
                    ];
                    return {
                        content: [
                            { type: "text", text: textLines.join("\n") },
                            {
                                type: "text",
                                text: "\n\nJSON:\n" + JSON.stringify(json, null, 2),
                            },
                        ],
                    };
                }
                case "export_otel": {
                    const format = safeArgs.format;
                    if (format !== undefined && format !== "json") {
                        throw new McpError(ErrorCode.InvalidParams, 'format must be "json"');
                    }
                    const traceId = safeArgs.trace_id !== undefined
                        ? safeArgs.trace_id
                        : undefined;
                    if (traceId !== undefined &&
                        (typeof traceId !== "string" || traceId.trim() === "")) {
                        throw new McpError(ErrorCode.InvalidParams, "trace_id must be a non-empty string when provided");
                    }
                    if (traceId !== undefined) {
                        const summary = computeSummary(db, traceId);
                        if (!summary) {
                            throw new McpError(ErrorCode.InvalidParams, `Unknown trace_id: ${traceId}`);
                        }
                    }
                    const document = exportOtlpDocument(db, traceId);
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(document, null, 2),
                            },
                        ],
                    };
                }
                case "configure_alerts": {
                    const rawRules = safeArgs.rules;
                    if (!Array.isArray(rawRules)) {
                        throw new McpError(ErrorCode.InvalidParams, "rules must be an array");
                    }
                    const validTypes = new Set(["latency", "error_rate", "cost"]);
                    const rules = rawRules.map((rawRule, index) => {
                        if (typeof rawRule !== "object" ||
                            rawRule === null ||
                            Array.isArray(rawRule)) {
                            throw new McpError(ErrorCode.InvalidParams, `rules[${index}] must be an object`);
                        }
                        const { type, threshold } = rawRule;
                        if (typeof type !== "string" || !validTypes.has(type)) {
                            throw new McpError(ErrorCode.InvalidParams, `rules[${index}].type must be one of: latency, error_rate, cost`);
                        }
                        if (typeof threshold !== "number" ||
                            !Number.isFinite(threshold) ||
                            threshold < 0) {
                            throw new McpError(ErrorCode.InvalidParams, `rules[${index}].threshold must be a finite, non-negative number`);
                        }
                        return {
                            type: type,
                            threshold,
                        };
                    });
                    const slackWebhook = validateWebhookUrl(safeArgs.slack_webhook, "slack_webhook");
                    const webhookUrl = validateWebhookUrl(safeArgs.webhook_url, "webhook_url");
                    initAlertRulesTable(db);
                    saveAlertRules(db, rules);
                    // Preserve previously configured channels when only rules are
                    // updated; omitted URLs do not silently clear delivery targets.
                    _alertChannels = {
                        slackWebhook: slackWebhook ?? _alertChannels.slackWebhook,
                        genericWebhook: webhookUrl ?? _alertChannels.genericWebhook,
                    };
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    status: "ok",
                                    rules_saved: rules.length,
                                    channels: {
                                        slack: !!_alertChannels.slackWebhook,
                                        generic: !!_alertChannels.genericWebhook,
                                    },
                                }),
                            },
                        ],
                    };
                }
                case "set_retention_policy": {
                    const retentionDays = safeArgs.retention_days;
                    if (typeof retentionDays !== "number" ||
                        !Number.isFinite(retentionDays) ||
                        retentionDays <= 0) {
                        throw new McpError(ErrorCode.InvalidParams, "retention_days must be a positive number");
                    }
                    _retentionDays = retentionDays;
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    status: "ok",
                                    retention_days: retentionDays,
                                }),
                            },
                        ],
                    };
                }
                case "apply_retention": {
                    if (_retentionDays === null) {
                        throw new McpError(ErrorCode.InvalidParams, "No retention policy set. Call set_retention_policy first.");
                    }
                    const retResult = applyRetentionPolicy(db, _retentionDays);
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    status: "ok",
                                    retention_days: _retentionDays,
                                    ...retResult,
                                }),
                            },
                        ],
                    };
                }
                case "export_compliance_log": {
                    const fromDate = safeArgs.from_date !== undefined
                        ? safeArgs.from_date
                        : undefined;
                    const toDate = safeArgs.to_date !== undefined
                        ? safeArgs.to_date
                        : undefined;
                    const format = safeArgs.format;
                    if (format !== "json" && format !== "csv") {
                        throw new McpError(ErrorCode.InvalidParams, 'format must be "json" or "csv"');
                    }
                    for (const [field, value] of [
                        ["from_date", fromDate],
                        ["to_date", toDate],
                    ]) {
                        if (value !== undefined) {
                            if (typeof value !== "string" ||
                                Number.isNaN(Date.parse(value))) {
                                throw new McpError(ErrorCode.InvalidParams, `${field} must be a valid ISO date string`);
                            }
                        }
                    }
                    if (!auditLog) {
                        throw new McpError(ErrorCode.InternalError, "Audit log is unavailable; check MCP_AUDIT_LOG_PATH and its permissions");
                    }
                    const entries = auditLog.export(fromDate, toDate);
                    if (format === "csv") {
                        const header = "timestamp,trace_id,tool_name,user_id,token_count,cost_usd";
                        const rows = entries.map((e) => [
                            e.timestamp,
                            e.trace_id,
                            e.tool_name,
                            e.user_id,
                            e.token_count,
                            e.cost_usd,
                        ]
                            .map((v) => JSON.stringify(v))
                            .join(","));
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: [header, ...rows].join("\n"),
                                },
                            ],
                        };
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(entries, null, 2),
                            },
                        ],
                    };
                }
                default:
                    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
            }
        }
        catch (err) {
            if (err instanceof McpError)
                throw err;
            const message = err instanceof Error ? err.message : String(err);
            throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${message}`);
        }
    });
    return server;
}
