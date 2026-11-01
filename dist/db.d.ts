import { DatabaseSync } from "node:sqlite";
export type Db = DatabaseSync;
export interface TraceRow {
    id: string;
    name: string;
    status: string;
    started_at: number;
    ended_at: number | null;
    metadata: string | null;
}
export interface StepRow {
    id: string;
    trace_id: string;
    tool_name: string;
    input_json: string;
    output_json: string;
    token_count: number | null;
    latency_ms: number | null;
    created_at: number;
}
export declare function expandPath(p: string): string;
export declare function openDatabase(dbPath: string): DatabaseSync;
export declare function insertTrace(db: DatabaseSync, id: string, name: string): void;
export declare function endTrace(db: DatabaseSync, id: string): void;
export declare function insertStep(db: DatabaseSync, step: Omit<StepRow, "created_at">): void;
export declare function getTrace(db: DatabaseSync, id: string): TraceRow | undefined;
export declare function getSteps(db: DatabaseSync, traceId: string): StepRow[];
export declare function listTraces(db: DatabaseSync, limit?: number): TraceRow[];
export declare function deleteOldTraces(db: DatabaseSync, retentionDays: number): number;
export interface TraceSummary {
    trace: TraceRow;
    stepCount: number;
    totalTokens: number;
    totalLatencyMs: number;
    steps: StepRow[];
}
export declare function computeSummary(db: DatabaseSync, traceId: string): TraceSummary | null;
