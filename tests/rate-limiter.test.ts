import { describe, it, expect } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { createRateLimiter } from "../src/rate-limiter.js";

function makeReq(ip: string = "127.0.0.1", apiKey?: string): Request {
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;
  return {
    headers,
    ip,
    socket: { remoteAddress: ip },
  } as unknown as Request;
}

function makeResCtx(): {
  res: Response;
  ctx: {
    statusCode: number | undefined;
    body: unknown;
    headers: Record<string, string>;
  };
} {
  const ctx: {
    statusCode: number | undefined;
    body: unknown;
    headers: Record<string, string>;
  } = {
    statusCode: undefined,
    body: undefined,
    headers: {},
  };
  const res = {
    status(code: number) {
      ctx.statusCode = code;
      return res;
    },
    json(data: unknown) {
      ctx.body = data;
    },
    setHeader(name: string, value: string) {
      ctx.headers[name] = value;
      return res;
    },
  } as unknown as Response;
  return { res, ctx };
}

function makeNextCtx(): { next: NextFunction; ctx: { called: boolean } } {
  const ctx = { called: false };
  const next: NextFunction = () => {
    ctx.called = true;
  };
  return { next, ctx };
}

describe("createRateLimiter", () => {
  it("allows requests under the limit", () => {
    const limiter = createRateLimiter(5, 60000);
    for (let i = 0; i < 5; i++) {
      const req = makeReq(`10.0.0.${i + 1}`); // different IPs to avoid interference
      const { res } = makeResCtx();
      const { next, ctx } = makeNextCtx();
      limiter(req, res, next);
      expect(ctx.called).toBe(true);
    }
  });

  it("blocks requests over the limit and returns 429", () => {
    const limiter = createRateLimiter(3, 60000);
    const req = makeReq("192.168.1.100");

    // First 3 should pass
    for (let i = 0; i < 3; i++) {
      const { res } = makeResCtx();
      const { next } = makeNextCtx();
      limiter(req, res, next);
    }

    // 4th should be blocked
    const { res, ctx: resCtx } = makeResCtx();
    const { next, ctx: nextCtx } = makeNextCtx();
    limiter(req, res, next);

    expect(nextCtx.called).toBe(false);
    expect(resCtx.statusCode).toBe(429);
  });

  it("only trusts a validated API key as the rate-limit key", () => {
    process.env.MCP_API_KEY = "key-a";
    try {
      const limiter = createRateLimiter(2, 60000);
      const validated = makeReq("10.0.0.1", "key-a");
      const unvalidated = makeReq("10.0.0.1", "key-b");

      // Two requests with an unvalidated key consume the shared IP bucket.
      for (let i = 0; i < 2; i++) {
        const { res } = makeResCtx();
        const { next } = makeNextCtx();
        limiter(unvalidated, res, next);
      }

      // A third unvalidated key value cannot create a fresh bucket.
      const blockedRes = makeResCtx();
      const blockedNext = makeNextCtx();
      limiter(unvalidated, blockedRes.res, blockedNext.next);
      expect(blockedNext.ctx.called).toBe(false);
      expect(blockedRes.ctx.statusCode).toBe(429);

      // The validated key has its own bucket and is still allowed.
      const validRes = makeResCtx();
      const validNext = makeNextCtx();
      limiter(validated, validRes.res, validNext.next);
      expect(validNext.ctx.called).toBe(true);
    } finally {
      delete process.env.MCP_API_KEY;
    }
  });

  it("blocks when api key limit is exceeded", () => {
    const limiter = createRateLimiter(2, 60000);
    const req = makeReq("10.0.0.2", "my-key");

    // Consume 2 slots
    for (let i = 0; i < 2; i++) {
      const { res } = makeResCtx();
      const { next } = makeNextCtx();
      limiter(req, res, next);
    }

    // 3rd should be blocked
    const { res, ctx: resCtx } = makeResCtx();
    const { next, ctx: nextCtx } = makeNextCtx();
    limiter(req, res, next);
    expect(nextCtx.called).toBe(false);
    expect(resCtx.statusCode).toBe(429);
    expect(resCtx.headers["Retry-After"]).toBe("60");
    expect((resCtx.body as { error: string }).error).toBe("Too Many Requests");
  });

  it("prunes idle client windows without disrupting requests", () => {
    const limiter = createRateLimiter(100000, 60000);
    for (let i = 0; i < 1000; i++) {
      const { res } = makeResCtx();
      const { next, ctx } = makeNextCtx();
      limiter(makeReq(`10.1.${Math.floor(i / 250)}.${i % 250}`), res, next);
      expect(ctx.called).toBe(true);
    }
  });

  it("uses default limits of 60 req / 60s", () => {
    const limiter = createRateLimiter(); // defaults: 60, 60000
    const req = makeReq("192.168.99.99");

    // 60 requests should pass
    for (let i = 0; i < 60; i++) {
      const { res } = makeResCtx();
      const { next, ctx } = makeNextCtx();
      limiter(req, res, next);
      expect(ctx.called).toBe(true);
    }

    // 61st should be blocked
    const { res, ctx: resCtx } = makeResCtx();
    const { next, ctx: nextCtx } = makeNextCtx();
    limiter(req, res, next);
    expect(nextCtx.called).toBe(false);
    expect(resCtx.statusCode).toBe(429);
  });
});
