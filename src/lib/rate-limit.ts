import type { DbOrTx } from "./db.ts";
import { AppError } from "./errors.ts";

/**
 * Fixed-window rate limiter stored in PostgreSQL, so every web instance shares the same
 * counters. Counts the attempt, then refuses it when the window's limit is exceeded.
 */
export async function consume(
  db: DbOrTx,
  key: string,
  limit: number,
  windowSeconds: number,
  now: Date = new Date(),
): Promise<void> {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const safeKey = key.length > 160 ? key.slice(0, 160) : key;
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limit_buckets (key, window_start, count)
    VALUES (${safeKey}, ${windowStart}, 1)
    ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_buckets.count + 1
    RETURNING count`;
  const count = rows[0]?.count ?? 1;
  if (count > limit) {
    const retry = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000));
    throw new AppError("RATE_LIMITED", "Too many attempts. Please try again later.", { retryAfterSeconds: retry });
  }
}

/** Housekeeping: drop counters from finished windows. Run periodically. */
export async function purgeRateLimits(db: DbOrTx, olderThan: Date): Promise<number> {
  return db.$executeRaw`DELETE FROM rate_limit_buckets WHERE window_start < ${olderThan}`;
}
