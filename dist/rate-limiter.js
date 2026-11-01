function getClientKey(req) {
    const apiKey = req.headers["x-api-key"];
    if (typeof apiKey === "string" && apiKey) {
        return `apikey:${apiKey}`;
    }
    // Fall back to IP address
    const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
    return `ip:${ip}`;
}
export function createRateLimiter(maxRequests = 60, windowMs = 60000) {
    // Each limiter instance has its own window map (not module-level)
    const windows = new Map();
    return (req, res, next) => {
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
        if (entry.timestamps.length >= maxRequests) {
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
