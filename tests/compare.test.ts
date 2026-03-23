import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { insertTrace, insertStep, endTrace } from "../src/db.js";
import { handleCompareTraces } from "../src/tools/compare.js";
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

describe("compare_traces", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("throws McpError for unknown trace_id_a", () => {
    insertTrace(db, "trace-b", "Trace B");
    expect(() =>
      handleCompareTraces(db, {
        trace_id_a: "nonexistent",
        trace_id_b: "trace-b",
      }),
    ).toThrow(McpError);
  });

  it("throws McpError for unknown trace_id_b", () => {
    insertTrace(db, "trace-a", "Trace A");
    expect(() =>
      handleCompareTraces(db, {
        trace_id_a: "trace-a",
        trace_id_b: "nonexistent",
      }),
    ).toThrow(McpError);
  });

  it("throws McpError for empty trace_id_a", () => {
    insertTrace(db, "trace-b", "Trace B");
    expect(() =>
      handleCompareTraces(db, { trace_id_a: "", trace_id_b: "trace-b" }),
    ).toThrow(McpError);
  });

  it("compares two traces with no steps — all diffs are zero", () => {
    insertTrace(db, "ta", "Trace A");
    insertTrace(db, "tb", "Trace B");

    const result = handleCompareTraces(db, {
      trace_id_a: "ta",
      trace_id_b: "tb",
    });

    expect(result.content).toHaveLength(2);
    const text = result.content[0].text;
    expect(text).toContain("Trace A");
    expect(text).toContain("Trace B");
    expect(text).toContain("+0");

    const jsonText = result.content[1].text;
    const parsed = JSON.parse(jsonText.replace(/^[\s\S]*?JSON:\n/, ""));
    expect(parsed.diff.step_count).toBe(0);
    expect(parsed.diff.total_tokens).toBe(0);
    expect(parsed.diff.total_latency_ms).toBe(0);
    expect(parsed.tools_only_in_a).toHaveLength(0);
    expect(parsed.tools_only_in_b).toHaveLength(0);
  });

  it("shows positive step count diff when B has more steps", () => {
    insertTrace(db, "ta2", "Trace A2");
    insertTrace(db, "tb2", "Trace B2");

    insertStep(db, {
      id: "s1",
      trace_id: "ta2",
      tool_name: "tool_x",
      input_json: "{}",
      output_json: "{}",
      token_count: 10,
      latency_ms: 100,
    });

    insertStep(db, {
      id: "s2",
      trace_id: "tb2",
      tool_name: "tool_x",
      input_json: "{}",
      output_json: "{}",
      token_count: 20,
      latency_ms: 200,
    });
    insertStep(db, {
      id: "s3",
      trace_id: "tb2",
      tool_name: "tool_y",
      input_json: "{}",
      output_json: "{}",
      token_count: 30,
      latency_ms: 150,
    });

    const result = handleCompareTraces(db, {
      trace_id_a: "ta2",
      trace_id_b: "tb2",
    });

    const jsonText = result.content[1].text;
    const parsed = JSON.parse(jsonText.replace(/^[\s\S]*?JSON:\n/, ""));
    expect(parsed.diff.step_count).toBe(1); // B has 2, A has 1
    expect(parsed.diff.total_tokens).toBe(40); // (20+30) - 10
    expect(parsed.diff.total_latency_ms).toBe(250); // (200+150) - 100
    expect(parsed.tools_only_in_b).toContain("tool_y");
    expect(parsed.tools_in_both).toContain("tool_x");
  });

  it("shows negative diff when A has more tokens", () => {
    insertTrace(db, "ta3", "Heavy A");
    insertTrace(db, "tb3", "Light B");

    insertStep(db, {
      id: "h1",
      trace_id: "ta3",
      tool_name: "big_tool",
      input_json: "{}",
      output_json: "{}",
      token_count: 1000,
      latency_ms: 5000,
    });
    insertStep(db, {
      id: "h2",
      trace_id: "tb3",
      tool_name: "big_tool",
      input_json: "{}",
      output_json: "{}",
      token_count: 200,
      latency_ms: 1000,
    });

    const result = handleCompareTraces(db, {
      trace_id_a: "ta3",
      trace_id_b: "tb3",
    });

    const jsonText = result.content[1].text;
    const parsed = JSON.parse(jsonText.replace(/^[\s\S]*?JSON:\n/, ""));
    expect(parsed.diff.total_tokens).toBe(-800);
    expect(parsed.diff.total_latency_ms).toBe(-4000);
    expect(parsed.step_diffs[0].same_tool).toBe(true);
    expect(parsed.step_diffs[0].token_diff).toBe(-800);
  });

  it("detects different tools at same step position", () => {
    insertTrace(db, "ta4", "Trace A4");
    insertTrace(db, "tb4", "Trace B4");

    insertStep(db, {
      id: "d1",
      trace_id: "ta4",
      tool_name: "search_tool",
      input_json: "{}",
      output_json: "{}",
      token_count: null,
      latency_ms: null,
    });
    insertStep(db, {
      id: "d2",
      trace_id: "tb4",
      tool_name: "vector_search",
      input_json: "{}",
      output_json: "{}",
      token_count: null,
      latency_ms: null,
    });

    const result = handleCompareTraces(db, {
      trace_id_a: "ta4",
      trace_id_b: "tb4",
    });

    const jsonText = result.content[1].text;
    const parsed = JSON.parse(jsonText.replace(/^[\s\S]*?JSON:\n/, ""));
    expect(parsed.step_diffs[0].same_tool).toBe(false);
    expect(parsed.step_diffs[0].tool_a).toBe("search_tool");
    expect(parsed.step_diffs[0].tool_b).toBe("vector_search");

    const text = result.content[0].text;
    expect(text).toContain("[DIFFERENT]");
  });

  it("reports tools only in A", () => {
    insertTrace(db, "ta5", "Trace A5");
    insertTrace(db, "tb5", "Trace B5");

    insertStep(db, {
      id: "u1",
      trace_id: "ta5",
      tool_name: "unique_to_a",
      input_json: "{}",
      output_json: "{}",
      token_count: null,
      latency_ms: null,
    });
    // tb5 has no steps

    const result = handleCompareTraces(db, {
      trace_id_a: "ta5",
      trace_id_b: "tb5",
    });

    const jsonText = result.content[1].text;
    const parsed = JSON.parse(jsonText.replace(/^[\s\S]*?JSON:\n/, ""));
    expect(parsed.tools_only_in_a).toContain("unique_to_a");
    expect(parsed.tools_only_in_b).toHaveLength(0);
  });

  it("handles comparing a trace to itself", () => {
    insertTrace(db, "self", "Self Compare");
    insertStep(db, {
      id: "self1",
      trace_id: "self",
      tool_name: "tool_a",
      input_json: "{}",
      output_json: "{}",
      token_count: 50,
      latency_ms: 100,
    });
    endTrace(db, "self");

    const result = handleCompareTraces(db, {
      trace_id_a: "self",
      trace_id_b: "self",
    });

    const jsonText = result.content[1].text;
    const parsed = JSON.parse(jsonText.replace(/^[\s\S]*?JSON:\n/, ""));
    expect(parsed.diff.step_count).toBe(0);
    expect(parsed.diff.total_tokens).toBe(0);
    expect(parsed.diff.total_latency_ms).toBe(0);
    expect(parsed.step_diffs[0].same_tool).toBe(true);
    expect(parsed.step_diffs[0].token_diff).toBe(0);
  });
});
