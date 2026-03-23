export interface AuditEntry {
    timestamp: string;
    trace_id: string;
    tool_name: string;
    user_id: string;
    token_count: number;
    cost_usd: number;
}
export declare class AuditLog {
    private readonly filePath;
    constructor(filePath?: string);
    private ensureDir;
    record(entry: AuditEntry): void;
    export(from?: string, to?: string): AuditEntry[];
}
