import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SERVER_PORT: z.string().transform(Number).optional(),
  PORT: z.string().transform(Number).optional(),
  SERVER_HOST: z.string().optional(),
  HOST: z.string().optional(),
  
  // Telegram Bot
  BOT_TOKEN: z.string(),
  BOT_WEBHOOK_DOMAIN: z.string().optional(),
  BOT_WEBHOOK_SECRET: z.string().optional(),
  BOT_USERNAME: z.string().optional(),
  BOT_MINIAPP_SHORT_NAME: z.string().optional(),
  
  // Database
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.string().transform(Number).default('5432'),
  DB_USERNAME: z.string().default('postgres'),
  DB_PASSWORD: z.string(),
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
  JWT_SECRET: z.string(),
  HMAC_SECRET: z.string().optional(),
  
  // Bot Configuration
  DEFAULT_VERIFY_TTL_MINUTES: z.string().transform(Number).default('10'),
  DEFAULT_AUTO_ACTION: z.enum(['mute', 'kick']).default('mute'),
  DEFAULT_RATE_LIMIT_WINDOW_MS: z.string().transform(Number).default('60000'),
  DEFAULT_RATE_LIMIT_MAX_REQUESTS: z.string().transform(Number).default('10'),
  
  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LOG_FILE_PATH: z.string().default('./logs/bot.log'),
});

const env = envSchema.parse(process.env);

export const config = {
  env: env.NODE_ENV,
  server: {
    port: env.SERVER_PORT ?? env.PORT ?? 8080,
    host: env.SERVER_HOST ?? env.HOST ?? '0.0.0.0',
  },
  bot: {
    token: env.BOT_TOKEN,
    webhookDomain: env.BOT_WEBHOOK_DOMAIN,
    webhookSecret: env.BOT_WEBHOOK_SECRET,
    username: env.BOT_USERNAME,
    miniAppShortName: env.BOT_MINIAPP_SHORT_NAME,
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
    rateLimitWindowMs: env.DEFAULT_RATE_LIMIT_WINDOW_MS,
    rateLimitMaxRequests: env.DEFAULT_RATE_LIMIT_MAX_REQUESTS,
  },
  logging: {
    level: env.LOG_LEVEL,
    filePath: env.LOG_FILE_PATH,
  },
};