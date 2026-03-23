import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { insertTrace, insertStep, endTrace } from "../src/db.js";
import {
  handleGetTraceSummary,
  handleListTraces,
} from "../src/tools/inspect.js";
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

describe("get_trace_summary — cost estimation", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("includes estimated_cost_usd in JSON output for known model", () => {
    insertTrace(db, "cost-trace", "Cost Test");
    insertStep(db, {
      id: "c1",
      trace_id: "cost-trace",
      tool_name: "tool_a",
      input_json: "{}",
      output_json: "{}",
      token_count: 1000,
      latency_ms: 100,
    });
    endTrace(db, "cost-trace");

    const result = handleGetTraceSummary(db, {
      trace_id: "cost-trace",
      model: "claude-sonnet-4-6",
    });

    const jsonText = result.content[1].text;
    const parsed = JSON.parse(jsonText.replace(/^[\s\S]*?JSON:\n/, ""));

    expect(parsed.estimated_cost_usd).not.toBeNull();
    // 1000 tokens at $0.003/1K input = $0.003
    expect(parsed.estimated_cost_usd).toBeCloseTo(0.003, 5);
    expect(parsed.cost_model).toBe("claude-sonnet-4-6");
  });

  it("estimated_cost_usd is null for unknown model", () => {
    insertTrace(db, "cost-trace2", "Cost Test 2");
    insertStep(db, {
      id: "c2",
      trace_id: "cost-trace2",
      tool_name: "tool_b",
      input_json: "{}",
      output_json: "{}",
      token_count: 500,
      latency_ms: 50,
    });

    const result = handleGetTraceSummary(db, {
      trace_id: "cost-trace2",
      model: "gpt-4-unknown",
    });

    const jsonText = result.content[1].text;
    const parsed = JSON.parse(jsonText.replace(/^[\s\S]*?JSON:\n/, ""));

    expect(parsed.estimated_cost_usd).toBeNull();
  });

  it("estimated_cost_usd is null when no tokens recorded", () => {
    insertTrace(db, "cost-trace3", "No Tokens");
    insertStep(db, {
      id: "c3",
      trace_id: "cost-trace3",
      tool_name: "tool_c",
      input_json: "{}",
      output_json: "{}",
      token_count: null,
      latency_ms: 100,
    });

    const result = handleGetTraceSummary(db, { trace_id: "cost-trace3" });
    const jsonText = result.content[1].text;
    const parsed = JSON.parse(jsonText.replace(/^[\s\S]*?JSON:\n/, ""));

    expect(parsed.estimated_cost_usd).toBeNull();
  });

  it("uses claude-sonnet-4-6 as default model", () => {
    insertTrace(db, "default-model", "Default Model");
    insertStep(db, {
      id: "dm1",
      trace_id: "default-model",
      tool_name: "tool",
      input_json: "{}",
      output_json: "{}",
      token_count: 2000,
      latency_ms: 100,
    });

    const result = handleGetTraceSummary(db, { trace_id: "default-model" });
    const jsonText = result.content[1].text;
    const parsed = JSON.parse(jsonText.replace(/^[\s\S]*?JSON:\n/, ""));

    expect(parsed.cost_model).toBe("claude-sonnet-4-6");
    expect(parsed.estimated_cost_usd).not.toBeNull();
  });

  it("text output includes cost line", () => {
    insertTrace(db, "cost-text", "Cost Text");
    insertStep(db, {
      id: "ct1",
      trace_id: "cost-text",
      tool_name: "tool",
      input_json: "{}",
      output_json: "{}",
      token_count: 1000,
      latency_ms: 100,
    });

    const result = handleGetTraceSummary(db, { trace_id: "cost-text" });
    const text = result.content[0].text;

    expect(text).toContain("Est. Cost:");
  });
});

