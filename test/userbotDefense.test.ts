import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentFilterHandler } from '../src/handlers/ContentFilterHandler';
import { ContentFilterService } from '../src/services/ContentFilterService';
import { MembershipHandler } from '../src/handlers/MembershipHandler';
import { CasService } from '../src/services/CasService';
import { config } from '../src/config/config';

/**
 * Defences against accounts that pass verification and then spam.
 *
 * A captcha proves only that somebody solved it at join time; spam operations
 * pay to have it solved, or verify once and post days later. The reported case:
 * a normal-looking account posts "@somebot campaign_001 <token>" under a quote
 * that impersonates the group's own announcement channel. No link, no phone
 * number — it scored zero and was not even treated as a link for the new-user
 * delay.
 */

const THIS_BOT = 'sufe_guard_bot';

function settingsWith(filter: Record<string, unknown> = {}) {
  return { customSettings: { filter: { enabled: true, ...filter } } } as never;
}

function makeFilterHarness(message: Record<string, unknown>, opts: { newUser?: boolean } = {}) {
  const api = {
    deleteMessage: vi.fn().mockResolvedValue(true),
    restrictChatMember: vi.fn().mockResolvedValue(true),
    banChatMember: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  };
  const service = new ContentFilterService();
  vi.spyOn(service, 'addViolation').mockResolvedValue(1 as never);
  vi.spyOn(service, 'isNewUser').mockResolvedValue((opts.newUser ?? false) as never);

  const handler = new ContentFilterHandler({} as never, service, { log: vi.fn().mockResolvedValue(undefined) } as never);
  const ctx = {
    chat: { id: -1001234567890 },
    from: { id: 555, first_name: 'liujing', is_bot: false },
    me: { id: 42, username: THIS_BOT },
    message: { message_id: 7, ...message },
    api,
    deleteMessage: api.deleteMessage,
  } as never;
  return { handler, ctx, api };
}

// The message from the report, field for field.
const REPORTED = {
  text: '@zhiasudasdkoubot campaign_001 g1790033580614cfd80825',
  entities: [{ type: 'mention', offset: 0, length: 17 }],
  quote: { text: '现在大幅度优化了佣金提现系统，现在使用 sufe.us 官网提现更方便更快捷', position: 0 },
  external_reply: {
    origin: {
      type: 'channel',
      chat: { id: -1009999999999, type: 'channel', title: 'sufe.pro 苏菲家宽-前沿资讯' },
      message_id: 12,
      date: 0,
    },
    chat: { id: -1009999999999, type: 'channel', title: 'sufe.pro 苏菲家宽-前沿资讯' },
    message_id: 12,
  },
};

describe('phishing-bot lure (the reported message)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is blocked for an established member, with default settings', async () => {
    const { handler, ctx } = makeFilterHarness(REPORTED);
    expect(await handler.handle(ctx, settingsWith(), false)).toBe(true);
  });

  it('is deleted', async () => {
    const { handler, ctx, api } = makeFilterHarness(REPORTED);
    await handler.handle(ctx, settingsWith(), false);
    expect(api.deleteMessage).toHaveBeenCalled();
  });

  it('is blocked on the body alone, without the fake quote', async () => {
    const { handler, ctx } = makeFilterHarness({ text: REPORTED.text, entities: REPORTED.entities });
    expect(await handler.handle(ctx, settingsWith(), false)).toBe(true);
  });

  it('is blocked even when every link rule is off', async () => {
    const { handler, ctx } = makeFilterHarness(REPORTED);
    const blocked = await handler.handle(
      ctx,
      settingsWith({ blockUrls: false, blockInviteLinks: false, blockPhoneNumbers: false }),
      false
    );
    expect(blocked).toBe(true);
  });
});

describe('ordinary bot mentions are left alone', () => {
  beforeEach(() => vi.clearAllMocks());

  // These all end in "bot", so they exercise the detection path: each is
  // recognised as a bot mention, and none is blocked, because none carries a
  // tracking payload. (Legacy official inline bots such as @gif do not end in
  // "bot" and are not recognised at all — nor are they the threat.)
  it.each([
    '出题用 @QuizBot 很方便',
    '查天气可以用 @weatherbot 北京',
    '@stickers_bot 有好看的表情包吗',
    '这个 @helper_bot 挺好用的，大家试试',
  ])('allows "%s" from an established member', async (text) => {
    const { handler, ctx } = makeFilterHarness({ text });
    expect(await handler.handle(ctx, settingsWith(), false)).toBe(false);
  });

  it('never treats this bot as a lure', async () => {
    const { handler, ctx } = makeFilterHarness({ text: `@${THIS_BOT} campaign_001 g1790033580614cfd80825` });
    expect(await handler.handle(ctx, settingsWith(), false)).toBe(false);
  });

  it('allows an established member to quote the official channel', async () => {
    const { handler, ctx } = makeFilterHarness({
      text: '这条公告大家看一下',
      quote: REPORTED.quote,
      external_reply: REPORTED.external_reply,
    });
    expect(await handler.handle(ctx, settingsWith(), false)).toBe(false);
  });

  it('blocks every bot mention when the admin opts in', async () => {
    const { handler, ctx } = makeFilterHarness({ text: '这个 @helper_bot 挺好用的' });
    expect(await handler.handle(ctx, settingsWith({ blockBotMentions: true }), false)).toBe(true);
  });
});

