import { createHmac } from "node:crypto";
import type { RequestHandler, Request, Response, NextFunction } from "express";

function base64urlDecode(str: string): Buffer {
  // Convert base64url to base64
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function verifyJwt(token: string, secret: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const expectedSig = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");

  // Constant-time comparison
  const expected = Buffer.from(expectedSig);
  const actual = Buffer.from(signatureB64);

  if (expected.length !== actual.length) return false;

  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected[i] ^ actual[i];
  }
  return diff === 0;
}

function verifyPayloadExpiry(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  try {
    const payloadJson = base64urlDecode(parts[1]).toString("utf8");
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    if (
      typeof payload.exp === "number" &&
      payload.exp < Math.floor(Date.now() / 1000)
    ) {
      return false;
    }
  } catch {
    // If payload can't be parsed, don't block — just ignore expiry check
  }
  return true;
}

export function createAuthMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const apiKeyEnv = process.env.MCP_API_KEY;
    const jwtSecretEnv = process.env.MCP_JWT_SECRET;

    // If neither env var is set, pass through
    if (!apiKeyEnv && !jwtSecretEnv) {
      next();
      return;
    }

    // Validate X-API-Key if MCP_API_KEY is set
    if (apiKeyEnv) {
      const providedKey = req.headers["x-api-key"];
      if (typeof providedKey !== "string" || providedKey !== apiKeyEnv) {
        res.status(401).json({ error: "Unauthorized: invalid API key" });
        return;
      }
    }

    // Validate Authorization: Bearer <token> if MCP_JWT_SECRET is set
    if (jwtSecretEnv) {
      const authHeader = req.headers["authorization"];
      if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
        res.status(401).json({
          error: "Unauthorized: missing or malformed Authorization header",
        });
        return;
      }

      const token = authHeader.slice("Bearer ".length).trim();
      if (!verifyJwt(token, jwtSecretEnv)) {
        res.status(401).json({ error: "Unauthorized: invalid JWT signature" });
        return;
      }

      if (!verifyPayloadExpiry(token)) {
        res.status(401).json({ error: "Unauthorized: JWT has expired" });
        return;
      }
    }

    next();
  };
}
