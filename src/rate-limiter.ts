import type { RequestHandler, Request, Response, NextFunction } from "express";

interface WindowEntry {
  timestamps: number[];
}

function getClientKey(req: Request): string {
  // Only a *validated* API key may become a rate-limit key. Otherwise a
  // client could rotate arbitrary X-API-Key headers to bypass the limit.
  const apiKey = req.headers["x-api-key"];
  const configuredKey = process.env.MCP_API_KEY;
  if (typeof apiKey === "string" && configuredKey && apiKey === configuredKey) {
    return `apikey:${apiKey}`;
  }

  const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
  return `ip:${ip}`;
}

export function createRateLimiter(
  maxRequests: number = 60,
  windowMs: number = 60000,
): RequestHandler {
  // Each limiter instance has its own window map (not module-level)
  const windows = new Map<string, WindowEntry>();
  let requestCount = 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = getClientKey(req);
    const now = Date.now();
    const windowStart = now - windowMs;

    let entry = windows.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      windows.set(key, entry);
    }

    // Slide the window: remove timestamps older than windowMs
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    // Periodically drop idle clients so the map does not grow without bound
    // under traffic from many source addresses.
    requestCount++;
    if (requestCount % 1000 === 0 || windows.size > 10_000) {
      for (const [clientKey, clientEntry] of windows) {
        clientEntry.timestamps = clientEntry.timestamps.filter(
          (t) => t > windowStart,
        );
        if (clientEntry.timestamps.length === 0) {
          windows.delete(clientKey);
        }
      }
      entry = windows.get(key);
      if (!entry) {
        entry = { timestamps: [] };
        windows.set(key, entry);
      }
    }

    if (entry.timestamps.length >= maxRequests) {
      res.setHeader("Retry-After", Math.ceil(windowMs / 1000).toString());
      res.status(429).json({
        error: "Too Many Requests",
        retryAfterMs: windowMs,
      });
      return;
    }

    entry.timestamps.push(now);
    next();
  };
}
