import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createHmac } from 'crypto';

/**
 * The verification endpoints on groups behind the Xboard gate: the panel
 * account replaces the captcha, so a submit with no captcha token but a good
 * subscription link must unmute, and one with a bad link must not.
 */

vi.hoisted(() => {
  process.env.XBOARD_GATE_API_URL = 'https://panel.example.test';
  process.env.XBOARD_GATE_SECRET = 'gate-secret';
  process.env.XBOARD_PANEL_URL = 'https://panel.example.test';
  process.env.BOT_USERNAME = 'sufe_bot';
});

const repoStub = {
  findOne: vi.fn().mockResolvedValue(null),
  find: vi.fn().mockResolvedValue([]),
  save: vi.fn(async (x: unknown) => x),
  create: vi.fn((x: unknown) => x),
};
vi.mock('../src/config/database', () => ({
  AppDataSource: { getRepository: () => repoStub, transaction: vi.fn() },
}));

const api = {
  restrictChatMember: vi.fn().mockResolvedValue(true),
  sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  deleteMessage: vi.fn().mockResolvedValue(true),
  getChatMember: vi.fn().mockResolvedValue({ status: 'member' }),
};
const botStub = { getBot: () => ({ api }) } as never;

const { MiniAppController } = await import('../src/controllers/MiniAppController');

const USER_ID = '4242';
const GROUP_ID = '-100777';

function session() {
  return {
    id: 'sess-1',
    userId: USER_ID,
    groupId: GROUP_ID,
    status: 'pending',
    attemptCount: 0,
    expiresAt: new Date(Date.now() + 5 * 60_000),
    messageId: null,
  };
}

async function build(gateOn: boolean, panel: { check: string; bind?: string }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const status = url.endsWith('/bind') ? panel.bind : panel.check;
      return new Response(JSON.stringify({ data: { status } }), { status: 200 });
    })
  );

  const ctrl = new MiniAppController(botStub) as any;
  ctrl.validateInitData = () => USER_ID;
  ctrl.rateLimiter = {
    apiVerifyLimit: async () => true,
    verifyPageLimit: async () => true,
    gateStatusLimit: async () => true,
  };
  ctrl.verificationService = {
    getSession: vi.fn().mockResolvedValue(session()),
    verifySession: vi.fn().mockResolvedValue(true),
    incrementAttempts: vi.fn(),
  };
  ctrl.groupService = {
    getSettings: vi.fn().mockResolvedValue({ customSettings: gateOn ? { xboardGate: true } : {} }),
    findById: vi.fn().mockResolvedValue({ title: 'G' }),
  };
  ctrl.userService = { findById: vi.fn().mockResolvedValue({ id: USER_ID, firstName: 'A' }) };
  ctrl.auditService = { log: vi.fn().mockResolvedValue(undefined) };
  ctrl.turnstileService = { verify: vi.fn(), getSiteKey: () => 'k' };

  const app: FastifyInstance = Fastify();
  await ctrl.register(app);
  return { app, ctrl };
}

const submit = (app: FastifyInstance, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/miniapp/verify', payload: { initData: 'x', sessionId: 'sess-1', ...body } });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('verification on a gated group', () => {
  it('binds with the subscription link and unmutes, no captcha needed', async () => {
    const { app, ctrl } = await build(true, { check: 'unbound', bind: 'bound' });
    const res = await submit(app, { subscribeUrl: 'https://sub.test/s/' + 'a'.repeat(32) });
    expect(res.json()).toMatchObject({ success: true });
    expect(api.restrictChatMember).toHaveBeenCalled();
    expect(ctrl.turnstileService.verify).not.toHaveBeenCalled();
    expect(ctrl.verificationService.verifySession).toHaveBeenCalled();
  });

  it('keeps the member muted on a bad link, without charging an attempt', async () => {
    const { app, ctrl } = await build(true, { check: 'unbound', bind: 'invalid_link' });
    const res = await submit(app, { subscribeUrl: 'https://sub.test/nope' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, needsBind: true });
    expect(api.restrictChatMember).not.toHaveBeenCalled();
    expect(ctrl.verificationService.incrementAttempts).not.toHaveBeenCalled();
  });

  it('the session tells the page to skip the captcha', async () => {
    const { app } = await build(true, { check: 'unbound' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/miniapp/verify/session',
      payload: { initData: 'x', sessionId: 'sess-1' },
    });
    expect(res.json()).toMatchObject({ captchaRequired: false, needsBind: true, bindLinkAvailable: true });
  });
});

describe('one-click binding on a gated group', () => {
  const post = (app: FastifyInstance, url: string) =>
    app.inject({ method: 'POST', url, payload: { initData: 'x', sessionId: 'sess-1' } });

  it('hands out a signed link to the panel binding page', async () => {
    const { app } = await build(true, { check: 'unbound' });
    const res = await post(app, '/api/miniapp/verify/bind-link');
    expect(res.statusCode).toBe(200);
    const url: string = res.json().url;
    expect(url).toMatch(/^https:\/\/panel\.example\.test\/tg-bind\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const [payloadB64, sig] = url.split('/tg-bind/')[1].split('.');
    const expected = createHmac('sha256', 'gate-secret').update('xbgate-bind:' + payloadB64).digest('base64url');
    expect(sig).toBe(expected);
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    expect(payload).toMatchObject({ v: 1, tg: 4242, n: 'A', b: 'sufe_bot' });
    expect(payload.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(14 * 60);
  });

  it('reports the binding once the panel has it', async () => {
    const { app } = await build(true, { check: 'member' });
    const res = await post(app, '/api/miniapp/verify/gate-status');
    expect(res.json()).toEqual({ bound: true, banned: false });
  });

  it('offers nothing on a group without the gate', async () => {
    const { app } = await build(false, { check: 'unbound' });
    expect((await post(app, '/api/miniapp/verify/bind-link')).statusCode).toBe(404);
    expect((await post(app, '/api/miniapp/verify/gate-status')).statusCode).toBe(404);
  });
});

describe('verification on an ordinary group', () => {
  it('still requires the captcha', async () => {
    const { app } = await build(false, { check: 'member' });
    const res = await submit(app, {});
    expect(res.statusCode).toBe(400);
    expect(api.restrictChatMember).not.toHaveBeenCalled();
  });
});
