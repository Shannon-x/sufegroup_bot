import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/server';

/**
 * Integration tests for the HTTP stack's plugin configuration.
 *
 * These exist to gate the Fastify v4 → v5 upgrade. Almost none of this app's
 * HTTP security lives in our own code — it lives in how @fastify/helmet,
 * @fastify/cors and @fastify/static are configured. A major-version bump can
 * rename an option, change a default, or drop a header without any type error
 * and without any existing test noticing. Each assertion below pins a
 * behaviour that must survive the upgrade.
 */
describe('HTTP stack', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createHttpServer();
    // Minimal stand-ins for the real routes, so the tests exercise plugin
    // behaviour rather than controller logic.
    app.get('/probe', async () => ({ ok: true }));
    app.get('/render', async (_req, reply) => reply.view('error', {
      message: 'test',
      botUsername: 'test_bot',
      canRetry: false,
    }));
    app.post('/sink', async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves JSON routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  describe('helmet', () => {
    it('sets a Content-Security-Policy', async () => {
      const res = await app.inject({ method: 'GET', url: '/probe' });
      const csp = res.headers['content-security-policy'];
      expect(csp).toBeTruthy();
      expect(String(csp)).toContain("default-src 'self'");
    });

    it('keeps the Telegram frame-ancestors allowlist', async () => {
      // Without this the Mini App cannot be embedded by Telegram clients, which
      // breaks verification entirely — a silent, user-visible regression.
      const res = await app.inject({ method: 'GET', url: '/probe' });
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain('frame-ancestors');
      expect(csp).toContain('https://web.telegram.org');
    });

    it('allows the captcha providers the verification page loads', async () => {
      const res = await app.inject({ method: 'GET', url: '/probe' });
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain('https://challenges.cloudflare.com');
      expect(csp).toContain('https://js.hcaptcha.com');
    });

    it('blocks inline event-handler attributes', async () => {
      const res = await app.inject({ method: 'GET', url: '/probe' });
      expect(String(res.headers['content-security-policy'])).toContain("script-src-attr 'none'");
    });

    it('omits X-Frame-Options so frame-ancestors governs embedding', async () => {
      const res = await app.inject({ method: 'GET', url: '/probe' });
      expect(res.headers['x-frame-options']).toBeUndefined();
    });

    it('sets HSTS and nosniff', async () => {
      const res = await app.inject({ method: 'GET', url: '/probe' });
      expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('sets a no-referrer policy', async () => {
      const res = await app.inject({ method: 'GET', url: '/probe' });
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });
  });

  describe('cors', () => {
    it('does not hand out an allow-origin to cross-site callers', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/probe',
        headers: { origin: 'https://attacker.example' },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('static files', () => {
    it('serves public assets from the root prefix', async () => {
      const res = await app.inject({ method: 'GET', url: '/css/modern-verify.css' });
      expect(res.statusCode).toBe(200);
    });

    // GHSA-8pvw-jcv7-9cmj / GHSA-83w8-p2f5-377r: @fastify/static <= 10.1.1
    // mishandles non-canonical paths. Percent-encoded variants are the shapes
    // that actually exercise those advisories, so they are asserted explicitly
    // rather than only the plain `..` form.
    it.each([
      '/../package.json',
      '/%2e%2e/package.json',
      '/..%2fpackage.json',
      '/%2e%2e%2fpackage.json',
      '/.%2e/package.json',
      '/css/../../package.json',
      '/css/..%2f..%2fpackage.json',
    ])('does not escape the public root via %s', async (url) => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).not.toBe(200);
      expect(res.body).not.toContain('"name": "telegram-group-bot"');
    });

    it('404s unknown paths rather than leaking the filesystem', async () => {
      const res = await app.inject({ method: 'GET', url: '/definitely-not-a-real-asset.xyz' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('view engine', () => {
    it('renders EJS templates by name without an extension', async () => {
      const res = await app.inject({ method: 'GET', url: '/render' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body.length).toBeGreaterThan(0);
    });
  });

  describe('body limit', () => {
    it('rejects payloads over the webhook limit', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sink',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ blob: 'x'.repeat(20000) }),
      });

      expect(res.statusCode).toBe(413);
    });
  });
});
