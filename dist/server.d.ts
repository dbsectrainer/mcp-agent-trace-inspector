import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { DatabaseSync } from "node:sqlite";
import { AuditLog } from "./audit-log.js";
import { type PricingTable } from "./pricing.js";
export interface ServerOptions {
    db: DatabaseSync;
    noTokenCount: boolean;
    /** Pricing table used by summaries and audit cost estimates. */
    pricing?: PricingTable;
    /** Explicit audit log instance. Pass null to disable audit logging. */
    auditLog?: AuditLog | null;
}
export declare function createServer(options: ServerOptions): Server;
