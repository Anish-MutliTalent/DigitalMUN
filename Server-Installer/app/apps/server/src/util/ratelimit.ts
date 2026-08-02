/**
 * @mun/server — in-memory token-bucket rate limiter
 *
 * Used for login brute-force protection and monitoring-ingest throttling. This
 * is a single-process limiter; for a multi-process deployment a shared store
 * (Redis) would be needed, but the venue server is a single process by design.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {}

  /** Consume 1 token. Returns true if allowed, false if rate-limited. */
  consume(key: string): boolean {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(key, b);
    }
    // Refill.
    const elapsed = (now - b.lastRefill) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSecond);
    b.lastRefill = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Remove a key (e.g. on successful auth). */
  reset(key: string): void {
    this.buckets.delete(key);
  }
}

/** Login rate limiter: 5 attempts per 15s per username. */
export const loginLimiter = new RateLimiter(5, 5 / 15);

/** Per-IP coarse limiter: 30 login attempts per minute per IP. */
export const loginIpLimiter = new RateLimiter(30, 0.5);
