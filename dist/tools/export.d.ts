import { DatabaseSync } from "node:sqlite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
export interface ExportDashboardArgs {
    trace_id: string;
}
export declare function handleExportDashboard(db: DatabaseSync, args: ExportDashboardArgs, server?: Server): Promise<{
    content: Array<{
        type: string;
        text: string;
    }>;
}>;
