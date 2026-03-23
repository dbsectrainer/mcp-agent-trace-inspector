import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  insertTrace,
  endTrace,
  insertStep,
  getTrace,
  getSteps,
  listTraces,
  deleteOldTraces,
  openDatabase,
  expandPath,
  computeSummary,
} from "../src/db.js";

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

describe("SQLite storage", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("inserts and retrieves a trace", () => {
    insertTrace(db, "test-id-1", "My Test Trace");
    const trace = getTrace(db, "test-id-1");
    expect(trace).toBeDefined();
    expect(trace!.id).toBe("test-id-1");
    expect(trace!.name).toBe("My Test Trace");
    expect(trace!.status).toBe("running");
    expect(trace!.ended_at).toBeNull();
  });

  it("ends a trace and sets status to completed", () => {
    insertTrace(db, "test-id-2", "Completed Trace");
    endTrace(db, "test-id-2");
    const trace = getTrace(db, "test-id-2");
    expect(trace!.status).toBe("completed");
    expect(trace!.ended_at).not.toBeNull();
  });

  it("returns undefined for non-existent trace", () => {
    const trace = getTrace(db, "nonexistent");
    expect(trace).toBeUndefined();
  });

  it("inserts and retrieves steps", () => {
    insertTrace(db, "trace-for-steps", "Steps Trace");
    insertStep(db, {
      id: "step-1",
      trace_id: "trace-for-steps",
      tool_name: "my_tool",
      input_json: JSON.stringify({ query: "hello" }),
      output_json: JSON.stringify({ result: "world" }),
      token_count: 50,
      latency_ms: 120,
    });
    const steps = getSteps(db, "trace-for-steps");
    expect(steps).toHaveLength(1);
    expect(steps[0].tool_name).toBe("my_tool");
    expect(steps[0].token_count).toBe(50);
    expect(steps[0].latency_ms).toBe(120);
  });

  it("lists all traces", () => {
    insertTrace(db, "t1", "Trace One");
    insertTrace(db, "t2", "Trace Two");
    insertTrace(db, "t3", "Trace Three");
    const all = listTraces(db);
    expect(all).toHaveLength(3);
  });

  it("respects limit in listTraces", () => {
    insertTrace(db, "t1", "Trace One");
    insertTrace(db, "t2", "Trace Two");
    insertTrace(db, "t3", "Trace Three");
    const limited = listTraces(db, 2);
    expect(limited).toHaveLength(2);
  });

  it("deletes old traces with retention", () => {
    const oldTime = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
    db.prepare(
      "INSERT INTO traces (id, name, status, started_at) VALUES (?, ?, 'running', ?)",
    ).run("old-trace", "Old Trace", oldTime);
    insertTrace(db, "new-trace", "New Trace");

    const deleted = deleteOldTraces(db, 5); // delete traces older than 5 days
    expect(deleted).toBe(1);

    expect(getTrace(db, "old-trace")).toBeUndefined();
    expect(getTrace(db, "new-trace")).toBeDefined();
  });

  it("does not delete traces when retention is 0", () => {
    insertTrace(db, "t1", "Trace One");
    const deleted = deleteOldTraces(db, 0);
    expect(deleted).toBe(0);
    expect(getTrace(db, "t1")).toBeDefined();
  });

  it("computeSummary returns null for non-existent trace", () => {
    const result = computeSummary(db, "missing-trace");
    expect(result).toBeNull();
  });

  it("computeSummary sums token_count and latency_ms treating null as 0", () => {
    insertTrace(db, "sum2", "Sum2");
    insertStep(db, {
      id: "s10",
      trace_id: "sum2",
      tool_name: "t1",
      input_json: "{}",
      output_json: "{}",
      token_count: null,
      latency_ms: null,
    });
    insertStep(db, {
      id: "s11",
      trace_id: "sum2",
      tool_name: "t2",
      input_json: "{}",
      output_json: "{}",
      token_count: 25,
      latency_ms: 75,
    });
    const summary = computeSummary(db, "sum2");
    expect(summary).not.toBeNull();
    expect(summary!.totalTokens).toBe(25);
    expect(summary!.totalLatencyMs).toBe(75);
    expect(summary!.stepCount).toBe(2);
  });
});

describe("openDatabase and expandPath", () => {
  const testDir = join(tmpdir(), `trace-inspector-test-${Date.now()}`);
  const testDbPath = join(testDir, "test.db");

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("expandPath resolves ~ to homedir", () => {
    const result = expandPath("~/some/path");
    expect(result).toContain(homedir());
    expect(result).not.toContain("~");
  });

  it("expandPath resolves absolute path without tilde", () => {
    const result = expandPath("/tmp/test.db");
    expect(result).toBe("/tmp/test.db");
  });

  it("openDatabase creates the directory if it does not exist", () => {
    expect(existsSync(testDir)).toBe(false);
    const db = openDatabase(testDbPath);
    expect(existsSync(testDir)).toBe(true);
    expect(existsSync(testDbPath)).toBe(true);
    db.close();
  });

  it("openDatabase returns a working DatabaseSync with the schema initialized", () => {
    const db = openDatabase(testDbPath);
    // The schema should be set up — insert a trace and verify it works
    insertTrace(db, "schema-test", "Schema Test");
    const trace = getTrace(db, "schema-test");
    expect(trace).toBeDefined();
    expect(trace!.name).toBe("Schema Test");
    db.close();
  });

  it("openDatabase works with a tilde path", () => {
    const tildePath = "~/tmp-trace-inspector-test-db/test.db";
    const expandedPath = expandPath(tildePath);
    let db: DatabaseSync | undefined;
    try {
      db = openDatabase(tildePath);
      expect(existsSync(expandedPath)).toBe(true);
      insertTrace(db, "tilde-test", "Tilde Test");
      const trace = getTrace(db, "tilde-test");
      expect(trace).toBeDefined();
    } finally {
      if (db) db.close();
      const dir = expandPath("~/tmp-trace-inspector-test-db");
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
