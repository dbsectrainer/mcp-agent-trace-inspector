#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { openDatabase, deleteOldTraces } from "./db.js";
import { createServer } from "./server.js";
import { loadPricingTable } from "./pricing.js";
import { startHttpServer } from "./http-server.js";
async function main() {
    const argv = await yargs(hideBin(process.argv))
        .option("db", {
        alias: "db-path",
        type: "string",
        default: "~/.mcp/traces.db",
        description: "Path to the SQLite database file",
    })
        .option("retention-days", {
        type: "number",
        default: 0,
        description: "Auto-delete traces older than this many days. 0 = disabled.",
    })
        .option("no-token-count", {
        type: "boolean",
        default: false,
        description: "Disable token counting",
    })
        .option("pricing-table", {
        type: "string",
        description: "Path to a custom JSON pricing table file",
    })
        .option("http-port", {
        type: "number",
        description: "Start in HTTP mode on the given port instead of stdio. Example: --http-port=3000",
    })
        .help()
        .parseAsync();
    // Load pricing table (for future use / extensions)
    if (argv["pricing-table"]) {
        try {
            const customPricing = loadPricingTable(argv["pricing-table"]);
            console.error(`[init] Loaded custom pricing table with ${Object.keys(customPricing).length} model(s)`);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[warn] Failed to load pricing table: ${message}`);
        }
    }
    // Open database (uses built-in node:sqlite)
    const dbPath = argv.db;
    const db = openDatabase(dbPath);
    console.error(`[init] Database opened at: ${dbPath}`);
    // Apply retention policy
    const retentionDays = argv["retention-days"];
    if (retentionDays > 0) {
        const deleted = deleteOldTraces(db, retentionDays);
        if (deleted > 0) {
            console.error(`[retention] Deleted ${deleted} trace(s) older than ${retentionDays} day(s)`);
        }
    }
    const noTokenCount = argv["no-token-count"];
    const httpPort = argv["http-port"];
    if (httpPort !== undefined) {
        await startHttpServer(httpPort, dbPath, noTokenCount);
        return;
    }
    const server = createServer({ db, noTokenCount });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[init] MCP Agent Trace Inspector server running on stdio");
}
main().catch((err) => {
    console.error("[fatal]", err);
    process.exit(1);
});
