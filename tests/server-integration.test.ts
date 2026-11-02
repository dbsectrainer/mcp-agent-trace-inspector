/**
 * Integration tests for server.ts using InMemoryTransport + MCP Client.
 * These tests exercise the actual handler closures registered in createServer.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { insertTrace, insertStep, endTrace } from "../src/db.js";
import { AuditLog } from "../src/audit-log.js";
import { getPackageVersion } from "../src/version.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS traces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      metadata TEXT
    );
    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT NOT NULL,
      token_count INTEGER,
      latency_ms INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (trace_id) REFERENCES traces(id)
    );
  `);
  return db;
}

async function createConnectedPair(
  db: DatabaseSync,
  noTokenCount = false,
  options: { auditLog?: AuditLog | null } = {},
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const auditDir = mkdtempSync(join(tmpdir(), "trace-inspector-audit-"));
  const auditLog =
    options.auditLog === null
      ? null
      : (options.auditLog ?? new AuditLog(join(auditDir, "audit.jsonl")));
  const server = createServer({
    db,
    noTokenCount,
    auditLog,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} },
  );

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    cleanup: async () => {
      await client.close();
      rmSync(auditDir, { recursive: true, force: true });
    },
  };
}

describe("server integration via InMemoryTransport", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("lists tools via ListTools", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      const response = await client.listTools();
      const names = response.tools.map((t) => t.name);
      expect(names).toContain("trace_start");
      expect(names).toContain("trace_step");
      expect(names).toContain("trace_end");
      expect(names).toContain("get_trace_summary");
      expect(names).toContain("list_traces");
      expect(names).toContain("export_dashboard");
      expect(names).toContain("compare_traces");
      expect(names).toContain("extract_reasoning_chain");
    } finally {
      await cleanup();
    }
  });

  it("advertises the package version during initialize", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      expect(client.getServerVersion()?.version).toBe(getPackageVersion());
      expect(client.getServerVersion()?.name).toBe("mcp-agent-trace-inspector");
    } finally {
      await cleanup();
    }
  });

  it("calls trace_start tool", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      const result = await client.callTool({
        name: "trace_start",
        arguments: { name: "Integration Test" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      const parsed = JSON.parse(text) as {
        trace_id: string;
        name: string;
        status: string;
      };
      expect(parsed.trace_id).toBeDefined();
      expect(parsed.name).toBe("Integration Test");
      expect(parsed.status).toBe("running");
    } finally {
      await cleanup();
    }
  });

  it("calls trace_start with auto name", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      const result = await client.callTool({
        name: "trace_start",
        arguments: { name: "auto" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      const parsed = JSON.parse(text) as { trace_id: string; name: string };
      expect(parsed.name).toMatch(/^trace-/);
    } finally {
      await cleanup();
    }
  });

  it("calls trace_step tool", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      const startResult = await client.callTool({
        name: "trace_start",
        arguments: { name: "Step Integration" },
      });
      const startText = (
        startResult.content as Array<{ type: string; text: string }>
      )[0].text;
      const { trace_id } = JSON.parse(startText) as { trace_id: string };

      const stepResult = await client.callTool({
        name: "trace_step",
        arguments: {
          trace_id,
          tool_name: "reasoning_tool",
          input: { query: "how to think" },
          output: { answer: "carefully" },
          token_count: 25,
          latency_ms: 75,
        },
      });
      const stepText = (
        stepResult.content as Array<{ type: string; text: string }>
      )[0].text;
      const parsed = JSON.parse(stepText) as {
        step_id: string;
        tool_name: string;
      };
      expect(parsed.step_id).toBeDefined();
      expect(parsed.tool_name).toBe("reasoning_tool");
    } finally {
      await cleanup();
    }
  });

  it("calls trace_step with noTokenCount=true", async () => {
    const { client, cleanup } = await createConnectedPair(db, true);
    try {
      const startResult = await client.callTool({
        name: "trace_start",
        arguments: { name: "No Token Count" },
      });
      const startText = (
        startResult.content as Array<{ type: string; text: string }>
      )[0].text;
      const { trace_id } = JSON.parse(startText) as { trace_id: string };

      const stepResult = await client.callTool({
        name: "trace_step",
        arguments: {
          trace_id,
          tool_name: "some_tool",
          input: {},
          output: {},
          token_count: 999,
          latency_ms: 100,
        },
      });
      const stepText = (
        stepResult.content as Array<{ type: string; text: string }>
      )[0].text;
      const parsed = JSON.parse(stepText) as { token_count: null };
      expect(parsed.token_count).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("calls trace_end tool", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      const startResult = await client.callTool({
        name: "trace_start",
        arguments: { name: "End Integration" },
      });
      const { trace_id } = JSON.parse(
        (startResult.content as Array<{ type: string; text: string }>)[0].text,
      ) as { trace_id: string };

      const endResult = await client.callTool({
        name: "trace_end",
        arguments: { trace_id },
      });
      const endText = (
        endResult.content as Array<{ type: string; text: string }>
      )[0].text;
      const parsed = JSON.parse(endText) as { status: string };
      expect(parsed.status).toBe("completed");
    } finally {
      await cleanup();
    }
  });

  it("calls get_trace_summary tool", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      insertTrace(db, "summary-int", "Summary Integration");
      insertStep(db, {
        id: "si1",
        trace_id: "summary-int",
        tool_name: "plan_step",
        input_json: "{}",
        output_json: "{}",
        token_count: 50,
        latency_ms: 200,
      });
      endTrace(db, "summary-int");

      const result = await client.callTool({
        name: "get_trace_summary",
        arguments: { trace_id: "summary-int", model: "claude-sonnet-4-6" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain("Summary Integration");
      expect(text).toContain("completed");
    } finally {
      await cleanup();
    }
  });

  it("calls list_traces tool", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      insertTrace(db, "lt1", "List Trace One");
      insertTrace(db, "lt2", "List Trace Two");

      const result = await client.callTool({
        name: "list_traces",
        arguments: { limit: 10 },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain("List Trace One");
      expect(text).toContain("List Trace Two");
    } finally {
      await cleanup();
    }
  });

  it("calls list_traces with no arguments", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      insertTrace(db, "lt3", "Trace Three");

      const result = await client.callTool({
        name: "list_traces",
        arguments: {},
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain("Trace Three");
    } finally {
      await cleanup();
    }
  });

  it("calls export_dashboard tool", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      insertTrace(db, "exp-int", "Export Integration");
      insertStep(db, {
        id: "ei1",
        trace_id: "exp-int",
        tool_name: "reflect_tool",
        input_json: JSON.stringify({ x: 1 }),
        output_json: JSON.stringify({ y: 2 }),
        token_count: 30,
        latency_ms: 90,
      });

      const result = await client.callTool({
        name: "export_dashboard",
        arguments: { trace_id: "exp-int" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain("<!DOCTYPE html>");
      expect(text).toContain("Export Integration");
    } finally {
      await cleanup();
    }
  });

  it("calls compare_traces tool", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      insertTrace(db, "cmp-int-a", "Compare A");
      insertTrace(db, "cmp-int-b", "Compare B");
      insertStep(db, {
        id: "ca1",
        trace_id: "cmp-int-a",
        tool_name: "tool_x",
        input_json: "{}",
        output_json: "{}",
        token_count: 10,
        latency_ms: 50,
      });

      const result = await client.callTool({
        name: "compare_traces",
        arguments: { trace_id_a: "cmp-int-a", trace_id_b: "cmp-int-b" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain("Trace Comparison");
      expect(text).toContain("Compare A");
      expect(text).toContain("Compare B");
    } finally {
      await cleanup();
    }
  });

  it("calls extract_reasoning_chain tool with reasoning steps", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      insertTrace(db, "rc-int", "Reasoning Chain Integration");
      insertStep(db, {
        id: "rc1",
        trace_id: "rc-int",
        tool_name: "thinking_module",
        input_json: JSON.stringify({ context: "analyze this" }),
        output_json: JSON.stringify({ thought: "I should plan first" }),
        token_count: 40,
        latency_ms: 120,
      });
      insertStep(db, {
        id: "rc2",
        trace_id: "rc-int",
        tool_name: "plan_and_reason",
        input_json: JSON.stringify({ task: "build a report" }),
        output_json: JSON.stringify({ steps: ["gather", "analyze", "write"] }),
        token_count: 60,
        latency_ms: 180,
      });
      insertStep(db, {
        id: "rc3",
        trace_id: "rc-int",
        tool_name: "file_reader",
        input_json: JSON.stringify({ path: "/data/file.txt" }),
        output_json: JSON.stringify({ content: "some content" }),
        token_count: 15,
        latency_ms: 30,
      });

      const result = await client.callTool({
        name: "extract_reasoning_chain",
        arguments: { trace_id: "rc-int" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain("Reasoning Chain");
      expect(text).toContain("thinking_module");
      expect(text).toContain("plan_and_reason");

      const jsonText = (
        result.content as Array<{ type: string; text: string }>
      )[1].text;
      const json = JSON.parse(jsonText.replace("\n\nJSON:\n", "")) as {
        reasoning_step_count: number;
        steps: Array<{ tool_name: string }>;
      };
      expect(json.reasoning_step_count).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("calls extract_reasoning_chain with empty trace", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      insertTrace(db, "empty-rc", "Empty Reasoning Chain");

      const result = await client.callTool({
        name: "extract_reasoning_chain",
        arguments: { trace_id: "empty-rc" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(text).toContain("0 / 0 total");
    } finally {
      await cleanup();
    }
  });

  it("extract_reasoning_chain detects 'think' in content", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      insertTrace(db, "think-content", "Think in Content");
      insertStep(db, {
        id: "tc1",
        trace_id: "think-content",
        tool_name: "llm_inference",
        input_json: JSON.stringify({ prompt: "think step by step" }),
        output_json: JSON.stringify({ result: "done" }),
        token_count: 25,
        latency_ms: 80,
      });

      const result = await client.callTool({
        name: "extract_reasoning_chain",
        arguments: { trace_id: "think-content" },
      });
      const jsonText = (
        result.content as Array<{ type: string; text: string }>
      )[1].text;
      const json = JSON.parse(jsonText.replace("\n\nJSON:\n", "")) as {
        reasoning_step_count: number;
      };
      // llm_inference doesn't match reasoning pattern by name, but input contains "think"
      expect(json.reasoning_step_count).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("extract_reasoning_chain throws McpError for unknown trace_id", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      await expect(
        client.callTool({
          name: "extract_reasoning_chain",
          arguments: { trace_id: "nonexistent-trace" },
        }),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("trace_step throws McpError for nonexistent trace_id", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      await expect(
        client.callTool({
          name: "trace_step",
          arguments: {
            trace_id: "nonexistent",
            tool_name: "tool",
            input: {},
            output: {},
          },
        }),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("trace_end throws McpError for unknown trace_id", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      await expect(
        client.callTool({
          name: "trace_end",
          arguments: { trace_id: "no-such-trace" },
        }),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("export_dashboard throws McpError for unknown trace_id", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      await expect(
        client.callTool({
          name: "export_dashboard",
          arguments: { trace_id: "no-such-trace" },
        }),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("unknown tool throws McpError", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      await expect(
        client.callTool({
          name: "nonexistent_tool",
          arguments: {},
        }),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("lists resources", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      const result = await client.listResources();
      expect(result.resources).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("lists prompts", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      const result = await client.listPrompts();
      expect(result.prompts).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("evaluates configured alert rules on trace_end", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      await client.callTool({
        name: "configure_alerts",
        arguments: {
          rules: [{ type: "error_rate", threshold: 0 }],
        },
      });

      const startResult = await client.callTool({
        name: "trace_start",
        arguments: { name: "Alert Integration" },
      });
      const { trace_id } = JSON.parse(
        (startResult.content as Array<{ type: string; text: string }>)[0].text,
      ) as { trace_id: string };

      await client.callTool({
        name: "trace_step",
        arguments: {
          trace_id,
          tool_name: "failing_tool",
          input: {},
          output: { error: "boom" },
          token_count: 10,
          latency_ms: 100,
        },
      });

      const endResult = await client.callTool({
        name: "trace_end",
        arguments: { trace_id },
      });
      const endData = JSON.parse(
        (endResult.content as Array<{ type: string; text: string }>)[0].text,
      ) as {
        status: string;
        alerts_fired: number;
        alerts: Array<{ type: string }>;
      };

      expect(endData.status).toBe("completed");
      expect(endData.alerts_fired).toBe(1);
      expect(endData.alerts[0].type).toBe("error_rate");
    } finally {
      await cleanup();
    }
  });

  it("exports an OTLP/JSON document with resourceSpans", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      const startResult = await client.callTool({
        name: "trace_start",
        arguments: { name: "OTLP Integration" },
      });
      const { trace_id } = JSON.parse(
        (startResult.content as Array<{ type: string; text: string }>)[0].text,
      ) as { trace_id: string };

      await client.callTool({
        name: "trace_step",
        arguments: {
          trace_id,
          tool_name: "search",
          input: { q: "x" },
          output: { ok: true },
          token_count: 5,
          latency_ms: 25,
        },
      });
      await client.callTool({
        name: "trace_end",
        arguments: { trace_id },
      });

      const otlpResult = await client.callTool({
        name: "export_otel",
        arguments: { format: "json", trace_id },
      });
      const document = JSON.parse(
        (otlpResult.content as Array<{ type: string; text: string }>)[0].text,
      ) as {
        resourceSpans: Array<{
          resource: { attributes: Array<{ key: string }> };
          scopeSpans: Array<{
            spans: Array<{ name: string; traceId: string }>;
          }>;
        }>;
      };

      expect(document.resourceSpans).toHaveLength(1);
      expect(document.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
      expect(
        document.resourceSpans[0].resource.attributes.map((a) => a.key),
      ).toContain("service.name");
    } finally {
      await cleanup();
    }
  });

  it("writes and exports the compliance audit log", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      const startResult = await client.callTool({
        name: "trace_start",
        arguments: { name: "Audit Integration" },
      });
      const { trace_id } = JSON.parse(
        (startResult.content as Array<{ type: string; text: string }>)[0].text,
      ) as { trace_id: string };

      await client.callTool({
        name: "trace_step",
        arguments: {
          trace_id,
          tool_name: "audited_tool",
          input: {},
          output: {},
          token_count: 42,
          latency_ms: 12,
        },
      });

      const auditResult = await client.callTool({
        name: "export_compliance_log",
        arguments: { format: "json" },
      });
      const entries = JSON.parse(
        (auditResult.content as Array<{ type: string; text: string }>)[0].text,
      ) as Array<{ trace_id: string; tool_name: string; token_count: number }>;

      expect(entries).toHaveLength(1);
      expect(entries[0].trace_id).toBe(trace_id);
      expect(entries[0].tool_name).toBe("audited_tool");
      expect(entries[0].token_count).toBe(42);
    } finally {
      await cleanup();
    }
  });

  it("rejects invalid tool arguments with InvalidParams", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      await expect(
        client.callTool({
          name: "trace_start",
          arguments: { name: 42 },
        }),
      ).rejects.toThrow();

      await expect(
        client.callTool({
          name: "list_traces",
          arguments: { limit: 1.5 },
        }),
      ).rejects.toThrow();

      await expect(
        client.callTool({
          name: "get_trace_summary",
          arguments: { trace_id: "missing", model: "  " },
        }),
      ).rejects.toThrow();

      await expect(
        client.callTool({
          name: "configure_alerts",
          arguments: { rules: "not-an-array" },
        }),
      ).rejects.toThrow();

      await expect(
        client.callTool({
          name: "configure_alerts",
          arguments: { rules: [{ type: "unknown", threshold: 1 }] },
        }),
      ).rejects.toThrow();

      await expect(
        client.callTool({
          name: "configure_alerts",
          arguments: { rules: [{ type: "latency", threshold: "fast" }] },
        }),
      ).rejects.toThrow();

      await expect(
        client.callTool({
          name: "configure_alerts",
          arguments: {
            rules: [{ type: "latency", threshold: 1 }],
            slack_webhook: "ftp://example.com/hook",
          },
        }),
      ).rejects.toThrow();

      await expect(
        client.callTool({
          name: "export_otel",
          arguments: { format: "xml" },
        }),
      ).rejects.toThrow();

      await expect(
        client.callTool({
          name: "export_otel",
          arguments: { format: "json", trace_id: "missing" },
        }),
      ).rejects.toThrow();

      await expect(
        client.callTool({
          name: "export_compliance_log",
          arguments: { format: "xml" },
        }),
      ).rejects.toThrow();

      await expect(
        client.callTool({
          name: "export_compliance_log",
          arguments: { format: "json", from_date: "not-a-date" },
        }),
      ).rejects.toThrow();

      await expect(
        client.callTool({
          name: "set_retention_policy",
          arguments: { retention_days: 0 },
        }),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("reports an error when the audit log is unavailable", async () => {
    const { client, cleanup } = await createConnectedPair(db, false, {
      auditLog: null,
    });
    try {
      await expect(
        client.callTool({
          name: "export_compliance_log",
          arguments: { format: "json" },
        }),
      ).rejects.toThrow(/Audit log is unavailable/);
    } finally {
      await cleanup();
    }
  });

  it("supports the retention policy lifecycle", async () => {
    const { client, cleanup } = await createConnectedPair(db);
    try {
      const setResult = await client.callTool({
        name: "set_retention_policy",
        arguments: { retention_days: 30 },
      });
      const setData = JSON.parse(
        (setResult.content as Array<{ type: string; text: string }>)[0].text,
      ) as { status: string; retention_days: number };
      expect(setData).toEqual({ status: "ok", retention_days: 30 });

      const applyResult = await client.callTool({
        name: "apply_retention",
        arguments: {},
      });
      const applyData = JSON.parse(
        (applyResult.content as Array<{ type: string; text: string }>)[0].text,
      ) as { status: string; retention_days: number; archived: number };
      expect(applyData.status).toBe("ok");
      expect(applyData.retention_days).toBe(30);
      expect(applyData.archived).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
