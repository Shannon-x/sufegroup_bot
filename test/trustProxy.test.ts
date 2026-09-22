import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/server';
import { TelegramIpWhitelist } from '../src/middleware/TelegramIpWhitelist';

/**
 * The webhook IP allowlist sees whatever request.ip resolves to, and behind
 * the shipped deployment (host nginx → Docker bridge → container) the
 * immediate peer is always a private bridge address. If TRUST_PROXY does not
 * cover that peer, request.ip *is* the bridge address, the allowlist rejects
 * every genuine update, and the bot silently receives nothing at all — no
 * join verification, no commands, no filtering. That was the effect of the
 * previous default.
 */

const TELEGRAM_IP = '149.154.167.51';

describe('webhook source resolution behind the shipped reverse proxy', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createHttpServer();
    app.post('/hook', { preHandler: (req, reply) => TelegramIpWhitelist.verify(req, reply).then(() => undefined) },
      async (req) => ({ ok: true, ip: req.ip }));
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  it('accepts an update relayed by a private-network proxy', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/hook',
      remoteAddress: '172.18.0.1', // Docker bridge gateway, as seen inside the container
      headers: { 'x-forwarded-for': TELEGRAM_IP },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ip).toBe(TELEGRAM_IP);
  });

  it('accepts an update relayed over loopback', async () => {
    const res = await app.inject({
      method: 'POST', url: '/hook', remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': TELEGRAM_IP }, payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('does not let a public client forge a Telegram address', async () => {
    // Only trusted proxies may supply the header; a public peer's claim is ignored.
    const res = await app.inject({
      method: 'POST', url: '/hook', remoteAddress: '203.0.113.9',
      headers: { 'x-forwarded-for': TELEGRAM_IP }, payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a non-Telegram client relayed through the proxy', async () => {
    const res = await app.inject({
      method: 'POST', url: '/hook', remoteAddress: '172.18.0.1',
      headers: { 'x-forwarded-for': '203.0.113.9' }, payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('diagnosing a misconfigured proxy', () => {
  function verifyFrom(ip: string) {
    const logger = { warn: vi.fn(), error: vi.fn() };
    (TelegramIpWhitelist as any).logger = logger;
    const reply: any = { code: () => reply, send: () => reply };
    return TelegramIpWhitelist.verify({ ip } as never, reply).then(() => logger);
  }

  it('names TRUST_PROXY as the fix when the source is a proxy address', async () => {
    const logger = await verifyFrom('172.18.0.1');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toContain('TRUST_PROXY');
  });

  it('logs an ordinary warning for a public non-Telegram source', async () => {
    const logger = await verifyFrom('203.0.113.9');
    expect(logger.warn).toHaveBeenCalledWith('Request from non-Telegram IP', expect.anything());
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('TRUST_PROXY validation', () => {
  it('rejects a hop count, which Fastify now treats as trusting no one', async () => {
    vi.resetModules();
    const previous = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = '1';
    await expect(import('../src/config/config')).rejects.toThrow(/TRUST_PROXY/);
    process.env.TRUST_PROXY = previous;
    if (previous === undefined) delete process.env.TRUST_PROXY;
    vi.resetModules();
  });

  it('defaults to trusting loopback and private ranges', async () => {
    vi.resetModules();
    const previous = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
    const { config } = await import('../src/config/config');
    expect(config.server.trustProxy).toBe('loopback,uniquelocal');
    if (previous !== undefined) process.env.TRUST_PROXY = previous;
    vi.resetModules();
  });
});
