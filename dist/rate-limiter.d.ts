import type { RequestHandler } from "express";
export declare function createRateLimiter(maxRequests?: number, windowMs?: number): RequestHandler;
