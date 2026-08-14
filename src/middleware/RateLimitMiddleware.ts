import { FastifyRequest, FastifyReply } from 'fastify';
import { redisService } from '../services/RedisService';
import { config } from '../config/config';
import { Logger } from '../utils/logger';

/**
 * Degraded-mode budget divisor. When Redis is unreachable each process counts
 * on its own, so the cluster-wide allowance becomes N × the configured limit.
 * Halving the per-process budget keeps the effective ceiling close to what was
 * intended instead of dropping the guard entirely.
 */
const FALLBACK_LIMIT_DIVISOR = 2;

/** Upper bound on in-memory buckets so a spray of source IPs can't grow the map without bound. */
const FALLBACK_MAX_KEYS = 20000;

/** How often expired buckets are swept, independent of how full the map is. */
const FALLBACK_SWEEP_INTERVAL_MS = 60000;

interface FallbackBucket {
  count: number;
  resetAt: number;
}

/**
 * Process-local counters, used only while the shared Redis counter is down.
 * Module-level so every RateLimitMiddleware instance (each controller builds
 * its own) shares one view of the degraded budget.
 */
const fallbackBuckets = new Map<string, FallbackBucket>();
let lastFallbackSweep = 0;

export class RateLimitMiddleware {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('RateLimitMiddleware');
  }

  async checkRateLimit(
    request: FastifyRequest,
    reply: FastifyReply,
    options?: {
      windowMs?: number;
      maxRequests?: number;
      keyPrefix?: string;
      /**
       * Per-process budget to use while Redis is down. Defaults to half of
       * maxRequests; endpoints where a false 429 is worse than a few extra
       * requests (see apiVerifyLimit) opt out of the halving.
       */
      degradedMaxRequests?: number;
    }
  ): Promise<boolean> {
    const windowMs = options?.windowMs || config.defaults.rateLimitWindowMs;
    const maxRequests = options?.maxRequests || config.defaults.rateLimitMaxRequests;
    const keyPrefix = options?.keyPrefix || 'ratelimit';

    // Generate rate limit key
    const identifier = request.ip || 'unknown';
    const key = `${keyPrefix}:${identifier}:${request.url}`;

    let allowed: boolean;
    let remaining: number;
    let resetAt: number;
    let effectiveLimit = maxRequests;
    let degraded = false;

    try {
      ({ allowed, remaining, resetAt } = await redisService.getRateLimitInfo(
        key,
        windowMs,
        maxRequests
      ));
    } catch (error) {
      // Redis holds the shared counter, but losing it must not switch rate
      // limiting off: the previous `return true` left verification submits and
      // the leaderboard completely unguarded for the length of any blip.
      // Degrade to a conservative in-process counter instead of failing open —
      // and not to a blanket reject either, since that would turn a Redis
      // hiccup into a self-inflicted outage for legitimate users.
      degraded = true;
      this.logger.error('Rate limit backend unavailable, degrading to in-process counter', error);
      ({ allowed, remaining, resetAt, limit: effectiveLimit } = this.checkFallbackLimit(
        key,
        windowMs,
        maxRequests,
        options?.degradedMaxRequests
      ));
    }

    // Report the limit actually being enforced. Advertising the configured
    // maximum while enforcing a smaller degraded one made a well-behaved client
    // pace itself to a budget that did not exist.
    reply.header('X-RateLimit-Limit', effectiveLimit.toString());
    reply.header('X-RateLimit-Remaining', remaining.toString());
    reply.header('X-RateLimit-Reset', new Date(resetAt).toISOString());

    if (!allowed) {
      reply.header('Retry-After', Math.ceil(windowMs / 1000).toString());

      this.logger.warn('Rate limit exceeded', {
        ip: identifier,
        url: request.url,
        remaining,
        resetAt,
        degraded
      });

      reply.code(429).send({
        error: 'Too Many Requests',
        message: '请求过于频繁，请稍后再试',
        retryAfter: Math.ceil(windowMs / 1000)
      });

      return false;
    }

    return true;
  }

  /**
   * Process-local **fixed window** used while Redis is unavailable: the first
   * request of a key starts a window and every request inside it shares one
   * counter. Deliberately approximate — it only has to keep an attacker from
   * getting unlimited attempts during an outage — but it is not the sliding
   * window the shared counter implements, and calling it one hid the fact that
   * a burst can straddle two windows.
   */
  private checkFallbackLimit(
    key: string,
    windowMs: number,
    maxRequests: number,
    degradedMaxRequests?: number
  ): { allowed: boolean; remaining: number; resetAt: number; limit: number } {
    const limit = Math.max(
      1,
      Math.floor(degradedMaxRequests ?? maxRequests / FALLBACK_LIMIT_DIVISOR)
    );
    const now = Date.now();
    this.pruneFallbackBuckets(now);
    const bucket = fallbackBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      const resetAt = now + windowMs;
      fallbackBuckets.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: Math.max(0, limit - 1), resetAt, limit };
    }

    bucket.count += 1;
    return {
      allowed: bucket.count <= limit,
      remaining: Math.max(0, limit - bucket.count),
      resetAt: bucket.resetAt,
      limit,
    };
  }

  /**
   * Drop expired buckets, then trim the oldest ones if the map is still
   * oversized.
   *
   * The sweep is time-based rather than gated on the size cap: gating it meant
   * expired buckets below 20000 keys were never reclaimed, so a process that saw
   * one Redis blip carried that memory (and stale windows) for its whole life.
   */
  private pruneFallbackBuckets(now: number): void {
    const overCap = fallbackBuckets.size > FALLBACK_MAX_KEYS;
    if (!overCap && now - lastFallbackSweep < FALLBACK_SWEEP_INTERVAL_MS) return;
    lastFallbackSweep = now;

    for (const [key, bucket] of fallbackBuckets) {
      if (bucket.resetAt <= now) fallbackBuckets.delete(key);
    }

    // Map iterates in insertion order, so this evicts the least recently created.
    for (const key of fallbackBuckets.keys()) {
      if (fallbackBuckets.size <= FALLBACK_MAX_KEYS) break;
      fallbackBuckets.delete(key);
    }
  }

  // Specific rate limiters for different endpoints
  async verifyPageLimit(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    return this.checkRateLimit(request, reply, {
      windowMs: 60000, // 1 minute
      maxRequests: 10,
      keyPrefix: 'verify-page'
    });
  }

  async apiVerifyLimit(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    return this.checkRateLimit(request, reply, {
      windowMs: 60000, // 1 minute
      maxRequests: 5,
      keyPrefix: 'api-verify',
      // No degraded halving here. The two failure modes are not symmetric: an
      // extra submission costs one siteverify call, while a wrongly rejected one
      // costs the user their place in the group — they cannot verify, the
      // session times out and the scheduler removes them. 2/minute per process
      // is also below what a single legitimate user needs when a captcha widget
      // makes them retry, so a Redis blip alone was enough to start kicking
      // people. Abuse is still bounded by the captcha, the session ownership
      // check and the per-session attempt counter.
      degradedMaxRequests: 5
    });
  }

  /** Admin Mini App endpoints — cheap for the caller, expensive for us (Bot API fan-out). */
  async adminApiLimit(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    return this.checkRateLimit(request, reply, {
      windowMs: 60000, // 1 minute
      maxRequests: 20,
      keyPrefix: 'admin-api'
    });
  }

  /**
   * Per-identity budget for endpoints where the source IP is a poor identifier
   * (Mini App traffic shares exit nodes, and a captured initData stays valid for
   * an hour and can be replayed from anywhere). Returns false when over budget;
   * the caller decides how to answer.
   */
  async userActionLimit(
    userId: string,
    action: string,
    windowMs: number,
    maxRequests: number
  ): Promise<boolean> {
    const key = `user-action:${action}:${userId}`;
    try {
      const { allowed } = await redisService.getRateLimitInfo(key, windowMs, maxRequests);
      return allowed;
    } catch (error) {
      this.logger.error('User rate limit backend unavailable, degrading to in-process counter', error);
      return this.checkFallbackLimit(key, windowMs, maxRequests).allowed;
    }
  }

  async commandLimit(userId: string, command: string): Promise<boolean> {
    const key = `command:${userId}:${command}`;
    try {
      const { allowed } = await redisService.getRateLimitInfo(
        key,
        60000, // 1 minute
        10 // 10 commands per minute
      );
      return allowed;
    } catch (error) {
      // Same trade-off as checkRateLimit: degrade, never disable.
      this.logger.error('Command rate limit backend unavailable, degrading to in-process counter', error);
      return this.checkFallbackLimit(key, 60000, 10).allowed;
    }
  }
}
