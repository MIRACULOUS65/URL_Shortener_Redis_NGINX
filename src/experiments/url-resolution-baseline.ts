
import { findByCode } from "../repositories/url.repository.js";

// Phase 2–9 baseline:
// Every resolution queries PostgreSQL through Prisma.
// Preserved for comparison with the Redis-cached implementation.

export async function resolveUrlWithoutCache(
  code: string
): Promise<string | null> {
  const url = await findByCode(code);

  if (!url) {
    return null;
  }

  return url.originalUrl;
}
