import { createClient } from "redis";
import { env } from "../config/env.js";

// PHASE 9 — Redis shared-state experiment.
//
// Phase 8 remains implemented in:
// src/experiments/in-memory-counter.ts
//
// If REDIS_URL is absent, Redis stays disabled for native runs.

export const redisClient = env.redisUrl
  ? createClient({ url: env.redisUrl })
  : null;

if (redisClient) {
  redisClient.on("error", (error) => {
    console.error("[Redis] Client error:", error);
  });
}

export async function connectRedis(): Promise<void> {
  if (!redisClient) {
    return;
  }

  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
}