import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { openDatabase } from "./db.js";
import { createAuthMiddleware } from "./auth.js";
import { createRateLimiter } from "./rate-limiter.js";
export async function startHttpServer(port, dbPath, noTokenCount) {
  const app = express();
  app.use(express.json());
  const db = openDatabase(dbPath);
  const server = createServer({ db, noTokenCount });
  const auth = createAuthMiddleware();
  const rateLimiter = createRateLimiter(60, 60000);
  app.post("/mcp", auth, rateLimiter, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get("/mcp", auth, rateLimiter, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed" });
  });
  app.listen(port, () => {
    console.error(
      `MCP Agent Trace Inspector HTTP server listening on port ${port}`,
    );
  });
}
