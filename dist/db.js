// Uses the built-in node:sqlite module (Node.js >= 22.5.0)
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
export function expandPath(p) {
    if (p.startsWith("~")) {
        return resolve(homedir() + p.slice(1));
    }
    return resolve(p);
}
export function openDatabase(dbPath) {
    const expanded = expandPath(dbPath);
    const dir = dirname(expanded);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    const db = new DatabaseSync(expanded);
    initSchema(db);
    return db;
}
function initSchema(db) {
    db.exec(`
    PRAGMA journal_mode = WAL;
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

    CREATE INDEX IF NOT EXISTS idx_steps_trace_id ON steps(trace_id);
    CREATE INDEX IF NOT EXISTS idx_traces_started_at ON traces(started_at);
  `);
}
export function insertTrace(db, id, name) {
    db.prepare(`INSERT INTO traces (id, name, status, started_at) VALUES (?, ?, 'running', ?)`).run(id, name, Date.now());
}
export function endTrace(db, id) {
    db.prepare(`UPDATE traces SET status = 'completed', ended_at = ? WHERE id = ?`).run(Date.now(), id);
}
export function insertStep(db, step) {
    db.prepare(`
    INSERT INTO steps (id, trace_id, tool_name, input_json, output_json, token_count, latency_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(step.id, step.trace_id, step.tool_name, step.input_json, step.output_json, step.token_count ?? null, step.latency_ms ?? null, Date.now());
}
export function getTrace(db, id) {
    return db.prepare(`SELECT * FROM traces WHERE id = ?`).get(id);
}
export function getSteps(db, traceId) {
    return db
        .prepare(`SELECT * FROM steps WHERE trace_id = ? ORDER BY created_at ASC`)
        .all(traceId);
}
export function listTraces(db, limit) {
    if (limit && limit > 0) {
        return db
            .prepare(`SELECT * FROM traces ORDER BY started_at DESC LIMIT ?`)
            .all(limit);
    }
    return db
        .prepare(`SELECT * FROM traces ORDER BY started_at DESC`)
        .all();
}
export function deleteOldTraces(db, retentionDays) {
    if (retentionDays <= 0)
        return 0;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    // Delete steps for old traces first (foreign key safety)
    db.prepare(`DELETE FROM steps WHERE trace_id IN (SELECT id FROM traces WHERE started_at < ?)`).run(cutoff);
    const result = db
        .prepare(`DELETE FROM traces WHERE started_at < ?`)
        .run(cutoff);
    return result.changes;
}
export function computeSummary(db, traceId) {
    const trace = getTrace(db, traceId);
    if (!trace)
        return null;
    const steps = getSteps(db, traceId);
    const totalTokens = steps.reduce((acc, s) => acc + (s.token_count ?? 0), 0);
    const totalLatencyMs = steps.reduce((acc, s) => acc + (s.latency_ms ?? 0), 0);
    return {
        trace,
        stepCount: steps.length,
        totalTokens,
        totalLatencyMs,
        steps,
    };
}
