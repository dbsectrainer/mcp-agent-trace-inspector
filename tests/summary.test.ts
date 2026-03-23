import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  insertTrace,
  endTrace,
  insertStep,
  computeSummary,
} from "../src/db.js";
import { handleGetTraceSummary } from "../src/tools/inspect.js";
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

describe("summary calculation", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("computes zero totals for a trace with no steps", () => {
    insertTrace(db, "empty-trace", "Empty");
    const summary = computeSummary(db, "empty-trace");
    expect(summary).not.toBeNull();
    expect(summary!.stepCount).toBe(0);
    expect(summary!.totalTokens).toBe(0);
    expect(summary!.totalLatencyMs).toBe(0);
  });

  it("sums tokens and latency across steps", () => {
    insertTrace(db, "sum-trace", "Sum Test");
    insertStep(db, {
      id: "s1",
      trace_id: "sum-trace",
      tool_name: "tool_a",
      input_json: "{}",
      output_json: "{}",
      token_count: 100,
      latency_ms: 200,
    });
    insertStep(db, {
      id: "s2",
      trace_id: "sum-trace",
      tool_name: "tool_b",
      input_json: "{}",
      output_json: "{}",
      token_count: 50,
      latency_ms: 150,
    });
    insertStep(db, {
      id: "s3",
      trace_id: "sum-trace",
      tool_name: "tool_c",
      input_json: "{}",
      output_json: "{}",
      token_count: null,
      latency_ms: null,
    });

    const summary = computeSummary(db, "sum-trace");
    expect(summary!.stepCount).toBe(3);
    expect(summary!.totalTokens).toBe(150); // 100 + 50 + 0
    expect(summary!.totalLatencyMs).toBe(350); // 200 + 150 + 0
  });

  it("returns null for non-existent trace", () => {
    const summary = computeSummary(db, "does-not-exist");
    expect(summary).toBeNull();
  });

  it("handleGetTraceSummary throws McpError for unknown trace_id", () => {
    expect(() =>
      handleGetTraceSummary(db, { trace_id: "nonexistent" }),
    ).toThrow(McpError);
  });

  it("handleGetTraceSummary returns formatted summary with JSON", () => {
    insertTrace(db, "format-trace", "Format Test");
    insertStep(db, {
      id: "fs1",
      trace_id: "format-trace",
      tool_name: "my_tool",
      input_json: JSON.stringify({ x: 1 }),
      output_json: JSON.stringify({ y: 2 }),
      token_count: 77,
      latency_ms: 333,
    });
    endTrace(db, "format-trace");

    const result = handleGetTraceSummary(db, { trace_id: "format-trace" });
    expect(result.content.length).toBeGreaterThanOrEqual(1);

    // First content item is the text summary
    const text = result.content[0].text;
    expect(text).toContain("Format Test");
    expect(text).toContain("completed");
    expect(text).toContain("my_tool");

    // Second content item has the JSON
    const jsonText = result.content[1].text;
    expect(jsonText).toContain("JSON:");
    const jsonMatch = jsonText.match(/\{[\s\S]+\}/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![0]);
    expect(parsed.step_count).toBe(1);
    expect(parsed.total_tokens).toBe(77);
    expect(parsed.total_latency_ms).toBe(333);
  });

  it("computes correct duration for completed trace", () => {
    const startedAt = Date.now() - 5000;
    const endedAt = Date.now() - 1000;
    db.prepare(
      "INSERT INTO traces (id, name, status, started_at, ended_at) VALUES (?, ?, 'completed', ?, ?)",
    ).run("duration-trace", "Duration Test", startedAt, endedAt);

    const summary = computeSummary(db, "duration-trace");
    expect(summary).not.toBeNull();
    // Duration should be close to 4000ms
    const expectedDuration = endedAt - startedAt;
    expect(expectedDuration).toBeCloseTo(4000, -2); // within ~100ms
  });
});
