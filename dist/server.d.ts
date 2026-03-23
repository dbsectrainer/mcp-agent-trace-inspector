import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { DatabaseSync } from "node:sqlite";
export declare function isRequestCancelled(requestId: string): boolean;
export declare function clearCancellation(requestId: string): void;
export interface ServerOptions {
  db: DatabaseSync;
  noTokenCount: boolean;
}
export declare function createServer(options: ServerOptions): Server;
