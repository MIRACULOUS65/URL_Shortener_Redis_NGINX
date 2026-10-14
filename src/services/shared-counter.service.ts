import {
  connectRedis,
  redisClient
} from "../db/redis.js";

const SHARED_COUNTER_KEY = "lab:shared-counter:v1";

export async function incrementSharedCounter(): Promise<number> {
  if (!redisClient) {
    throw new Error(
      "Redis is not configured. Run the Docker Compose setup."
    );
  }

  if (!redisClient.isReady) {
    await connectRedis();
  }

  return redisClient.incr(SHARED_COUNTER_KEY);
}