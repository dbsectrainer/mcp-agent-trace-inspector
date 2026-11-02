import { appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
const DEFAULT_AUDIT_PATH = join(homedir(), ".mcp", "trace-inspector-audit.jsonl");
export function getDefaultAuditLogPath() {
    const configured = process.env.MCP_AUDIT_LOG_PATH;
    return configured && configured.trim() !== ""
        ? configured
        : DEFAULT_AUDIT_PATH;
}
export class AuditLog {
    filePath;
    constructor(filePath = getDefaultAuditLogPath()) {
        this.filePath = filePath;
        this.ensureDir();
    }
    get path() {
        return this.filePath;
    }
    ensureDir() {
        const dir = dirname(this.filePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
    }
    record(entry) {
        this.ensureDir();
        const line = JSON.stringify(entry) + "\n";
        // The audit trail may contain tool names and token/cost metadata. Create
        // it owner-readable/writable only (mode is applied when the file is new).
        appendFileSync(this.filePath, line, { encoding: "utf8", mode: 0o600 });
    }
    export(from, to) {
        const parseBoundary = (value, endOfDay) => {
            const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
            const parsed = new Date(value).getTime();
            if (Number.isNaN(parsed)) {
                throw new Error(`Invalid date filter: ${value}`);
            }
            // A date-only upper bound means the entire day is included, not just
            // midnight at the start of that day.
            return dateOnly && endOfDay ? parsed + 24 * 60 * 60 * 1000 - 1 : parsed;
        };
        const fromDate = from ? parseBoundary(from, false) : null;
        const toDate = to ? parseBoundary(to, true) : null;
        if (!existsSync(this.filePath)) {
            return [];
        }
        const raw = readFileSync(this.filePath, "utf8");
        const lines = raw.split("\n").filter((l) => l.trim() !== "");
        const entries = [];
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                entries.push(entry);
            }
            catch {
                // skip malformed lines
            }
        }
        return entries.filter((e) => {
            const ts = new Date(e.timestamp).getTime();
            if (Number.isNaN(ts))
                return false;
            if (fromDate !== null && ts < fromDate)
                return false;
            if (toDate !== null && ts > toDate)
                return false;
            return true;
        });
    }
}
