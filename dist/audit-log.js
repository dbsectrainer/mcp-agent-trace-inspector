import { appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
const DEFAULT_AUDIT_PATH = join(homedir(), ".mcp", "trace-inspector-audit.jsonl");
export class AuditLog {
    filePath;
    constructor(filePath = DEFAULT_AUDIT_PATH) {
        this.filePath = filePath;
        this.ensureDir();
    }
    ensureDir() {
        const dir = dirname(this.filePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }
    record(entry) {
        this.ensureDir();
        const line = JSON.stringify(entry) + "\n";
        appendFileSync(this.filePath, line, "utf8");
    }
    export(from, to) {
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
        const fromDate = from ? new Date(from).getTime() : null;
        const toDate = to ? new Date(to).getTime() : null;
        return entries.filter((e) => {
            const ts = new Date(e.timestamp).getTime();
            if (fromDate !== null && ts < fromDate)
                return false;
            if (toDate !== null && ts > toDate)
                return false;
            return true;
        });
    }
}
