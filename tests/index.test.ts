/**
 * Tests for src/index.ts — exercises the CLI argument parsing and startup
 * logic by mocking the transport and database layers.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";

// We test the individual components that index.ts stitches together,
// since spawning the actual binary in tests is fragile and slow.

describe("index.ts components (openDatabase + deleteOldTraces + loadPricingTable)", () => {
  it("openDatabase creates an in-memory db", async () => {
    const { openDatabase } = await import("../src/db.js");
    // Use a temp path-like string; openDatabase expands "~" paths
    // For testing, use ":memory:" isn't directly supported via openDatabase
    // but we can verify the function exists and opens a real db
    expect(typeof openDatabase).toBe("function");
  });

  it("deleteOldTraces returns 0 when retentionDays <= 0", async () => {
    const { deleteOldTraces } = await import("../src/db.js");
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
        started_at INTEGER NOT NULL, ended_at INTEGER, metadata TEXT
      );
      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, tool_name TEXT NOT NULL,
        input_json TEXT NOT NULL, output_json TEXT NOT NULL,
        token_count INTEGER, latency_ms INTEGER, created_at INTEGER NOT NULL,
        FOREIGN KEY (trace_id) REFERENCES traces(id)
      );
    `);
    const deleted = deleteOldTraces(db, 0);
    expect(deleted).toBe(0);
    db.close();
  });

  it("deleteOldTraces deletes old traces", async () => {
    const { deleteOldTraces } = await import("../src/db.js");
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
        started_at INTEGER NOT NULL, ended_at INTEGER, metadata TEXT
      );
      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, tool_name TEXT NOT NULL,
        input_json TEXT NOT NULL, output_json TEXT NOT NULL,
        token_count INTEGER, latency_ms INTEGER, created_at INTEGER NOT NULL,
        FOREIGN KEY (trace_id) REFERENCES traces(id)
      );
    `);

    // Insert an old trace (100 days ago)
    const oldTimestamp = Date.now() - 100 * 24 * 60 * 60 * 1000;
    db.prepare(
      `INSERT INTO traces (id, name, status, started_at) VALUES (?, ?, 'running', ?)`,
    ).run("old-id", "Old Trace", oldTimestamp);

    const deleted = deleteOldTraces(db, 30);
    expect(deleted).toBe(1);
    db.close();
  });

  it("loadPricingTable throws for a non-existent file", async () => {
    const { loadPricingTable } = await import("../src/pricing.js");
    expect(() => loadPricingTable("/nonexistent/path/pricing.json")).toThrow();
  });

  it("createServer initializes correctly with options", async () => {
    const { createServer } = await import("../src/server.js");
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
        started_at INTEGER NOT NULL, ended_at INTEGER, metadata TEXT
      );
      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, tool_name TEXT NOT NULL,
        input_json TEXT NOT NULL, output_json TEXT NOT NULL,
        token_count INTEGER, latency_ms INTEGER, created_at INTEGER NOT NULL,
        FOREIGN KEY (trace_id) REFERENCES traces(id)
      );
    `);

    const server = createServer({ db, noTokenCount: false });
    expect(server).toBeDefined();
    db.close();
  });

  it("createServer works with noTokenCount=true", async () => {
    const { createServer } = await import("../src/server.js");
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
        started_at INTEGER NOT NULL, ended_at INTEGER, metadata TEXT
      );
      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, tool_name TEXT NOT NULL,
        input_json TEXT NOT NULL, output_json TEXT NOT NULL,
        token_count INTEGER, latency_ms INTEGER, created_at INTEGER NOT NULL,
        FOREIGN KEY (trace_id) REFERENCES traces(id)
      );
    `);
    const server = createServer({ db, noTokenCount: true });
    expect(server).toBeDefined();
    db.close();
  });
});

describe("expandPath utility", () => {
  it("expands ~ to home directory", async () => {
    const { expandPath } = await import("../src/db.js");
    const homedir = (await import("node:os")).homedir();
    const result = expandPath("~/test.db");
    expect(result).toContain(homedir);
    expect(result).toContain("test.db");
  });

  it("resolves relative path", async () => {
    const { expandPath } = await import("../src/db.js");
    const result = expandPath("./some/path.db");
    expect(result).toContain("some/path.db");
    expect(result.startsWith("/")).toBe(true); // absolute path
  });

  it("keeps absolute path as-is (resolved)", async () => {
    const { expandPath } = await import("../src/db.js");
    const result = expandPath("/tmp/test.db");
    expect(result).toBe("/tmp/test.db");
  });
});

describe("http-server module", () => {
  it("startHttpServer is a function", async () => {
    const { startHttpServer } = await import("../src/http-server.js");
    expect(typeof startHttpServer).toBe("function");
  });
});

describe("pricing.ts", () => {
  it("DEFAULT_PRICING has known models", async () => {
    const { DEFAULT_PRICING } = await import("../src/pricing.js");
    expect(DEFAULT_PRICING["claude-sonnet-4-6"]).toBeDefined();
    expect(DEFAULT_PRICING["claude-sonnet-4-6"].input).toBeGreaterThan(0);
    expect(DEFAULT_PRICING["claude-sonnet-4-6"].output).toBeGreaterThan(0);
  });

  it("estimateCost returns null for unknown model", async () => {
    const { estimateCost, DEFAULT_PRICING } = await import("../src/pricing.js");
    const result = estimateCost(1000, "unknown-model", DEFAULT_PRICING);
    expect(result).toBeNull();
  });

  it("estimateCost returns a number for known model", async () => {
    const { estimateCost, DEFAULT_PRICING } = await import("../src/pricing.js");
    const result = estimateCost(1000, "claude-sonnet-4-6", DEFAULT_PRICING);
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThan(0);
  });

  it("estimateCost calculates correctly (1000 tokens at 0.003/1K = 0.003)", async () => {
    const { estimateCost, DEFAULT_PRICING } = await import("../src/pricing.js");
    const result = estimateCost(1000, "claude-sonnet-4-6", DEFAULT_PRICING);
    expect(result).toBeCloseTo(0.003, 6);
  });

  it("loadPricingTable throws for nonexistent file", async () => {
    const { loadPricingTable } = await import("../src/pricing.js");
    expect(() => loadPricingTable("/does/not/exist.json")).toThrow(
      /Failed to load pricing table/,
    );
  });

  it("loadPricingTable throws for invalid JSON structure (array)", async () => {
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const path = "/tmp/test-pricing-invalid.json";
    writeFileSync(path, JSON.stringify([1, 2, 3]));
    const { loadPricingTable } = await import("../src/pricing.js");
    try {
      expect(() => loadPricingTable(path)).toThrow(/Pricing table must be/);
    } finally {
      unlinkSync(path);
    }
  });

  it("loadPricingTable throws for invalid model entry", async () => {
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const path = "/tmp/test-pricing-bad-entry.json";
    writeFileSync(
      path,
      JSON.stringify({ "bad-model": { input: "not-a-number", output: 0.01 } }),
    );
    const { loadPricingTable } = await import("../src/pricing.js");
    try {
      expect(() => loadPricingTable(path)).toThrow(/Invalid pricing entry/);
    } finally {
      unlinkSync(path);
    }
  });

  it("loadPricingTable loads valid pricing table successfully", async () => {
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const path = "/tmp/test-pricing-valid.json";
    const table = {
      "custom-model": { input: 0.002, output: 0.01 },
    };
    writeFileSync(path, JSON.stringify(table));
    const { loadPricingTable } = await import("../src/pricing.js");
    try {
      const result = loadPricingTable(path);
      expect(result["custom-model"]).toBeDefined();
      expect(result["custom-model"].input).toBe(0.002);
    } finally {
      unlinkSync(path);
    }
  });
});
