import Redis from 'ioredis';
import { config } from '../config/config';
import { Logger } from '../utils/logger';

/** Fail fast so callers reach their degraded path while the request is still alive. */
const REDIS_CONNECT_TIMEOUT_MS = 2000;
const REDIS_COMMAND_TIMEOUT_MS = 1000;

export class RedisService {
  private client: Redis;
  private logger: Logger;

  constructor() {
    this.logger = new Logger('RedisService');
    
    this.client = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      // Every "degrade gracefully when Redis is down" path in this codebase
      // depends on commands *failing*. With ioredis defaults they do not fail —
      // they queue. enableOfflineQueue buffers commands while disconnected and
      // maxRetriesPerRequest (default 20) keeps retrying, so a caller waits tens
      // of seconds before reaching its catch block. During a Redis outage that
      // turned "degrade" into "hang": moderation, rate limiting and the join
      // guard all stalled on awaits instead of taking their fallback branch.
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });

    this.client.on('error', (err) => {
      this.logger.error('Redis connection error', err);
    });

    this.client.on('connect', () => {
      this.logger.info('Redis connected');
    });
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  /**
   * Atomically read and delete a key (Redis >= 6.2 GETDEL). Used to drain XP
   * buffers without the lost-update window of a separate GET then DEL.
   * Falls back to GET+DEL if GETDEL is unavailable.
   */
  async getAndDelete(key: string): Promise<string | null> {
    try {
      return await (this.client as unknown as { getdel(k: string): Promise<string | null> }).getdel(key);
    } catch (err) {
      this.logger.warn('GETDEL unavailable, falling back to GET+DEL', err);
      const value = await this.client.get(key);
      if (value !== null) await this.client.del(key);
      return value;
    }
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  /**
   * Best-effort distributed lock via SET key val NX EX ttl.
   * Returns true if the lock was acquired (key did not previously exist).
   */
  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (err) {
      this.logger.error('acquireLock error', err);
      // Fail-open: if Redis is unavailable, allow the caller to proceed.
      //
      // Correct for advisory uses — deduplicating a scheduler tick, throttling a
      // notice — where losing the lock costs duplicated work. It is NOT correct
      // where the lock is the only thing preventing a double side effect; use
      // acquireLockStrict() there.
      return true;
    }
  }

  /**
   * Mutual exclusion that refuses to guess. Throws when Redis cannot answer,
   * instead of reporting a lock it never took.
   *
   * The fail-open variant above quietly returned "acquired" during exactly the
   * outage in which concurrent requests are most likely to pile up, so callers
   * guarding a non-idempotent commit (lift a restriction, mark a session
   * verified, spend a captcha token) believed they held a lock that did not
   * exist. Callers here should surface a retryable error to the user rather
   * than perform the side effect unguarded.
   */
  async acquireLockStrict(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async increment(key: string, ttlSeconds?: number): Promise<number> {
    const result = await this.client.incr(key);
    if (ttlSeconds && result === 1) {
      await this.client.expire(key, ttlSeconds);
    }
    return result;
  }

  async getRateLimitInfo(key: string, windowMs: number, maxRequests: number): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const now = Date.now();
    const windowStart = now - windowMs;
    
    // Use sliding window counter
    const pipe = this.client.pipeline();
    pipe.zremrangebyscore(key, 0, windowStart);
    pipe.zadd(key, now, `${now}-${Math.random()}`);
    pipe.zcard(key);
    pipe.expire(key, Math.ceil(windowMs / 1000));
    
    const results = await pipe.exec();
    const count = results?.[2]?.[1] as number || 0;
    
    return {
      allowed: count <= maxRequests,
      remaining: Math.max(0, maxRequests - count),
      resetAt: now + windowMs,
    };
  }

  /**
   * Liveness probe for the readiness endpoint. Never throws — callers use the
   * boolean to decide whether to report the process as ready.
   */
  async ping(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      return pong === 'PONG';
    } catch (err) {
      this.logger.warn('Redis ping failed', err);
      return false;
    }
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

export const redisService = new RedisService();