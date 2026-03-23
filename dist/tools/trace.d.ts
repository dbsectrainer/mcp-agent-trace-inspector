import { DatabaseSync } from "node:sqlite";
export interface TraceStartArgs {
    name: string;
}
export interface TraceStepArgs {
    trace_id: string;
    tool_name: string;
    input: object;
    output: object;
    token_count?: number;
    latency_ms?: number;
}
export interface TraceEndArgs {
    trace_id: string;
}
export declare function handleTraceStart(db: DatabaseSync, args: TraceStartArgs): {
    content: Array<{
        type: string;
        text: string;
    }>;
};
export declare function handleTraceStep(db: DatabaseSync, args: TraceStepArgs, noTokenCount: boolean): {
    content: Array<{
        type: string;
        text: string;
    }>;
};
export declare function handleTraceEnd(db: DatabaseSync, args: TraceEndArgs): {
    content: Array<{
        type: string;
        text: string;
    }>;
};
