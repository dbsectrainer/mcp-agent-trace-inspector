import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  handleTraceStart,
  handleTraceStep,
  handleTraceEnd,
} from "../src/tools/trace.js";
import { getTrace, getSteps } from "../src/db.js";
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

describe("trace lifecycle", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("trace_start creates a trace and returns trace_id", () => {
    const result = handleTraceStart(db, { name: "My Workflow" });
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.trace_id).toBeDefined();
    expect(typeof parsed.trace_id).toBe("string");
    expect(parsed.name).toBe("My Workflow");
    expect(parsed.status).toBe("running");

    const trace = getTrace(db, parsed.trace_id);
    expect(trace).toBeDefined();
    expect(trace!.name).toBe("My Workflow");
    expect(trace!.status).toBe("running");
  });

  it("trace_start auto-generates a name for empty or whitespace input", () => {
    // Phase 2: empty/whitespace names are auto-generated rather than rejected
    const r1 = handleTraceStart(db, { name: "" });
    const parsed1 = JSON.parse(r1.content[0].text);
    expect(parsed1.trace_id).toBeDefined();
    expect(parsed1.name).toMatch(/^trace-/); // auto-generated name starts with "trace-"

    const r2 = handleTraceStart(db, { name: "   " });
    const parsed2 = JSON.parse(r2.content[0].text);
    expect(parsed2.name).toMatch(/^trace-/);
  });

  it("trace_start auto-generates a name when name is 'auto'", () => {
    const result = handleTraceStart(db, { name: "auto" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.trace_id).toBeDefined();
    expect(parsed.name).toMatch(/^trace-/);
    expect(parsed.status).toBe("running");
  });

  it("trace_step records a step for an existing trace", () => {
    const startResult = handleTraceStart(db, { name: "Step Test" });
    const { trace_id } = JSON.parse(startResult.content[0].text);

    const stepResult = handleTraceStep(
      db,
      {
        trace_id,
        tool_name: "search_tool",
        input: { query: "hello world" },
        output: { results: ["foo", "bar"] },
        token_count: 42,
        latency_ms: 250,
      },
      false,
    );

    expect(stepResult.content).toHaveLength(1);
    const parsedStep = JSON.parse(stepResult.content[0].text);
    expect(parsedStep.step_id).toBeDefined();
    expect(parsedStep.tool_name).toBe("search_tool");
    expect(parsedStep.token_count).toBe(42);
    expect(parsedStep.latency_ms).toBe(250);

    const steps = getSteps(db, trace_id);
    expect(steps).toHaveLength(1);
    expect(steps[0].tool_name).toBe("search_tool");
    expect(JSON.parse(steps[0].input_json)).toEqual({ query: "hello world" });
    expect(JSON.parse(steps[0].output_json)).toEqual({
      results: ["foo", "bar"],
    });
  });

  it("trace_step ignores token_count when noTokenCount is true", () => {
    const startResult = handleTraceStart(db, { name: "No Tokens" });
    const { trace_id } = JSON.parse(startResult.content[0].text);

    handleTraceStep(
      db,
      {
        trace_id,
        tool_name: "tool_a",
        input: {},
        output: {},
        token_count: 100,
      },
      true, // noTokenCount = true
    );

    const steps = getSteps(db, trace_id);
    expect(steps[0].token_count).toBeNull();
  });

  it("trace_step throws McpError for unknown trace_id", () => {
    expect(() =>
      handleTraceStep(
        db,
        {
          trace_id: "nonexistent-id",
          tool_name: "tool",
          input: {},
          output: {},
        },
        false,
      ),
    ).toThrow(McpError);
  });

  it("trace_end marks the trace as completed", () => {
    const startResult = handleTraceStart(db, { name: "End Test" });
    const { trace_id } = JSON.parse(startResult.content[0].text);

    const endResult = handleTraceEnd(db, { trace_id });
    const parsedEnd = JSON.parse(endResult.content[0].text);
    expect(parsedEnd.status).toBe("completed");
    expect(parsedEnd.trace_id).toBe(trace_id);

    const trace = getTrace(db, trace_id);
    expect(trace!.status).toBe("completed");
    expect(trace!.ended_at).not.toBeNull();
  });

  it("trace_end throws McpError for unknown trace_id", () => {
    expect(() => handleTraceEnd(db, { trace_id: "no-such-id" })).toThrow(
      McpError,
    );
  });

  it("trace_step throws McpError for empty trace_id", () => {
    expect(() =>
      handleTraceStep(
        db,
        {
          trace_id: "",
          tool_name: "tool",
          input: {},
          output: {},
        },
        false,
      ),
    ).toThrow(McpError);
  });

  it("trace_step throws McpError when tool_name is empty", () => {
    const startResult = handleTraceStart(db, { name: "Test" });
    const { trace_id } = JSON.parse(startResult.content[0].text);
    expect(() =>
      handleTraceStep(
        db,
        {
          trace_id,
          tool_name: "",
          input: {},
          output: {},
        },
        false,
      ),
    ).toThrow(McpError);
  });

  it("trace_step throws McpError when input is null", () => {
    const startResult = handleTraceStart(db, { name: "Test" });
    const { trace_id } = JSON.parse(startResult.content[0].text);
    expect(() =>
      handleTraceStep(
        db,
        {
          trace_id,
          tool_name: "tool",
          input: null as unknown as object,
          output: {},
        },
        false,
      ),
    ).toThrow(McpError);
  });

  it("trace_step throws McpError when output is null", () => {
    const startResult = handleTraceStart(db, { name: "Test" });
    const { trace_id } = JSON.parse(startResult.content[0].text);
    expect(() =>
      handleTraceStep(
        db,
        {
          trace_id,
          tool_name: "tool",
          input: {},
          output: null as unknown as object,
        },
        false,
      ),
    ).toThrow(McpError);
  });

  it("trace_step wraps non-McpError DB errors in McpError (InternalError)", async () => {
    const startResult = handleTraceStart(db, { name: "Error Test" });
    const { trace_id } = JSON.parse(startResult.content[0].text);

    // Import and mock insertStep to throw a regular error
    const dbModule = await import("../src/db.js");
    const spy = vi.spyOn(dbModule, "insertStep").mockImplementation(() => {
      throw new Error("disk full");
    });

    try {
      expect(() =>
        handleTraceStep(
          db,
          {
            trace_id,
            tool_name: "tool",
            input: {},
            output: {},
          },
          false,
        ),
      ).toThrow(McpError);
    } finally {
      spy.mockRestore();
    }
  });

  it("trace_end throws McpError for empty trace_id", () => {
    expect(() => handleTraceEnd(db, { trace_id: "" })).toThrow(McpError);
  });

  it("trace_end computes duration when trace already has ended_at set", () => {
    // Insert a trace with ended_at already set (as if it was ended previously)
    const startedAt = Date.now() - 5000;
    const endedAt = Date.now() - 1000;
    db.prepare(
      "INSERT INTO traces (id, name, status, started_at, ended_at) VALUES (?, ?, 'running', ?, ?)",
    ).run("already-ended", "Already Ended", startedAt, endedAt);

    const result = handleTraceEnd(db, { trace_id: "already-ended" });
    const parsed = JSON.parse(result.content[0].text);
    // Duration should be endedAt - startedAt, approximately 4000ms
    expect(parsed.duration_ms).toBeCloseTo(endedAt - startedAt, -2);
    expect(parsed.trace_id).toBe("already-ended");
    expect(parsed.status).toBe("completed");
  });

  it("trace_end wraps non-McpError DB errors in McpError (InternalError)", async () => {
    const startResult = handleTraceStart(db, { name: "End Error Test" });
    const { trace_id } = JSON.parse(startResult.content[0].text);

    const dbModule = await import("../src/db.js");
    const spy = vi.spyOn(dbModule, "endTrace").mockImplementation(() => {
      throw new Error("write protected");
    });

    try {
      expect(() => handleTraceEnd(db, { trace_id })).toThrow(McpError);
    } finally {
      spy.mockRestore();
    }
  });

  it("full lifecycle: start -> multiple steps -> end", () => {
    const startResult = handleTraceStart(db, { name: "Full Lifecycle" });
    const { trace_id } = JSON.parse(startResult.content[0].text);

    for (let i = 0; i < 3; i++) {
      handleTraceStep(
        db,
        {
          trace_id,
          tool_name: `tool_${i}`,
          input: { step: i },
          output: { result: i * 2 },
          token_count: 10 * (i + 1),
          latency_ms: 100 * (i + 1),
        },
        false,
      );
    }

    handleTraceEnd(db, { trace_id });

    const trace = getTrace(db, trace_id);
    expect(trace!.status).toBe("completed");

    const steps = getSteps(db, trace_id);
    expect(steps).toHaveLength(3);
    expect(steps[0].tool_name).toBe("tool_0");
    expect(steps[1].tool_name).toBe("tool_1");
    expect(steps[2].tool_name).toBe("tool_2");
  });
});