describe('new members', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cannot mention a bot during the new-user delay', async () => {
    // A bot mention is a link in every sense that matters: one tap opens it.
    const { handler, ctx } = makeFilterHarness({ text: '这个 @helper_bot 挺好用的' }, { newUser: true });
    expect(await handler.handle(ctx, settingsWith(), false)).toBe(true);
  });

  it('cannot quote another chat during the new-user delay', async () => {
    const { handler, ctx } = makeFilterHarness(
      { text: '看看', quote: REPORTED.quote, external_reply: REPORTED.external_reply },
      { newUser: true }
    );
    expect(await handler.handle(ctx, settingsWith(), false)).toBe(true);
  });

  it('can still chat normally', async () => {
    const { handler, ctx } = makeFilterHarness({ text: '大家好，刚进群' }, { newUser: true });
    expect(await handler.handle(ctx, settingsWith(), false)).toBe(false);
  });
});

// ── CAS at join ──

let seq = 0;

function makeJoinHarness(cas: Partial<CasService>, overrides: Record<string, any> = {}) {
  const api = {
    restrictChatMember: vi.fn().mockResolvedValue(true),
    banChatMember: vi.fn().mockResolvedValue(true),
    getChatMember: vi.fn().mockResolvedValue({ status: 'member' }),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    deleteMessage: vi.fn().mockResolvedValue(true),
    ...(overrides.api || {}),
  };
  const userId = String(70000 + seq++);
  const groupId = '-1001234567890';
  const verificationService = {
    isBlacklisted: vi.fn().mockResolvedValue(false),
    isWhitelisted: vi.fn().mockResolvedValue(false),
    getPendingSession: vi.fn().mockResolvedValue(null),
    cancelSession: vi.fn(),
    createSession: vi.fn().mockResolvedValue({ id: 's1' }),
    updateSessionMessageId: vi.fn(),
    markRestrictionApplied: vi.fn(),
  };
  const auditService = { log: vi.fn().mockResolvedValue(undefined) };
  const handler = new MembershipHandler(
    {} as any,
    { findOrCreate: vi.fn().mockResolvedValue({ id: userId, firstName: 'liujing' }) } as any,
    {
      findOrCreate: vi.fn().mockResolvedValue({
        group: { id: groupId, title: 'Test' },
        settings: {
          verificationEnabled: true, ttlMinutes: 10, adminBypassVerification: false,
          deleteWelcomeMessage: false, deleteWelcomeMessageAfter: 300,
          customSettings: overrides.customSettings ?? {},
        },
      }),
    } as any,
    verificationService as any,
    auditService as any,
    { recordUserJoinTime: vi.fn() } as any,
    { reactivateProfile: vi.fn().mockResolvedValue(undefined) } as any,
    cas as CasService
  );
  const ctx = { api, me: { id: 42 } } as any;
  const member = { id: Number(userId), is_bot: false, first_name: 'liujing' };
  const chat = { id: Number(groupId), type: 'supergroup', title: 'Test' };
  return { api, verificationService, auditService, run: () => handler.processNewMember(ctx, member, chat) };
}

describe('CAS blocklist at join', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bans a listed account instead of offering a captcha', async () => {
    const h = makeJoinHarness({ isBanned: vi.fn().mockResolvedValue(true) });
    await h.run();
    expect(h.api.banChatMember).toHaveBeenCalled();
    expect(h.verificationService.createSession).not.toHaveBeenCalled();
  });

  it('still mutes before waiting on the lookup', async () => {
    let resolveLookup: (v: boolean) => void = () => undefined;
    const pending = new Promise<boolean>((r) => { resolveLookup = r; });
    const h = makeJoinHarness({ isBanned: vi.fn().mockReturnValue(pending) });
    const run = h.run();
    await new Promise((r) => setTimeout(r, 10));
    // The lookup has not answered, yet the member is already restricted.
    expect(h.api.restrictChatMember).toHaveBeenCalled();
    resolveLookup(false);
    await run;
  });

  it('verifies an unlisted account normally', async () => {
    const h = makeJoinHarness({ isBanned: vi.fn().mockResolvedValue(false) });
    await h.run();
    expect(h.api.banChatMember).not.toHaveBeenCalled();
    expect(h.verificationService.createSession).toHaveBeenCalled();
  });

  it('falls back to verification when the ban itself fails', async () => {
    const h = makeJoinHarness(
      { isBanned: vi.fn().mockResolvedValue(true) },
      { api: { banChatMember: vi.fn().mockRejectedValue(new Error('not enough rights')) } }
    );
    await h.run();
    expect(h.verificationService.createSession).toHaveBeenCalled();
  });

  it('skips the lookup for a group that opted out', async () => {
    const isBanned = vi.fn().mockResolvedValue(true);
    const h = makeJoinHarness({ isBanned }, { customSettings: { casCheck: false } });
    await h.run();
    expect(isBanned).not.toHaveBeenCalled();
    expect(h.api.banChatMember).not.toHaveBeenCalled();
  });
});

describe('CasService', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { config.cas.enabled = true; });
  afterEach(() => { config.cas.enabled = false; globalThis.fetch = realFetch; });

  function respond(body: unknown, status = 200) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as never;
  }

  it('reports a listed account', async () => {
    respond({ ok: true, result: { offenses: 3, time_added: '2026-01-01' } });
    expect(await new CasService().isBanned(`${seq++}`)).toBe(true);
  });

  it('reports an unlisted account', async () => {
    respond({ ok: false, description: 'Record not found.' });
    expect(await new CasService().isBanned(`${seq++}`)).toBe(false);
  });

  it.each([
    ['an HTTP error', () => respond({}, 503)],
    ['a network failure', () => { globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET')) as never; }],
    ['a malformed body', () => respond('not json at all')],
  ])('treats %s as not listed', async (_label, arrange) => {
    // An outage of a third-party list must never stop people joining.
    arrange();
    expect(await new CasService().isBanned(`${seq++}`)).toBe(false);
  });

  it('makes no request when disabled', async () => {
    config.cas.enabled = false;
    globalThis.fetch = vi.fn() as never;
    expect(await new CasService().isBanned(`${seq++}`)).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
