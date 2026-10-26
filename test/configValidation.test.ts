import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A schema-library upgrade must not leave string defaults in numeric ports,
// timeout arithmetic or rate-limit counters.
const numericSettings = [
  'CHATWOOT_VERIFICATION_TTL_MINUTES',
  'CHATWOOT_VERIFIED_TTL_DAYS',
  'CHATWOOT_PROMPT_COOLDOWN_SECONDS',
  'CHATWOOT_GATEWAY_FORWARD_TIMEOUT_SECONDS',
  'DB_PORT', 'REDIS_PORT', 'DEFAULT_VERIFY_TTL_MINUTES',
  'VERIFICATION_REJOIN_COOLDOWN_SECONDS',
  'DEFAULT_RATE_LIMIT_WINDOW_MS', 'DEFAULT_RATE_LIMIT_MAX_REQUESTS',
];

describe('environment validation after the Zod upgrade', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of numericSettings) vi.stubEnv(key, undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('keeps numeric defaults and existing timeout values', async () => {
    const { config } = await import('../src/config/config');
    expect(config.db.port).toBe(5432);
    expect(config.redis.port).toBe(6379);
    expect(config.chatwootVerification).toMatchObject({
      ttlMinutes: 10, verifiedTtlDays: 30, promptCooldownSeconds: 300,
      gatewayForwardTimeoutSeconds: 5,
    });
    expect(config.defaults).toMatchObject({
      verifyTtlMinutes: 10, verificationRejoinCooldownSeconds: 60,
      rateLimitWindowMs: 60000, rateLimitMaxRequests: 10,
    });
  });

  it('still converts explicitly configured numbers including zero', async () => {
    vi.stubEnv('DB_PORT', '5433');
    vi.stubEnv('VERIFICATION_REJOIN_COOLDOWN_SECONDS', '0');
    vi.stubEnv('DEFAULT_RATE_LIMIT_MAX_REQUESTS', '20');
    const { config } = await import('../src/config/config');
    expect(config.db.port).toBe(5433);
    expect(config.defaults.verificationRejoinCooldownSeconds).toBe(0);
    expect(config.defaults.rateLimitMaxRequests).toBe(20);
  });

  it.each(['-1', '86401', '1.5', 'not-a-number'])(
    'rejects an invalid rejoin cooldown: %s', async (value) => {
      vi.stubEnv('VERIFICATION_REJOIN_COOLDOWN_SECONDS', value);
      await expect(import('../src/config/config')).rejects.toThrow('VERIFICATION_REJOIN_COOLDOWN_SECONDS');
    }
  );

  it('still fails startup with a named error for an empty required secret', async () => {
    vi.stubEnv('BOT_TOKEN', '');
    await expect(import('../src/config/config')).rejects.toThrow('BOT_TOKEN must not be empty');
  });
});
