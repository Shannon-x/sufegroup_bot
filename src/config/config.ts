import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SERVER_PORT: z.string().transform(Number).optional(),
  PORT: z.string().transform(Number).optional(),
  SERVER_HOST: z.string().optional(),
  HOST: z.string().optional(),
  
  // Telegram Bot. Bare z.string() accepted the empty string, so a missing value
  // in the environment file passed validation and failed later as a confusing
  // 401 from the Telegram API.
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN must not be empty'),
  BOT_WEBHOOK_DOMAIN: z.string().optional(),
  BOT_WEBHOOK_SECRET: z.string().optional(),
  BOT_USERNAME: z.string().optional(),
  BOT_MINIAPP_SHORT_NAME: z.string().optional(),

  // Chatwoot Telegram inbox verification gate
  CHATWOOT_VERIFICATION_TTL_MINUTES: z.string().transform(Number).default('10'),
  CHATWOOT_VERIFIED_TTL_DAYS: z.string().transform(Number).default('30'),
  CHATWOOT_PROMPT_COOLDOWN_SECONDS: z.string().transform(Number).default('300'),
  CHATWOOT_GATEWAY_BASE_URL: z.string().optional(),
  CHATWOOT_GATEWAY_TELEGRAM_BOT_TOKEN: z.string().optional(),
  CHATWOOT_GATEWAY_WEBHOOK_SECRET: z.string().optional(),
  CHATWOOT_GATEWAY_INBOX_ID: z.string().default('default'),
  CHATWOOT_GATEWAY_FORWARD_TIMEOUT_SECONDS: z.string().transform(Number).default('5'),
  
  // Database
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.string().transform(Number).default('5432'),
  DB_USERNAME: z.string().default('postgres'),
  DB_PASSWORD: z.string().min(1, 'DB_PASSWORD must not be empty'),
  DB_DATABASE: z.string().default('telegram_bot'),
  
  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().transform(Number).default('6379'),
  REDIS_PASSWORD: z.string().optional(),
  
  // Cloudflare Turnstile
  TURNSTILE_SITE_KEY: z.string(),
  TURNSTILE_SECRET_KEY: z.string(),
  
  // hCaptcha (Optional)
  HCAPTCHA_SITE_KEY: z.string().optional(),
  HCAPTCHA_SECRET_KEY: z.string().optional(),
  
  // Security
  JWT_SECRET: z.string().min(1, 'JWT_SECRET must not be empty'),
  HMAC_SECRET: z.string().optional(),
  
  // Bot Configuration
  DEFAULT_VERIFY_TTL_MINUTES: z.string().transform(Number).default('10'),
  DEFAULT_AUTO_ACTION: z.enum(['mute', 'kick']).default('mute'),
  // Zero means a verification timeout is a classic kick: remove the member,
  // then immediately lift the ban so a legitimate user can rejoin and retry.
  // Positive values intentionally keep the member out for a short cooling-off
  // period; telegram.ts clamps them above Telegram's 30-second permanent-ban
  // boundary.
  VERIFICATION_REJOIN_COOLDOWN_SECONDS: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(0).max(86400))
    .default('60'),
  DEFAULT_RATE_LIMIT_WINDOW_MS: z.string().transform(Number).default('60000'),
  DEFAULT_RATE_LIMIT_MAX_REQUESTS: z.string().transform(Number).default('10'),
  
  // Reverse-proxy trust: which peers may supply X-Forwarded-For. Fastify turns
  // it into request.ip, which the Telegram webhook IP allowlist checks.
  //
  // The default trusts loopback and private (RFC 1918) addresses, which is what
  // the shipped deployment needs: nginx on the host reaches the container
  // through Docker's bridge, so the container sees a 172.x.x.1 peer. The
  // previous default, `false`, took that bridge address as the client — never
  // a Telegram address — so the allowlist rejected every webhook update and the
  // bot silently received nothing: no join verification, no commands, no
  // filtering. The port is bound to 127.0.0.1, so only the host's own proxy can
  // reach it to supply the header.
  //
  // Use `false` only when the app is directly exposed with no proxy in front.
  // Hop counts are rejected: current Fastify treats a numeric value as "trust
  // no one", because a count alone cannot validate the immediate peer.
  TRUST_PROXY: z
    .string()
    .default('loopback,uniquelocal')
    .refine((value) => !/^\s*\d+\s*$/.test(value), {
      message:
        'TRUST_PROXY no longer accepts a hop count (Fastify now trusts no one for numeric values, ' +
        'which silently rejects every webhook). Use the proxy address or a range, e.g. "loopback,uniquelocal".',
    }),

  // Combot Anti-Spam (https://cas.chat) — a shared blocklist of accounts
  // reported for spam across many Telegram groups. Checked when someone joins,
  // so a known spam account is removed before it can post. Sends the joining
  // member's numeric Telegram id to api.cas.chat; set to false to opt out.
  CAS_ENABLED: z.enum(['true', 'false']).default('true'),

  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LOG_FILE_PATH: z.string().default('./logs/bot.log'),
})
  .superRefine((env, ctx) => {
    // A webhook endpoint without a secret token accepts updates from anyone who
    // learns the URL. Telegram sends the configured secret in the
    // X-Telegram-Bot-Api-Secret-Token header, so this is always available.
    if (env.NODE_ENV === 'production' && env.BOT_WEBHOOK_DOMAIN && !env.BOT_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BOT_WEBHOOK_SECRET'],
        message:
          'BOT_WEBHOOK_SECRET is required in production when BOT_WEBHOOK_DOMAIN is set. ' +
          'Generate one with `openssl rand -hex 32` and pass it to setWebhook.',
      });
    }

    if (env.NODE_ENV === 'production' && env.JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET must be at least 32 characters in production.',
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast and legibly: a misconfigured deployment must not boot into a
  // state where the join guard silently does nothing.
  const details = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

const env = parsed.data;

/** Parse TRUST_PROXY into the shape Fastify expects. */
function parseTrustProxy(value: string): boolean | string {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed; // Address, CIDR, named range, or a comma-separated list of them
}

export const config = {
  env: env.NODE_ENV,
  server: {
    port: env.SERVER_PORT ?? env.PORT ?? 8080,
    host: env.SERVER_HOST ?? env.HOST ?? '0.0.0.0',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  },
  bot: {
    token: env.BOT_TOKEN,
    webhookDomain: env.BOT_WEBHOOK_DOMAIN,
    webhookSecret: env.BOT_WEBHOOK_SECRET,
    username: env.BOT_USERNAME,
    miniAppShortName: env.BOT_MINIAPP_SHORT_NAME,
  },
  chatwootVerification: {
    ttlMinutes: env.CHATWOOT_VERIFICATION_TTL_MINUTES,
    verifiedTtlDays: env.CHATWOOT_VERIFIED_TTL_DAYS,
    promptCooldownSeconds: env.CHATWOOT_PROMPT_COOLDOWN_SECONDS,
    gatewayBaseUrl: env.CHATWOOT_GATEWAY_BASE_URL,
    gatewayTelegramBotToken: env.CHATWOOT_GATEWAY_TELEGRAM_BOT_TOKEN,
    gatewayWebhookSecret: env.CHATWOOT_GATEWAY_WEBHOOK_SECRET,
    gatewayInboxId: env.CHATWOOT_GATEWAY_INBOX_ID,
    gatewayForwardTimeoutSeconds: env.CHATWOOT_GATEWAY_FORWARD_TIMEOUT_SECONDS,
  },
  db: {
    host: env.DB_HOST,
    port: env.DB_PORT,
    username: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    database: env.DB_DATABASE,
  },
  redis: {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
  },
  turnstile: {
    siteKey: env.TURNSTILE_SITE_KEY,
    secretKey: env.TURNSTILE_SECRET_KEY,
  },
  hcaptcha: {
    siteKey: env.HCAPTCHA_SITE_KEY,
    secretKey: env.HCAPTCHA_SECRET_KEY,
  },
  security: {
    jwtSecret: env.JWT_SECRET,
    hmacSecret: env.HMAC_SECRET || env.JWT_SECRET,
  },
  defaults: {
    verifyTtlMinutes: env.DEFAULT_VERIFY_TTL_MINUTES,
    autoAction: env.DEFAULT_AUTO_ACTION,
    verificationRejoinCooldownSeconds: env.VERIFICATION_REJOIN_COOLDOWN_SECONDS,
    rateLimitWindowMs: env.DEFAULT_RATE_LIMIT_WINDOW_MS,
    rateLimitMaxRequests: env.DEFAULT_RATE_LIMIT_MAX_REQUESTS,
  },
  cas: {
    enabled: env.CAS_ENABLED === 'true',
  },
  logging: {
    level: env.LOG_LEVEL,
    filePath: env.LOG_FILE_PATH,
  },
};
