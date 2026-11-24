import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

/**
 * The verification endpoints on groups behind the Xboard gate: the panel
 * account replaces the captcha, so a submit with no captcha token but a good
 * subscription link must unmute, and one with a bad link must not.
 */

vi.hoisted(() => {
  process.env.XBOARD_GATE_API_URL = 'https://panel.example.test';
  process.env.XBOARD_GATE_SECRET = 'gate-secret';
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
  ctrl.rateLimiter = { apiVerifyLimit: async () => true, verifyPageLimit: async () => true };
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
    expect(res.json()).toMatchObject({ captchaRequired: false, needsBind: true });
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
