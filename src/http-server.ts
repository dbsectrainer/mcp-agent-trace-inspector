import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { Server as HttpServer } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { createServer } from "./server.js";
import { createAuthMiddleware } from "./auth.js";
import { createRateLimiter } from "./rate-limiter.js";
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

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function jsonRpcError(
  code: number,
  message: string,
  id: string | number | null = null,
): {
  jsonrpc: "2.0";
  error: { code: number; message: string };
  id: string | number | null;
} {
  return { jsonrpc: "2.0", error: { code, message }, id };
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
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
export async function startHttpServer(
  options: HttpServerOptions,
): Promise<HttpServerHandle> {
  const {
    port,
    host = "127.0.0.1",
    db,
    noTokenCount,
    pricing,
    auditLog,
    rateLimitMax = 60,
    rateLimitWindowMs = 60_000,
    bodyLimit = "10mb",
  } = options;

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("port must be an integer between 0 and 65535");
  }
  if (typeof host !== "string" || host.trim() === "") {
    throw new Error("host must be a non-empty string");
  }

  const app = express();
  app.disable("x-powered-by");

  // DNS-rebinding protection is important for an unauthenticated localhost
  // service. When binding to a non-loopback address the operator is expected
  // to configure MCP_API_KEY / MCP_JWT_SECRET (documented in the README).
  if (LOOPBACK_HOSTS.has(host)) {
    app.use(localhostHostValidation());
  } else {
    console.error(
      `[warn] HTTP server is bound to ${host}. Configure MCP_API_KEY or MCP_JWT_SECRET before exposing it beyond this machine.`,
    );
  }

  // Authenticate and rate-limit before reading a potentially large body.
  const auth = createAuthMiddleware();
  const rateLimiter = createRateLimiter(rateLimitMax, rateLimitWindowMs);
  app.use(auth, rateLimiter);
  app.use(express.json({ limit: bodyLimit }));

  app.post("/mcp", async (req: Request, res: Response) => {
    const server = createServer({
      db,
      noTokenCount,
      pricing,
      auditLog,
    });
    const transport = new StreamableHTTPServerTransport({
      // Stateless mode: no Mcp-Session-Id, and a clean server per request.
      sessionIdGenerator: undefined,
    });

    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      void server.close().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[http] Failed to close MCP server: ${message}`);
      });
    };
    res.on("close", cleanup);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      cleanup();
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[http] MCP request failed: ${message}`);
      if (!res.headersSent) {
        res
          .status(500)
          .json(jsonRpcError(-32_603, "Internal server error", null));
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  // The stateless transport has no server-to-client SSE stream. Return a
  // machine-readable error rather than leaking an SDK exception page.
  app.get("/mcp", (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST");
    res
      .status(405)
      .json(
        jsonRpcError(
          -32_000,
          "Method not allowed. This endpoint does not support server-initiated SSE streams.",
        ),
      );
  });

  app.delete("/mcp", (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST");
    res
      .status(405)
      .json(
        jsonRpcError(-32_000, "Method not allowed. No sessions to delete."),
      );
  });

  app.use((_req: Request, res: Response) => {
    res
      .status(404)
      .json({ error: "Not found. The MCP endpoint is POST /mcp." });
  });

  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      const error = err as {
        type?: string;
        status?: number;
        message?: string;
      };

      if (error.type === "entity.parse.failed") {
        res.status(400).json(jsonRpcError(-32_700, "Parse error", null));
        return;
      }
      if (error.type === "entity.too.large" || error.status === 413) {
        res
          .status(413)
          .json(jsonRpcError(-32_000, "Request body too large", null));
        return;
      }

      console.error(`[http] Unhandled error: ${error.message ?? String(err)}`);
      if (!res.headersSent) {
        res
          .status(500)
          .json(jsonRpcError(-32_603, "Internal server error", null));
      } else if (!res.writableEnded) {
        res.end();
      }
    },
  );

  const server = await new Promise<HttpServer>((resolve, reject) => {
    const listening = app.listen(port, host, () => {
      resolve(listening);
    });
    listening.once("error", reject);
  });

  const address = server.address();
  const actualPort =
    address !== null && typeof address === "object" ? address.port : port;
  const displayHost =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const url = `http://${displayHost}:${actualPort}/mcp`;

  console.error(`MCP Agent Trace Inspector HTTP server listening on ${url}`);

  return {
    server,
    host,
    port: actualPort,
    url,
    close: async () => {
      server.closeIdleConnections();
      await closeServer(server);
    },
  };
}
