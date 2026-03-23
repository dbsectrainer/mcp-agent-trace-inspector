import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockWrite, mockEnd, mockOn, mockResOn, mockResume } = vi.hoisted(
  () => ({
    mockWrite: vi.fn(),
    mockEnd: vi.fn(),
    mockOn: vi.fn().mockReturnThis(),
    mockResOn: vi.fn(),
    mockResume: vi.fn(),
  }),
);

vi.mock("node:https", () => ({
  request: vi.fn((_opts: unknown, cb: (res: unknown) => void) => {
    cb({ resume: mockResume, on: mockResOn });
    return { write: mockWrite, end: mockEnd, on: mockOn };
  }),
}));
import { DatabaseSync } from "node:sqlite";
import { insertTrace, insertStep } from "../src/db.js";
import {
  checkAndAlert,
  saveAlertRules,
  loadAlertRules,
  initAlertRulesTable,
  type AlertRule,
  type AlertChannels,
} from "../src/alerting.js";

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

describe("checkAndAlert", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it("returns empty array when no rules", async () => {
    const fired = await checkAndAlert(db, [], {});
    expect(fired).toEqual([]);
  });

  it("fires latency alert when average exceeds threshold", async () => {
    insertTrace(db, "t1", "Test");
    insertStep(db, {
      id: "s1",
      trace_id: "t1",
      tool_name: "slow_tool",
      input_json: "{}",
      output_json: "{}",
      token_count: null,
      latency_ms: 2000,
    });

    const rules: AlertRule[] = [{ type: "latency", threshold: 500 }];
    const fired = await checkAndAlert(db, rules, {});
    expect(fired).toHaveLength(1);
    expect(fired[0].rule.type).toBe("latency");
    expect(fired[0].value).toBe(2000);
  });

  it("does not fire latency alert when under threshold", async () => {
    insertTrace(db, "t2", "Fast Trace");
    insertStep(db, {
      id: "s2",
      trace_id: "t2",
      tool_name: "fast_tool",
      input_json: "{}",
      output_json: "{}",
      token_count: null,
      latency_ms: 100,
    });

    const rules: AlertRule[] = [{ type: "latency", threshold: 500 }];
    const fired = await checkAndAlert(db, rules, {});
    expect(fired).toHaveLength(0);
  });

  it("fires error_rate alert when rate exceeds threshold", async () => {
    insertTrace(db, "t3", "Error Trace");
    // 2 steps, 1 with error => 50% error rate
    insertStep(db, {
      id: "s3a",
      trace_id: "t3",
      tool_name: "ok_tool",
      input_json: "{}",
      output_json: JSON.stringify({ result: "ok" }),
      token_count: null,
      latency_ms: null,
    });
    insertStep(db, {
      id: "s3b",
      trace_id: "t3",
      tool_name: "err_tool",
      input_json: "{}",
      output_json: JSON.stringify({ error: "failed" }),
      token_count: null,
      latency_ms: null,
    });

    const rules: AlertRule[] = [{ type: "error_rate", threshold: 25 }]; // 25%
    const fired = await checkAndAlert(db, rules, {});
    expect(fired).toHaveLength(1);
    expect(fired[0].rule.type).toBe("error_rate");
    expect(fired[0].value).toBeCloseTo(50);
  });

  it("fires cost alert when total cost exceeds threshold", async () => {
    insertTrace(db, "t4", "Expensive Trace");
    // 100,000 tokens * $0.003/1K = $0.30
    insertStep(db, {
      id: "s4",
      trace_id: "t4",
      tool_name: "llm_call",
      input_json: "{}",
      output_json: "{}",
      token_count: 100000,
      latency_ms: null,
    });

    const rules: AlertRule[] = [{ type: "cost", threshold: 0.1 }]; // $0.10
    const fired = await checkAndAlert(db, rules, {});
    expect(fired).toHaveLength(1);
    expect(fired[0].rule.type).toBe("cost");
    expect(fired[0].value).toBeGreaterThan(0.1);
  });

  it("POSTs to generic webhook when alert fires", async () => {
    mockResOn.mockImplementation((event: string, cb: () => void) => {
      if (event === "end") cb();
    });

    insertTrace(db, "t5", "Webhook Test");
    insertStep(db, {
      id: "s5",
      trace_id: "t5",
      tool_name: "slow",
      input_json: "{}",
      output_json: "{}",
      token_count: null,
      latency_ms: 5000,
    });

    const rules: AlertRule[] = [{ type: "latency", threshold: 100 }];
    const channels: AlertChannels = {
      genericWebhook: "https://example.com/hook",
    };

    // We just verify the function completes without error and returns fired alerts
    const fired = await checkAndAlert(db, rules, channels);
    expect(fired).toHaveLength(1);
  });
});

describe("saveAlertRules / loadAlertRules", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("saves and loads alert rules", () => {
    const rules: AlertRule[] = [
      { type: "latency", threshold: 1000 },
      { type: "error_rate", threshold: 5 },
      { type: "cost", threshold: 0.5 },
    ];

    saveAlertRules(db, rules);
    const loaded = loadAlertRules(db);

    expect(loaded).toHaveLength(3);
    expect(loaded[0]).toEqual({ type: "latency", threshold: 1000 });
    expect(loaded[1]).toEqual({ type: "error_rate", threshold: 5 });
    expect(loaded[2]).toEqual({ type: "cost", threshold: 0.5 });
  });

  it("replaces existing rules on save", () => {
    saveAlertRules(db, [{ type: "latency", threshold: 1000 }]);
    saveAlertRules(db, [{ type: "cost", threshold: 1.0 }]);

    const loaded = loadAlertRules(db);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].type).toBe("cost");
  });

  it("loads empty array when no rules saved", () => {
    initAlertRulesTable(db);
    const loaded = loadAlertRules(db);
    expect(loaded).toEqual([]);
  });
});
