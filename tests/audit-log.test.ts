import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditLog, type AuditEntry } from "../src/audit-log.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "audit-log-test-"));
}

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    trace_id: "trace-abc",
    tool_name: "web_search",
    user_id: "user-1",
    token_count: 100,
    cost_usd: 0.003,
    ...overrides,
  };
}

describe("AuditLog", () => {
  let tempDir: string;
  let auditFilePath: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    auditFilePath = join(tempDir, "audit.jsonl");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates the directory if it doesn't exist", () => {
    const nestedPath = join(tempDir, "subdir", "deep", "audit.jsonl");
    const log = new AuditLog(nestedPath);
    log.record(makeEntry());
    expect(existsSync(nestedPath)).toBe(true);
  });

  it("records an entry and reads it back", () => {
    const log = new AuditLog(auditFilePath);
    const entry = makeEntry();
    log.record(entry);

    const entries = log.export();
    expect(entries).toHaveLength(1);
    expect(entries[0].trace_id).toBe("trace-abc");
    expect(entries[0].tool_name).toBe("web_search");
    expect(entries[0].token_count).toBe(100);
    expect(entries[0].cost_usd).toBe(0.003);
  });

  it("records multiple entries", () => {
    const log = new AuditLog(auditFilePath);
    log.record(makeEntry({ trace_id: "t1" }));
    log.record(makeEntry({ trace_id: "t2" }));
    log.record(makeEntry({ trace_id: "t3" }));

    const entries = log.export();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.trace_id)).toEqual(["t1", "t2", "t3"]);
  });

  it("returns empty array when file doesn't exist", () => {
    const log = new AuditLog(join(tempDir, "nonexistent.jsonl"));
    const entries = log.export();
    expect(entries).toEqual([]);
  });

  it("filters entries by from_date", () => {
    const log = new AuditLog(auditFilePath);
    const d1 = "2025-01-01T00:00:00.000Z";
    const d2 = "2025-06-15T12:00:00.000Z";
    const d3 = "2025-12-31T23:59:59.999Z";

    log.record(makeEntry({ timestamp: d1, trace_id: "t1" }));
    log.record(makeEntry({ timestamp: d2, trace_id: "t2" }));
    log.record(makeEntry({ timestamp: d3, trace_id: "t3" }));

    const entries = log.export("2025-06-01");
    expect(entries).toHaveLength(2);
    expect(entries[0].trace_id).toBe("t2");
    expect(entries[1].trace_id).toBe("t3");
  });

  it("filters entries by to_date", () => {
    const log = new AuditLog(auditFilePath);
    const d1 = "2025-01-01T00:00:00.000Z";
    const d2 = "2025-06-15T12:00:00.000Z";
    const d3 = "2025-12-31T23:59:59.999Z";

    log.record(makeEntry({ timestamp: d1, trace_id: "t1" }));
    log.record(makeEntry({ timestamp: d2, trace_id: "t2" }));
    log.record(makeEntry({ timestamp: d3, trace_id: "t3" }));

    const entries = log.export(undefined, "2025-06-30");
    expect(entries).toHaveLength(2);
    expect(entries[0].trace_id).toBe("t1");
    expect(entries[1].trace_id).toBe("t2");
  });

  it("filters entries by both from_date and to_date", () => {
    const log = new AuditLog(auditFilePath);
    log.record(
      makeEntry({ timestamp: "2025-01-01T00:00:00.000Z", trace_id: "t1" }),
    );
    log.record(
      makeEntry({ timestamp: "2025-06-15T12:00:00.000Z", trace_id: "t2" }),
    );
    log.record(
      makeEntry({ timestamp: "2025-12-31T23:59:59.999Z", trace_id: "t3" }),
    );

    const entries = log.export("2025-03-01", "2025-09-01");
    expect(entries).toHaveLength(1);
    expect(entries[0].trace_id).toBe("t2");
  });

  it("persists across multiple AuditLog instances (same file)", () => {
    const log1 = new AuditLog(auditFilePath);
    log1.record(makeEntry({ trace_id: "from-instance-1" }));

    const log2 = new AuditLog(auditFilePath);
    log2.record(makeEntry({ trace_id: "from-instance-2" }));

    const entries = log2.export();
    expect(entries).toHaveLength(2);
    expect(entries[0].trace_id).toBe("from-instance-1");
    expect(entries[1].trace_id).toBe("from-instance-2");
  });
});
