import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { createHmac } from "node:crypto";
import { createAuthMiddleware } from "../src/auth.js";

// Helper to create a mock Express request
function makeReq(headers: Record<string, string> = {}): Request {
  return { headers, ip: "127.0.0.1" } as unknown as Request;
}

// Helper to create a mock Express response (kept for reference)
function _makeRes(): {
  res: Response;
  statusCode: number | undefined;
  body: unknown;
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
  return { res, statusCode: ctx.statusCode, body: ctx.body };
}

// We need to capture statusCode via the ctx object, not the spread
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

function _makeNext(): { next: NextFunction; called: boolean } {
  const ctx = { called: false };
  const next: NextFunction = () => {
    ctx.called = true;
  };
  return { next, called: ctx.called, _ctx: ctx } as unknown as {
    next: NextFunction;
    called: boolean;
  };
}

// Better makeNext that references the same ctx object
function makeNextCtx(): { next: NextFunction; ctx: { called: boolean } } {
  const ctx = { called: false };
  const next: NextFunction = () => {
    ctx.called = true;
  };
  return { next, ctx };
}

function base64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

function makeJwt(
  secret: string,
  payload: Record<string, unknown> = {},
): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const pay = base64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret)
    .update(`${header}.${pay}`)
    .digest("base64url");
  return `${header}.${pay}.${sig}`;
}

describe("createAuthMiddleware", () => {
  beforeEach(() => {
    delete process.env.MCP_API_KEY;
    delete process.env.MCP_JWT_SECRET;
  });

  afterEach(() => {
    delete process.env.MCP_API_KEY;
    delete process.env.MCP_JWT_SECRET;
  });

  it("passes through when neither env var is set", () => {
    const middleware = createAuthMiddleware();
    const req = makeReq();
    const { res } = makeResCtx();
    const { next, ctx } = makeNextCtx();

    middleware(req, res, next);

    expect(ctx.called).toBe(true);
  });

  it("rejects request with wrong API key", () => {
    process.env.MCP_API_KEY = "correct-key";
    const middleware = createAuthMiddleware();

    const req = makeReq({ "x-api-key": "wrong-key" });
    const { res, ctx } = makeResCtx();
    const { next, ctx: nextCtx } = makeNextCtx();

    middleware(req, res, next);

    expect(nextCtx.called).toBe(false);
    expect(ctx.statusCode).toBe(401);
  });

  it("accepts request with correct API key", () => {
    process.env.MCP_API_KEY = "my-secret-key";
    const middleware = createAuthMiddleware();

    const req = makeReq({ "x-api-key": "my-secret-key" });
    const { res } = makeResCtx();
    const { next, ctx } = makeNextCtx();

    middleware(req, res, next);

    expect(ctx.called).toBe(true);
  });

  it("rejects request missing API key header when env is set", () => {
    process.env.MCP_API_KEY = "required-key";
    const middleware = createAuthMiddleware();

    const req = makeReq({});
    const { res, ctx } = makeResCtx();
    const { next, ctx: nextCtx } = makeNextCtx();

    middleware(req, res, next);

    expect(nextCtx.called).toBe(false);
    expect(ctx.statusCode).toBe(401);
  });

  it("accepts valid JWT when MCP_JWT_SECRET is set", () => {
    process.env.MCP_JWT_SECRET = "super-secret";
    const middleware = createAuthMiddleware();

    const token = makeJwt("super-secret", { sub: "user1" });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const { res } = makeResCtx();
    const { next, ctx } = makeNextCtx();

    middleware(req, res, next);

    expect(ctx.called).toBe(true);
  });

  it("rejects invalid JWT signature", () => {
    process.env.MCP_JWT_SECRET = "super-secret";
    const middleware = createAuthMiddleware();

    const token = makeJwt("wrong-secret", { sub: "user1" });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const { res, ctx } = makeResCtx();
    const { next, ctx: nextCtx } = makeNextCtx();

    middleware(req, res, next);

    expect(nextCtx.called).toBe(false);
    expect(ctx.statusCode).toBe(401);
  });

  it("rejects JWT with missing Authorization header", () => {
    process.env.MCP_JWT_SECRET = "super-secret";
    const middleware = createAuthMiddleware();

    const req = makeReq({});
    const { res, ctx } = makeResCtx();
    const { next, ctx: nextCtx } = makeNextCtx();

    middleware(req, res, next);

    expect(nextCtx.called).toBe(false);
    expect(ctx.statusCode).toBe(401);
  });

  it("rejects expired JWT", () => {
    process.env.MCP_JWT_SECRET = "super-secret";
    const middleware = createAuthMiddleware();

    const expiredToken = makeJwt("super-secret", {
      sub: "user1",
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    const req = makeReq({ authorization: `Bearer ${expiredToken}` });
    const { res, ctx } = makeResCtx();
    const { next, ctx: nextCtx } = makeNextCtx();

    middleware(req, res, next);

    expect(nextCtx.called).toBe(false);
    expect(ctx.statusCode).toBe(401);
  });

  it("accepts JWT with future expiry", () => {
    process.env.MCP_JWT_SECRET = "super-secret";
    const middleware = createAuthMiddleware();

    const token = makeJwt("super-secret", {
      sub: "user1",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const { res } = makeResCtx();
    const { next, ctx } = makeNextCtx();

    middleware(req, res, next);

    expect(ctx.called).toBe(true);
  });
});
