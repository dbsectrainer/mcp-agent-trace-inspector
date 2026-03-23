import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { insertTrace, insertStep, endTrace } from "../src/db.js";
import { handleListResources, handleReadResource } from "../src/resources.js";
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

describe("Resources handler", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns empty resources list when no traces exist", () => {
    const result = handleListResources(db);
    expect(result.resources).toHaveLength(0);
  });

  it("lists traces as trace:// resources", () => {
    insertTrace(db, "abc-123", "My Workflow");
    insertTrace(db, "def-456", "Another Workflow");

    const result = handleListResources(db);
    expect(result.resources).toHaveLength(2);

    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain("trace://abc-123");
    expect(uris).toContain("trace://def-456");
  });

  it("resource has correct name, description, and mimeType", () => {
    insertTrace(db, "test-id", "Test Trace");

    const result = handleListResources(db);
    const resource = result.resources[0];

    expect(resource.uri).toBe("trace://test-id");
    expect(resource.name).toBe("Test Trace");
    expect(resource.mimeType).toBe("application/json");
    expect(resource.description).toContain("Test Trace");
    expect(resource.description).toContain("running");
  });

  it("reads a trace resource and returns JSON content", () => {
    insertTrace(db, "read-id", "Read Me");
    insertStep(db, {
      id: "step1",
      trace_id: "read-id",
      tool_name: "my_tool",
      input_json: JSON.stringify({ x: 1 }),
      output_json: JSON.stringify({ y: 2 }),
      token_count: 42,
      latency_ms: 100,
    });
    endTrace(db, "read-id");

    const result = handleReadResource(db, "trace://read-id");
    expect(result.contents).toHaveLength(1);

    const content = result.contents[0];
    expect(content.uri).toBe("trace://read-id");
    expect(content.mimeType).toBe("application/json");

    const parsed = JSON.parse(content.text);
    expect(parsed.trace_id).toBe("read-id");
    expect(parsed.name).toBe("Read Me");
    expect(parsed.status).toBe("completed");
    expect(parsed.step_count).toBe(1);
    expect(parsed.total_tokens).toBe(42);
    expect(parsed.total_latency_ms).toBe(100);
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0].tool_name).toBe("my_tool");
  });

  it("throws McpError for unsupported URI scheme", () => {
    expect(() => handleReadResource(db, "http://example.com")).toThrow(
      McpError,
    );
  });

  it("throws McpError for unknown trace ID in read", () => {
    expect(() => handleReadResource(db, "trace://nonexistent")).toThrow(
      McpError,
    );
  });

  it("includes duration_ms in read resource content", () => {
    insertTrace(db, "dur-id", "Duration Trace");
    endTrace(db, "dur-id");

    const result = handleReadResource(db, "trace://dur-id");
    const parsed = JSON.parse(result.contents[0].text);
    expect(typeof parsed.duration_ms).toBe("number");
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
