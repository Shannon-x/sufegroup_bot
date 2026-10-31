import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { config } from '../src/config/config';
import { buildGroupVerificationKeyboard } from '../src/utils/verificationLinks';
import { MembershipHandler } from '../src/handlers/MembershipHandler';
import { PrivateChatHandler } from '../src/handlers/PrivateChatHandler';

/**
 * Third-party clients cannot verify through the Mini App.
 *
 * The join prompt only offered a Mini App direct link
 * (t.me/<bot>/<app>?startapp=verify_…), and the private /start path only a
 * web_app button. Telegram X answers both with "this link type is not
 * supported", so a newcomer on it had no way to verify and was removed when the
 * session expired — every time they rejoined. The fix keeps the Mini App as the
 * primary button and adds a fallback each step of the way: the group prompt
 * links to the bot's private chat (works in every client), and the private
 * chat offers the browser verification page next to the Mini App.
 */

const MINI_APP_BOT = {
  username: 'test_bot',
  miniAppShortName: 'verifyapp',
  webhookDomain: 'https://bot.example.com',
};

type Button = { text: string; url?: string; web_app?: { url: string } };
const rows = (kb: any): Button[][] => kb.inline_keyboard;
const allUrls = (kb: any): string[] =>
  rows(kb).flat().map((b) => b.url ?? b.web_app?.url ?? '');

describe('buildGroupVerificationKeyboard', () => {
  it('offers the Mini App first and the private-chat deep link as a fallback row', () => {
    const kb = buildGroupVerificationKeyboard('s1', MINI_APP_BOT)!;

    expect(rows(kb)).toHaveLength(2);
    expect(rows(kb)[0][0].url).toBe('https://t.me/test_bot/verifyapp?startapp=verify_s1');
    expect(rows(kb)[1][0].url).toBe('https://t.me/test_bot?start=verify_s1');
  });

  it('uses only the private-chat deep link when no Mini App is configured', () => {
    const kb = buildGroupVerificationKeyboard('s1', { username: 'test_bot' })!;

    expect(rows(kb)).toHaveLength(1);
    expect(rows(kb)[0][0].url).toBe('https://t.me/test_bot?start=verify_s1');
  });

  it('returns null without a bot username', () => {
    expect(buildGroupVerificationKeyboard('s1', { ...MINI_APP_BOT, username: undefined })).toBeNull();
  });

  // The group prompt is public: the bearer verification URL must never be in it.
  it('never carries the bearer /verify?token= page', () => {
    const kb = buildGroupVerificationKeyboard('s1', MINI_APP_BOT)!;
    for (const url of allUrls(kb)) {
      expect(url).not.toContain('/verify?token=');
      expect(url.startsWith('https://t.me/')).toBe(true);
    }
  });
});

describe('verification entry points with the Mini App configured', () => {
  const saved = { ...config.bot };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(config.bot, MINI_APP_BOT);
  });

  afterEach(() => {
    Object.assign(config.bot, saved);
  });

  it('join prompt includes the private-chat fallback button', async () => {
    const api = {
      restrictChatMember: vi.fn().mockResolvedValue(true),
      banChatMember: vi.fn().mockResolvedValue(true),
      unbanChatMember: vi.fn().mockResolvedValue(true),
      getChatMember: vi.fn().mockResolvedValue({ status: 'member' }),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 999 }),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const userId = '987654';
    const groupId = '-1001234567890';
    const handler = new MembershipHandler(
      {} as any,
      { findOrCreate: vi.fn().mockResolvedValue({ id: userId, firstName: 'Alice', username: 'alice' }) } as any,
      {
        findOrCreate: vi.fn().mockResolvedValue({
          group: { id: groupId, title: 'Test Group' },
          settings: {
            verificationEnabled: true,
            ttlMinutes: 10,
            autoAction: 'kick',
            adminBypassVerification: false,
            deleteWelcomeMessage: false,
            deleteWelcomeMessageAfter: 300,
          },
        }),
      } as any,
      {
        isBlacklisted: vi.fn().mockResolvedValue(false),
        isWhitelisted: vi.fn().mockResolvedValue(false),
        getPendingSession: vi.fn().mockResolvedValue(null),
        cancelSession: vi.fn().mockResolvedValue(undefined),
        createSession: vi.fn().mockResolvedValue({ id: 'session-join' }),
        updateSessionMessageId: vi.fn().mockResolvedValue(undefined),
        markRestrictionApplied: vi.fn().mockResolvedValue(undefined),
      } as any,
      { log: vi.fn().mockResolvedValue(undefined) } as any,
      { recordUserJoinTime: vi.fn().mockResolvedValue(undefined) } as any,
      {
        reactivateProfile: vi.fn().mockResolvedValue(undefined),
        markInactive: vi.fn().mockResolvedValue(undefined),
      } as any
    );

    await handler.processNewMember(
      { api, me: { id: 42 } } as any,
      { id: Number(userId), is_bot: false, first_name: 'Alice', username: 'alice' } as any,
      { id: Number(groupId), type: 'supergroup', title: 'Test Group' } as any
    );

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const [, , options] = api.sendMessage.mock.calls[0];
    expect(allUrls(options.reply_markup)).toEqual([
      'https://t.me/test_bot/verifyapp?startapp=verify_session-join',
      'https://t.me/test_bot?start=verify_session-join',
    ]);
  });

  function privateHarness(session: Record<string, any> | null, fromId = 111) {
    const verificationService = {
      getSession: vi.fn().mockResolvedValue(session),
      generateVerificationUrl: vi.fn().mockReturnValue('https://bot.example.com/verify?token=abc.def'),
    };
    const groupService = { findById: vi.fn().mockResolvedValue({ id: '-100', title: 'Test Group' }) };
    const handler = new PrivateChatHandler(verificationService as any, groupService as any);
    const ctx = {
      chat: { type: 'private' },
      from: { id: fromId },
      message: { text: '/start verify_s1' },
      reply: vi.fn().mockResolvedValue({}),
    } as any;
    return { handler, ctx, verificationService };
  }

  const pending = (overrides: Record<string, any> = {}) => ({
    id: 's1',
    userId: '111',
    groupId: '-100',
    status: 'pending',
    expiresAt: new Date(Date.now() + 5 * 60_000),
    ...overrides,
  });

  it('private chat offers the Mini App and the browser page to the session owner', async () => {
    const h = privateHarness(pending());

    await h.handler.handleStartCommand(h.ctx);

    expect(h.ctx.reply).toHaveBeenCalledTimes(1);
    const [, options] = h.ctx.reply.mock.calls[0];
    const kb = rows(options.reply_markup);
    expect(kb[0][0].web_app?.url).toBe('https://bot.example.com/mini-app?startapp=verify_s1');
    expect(kb[1][0].url).toBe('https://bot.example.com/verify?token=abc.def');
    expect(h.verificationService.generateVerificationUrl).toHaveBeenCalledWith('111', '-100', 's1');
  });

  it.each([
    ['someone else', pending(), 222],
    ['an expired session', pending({ expiresAt: new Date(Date.now() - 1000) }), 111],
    ['a finished session', pending({ status: 'verified' }), 111],
  ])('private chat never mints the bearer link for %s', async (_label, session, fromId) => {
    const h = privateHarness(session, fromId);

    await h.handler.handleStartCommand(h.ctx);

    expect(h.verificationService.generateVerificationUrl).not.toHaveBeenCalled();
    for (const [, options] of h.ctx.reply.mock.calls) {
      expect(options?.reply_markup).toBeUndefined();
    }
  });
});
