import { vi } from 'vitest';

// Dummy env vars so config.ts (zod parse at import time) doesn't throw in tests.
process.env.BOT_TOKEN ||= '123456:TEST_BOT_TOKEN_FOR_UNIT_TESTS';
process.env.DB_PASSWORD ||= 'test';
process.env.JWT_SECRET ||= 'unit-test-jwt-secret-not-used-in-prod';
process.env.TURNSTILE_SITE_KEY ||= 'test-site-key';
process.env.TURNSTILE_SECRET_KEY ||= 'test-secret-key';

// Mock ioredis so importing modules that construct RedisService doesn't open a
// real network connection (the pure functions under test never touch Redis).
vi.mock('ioredis', () => {
  class MockRedis {
    on() { return this; }
    get() { return Promise.resolve(null); }
    set() { return Promise.resolve('OK'); }
    setex() { return Promise.resolve('OK'); }
    del() { return Promise.resolve(1); }
    exists() { return Promise.resolve(0); }
    incr() { return Promise.resolve(1); }
    expire() { return Promise.resolve(1); }
    quit() { return Promise.resolve('OK'); }
    pipeline() {
      const chain: any = {
        zremrangebyscore() { return chain; },
        zadd() { return chain; },
        zcard() { return chain; },
        expire() { return chain; },
        exec() { return Promise.resolve([]); },
      };
      return chain;
    }
  }
  return { default: MockRedis };
});
