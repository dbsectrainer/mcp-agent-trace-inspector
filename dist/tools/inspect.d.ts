import { DatabaseSync } from "node:sqlite";
export interface GetTraceSummaryArgs {
    trace_id: string;
    model?: string;
}
export interface ListTracesArgs {
    limit?: number;
}
export declare function handleGetTraceSummary(db: DatabaseSync, args: GetTraceSummaryArgs): {
    content: Array<{
        type: string;
        text: string;
    }>;
};
export declare function handleListTraces(db: DatabaseSync, args: ListTracesArgs): {
    content: Array<{
        type: string;
        text: string;
    }>;
};
