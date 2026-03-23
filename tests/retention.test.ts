import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyRetentionPolicy } from "../src/retention.js";

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

function insertTrace(
  db: DatabaseSync,
  id: string,
  name: string,
  startedAt: number,
): void {
  db.prepare(
    "INSERT INTO traces (id, name, status, started_at) VALUES (?, ?, 'running', ?)",
  ).run(id, name, startedAt);
}

function insertStep(db: DatabaseSync, id: string, traceId: string): void {
  db.prepare(
    `INSERT INTO steps (id, trace_id, tool_name, input_json, output_json, created_at)
     VALUES (?, ?, 'tool', '{}', '{}', ?)`,
  ).run(id, traceId, Date.now());
}

function getTrace(
  db: DatabaseSync,
  id: string,
): { id: string; archived: number } | undefined {
  return db.prepare("SELECT id, archived FROM traces WHERE id = ?").get(id) as
    | { id: string; archived: number }
    | undefined;
}

describe("applyRetentionPolicy", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns zeros when retentionDays is 0", () => {
    const now = Date.now();
    insertTrace(db, "t1", "Recent", now - 1000);
    const result = applyRetentionPolicy(db, 0);
    expect(result.archived).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it("does not archive traces within the retention window", () => {
    const now = Date.now();
    // 1 day old, retention = 7 days
    insertTrace(db, "t1", "Recent", now - 1 * 24 * 60 * 60 * 1000);
    const result = applyRetentionPolicy(db, 7);
    expect(result.archived).toBe(0);
    expect(result.deleted).toBe(0);

    const trace = getTrace(db, "t1");
    expect(trace?.archived).toBe(0);
  });

  it("archives traces older than retentionDays", () => {
    const now = Date.now();
    // 10 days old, retention = 7 days
    insertTrace(db, "t1", "Old Trace", now - 10 * 24 * 60 * 60 * 1000);
    // 1 day old — should not be archived
    insertTrace(db, "t2", "New Trace", now - 1 * 24 * 60 * 60 * 1000);

    const result = applyRetentionPolicy(db, 7);
    expect(result.archived).toBe(1);
    expect(result.deleted).toBe(0);

    const old = getTrace(db, "t1");
    expect(old?.archived).toBe(1);

    const fresh = getTrace(db, "t2");
    expect(fresh?.archived).toBe(0);
  });

  it("deletes archived traces past 2× retention threshold", () => {
    const now = Date.now();
    // 25 days old, retention = 7 days → 2× = 14 days → should be deleted
    insertTrace(db, "t1", "Very Old", now - 25 * 24 * 60 * 60 * 1000);
    // 10 days old, retention = 7 days → archived but not deleted (within 2×)
    insertTrace(db, "t2", "Old", now - 10 * 24 * 60 * 60 * 1000);

    const result = applyRetentionPolicy(db, 7);
    // Both t1 and t2 are older than 7 days → archived
    // t1 is older than 14 days → deleted after archiving
    // t2 is between 7 and 14 days → archived but not deleted
    expect(result.archived).toBeGreaterThanOrEqual(1);
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const t1 = getTrace(db, "t1");
    expect(t1).toBeUndefined(); // deleted

    const t2 = getTrace(db, "t2");
    expect(t2?.archived).toBe(1); // archived but present
  });

  it("deletes steps when trace is deleted", () => {
    const now = Date.now();
    insertTrace(db, "t1", "Old With Steps", now - 25 * 24 * 60 * 60 * 1000);
    insertStep(db, "s1", "t1");
    insertStep(db, "s2", "t1");

    applyRetentionPolicy(db, 7);

    const steps = db
      .prepare("SELECT * FROM steps WHERE trace_id = ?")
      .all("t1") as unknown[];
    expect(steps).toHaveLength(0);
  });

  it("does not archive already-archived traces again", () => {
    const now = Date.now();
    insertTrace(db, "t1", "Old Trace", now - 10 * 24 * 60 * 60 * 1000);

    const first = applyRetentionPolicy(db, 7);
    expect(first.archived).toBe(1);

    // Second call should not increment archived count for already-archived trace
    const second = applyRetentionPolicy(db, 7);
    expect(second.archived).toBe(0);
  });
});