describe("handleListTraces", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("throws McpError when limit is 0", () => {
    expect(() => handleListTraces(db, { limit: 0 })).toThrow(McpError);
  });

  it("throws McpError when limit is negative", () => {
    expect(() => handleListTraces(db, { limit: -1 })).toThrow(McpError);
  });

  it("throws McpError when limit is a non-integer number string (wrong type)", () => {
    expect(() =>
      handleListTraces(db, { limit: "abc" as unknown as number }),
    ).toThrow(McpError);
  });

  it("returns all traces without limit", () => {
    insertTrace(db, "lt1", "List One");
    insertTrace(db, "lt2", "List Two");
    const result = handleListTraces(db, {});
    expect(result.content[0].text).toContain("List One");
    expect(result.content[0].text).toContain("List Two");
  });

  it("shows 'running' for traces that have not ended", () => {
    insertTrace(db, "running-lt", "Running Trace");
    const result = handleListTraces(db, {});
    expect(result.content[0].text).toContain("running");
  });

  it("shows ended timestamp for completed traces", () => {
    insertTrace(db, "ended-lt", "Ended Trace");
    endTrace(db, "ended-lt");
    const result = handleListTraces(db, {});
    expect(result.content[0].text).toContain("COMPLETED");
  });

  it("includes JSON output with trace data", () => {
    insertTrace(db, "json-lt", "JSON Trace");
    const result = handleListTraces(db, {});
    const jsonText = result.content[1].text;
    expect(jsonText).toContain("JSON:");
    const parsed = JSON.parse(jsonText.replace(/^[\s\S]*?JSON:\n/, ""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe("JSON Trace");
  });

  it("wraps non-McpError DB errors in McpError (InternalError)", async () => {
    const dbModule = await import("../src/db.js");
    const spy = vi.spyOn(dbModule, "listTraces").mockImplementation(() => {
      throw new Error("disk error");
    });

    try {
      expect(() => handleListTraces(db, {})).toThrow(McpError);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("handleGetTraceSummary — error handling", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("throws McpError for empty trace_id", () => {
    expect(() => handleGetTraceSummary(db, { trace_id: "" })).toThrow(McpError);
  });

  it("wraps non-McpError DB errors in McpError (InternalError)", async () => {
    const dbModule = await import("../src/db.js");
    const spy = vi.spyOn(dbModule, "computeSummary").mockImplementation(() => {
      throw new Error("connection lost");
    });

    try {
      expect(() => handleGetTraceSummary(db, { trace_id: "some-id" })).toThrow(
        McpError,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("shows duration from ended_at when trace is completed", () => {
    const startedAt = Date.now() - 3000;
    const endedAt = Date.now() - 500;
    db.prepare(
      "INSERT INTO traces (id, name, status, started_at, ended_at) VALUES (?, ?, 'completed', ?, ?)",
    ).run("dur-trace", "Duration Trace", startedAt, endedAt);

    const result = handleGetTraceSummary(db, { trace_id: "dur-trace" });
    const jsonText = result.content[1].text;
    const parsed = JSON.parse(jsonText.replace(/^[\s\S]*?JSON:\n/, ""));
    // Duration should be endedAt - startedAt
    expect(parsed.duration_ms).toBeCloseTo(endedAt - startedAt, -2);
    expect(parsed.status).toBe("completed");
  });
});

describe("get_trace_summary — reasoning chain detection", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("detects prompt→reasoning→action pattern", () => {
    insertTrace(db, "reason-trace", "Reasoning Trace");
    const toolSequence = ["user_prompt", "think_step", "execute_action"];
    toolSequence.forEach((tool, i) => {
      insertStep(db, {
        id: `r${i}`,
        trace_id: "reason-trace",
        tool_name: tool,
        input_json: "{}",
        output_json: "{}",
        token_count: null,
        latency_ms: null,
      });
    });

    const result = handleGetTraceSummary(db, { trace_id: "reason-trace" });
    const jsonText = result.content[1].text;
    const parsed = JSON.parse(jsonText.replace(/^[\s\S]*?JSON:\n/, ""));

    expect(parsed.reasoning_chain_detected).toBe(true);
    expect(parsed.reasoning_patterns.length).toBeGreaterThan(0);
  });

  it("does not detect reasoning chain in plain tool sequence", () => {
    insertTrace(db, "plain-trace", "Plain Trace");
    const toolSequence = ["search", "fetch", "format"];
    toolSequence.forEach((tool, i) => {
      insertStep(db, {
        id: `p${i}`,
        trace_id: "plain-trace",
        tool_name: tool,
        input_json: "{}",
        output_json: "{}",
        token_count: null,
        latency_ms: null,
      });
    });

    const result = handleGetTraceSummary(db, { trace_id: "plain-trace" });
    const jsonText = result.content[1].text;
    const parsed = JSON.parse(jsonText.replace(/^[\s\S]*?JSON:\n/, ""));

    expect(parsed.reasoning_chain_detected).toBe(false);
  });

  it("detects standalone reasoning step", () => {
    insertTrace(db, "think-trace", "Think Trace");
    insertStep(db, {
      id: "th1",
      trace_id: "think-trace",
      tool_name: "reflect_on_query",
      input_json: "{}",
      output_json: "{}",
      token_count: null,
      latency_ms: null,
    });

    const result = handleGetTraceSummary(db, { trace_id: "think-trace" });
    const jsonText = result.content[1].text;
    const parsed = JSON.parse(jsonText.replace(/^[\s\S]*?JSON:\n/, ""));

    expect(parsed.reasoning_chain_detected).toBe(true);
    expect(parsed.reasoning_patterns).toContain("reflect_on_query");
  });

  it("reasoning info appears in text output", () => {
    insertTrace(db, "rtext-trace", "Reasoning Text");
    insertStep(db, {
      id: "rt1",
      trace_id: "rtext-trace",
      tool_name: "plan_step",
      input_json: "{}",
      output_json: "{}",
      token_count: null,
      latency_ms: null,
    });

    const result = handleGetTraceSummary(db, { trace_id: "rtext-trace" });
    const text = result.content[0].text;

    expect(text).toContain("Reasoning:");
    expect(text).toContain("DETECTED");
  });

  it("no reasoning pattern flagged when trace has no steps", () => {
    insertTrace(db, "empty-reason", "Empty");

    const result = handleGetTraceSummary(db, { trace_id: "empty-reason" });
    const jsonText = result.content[1].text;
    const parsed = JSON.parse(jsonText.replace(/^[\s\S]*?JSON:\n/, ""));

    expect(parsed.reasoning_chain_detected).toBe(false);
    expect(parsed.reasoning_patterns).toHaveLength(0);
  });

  it("throws McpError for unknown trace_id", () => {
    expect(() => handleGetTraceSummary(db, { trace_id: "missing" })).toThrow(
      McpError,
    );
  });
});
