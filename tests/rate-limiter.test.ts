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
  ctx: { statusCode: number | undefined; body: unknown };
} {
  const ctx: { statusCode: number | undefined; body: unknown } = {
    statusCode: undefined,
    body: undefined,
  };
  const res = {
    status(code: number) {
      ctx.statusCode = code;
      return res;
    },
    json(data: unknown) {
      ctx.body = data;
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

  it("uses API key as the rate limit key when present", () => {
    const limiter = createRateLimiter(2, 60000);

    // Two requests from the same IP but different API keys
    const req1 = makeReq("10.0.0.1", "key-a");
    const req2 = makeReq("10.0.0.1", "key-b");

    // 2 requests for key-a
    for (let i = 0; i < 2; i++) {
      const { res } = makeResCtx();
      const { next } = makeNextCtx();
      limiter(req1, res, next);
    }

    // key-b should still be allowed (different key)
    const { res } = makeResCtx();
    const { next, ctx } = makeNextCtx();
    limiter(req2, res, next);
    expect(ctx.called).toBe(true);
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
    expect((resCtx.body as { error: string }).error).toBe("Too Many Requests");
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
