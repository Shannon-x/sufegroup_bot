import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.XBOARD_GATE_API_URL = 'https://panel.example.test/';
  process.env.XBOARD_GATE_SECRET = 'gate-secret';
  process.env.XBOARD_PANEL_NAME = 'SUFE 面板';
  process.env.XBOARD_PANEL_URL = 'https://panel.example.test';
});

// In-memory Redis so pending requests and caches behave like the real thing.
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/services/RedisService', () => ({
  redisService: {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    exists: async (k: string) => store.has(k),
    increment: async (k: string) => {
      const n = Number(store.get(k) ?? 0) + 1;
      store.set(k, String(n));
      return n;
    },
    acquireLock: async () => true,
  },
}));

import { XboardGateService, extractUrl } from '../src/services/XboardGateService';
import { XboardGateHandler, GATE_RECHECK_CALLBACK } from '../src/handlers/XboardGateHandler';
import { MembershipHandler } from '../src/handlers/MembershipHandler';

const GROUP_ID = -1001234567890;
const USER_ID = 777;

function mockPanel(answers: Record<string, string | Error>) {
  const fetchMock = vi.fn(async (url: string, init: any) => {
    const op = url.endsWith('/bind') ? 'bind' : 'check';
    const answer = answers[op];
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify({ status: 'success', data: { status: answer } }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function makeApi() {
  return {
    approveChatJoinRequest: vi.fn().mockResolvedValue(true),
    declineChatJoinRequest: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    deleteMessage: vi.fn().mockResolvedValue(true),
    banChatMember: vi.fn().mockResolvedValue(true),
    unbanChatMember: vi.fn().mockResolvedValue(true),
    restrictChatMember: vi.fn().mockResolvedValue(true),
    getChatMember: vi.fn().mockResolvedValue({ status: 'member' }),
  };
}

function makeGateHandler(gateOn = true) {
  const groupService = {
    getSettings: vi.fn().mockResolvedValue({ customSettings: gateOn ? { xboardGate: true } : {} }),
  };
  const verificationService = { isBlacklisted: vi.fn().mockResolvedValue(false) };
  const auditService = { log: vi.fn().mockResolvedValue(undefined) };
  const handler = new XboardGateHandler(groupService as any, verificationService as any, auditService as any);
  return { handler, verificationService, auditService };
}

function joinRequestCtx(api = makeApi()) {
  return {
    api,
    chatJoinRequest: {
      chat: { id: GROUP_ID, type: 'supergroup', title: '测试群' },
      from: { id: USER_ID, is_bot: false, first_name: 'Alice' },
      user_chat_id: USER_ID,
      date: 0,
    },
  } as any;
}

function privateCtx(text: string, api = makeApi()) {
  return {
    api,
    chat: { id: USER_ID, type: 'private' },
    from: { id: USER_ID, first_name: 'Alice' },
    message: { message_id: 55, text },
    reply: vi.fn().mockResolvedValue({}),
  } as any;
}

beforeEach(() => {
  store.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('XboardGateService', () => {
  it('sends the shared secret and reads the status', async () => {
    const fetchMock = mockPanel({ check: 'member' });
    const gate = new XboardGateService();
    expect(await gate.check(USER_ID)).toBe('member');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://panel.example.test/api/v1/guest/telegram/gate/check');
    expect(init.headers['X-Gate-Secret']).toBe('gate-secret');
    expect(JSON.parse(init.body)).toEqual({ telegram_id: USER_ID });
  });

  it('answers null — never a verdict — when the panel is unreachable or odd', async () => {
    mockPanel({ check: new Error('ECONNREFUSED') });
    expect(await new XboardGateService().check(USER_ID)).toBeNull();
    mockPanel({ check: 'something-else' });
    expect(await new XboardGateService().check(USER_ID, { fresh: true })).toBeNull();
  });

  it('is only enabled for groups that switched it on', () => {
    const gate = new XboardGateService();
    expect(gate.isEnabledFor({ customSettings: { xboardGate: true } })).toBe(true);
    expect(gate.isEnabledFor({ customSettings: {} })).toBe(false);
    expect(gate.isEnabledFor(null)).toBe(false);
  });

  it('extracts the subscription URL from a message', () => {
    expect(extractUrl('我的链接 https://sub.x.test/s/abc 谢谢')).toBe('https://sub.x.test/s/abc');
    expect(extractUrl('no link')).toBeNull();
  });
});

describe('XboardGateHandler — join requests', () => {
  it('approves a registered panel user straight away (paid or not)', async () => {
    mockPanel({ check: 'member' });
    const { handler } = makeGateHandler();
    const ctx = joinRequestCtx();
    await handler.handleJoinRequest(ctx);
    expect(ctx.api.approveChatJoinRequest).toHaveBeenCalledWith(GROUP_ID, USER_ID);
    expect(ctx.api.declineChatJoinRequest).not.toHaveBeenCalled();
    expect(await XboardGateHandler.wasApprovedByGate(GROUP_ID, USER_ID)).toBe(true);
  });

  it('declines a banned panel account', async () => {
    mockPanel({ check: 'banned' });
    const { handler } = makeGateHandler();
    const ctx = joinRequestCtx();
    await handler.handleJoinRequest(ctx);
    expect(ctx.api.declineChatJoinRequest).toHaveBeenCalledWith(GROUP_ID, USER_ID);
    expect(ctx.api.approveChatJoinRequest).not.toHaveBeenCalled();
  });

  it('keeps an unbound applicant pending and sends the binding guide', async () => {
    mockPanel({ check: 'unbound' });
    const { handler } = makeGateHandler();
    const ctx = joinRequestCtx();
    await handler.handleJoinRequest(ctx);
    expect(ctx.api.approveChatJoinRequest).not.toHaveBeenCalled();
    expect(ctx.api.declineChatJoinRequest).not.toHaveBeenCalled();
    const [chatId, text, opts] = ctx.api.sendMessage.mock.calls[0];
    expect(chatId).toBe(USER_ID);
    expect(text).toContain('订阅链接');
    expect(JSON.stringify(opts.reply_markup)).toContain(GATE_RECHECK_CALLBACK);
  });

  it('never declines because the panel is down', async () => {
    mockPanel({ check: new Error('timeout') });
    const { handler } = makeGateHandler();
    const ctx = joinRequestCtx();
    await handler.handleJoinRequest(ctx);
    expect(ctx.api.declineChatJoinRequest).not.toHaveBeenCalled();
    expect(ctx.api.approveChatJoinRequest).not.toHaveBeenCalled();
    expect(ctx.api.sendMessage).toHaveBeenCalled();
  });

  it('leaves requests alone in groups without the gate', async () => {
    const fetchMock = mockPanel({ check: 'member' });
    const { handler } = makeGateHandler(false);
    const ctx = joinRequestCtx();
    await handler.handleJoinRequest(ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.api.approveChatJoinRequest).not.toHaveBeenCalled();
  });

  it('declines blacklisted applicants even if they are panel users', async () => {
    mockPanel({ check: 'member' });
    const { handler, verificationService } = makeGateHandler();
    verificationService.isBlacklisted.mockResolvedValue(true);
    const ctx = joinRequestCtx();
    await handler.handleJoinRequest(ctx);
    expect(ctx.api.declineChatJoinRequest).toHaveBeenCalled();
    expect(ctx.api.approveChatJoinRequest).not.toHaveBeenCalled();
  });
});

describe('XboardGateHandler — binding in private chat', () => {
  async function pendingApplicant() {
    mockPanel({ check: 'unbound' });
    const { handler } = makeGateHandler();
    await handler.handleJoinRequest(joinRequestCtx());
    return handler;
  }

  it('binds with the subscription link, deletes it, and approves the request', async () => {
    const handler = await pendingApplicant();
    const fetchMock = mockPanel({ bind: 'bound' });
    const ctx = privateCtx('https://sub.example.test/s/0123456789abcdef0123456789abcdef');

    expect(await handler.handlePrivateMessage(ctx)).toBe(true);
    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(USER_ID, 55);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).subscribe_url).toContain('/s/0123');
    expect(ctx.api.approveChatJoinRequest).toHaveBeenCalledWith(GROUP_ID, USER_ID);
    expect(ctx.reply.mock.calls[0][0]).toContain('已通过');
  });

  it('keeps the request pending on an invalid link', async () => {
    const handler = await pendingApplicant();
    mockPanel({ bind: 'invalid_link' });
    const ctx = privateCtx('https://example.test/not-a-sub');
    await handler.handlePrivateMessage(ctx);
    expect(ctx.api.approveChatJoinRequest).not.toHaveBeenCalled();
    expect(ctx.api.declineChatJoinRequest).not.toHaveBeenCalled();
  });

  it('ignores private messages from people with nothing pending', async () => {
    const fetchMock = mockPanel({ bind: 'bound' });
    const { handler } = makeGateHandler();
    const ctx = privateCtx('https://sub.example.test/s/0123456789abcdef0123456789abcdef');
    expect(await handler.handlePrivateMessage(ctx)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.api.deleteMessage).not.toHaveBeenCalled();
  });

  it('"check again" approves once the panel sees the binding', async () => {
    const handler = await pendingApplicant();
    mockPanel({ check: 'member' });
    const api = makeApi();
    const ctx = {
      api,
      from: { id: USER_ID },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      reply: vi.fn().mockResolvedValue({}),
    } as any;
    await handler.handleRecheck(ctx);
    expect(api.approveChatJoinRequest).toHaveBeenCalledWith(GROUP_ID, USER_ID);
  });
});

describe('MembershipHandler — direct joins under the gate', () => {
  function harness(addedBy?: { id: number }) {
    const api = makeApi();
    const settings = {
      verificationEnabled: true,
      ttlMinutes: 10,
      autoAction: 'kick',
      adminBypassVerification: false,
      deleteWelcomeMessage: false,
      customSettings: { xboardGate: true, casCheck: false },
    };
    const userService = { findOrCreate: vi.fn().mockResolvedValue({ id: String(USER_ID), firstName: 'Alice' }) };
    const groupService = {
      findOrCreate: vi.fn().mockResolvedValue({ group: { id: String(GROUP_ID), title: 'G' }, settings }),
    };
    const verificationService = {
      isBlacklisted: vi.fn().mockResolvedValue(false),
      isWhitelisted: vi.fn().mockResolvedValue(false),
      getPendingSession: vi.fn().mockResolvedValue(null),
      createSession: vi.fn().mockResolvedValue({ id: 's' }),
      updateSessionMessageId: vi.fn(),
      markRestrictionApplied: vi.fn(),
    };
    const handler = new MembershipHandler(
      {} as any,
      userService as any,
      groupService as any,
      verificationService as any,
      { log: vi.fn().mockResolvedValue(undefined) } as any,
      { recordUserJoinTime: vi.fn() } as any,
      { reactivateProfile: vi.fn() } as any
    );
    const ctx = { api, me: { id: 42 } } as any;
    return {
      api,
      verificationService,
      run: () =>
        handler.processNewMember(ctx, { id: USER_ID, is_bot: false, first_name: 'Alice' }, { id: GROUP_ID, type: 'supergroup', title: 'G' }, addedBy),
    };
  }

  it('removes a non-panel user who walked in through a plain link', async () => {
    mockPanel({ check: 'unbound' });
    const h = harness();
    await h.run();
    expect(h.api.banChatMember).toHaveBeenCalledWith(GROUP_ID, USER_ID);
    expect(h.api.unbanChatMember).toHaveBeenCalled();
    expect(h.verificationService.createSession).not.toHaveBeenCalled();
  });

  it('lets a panel user in without a captcha', async () => {
    mockPanel({ check: 'member' });
    const h = harness();
    await h.run();
    expect(h.api.banChatMember).not.toHaveBeenCalled();
    expect(h.api.restrictChatMember).not.toHaveBeenCalled();
    expect(h.verificationService.createSession).not.toHaveBeenCalled();
  });

  it('falls back to the captcha when the panel is unreachable', async () => {
    mockPanel({ check: new Error('down') });
    const h = harness();
    await h.run();
    expect(h.api.banChatMember).not.toHaveBeenCalled();
    expect(h.api.restrictChatMember).toHaveBeenCalled();
    expect(h.verificationService.createSession).toHaveBeenCalled();
  });

  it('respects an admin adding a member by hand', async () => {
    const fetchMock = mockPanel({ check: 'unbound' });
    const h = harness({ id: 9001 });
    h.api.getChatMember.mockResolvedValue({ status: 'administrator' });
    await h.run();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.api.banChatMember).not.toHaveBeenCalled();
  });
});
