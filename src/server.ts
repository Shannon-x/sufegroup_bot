import Fastify, { FastifyInstance } from 'fastify';
import fastifyView from '@fastify/view';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import ejs from 'ejs';
import path from 'path';
import { config } from './config/config';

/** 10KB is ample for a Telegram webhook payload and caps the parse cost. */
const BODY_LIMIT_BYTES = 10240;

/**
 * Build the HTTP stack — framework plugins only, no controllers, no bot, no
 * database. Kept separate from bootstrap() so the plugin configuration can be
 * exercised by `fastify.inject()` in tests without standing up Postgres, Redis
 * and a Telegram connection.
 *
 * This matters because the security-relevant behaviour of the app is largely
 * expressed as plugin configuration: the CSP that lets Telegram embed the Mini
 * App, the frame-ancestors allowlist, the CORS lockdown, and the proxy-trust
 * setting that decides whether request.ip can be forged. A plugin upgrade can
 * change any of those silently.
 */
export async function createHttpServer(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: false,
    trustProxy: config.server.trustProxy,
    bodyLimit: BODY_LIMIT_BYTES,
  });

  await fastify.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://challenges.cloudflare.com', 'https://telegram.org', 'https://js.hcaptcha.com', 'https://newassets.hcaptcha.com'],
        // No inline event handlers in our markup (all bound via addEventListener),
        // so block inline event-handler attributes to shrink the XSS surface.
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://newassets.hcaptcha.com'],
        frameSrc: ['https://challenges.cloudflare.com', 'https://newassets.hcaptcha.com'],
        connectSrc: ["'self'", 'https://challenges.cloudflare.com', 'https://telegram.org', 'https://api.hcaptcha.com', 'https://newassets.hcaptcha.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        fontSrc: ["'self'", 'https:', 'data:'],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        childSrc: ["'none'"],
        // Allow Telegram clients to embed Mini App
        frameAncestors: ['https://web.telegram.org', 'https://desktop.telegram.org', 'https://ss.telegram.org', 'https://k.telegram.org'],
      },
    },
    crossOriginEmbedderPolicy: false,
    // Disable X-Frame-Options so frame-ancestors CSP takes effect for Telegram embedding
    xFrameOptions: false,
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    },
    noSniff: true,
    originAgentCluster: true,
    permittedCrossDomainPolicies: false,
    referrerPolicy: { policy: 'no-referrer' },
    xssFilter: true,
  });

  await fastify.register(fastifyCors, {
    origin: false,
  });

  await fastify.register(fastifyCookie);

  await fastify.register(fastifyRateLimit, {
    global: false, // We'll use custom rate limiting
  });

  await fastify.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
  });

  await fastify.register(fastifyView, {
    engine: {
      ejs,
    },
    root: path.join(__dirname, '..', 'views'),
  });

  return fastify;
}
