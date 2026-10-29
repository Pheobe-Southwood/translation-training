/**
 * Minimal in-process rate limiter.
 *
 * Compliance context: the site processes login credentials and calls a paid AI
 * API, so brute-force attempts and quota-draining loops must be slowed down.
 * A single-process Fastify deployment does not need Redis; the map is bounded and
 * pruned on write so a long-running process cannot leak memory.
 */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 20_000
  ) {}

  /** Record one attempt and report whether the caller is still under the limit. */
  consume(key: string): { allowed: boolean; retryAfterSec: number; remaining: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) || []).filter((ts) => ts > cutoff);

    if (recent.length >= this.limit) {
      const retryAfterSec = Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000));
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSec, remaining: 0 };
    }

    recent.push(now);
    this.hits.set(key, recent);

    if (this.hits.size > this.maxKeys) {
      for (const [k, timestamps] of this.hits) {
        if (!timestamps.some((ts) => ts > cutoff)) this.hits.delete(k);
        if (this.hits.size <= this.maxKeys * 0.8) break;
      }
    }

    return { allowed: true, retryAfterSec: 0, remaining: this.limit - recent.length };
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

/** Normalised client address, safe to log and to use as a limiter key. */
export function clientIp(req: { ip?: string; headers: Record<string, unknown> }): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || 'unknown';
}

/**
 * Log a moderation / security event without ever touching request bodies, so
 * passwords and answer text cannot leak into journald or access logs.
 */
export function auditLog(
  logger: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void },
  event: string,
  fields: Record<string, string | number | boolean | undefined>
): void {
  const clean: Record<string, string | number | boolean> = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) clean[key] = value;
  }
  logger.info(clean, `[audit] ${event}`);
}
