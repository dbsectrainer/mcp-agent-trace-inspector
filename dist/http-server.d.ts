import type { Server as HttpServer } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { AuditLog } from "./audit-log.js";
import type { PricingTable } from "./pricing.js";
export interface HttpServerOptions {
    /** TCP port. Use 0 in tests to let the OS choose an ephemeral port. */
    port: number;
    /** Bind address. Defaults to loopback for local-first safety. */
    host?: string;
    db: DatabaseSync;
    noTokenCount: boolean;
    pricing?: PricingTable;
    auditLog?: AuditLog | null;
    /** Requests allowed per client per window (default 60). */
    rateLimitMax?: number;
    /** Rate-limit window in milliseconds (default 60000). */
    rateLimitWindowMs?: number;
    /** Maximum JSON request body size (default 10mb). */
    bodyLimit?: string;
}
export interface HttpServerHandle {
    server: HttpServer;
    host: string;
    port: number;
    url: string;
    close(): Promise<void>;
}
/**
 * Start a stateless Streamable HTTP MCP endpoint.
 *
 * A fresh MCP Server + transport pair is created for every POST. The SDK's
 * Protocol deliberately rejects reusing one Server instance across transports,
 * so sharing a single server (the previous implementation) broke every request
 * after the first. Database, pricing, audit and alert state are shared because
 * they are process-level concerns.
 */
export declare function startHttpServer(options: HttpServerOptions): Promise<HttpServerHandle>;
