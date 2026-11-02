import { createHmac, timingSafeEqual } from "node:crypto";
function base64urlDecode(str) {
    // Convert base64url to base64
    const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return Buffer.from(padded, "base64");
}
function verifyJwt(token, secret) {
    const parts = token.split(".");
    if (parts.length !== 3)
        return false;
    const [headerB64, payloadB64, signatureB64] = parts;
    const signingInput = `${headerB64}.${payloadB64}`;
    // Only HMAC-SHA256 tokens are supported. Rejecting other algorithms avoids
    // accepting a token whose header claims an algorithm we do not verify.
    try {
        const header = JSON.parse(base64urlDecode(headerB64).toString("utf8"));
        if (header.alg !== "HS256")
            return false;
    }
    catch {
        return false;
    }
    const expectedSig = createHmac("sha256", secret)
        .update(signingInput)
        .digest();
    const actualSig = base64urlDecode(signatureB64);
    if (expectedSig.length !== actualSig.length)
        return false;
    return timingSafeEqual(expectedSig, actualSig);
}
function verifyPayloadClaims(token) {
    const parts = token.split(".");
    if (parts.length !== 3)
        return false;
    let payload;
    try {
        payload = JSON.parse(base64urlDecode(parts[1]).toString("utf8"));
    }
    catch {
        return false;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === "number" && payload.exp < nowSeconds) {
        return false;
    }
    if (typeof payload.nbf === "number" && payload.nbf > nowSeconds) {
        return false;
    }
    return true;
}
function constantTimeStringEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length)
        return false;
    return timingSafeEqual(left, right);
}
export function createAuthMiddleware() {
    return (req, res, next) => {
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
            if (typeof providedKey !== "string" ||
                !constantTimeStringEqual(providedKey, apiKeyEnv)) {
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
            if (!verifyPayloadClaims(token)) {
                res.status(401).json({
                    error: "Unauthorized: JWT claims are invalid or expired",
                });
                return;
            }
        }
        next();
    };
}
