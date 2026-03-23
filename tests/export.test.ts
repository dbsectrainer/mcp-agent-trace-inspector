import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { insertTrace, insertStep, endTrace } from "../src/db.js";
import { handleExportDashboard } from "../src/tools/export.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

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

describe("export_dashboard", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("throws McpError for unknown trace_id", async () => {
    await expect(
      handleExportDashboard(db, { trace_id: "nonexistent" }),
    ).rejects.toThrow(McpError);
  });

  it("throws McpError for empty trace_id", async () => {
    await expect(handleExportDashboard(db, { trace_id: "" })).rejects.toThrow(
      McpError,
    );
  });

  it("generates HTML dashboard for a basic trace", async () => {
    insertTrace(db, "html-trace", "HTML Export Test");
    insertStep(db, {
      id: "hs1",
      trace_id: "html-trace",
      tool_name: "search_tool",
      input_json: JSON.stringify({ query: "test" }),
      output_json: JSON.stringify({ results: ["a"] }),
      token_count: 30,
      latency_ms: 120,
    });
    endTrace(db, "html-trace");

    const result = await handleExportDashboard(db, { trace_id: "html-trace" });

    expect(result.content).toHaveLength(1);
    const html = result.content[0].text;

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("HTML Export Test");
    expect(html).toContain("search_tool");
    expect(html).toContain("120ms");
    expect(html).toContain("30");
  });

  it("highlights error steps with red background", async () => {
    insertTrace(db, "err-trace", "Error Trace");
    insertStep(db, {
      id: "e1",
      trace_id: "err-trace",
      tool_name: "failing_tool",
      input_json: JSON.stringify({ x: 1 }),
      output_json: JSON.stringify({ error: "Something went wrong" }),
      token_count: null,
      latency_ms: 50,
    });
    insertStep(db, {
      id: "e2",
      trace_id: "err-trace",
      tool_name: "ok_tool",
      input_json: JSON.stringify({ x: 2 }),
      output_json: JSON.stringify({ result: "ok" }),
      token_count: null,
      latency_ms: 80,
    });

    const result = await handleExportDashboard(db, { trace_id: "err-trace" });
    const html = result.content[0].text;

    // Error row should have red background
    expect(html).toContain("background:#3b0a0a");
    // Error badge should appear
    expect(html).toContain("error-badge");
    expect(html).toContain("ERROR");
    // Non-error row should not have red background for ok_tool row
    expect(html).toContain("ok_tool");
  });

  it("highlights steps with isError:true in output", async () => {
    insertTrace(db, "iserr-trace", "isError Trace");
    insertStep(db, {
      id: "ie1",
      trace_id: "iserr-trace",
      tool_name: "mcp_call",
      input_json: JSON.stringify({}),
      output_json: JSON.stringify({ isError: true, message: "failed" }),
      token_count: null,
      latency_ms: 10,
    });

    const result = await handleExportDashboard(db, {
      trace_id: "iserr-trace",
    });
    const html = result.content[0].text;

    expect(html).toContain("background:#3b0a0a");
    expect(html).toContain("error-output");
  });

  it("adds latency waterfall bars", async () => {
    insertTrace(db, "waterfall-trace", "Waterfall Test");
    insertStep(db, {
      id: "w1",
      trace_id: "waterfall-trace",
      tool_name: "fast_tool",
      input_json: "{}",
      output_json: "{}",
      token_count: null,
      latency_ms: 100,
    });
    insertStep(db, {
      id: "w2",
      trace_id: "waterfall-trace",
      tool_name: "slow_tool",
      input_json: "{}",
      output_json: "{}",
      token_count: null,
      latency_ms: 1000,
    });

    const result = await handleExportDashboard(db, {
      trace_id: "waterfall-trace",
    });
    const html = result.content[0].text;

    // Should contain waterfall bar elements
    expect(html).toContain("waterfall-bar");
    // Slow tool should be 100%, fast tool should be 10%
    expect(html).toContain("width:100%");
    expect(html).toContain("width:10%");
  });

  it("generates valid HTML with no steps", async () => {
    insertTrace(db, "empty-html", "Empty HTML Trace");

    const result = await handleExportDashboard(db, { trace_id: "empty-html" });
    const html = result.content[0].text;

    expect(html).toContain("No steps recorded");
    expect(html).toContain("Empty HTML Trace");
  });

  it("dashboard includes stat cards for steps, tokens, and latency", async () => {
    insertTrace(db, "stats-trace", "Stats Trace");
    insertStep(db, {
      id: "st1",
      trace_id: "stats-trace",
      tool_name: "tool_x",
      input_json: "{}",
      output_json: "{}",
      token_count: 100,
      latency_ms: 500,
    });
    endTrace(db, "stats-trace");

    const result = await handleExportDashboard(db, {
      trace_id: "stats-trace",
    });
    const html = result.content[0].text;

    expect(html).toContain("Total Steps");
    expect(html).toContain("Total Tokens");
    expect(html).toContain("Total Latency");
    expect(html).toContain("Wall Duration");
  });
});
