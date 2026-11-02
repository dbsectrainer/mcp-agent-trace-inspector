import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { startHttpServer, type HttpServerHandle } from "../src/http-server.js";
import { openDatabase } from "../src/db.js";
import { AuditLog } from "../src/audit-log.js";
import { getPackageVersion } from "../src/version.js";

interface JsonRpcResponse {
  result?: {
    serverInfo?: { name: string; version: string };
    content?: Array<{ type: string; text: string }>;
  };
  error?: { code: number; message: string };
}

function parseResponse(text: string): JsonRpcResponse {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  const jsonText = dataLine ? dataLine.slice("data: ".length) : text;
  return JSON.parse(jsonText) as JsonRpcResponse;
}

describe("HTTP transport (stateless Streamable HTTP)", () => {
  let dir: string;
  let db: DatabaseSync;
  let handle: HttpServerHandle | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trace-inspector-http-"));
    db = openDatabase(join(dir, "traces.db"));
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    db.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MCP_API_KEY;
    delete process.env.MCP_JWT_SECRET;
  });

  async function start(
    overrides: Partial<Parameters<typeof startHttpServer>[0]> = {},
  ): Promise<HttpServerHandle> {
    handle = await startHttpServer({
      port: 0,
      host: "127.0.0.1",
      db,
      noTokenCount: true,
      auditLog: new AuditLog(join(dir, "audit.jsonl")),
      rateLimitMax: 100,
      ...overrides,
    });
    return handle;
  }

  async function rpc(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{
    status: number;
    text: string;
    json: JsonRpcResponse;
    headers: Headers;
  }> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      json: parseResponse(text),
      headers: response.headers,
    };
  }

  function initializeBody(id: number): unknown {
    return {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "1.0.0" },
      },
    };
  }

  it("serves more than one request on the same server", async () => {
    const server = await start();

    const first = await rpc(server.url, initializeBody(1));
    expect(first.status).toBe(200);
    expect(first.json.result?.serverInfo?.version).toBe(getPackageVersion());

    const second = await rpc(server.url, initializeBody(2));
    expect(second.status).toBe(200);
    expect(second.text).not.toContain("Already connected to a transport");

    const startTrace = await rpc(server.url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "trace_start",
        arguments: { name: "HTTP Trace" },
      },
    });
    expect(startTrace.status).toBe(200);
    const payload = JSON.parse(startTrace.json.result!.content![0].text) as {
      trace_id: string;
      status: string;
    };
    expect(payload.status).toBe("running");

    const list = await rpc(server.url, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "list_traces", arguments: {} },
    });
    expect(list.status).toBe(200);
    expect(list.json.result!.content![0].text).toContain("HTTP Trace");
  });

  it("returns a JSON-RPC error for parse failures without a stack trace", async () => {
    const server = await start();
    const response = await rpc(server.url, "{not-json");

    expect(response.status).toBe(400);
    expect(response.json.error?.code).toBe(-32700);
    expect(response.text).not.toContain("SyntaxError");
    expect(response.text).not.toContain("http-server.ts");
  });

  it("rejects GET and DELETE with 405 and an Allow header", async () => {
    const server = await start();

    const getResponse = await fetch(server.url, { method: "GET" });
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toBe("POST");
    const getBody = (await getResponse.json()) as {
      error: { code: number };
    };
    expect(getBody.error.code).toBe(-32000);

    const deleteResponse = await fetch(server.url, { method: "DELETE" });
    expect(deleteResponse.status).toBe(405);
  });

  it("returns a 404 JSON response for unknown routes", async () => {
    const server = await start();
    const response = await fetch(new URL("/unknown", server.url), {
      method: "GET",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Not found. The MCP endpoint is POST /mcp.",
    });
  });

  it("enforces MCP_API_KEY when configured", async () => {
    process.env.MCP_API_KEY = "test-key";
    const server = await start();

    const unauthorized = await rpc(server.url, initializeBody(1));
    expect(unauthorized.status).toBe(401);

    const wrong = await rpc(server.url, initializeBody(2), {
      "x-api-key": "wrong-key",
    });
    expect(wrong.status).toBe(401);

    const authorized = await rpc(server.url, initializeBody(3), {
      "x-api-key": "test-key",
    });
    expect(authorized.status).toBe(200);
  });

  it("rate limits requests and returns Retry-After", async () => {
    const server = await start({ rateLimitMax: 2 });

    expect((await rpc(server.url, initializeBody(1))).status).toBe(200);
    expect((await rpc(server.url, initializeBody(2))).status).toBe(200);

    const limited = await rpc(server.url, initializeBody(3));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.text).toContain("Too Many Requests");
  });

  it("returns HTTP 413 for bodies over the configured limit", async () => {
    const server = await start({ bodyLimit: "1kb" });
    const large = "x".repeat(2 * 1024);
    const response = await rpc(server.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { padding: large },
    });

    expect(response.status).toBe(413);
    expect(response.json.error?.code).toBe(-32000);
  });
});
