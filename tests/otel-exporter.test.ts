import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { insertTrace, endTrace, insertStep } from "../src/db.js";
import { exportToOTLP, exportAllOTLP } from "../src/otel-exporter.js";

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

// Use UUID-like IDs to test hex conversion properly
const TRACE_UUID_1 = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const TRACE_UUID_2 = "b2c3d4e5-f6a7-8901-bcde-f01234567891";
const TRACE_UUID_3 = "c3d4e5f6-a7b8-9012-cdef-012345678902";
const STEP_UUID_A = "d4e5f6a7-b8c9-0123-def0-123456789012";
const STEP_UUID_B = "e5f6a7b8-c9d0-1234-ef01-234567890123";
const STEP_ERR = "f6a7b8c9-d0e1-2345-f012-345678901234";
const TRACE_UUID_4 = "a4b4c4d4-e4f4-4440-aaaa-ef1234567894";
const TRACE_UUID_5 = "a5b5c5d5-e5f5-5550-bbbb-ef1234567895";
const TRACE_UUID_6 = "a6b6c6d6-e6f6-6660-cccc-ef1234567896";

describe("exportToOTLP", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  it("throws for unknown trace_id", () => {
    expect(() => exportToOTLP(db, "nonexistent")).toThrow("Unknown trace_id");
  });

  it("returns a trace with root span and no child spans for trace with no steps", () => {
    insertTrace(db, TRACE_UUID_1, "My Trace");
    endTrace(db, TRACE_UUID_1);

    const result = exportToOTLP(db, TRACE_UUID_1);

    expect(result.traceId).toBeTruthy();
    expect(result.spans).toHaveLength(1);
    const rootSpan = result.spans[0];
    expect(rootSpan.name).toBe("My Trace");
    expect(rootSpan.traceId).toBe(result.traceId);
    expect(rootSpan.parentSpanId).toBeUndefined();
    expect(rootSpan.status.code).toBe(1); // OK
  });

  it("returns child spans for each step", () => {
    insertTrace(db, TRACE_UUID_2, "Trace With Steps");
    insertStep(db, {
      id: STEP_UUID_A,
      trace_id: TRACE_UUID_2,
      tool_name: "web_search",
      input_json: JSON.stringify({ q: "hello" }),
      output_json: JSON.stringify({ result: "world" }),
      token_count: 100,
      latency_ms: 200,
    });
    insertStep(db, {
      id: STEP_UUID_B,
      trace_id: TRACE_UUID_2,
      tool_name: "summarize",
      input_json: JSON.stringify({ text: "foo" }),
      output_json: JSON.stringify({ summary: "bar" }),
      token_count: 50,
      latency_ms: 100,
    });
    endTrace(db, TRACE_UUID_2);

    const result = exportToOTLP(db, TRACE_UUID_2);

    expect(result.spans).toHaveLength(3); // 1 root + 2 steps
    const [rootSpan, stepA, stepB] = result.spans;

    expect(rootSpan.name).toBe("Trace With Steps");
    expect(stepA.name).toBe("web_search");
    expect(stepA.parentSpanId).toBe(rootSpan.spanId);
    expect(stepA.attributes["step.token_count"]).toBe(100);
    expect(stepA.attributes["step.latency_ms"]).toBe(200);

    expect(stepB.name).toBe("summarize");
    expect(stepB.parentSpanId).toBe(rootSpan.spanId);
  });

  it("sets error status for steps with error in output", () => {
    insertTrace(db, TRACE_UUID_3, "Error Trace");
    insertStep(db, {
      id: STEP_ERR,
      trace_id: TRACE_UUID_3,
      tool_name: "failing_tool",
      input_json: "{}",
      output_json: JSON.stringify({ error: "Something went wrong" }),
      token_count: null,
      latency_ms: null,
    });

    const result = exportToOTLP(db, TRACE_UUID_3);
    const errorSpan = result.spans.find((s) => s.name === "failing_tool");
    expect(errorSpan).toBeDefined();
    expect(errorSpan!.status.code).toBe(2); // ERROR
    expect(errorSpan!.attributes["error.message"]).toBe("Something went wrong");
  });

  it("produces nanosecond timestamps as strings (>= insert time)", () => {
    const before = Date.now();
    insertTrace(db, TRACE_UUID_4, "TS Test");
    const result = exportToOTLP(db, TRACE_UUID_4);
    const rootSpan = result.spans[0];

    const startNano = BigInt(rootSpan.startTimeUnixNano);
    // timestamp should be >= before (same ms or later)
    expect(startNano).toBeGreaterThanOrEqual(BigInt(before) * 1_000_000n);
  });

  it("span IDs derived from UUID IDs are 16-char lowercase hex", () => {
    insertTrace(db, TRACE_UUID_5, "SpanID Test");
    const result = exportToOTLP(db, TRACE_UUID_5);
    const rootSpan = result.spans[0];
    expect(rootSpan.spanId).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(rootSpan.spanId)).toBe(true);
  });

  it("trace IDs derived from UUID IDs are 32-char lowercase hex", () => {
    insertTrace(db, TRACE_UUID_6, "TraceID Test");
    const result = exportToOTLP(db, TRACE_UUID_6);
    expect(result.traceId).toHaveLength(32);
    expect(/^[0-9a-f]+$/.test(result.traceId)).toBe(true);
  });
});

describe("exportAllOTLP", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns empty array when no traces", () => {
    const result = exportAllOTLP(db);
    expect(result).toEqual([]);
  });

  it("returns OTLP for all traces", () => {
    insertTrace(db, "t1", "Trace One");
    insertTrace(db, "t2", "Trace Two");
    insertTrace(db, "t3", "Trace Three");

    const result = exportAllOTLP(db);
    expect(result).toHaveLength(3);
    const names = result.map((r) => r.spans[0].name);
    expect(names).toContain("Trace One");
    expect(names).toContain("Trace Two");
    expect(names).toContain("Trace Three");
  });
});
