import { FastifyRequest, FastifyReply } from 'fastify';
import { redisService } from '../services/RedisService';
import { config } from '../config/config';
import { Logger } from '../utils/logger';

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
    }
  ): Promise<boolean> {
    const windowMs = options?.windowMs || config.defaults.rateLimitWindowMs;
    const maxRequests = options?.maxRequests || config.defaults.rateLimitMaxRequests;
    const keyPrefix = options?.keyPrefix || 'ratelimit';

    // Generate rate limit key
    const identifier = request.ip || 'unknown';
    const key = `${keyPrefix}:${identifier}:${request.url}`;

    try {
      const { allowed, remaining, resetAt } = await redisService.getRateLimitInfo(
        key,
        windowMs,
        maxRequests
      );

      // Set rate limit headers
      reply.header('X-RateLimit-Limit', maxRequests.toString());
      reply.header('X-RateLimit-Remaining', remaining.toString());
      reply.header('X-RateLimit-Reset', new Date(resetAt).toISOString());

      if (!allowed) {
        reply.header('Retry-After', Math.ceil(windowMs / 1000).toString());
        
        this.logger.warn('Rate limit exceeded', {
          ip: identifier,
          url: request.url,
          remaining,
          resetAt
        });

        reply.code(429).send({
          error: 'Too Many Requests',
          message: '请求过于频繁，请稍后再试',
          retryAfter: Math.ceil(windowMs / 1000)
        });

        return false;
      }

      return true;
    } catch (error) {
      this.logger.error('Rate limit check error', error);
      // Allow request on error
      return true;
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
      keyPrefix: 'api-verify'
    });
  }

  async commandLimit(userId: string, command: string): Promise<boolean> {
    const key = `command:${userId}:${command}`;
    const { allowed } = await redisService.getRateLimitInfo(
      key,
      60000, // 1 minute
      10 // 10 commands per minute
    );
    return allowed;
  }
}