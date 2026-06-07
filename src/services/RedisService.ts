import Redis from 'ioredis';
import { config } from '../config/config';
import { Logger } from '../utils/logger';

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
      return true;
    }
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

  async close(): Promise<void> {
    await this.client.quit();
  }
}

export const redisService = new RedisService();