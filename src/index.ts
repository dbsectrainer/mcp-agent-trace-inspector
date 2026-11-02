#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { openDatabase, deleteOldTraces } from "./db.js";
import { createServer } from "./server.js";
import {
  DEFAULT_PRICING,
  loadPricingTable,
  type PricingTable,
} from "./pricing.js";
import { startHttpServer } from "./http-server.js";
import { AuditLog } from "./audit-log.js";
import { getPackageVersion } from "./version.js";

function positiveNumber(value: unknown, flag: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${flag} must be a finite, non-negative number`);
  }
  return value;
}

async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .version(getPackageVersion())
    .option("db", {
      alias: "db-path",
      type: "string",
      default: "~/.mcp/traces.db",
      description: "Path to the SQLite database file",
    })
    .option("retention-days", {
      type: "number",
      default: 0,
      description:
        "On startup, delete traces older than this many days. 0 = disabled.",
    })
    .option("no-token-count", {
      type: "boolean",
      default: false,
      description: "Disable automatic token counting",
    })
    .option("pricing-table", {
      type: "string",
      description:
        "Path to a custom JSON pricing table file (merged over built-in rates)",
    })
    .option("http-port", {
      type: "number",
      description:
        "Start in HTTP mode on the given port instead of stdio. Example: --http-port=3000",
    })
    .option("http-host", {
      type: "string",
      default: "127.0.0.1",
      description:
        "HTTP bind address (default: 127.0.0.1). Use 0.0.0.0 only with authentication.",
    })
    .help()
    .parseAsync();

  const retentionDays = positiveNumber(
    argv["retention-days"],
    "--retention-days",
  );

  let pricing: PricingTable = DEFAULT_PRICING;
  if (argv["pricing-table"]) {
    try {
      pricing = loadPricingTable(argv["pricing-table"]);
      console.error(
        `[init] Loaded custom pricing table with ${Object.keys(pricing).length} model(s)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[warn] Failed to load pricing table; using built-in pricing: ${message}`,
      );
    }
  }

  const dbPath = argv.db as string;
  const db = openDatabase(dbPath);
  const version = getPackageVersion();

  let auditLog: AuditLog | null = null;
  try {
    auditLog = new AuditLog();
    console.error(`[init] Audit log: ${auditLog.path}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[warn] Audit log unavailable (${message}); trace_step will still work but compliance export will be unavailable`,
    );
  }

  console.error(
    `[init] Database opened: ${dbPath} (MCP Agent Trace Inspector v${version})`,
  );

  if (retentionDays > 0) {
    const deleted = deleteOldTraces(db, retentionDays);
    if (deleted > 0) {
      console.error(
        `[retention] Deleted ${deleted} trace(s) older than ${retentionDays} day(s)`,
      );
    }
  }

  const noTokenCount = argv["no-token-count"] as boolean;
  const httpPort = argv["http-port"] as number | undefined;

  if (httpPort !== undefined) {
    if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65_535) {
      throw new Error("--http-port must be an integer between 1 and 65535");
    }
    const host = argv["http-host"] as string;
    const handle = await startHttpServer({
      port: httpPort,
      host,
      db,
      noTokenCount,
      pricing,
      auditLog,
    });

    const shutdown = async (signal: string): Promise<void> => {
      console.error(`[shutdown] Received ${signal}; closing HTTP server`);
      try {
        await handle.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[warn] HTTP server close failed: ${message}`);
      } finally {
        try {
          db.close();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[warn] Database close failed: ${message}`);
        }
      }
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    return;
  }

  const server = createServer({
    db,
    noTokenCount,
    pricing,
    auditLog,
  });
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error(
    `[init] MCP Agent Trace Inspector v${version} running on stdio`,
  );
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
