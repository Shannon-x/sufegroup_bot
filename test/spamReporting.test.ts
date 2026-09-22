import { describe, it, expect, vi, beforeEach } from 'vitest';
import { describeMessage } from '../src/utils/messageSample';
import { ContentFilterHandler } from '../src/handlers/ContentFilterHandler';
import { ContentFilterService } from '../src/services/ContentFilterService';
import { SpamCommand } from '../src/commands/SpamCommand';

/**
 * Tooling that turns spam which got past the filter into something the filter
 * can learn from — and gives admins a way to remove advertising bots that this
 * bot is not permitted to see.
 */

describe('describeMessage', () => {
  const sample = describeMessage({
    message_id: 9,
    date: 0,
    chat: { id: -100, type: 'supergroup', title: 'g' },
    from: { id: 555, is_bot: true, first_name: 'Group Help', username: 'grouphelp_bot' },
    text: '还在打工吗？不要错过财富入口',
    entities: [{ type: 'text_link', offset: 0, length: 4, url: 'https://evil.example/x' }],
    reply_markup: { inline_keyboard: [[{ text: '💰 0本金搬砖 💰', url: 'https://t.me/+abc' }]] },
    quote: { text: '佣金提现系统已优化', position: 0 },
    external_reply: {
      origin: { type: 'channel', chat: { id: -1009, type: 'channel', title: 'sufe.pro 前沿资讯' }, message_id: 1, date: 0 },
      chat: { id: -1009, type: 'channel', title: 'sufe.pro 前沿资讯' },
    },
    via_bot: { id: 1, is_bot: true, first_name: 'x', username: 'lure_bot' },
  } as never);

  it('captures every place the payload has been found', () => {
    expect(sample.sender).toMatchObject({ id: 555, isBot: true, username: 'grouphelp_bot' });
    expect(sample.hiddenLinks).toEqual(['https://evil.example/x']);
    expect(sample.keyboard).toEqual([{ text: '💰 0本金搬砖 💰', url: 'https://t.me/+abc' }]);
    expect(sample.quote).toBe('佣金提现系统已优化');
    expect(sample.externalReplyFrom).toMatchObject({ type: 'channel', title: 'sufe.pro 前沿资讯' });
    expect(sample.viaBot).toBe('lure_bot');
  });

  it('truncates long text', () => {
    const long = describeMessage({ message_id: 1, date: 0, chat: { id: 1, type: 'group', title: 'g' }, text: 'x'.repeat(2000) } as never);
    expect(String(long.text).length).toBeLessThan(600);
  });

  it('serialises to a single log line', () => {
    expect(JSON.stringify(sample)).not.toContain('\n');
  });
});

describe('near-miss logging', () => {
  function run(message: Record<string, unknown>) {
    const service = new ContentFilterService();
    vi.spyOn(service, 'isNewUser').mockResolvedValue(false as never);
    const handler = new ContentFilterHandler({} as never, service, { log: vi.fn().mockResolvedValue(undefined) } as never);
    const info = vi.fn();
    (handler as any).logger.info = info;
    const ctx = {
      chat: { id: -100 },
      from: { id: 555, first_name: 'a' },
      me: { id: 42, username: 'sufe_guard_bot' },
      message: { message_id: 1, ...message },
      api: { deleteMessage: vi.fn(), sendMessage: vi.fn() },
    } as never;
    return handler
      .handle(ctx, { customSettings: { filter: { enabled: true, blockUrls: false } } } as never, false)
      .then(() => info);
  }

  it('records a suspicious message that was let through', async () => {
    const info = await run({ text: '这个 @helper_bot 挺好用的' });
    const call = info.mock.calls.find(([msg]) => msg === 'Suspicious message allowed');
    expect(call).toBeTruthy();
    expect(call![1]).toMatchObject({ event: 'near_miss' });
    expect(call![1].sample.text).toContain('@helper_bot');
  });

  it('does not record ordinary conversation', async () => {
    const info = await run({ text: '今天天气不错，大家吃饭了吗' });
    expect(info.mock.calls.find(([msg]) => msg === 'Suspicious message allowed')).toBeUndefined();
  });
});

// ── /spam ──

const REPORTER = 100;
const CHAT = -1001234567890;

function makeSpam(opts: { target: Record<string, unknown>; targetStatus?: string; banFails?: boolean; noReply?: boolean }) {
  let handler: (ctx: any) => Promise<void> = async () => undefined;
  const bot = { command: (_name: string, fn: typeof handler) => { handler = fn; } };
  const verificationService = { addToBlacklist: vi.fn().mockResolvedValue(undefined) };
  const auditService = { log: vi.fn().mockResolvedValue(undefined) };
  const cmd = new SpamCommand(bot as never, {} as never, {} as never, verificationService as never, auditService as never);
  const warn = vi.fn();
  (cmd as any).logger.warn = warn;
  cmd.setup();

  const api = {
    getChatMember: vi.fn(async (_chat: number, userId: number) =>
      userId === REPORTER
        ? { status: 'administrator', can_restrict_members: true, can_delete_messages: true }
        : { status: opts.targetStatus ?? 'member' }
    ),
    deleteMessage: vi.fn().mockResolvedValue(true),
    banChatMember: opts.banFails
      ? vi.fn().mockRejectedValue(new Error('not enough rights'))
      : vi.fn().mockResolvedValue(true),
    banChatSenderChat: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 77 }),
  };
  const ctx = {
    chat: { id: CHAT, type: 'supergroup' },
    from: { id: REPORTER, first_name: 'admin' },
    me: { id: 42, username: 'sufe_guard_bot' },
    message: {
      message_id: 500,
      text: '/spam',
      reply_to_message: opts.noReply ? undefined : { message_id: 499, date: 0, chat: { id: CHAT }, ...opts.target },
    },
    api,
    reply: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(true),
  };
  return { run: () => handler(ctx), api, ctx, warn, auditService, verificationService };
}

describe('/spam', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes an advertising bot this bot cannot otherwise see', async () => {
    const h = makeSpam({ target: { from: { id: 555, is_bot: true, first_name: 'Group Help', username: 'grouphelp_bot' }, text: '财富入口' } });
    await h.run();
    expect(h.api.deleteMessage).toHaveBeenCalledWith(CHAT, 499);
    expect(h.api.banChatMember).toHaveBeenCalledWith(CHAT, 555);
  });

  it('bans and blacklists a user who posted spam', async () => {
    const h = makeSpam({ target: { from: { id: 777, is_bot: false, first_name: 'liujing' }, text: '@zhiasudasdkoubot campaign_001 g1790033580614cfd80825' } });
    await h.run();
    expect(h.api.banChatMember).toHaveBeenCalledWith(CHAT, 777);
    expect(h.verificationService.addToBlacklist).toHaveBeenCalledWith('777', String(CHAT), String(REPORTER), expect.any(String));
  });

  it('records the full sample even before acting', async () => {
    const h = makeSpam({ target: { from: { id: 777, is_bot: false, first_name: 'liujing' }, text: '@zhiasudasdkoubot campaign_001' } });
    await h.run();
    const [msg, meta] = h.warn.mock.calls[0];
    expect(msg).toBe('Spam reported by admin');
    expect(meta).toMatchObject({ event: 'spam_report', reportedBy: REPORTER });
    expect(meta.sample.text).toContain('campaign_001');
    expect(h.auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'spam_reported' }));
  });

  it('bans the channel itself when spam is posted as a channel', async () => {
    const h = makeSpam({ target: { from: { id: 136817688, is_bot: true, first_name: 'Channel' }, sender_chat: { id: -1005555, type: 'channel', title: '广告频道' }, text: 'x' } });
    await h.run();
    expect(h.api.banChatSenderChat).toHaveBeenCalledWith(CHAT, -1005555);
    expect(h.api.banChatMember).not.toHaveBeenCalled();
  });

  it('refuses to act on an admin', async () => {
    const h = makeSpam({ target: { from: { id: 888, is_bot: false, first_name: 'mod' }, text: 'x' }, targetStatus: 'administrator' });
    await h.run();
    expect(h.api.banChatMember).not.toHaveBeenCalled();
    expect(h.api.deleteMessage).not.toHaveBeenCalled();
  });

  it('refuses to act on itself', async () => {
    const h = makeSpam({ target: { from: { id: 42, is_bot: true, first_name: 'me' }, text: 'x' } });
    await h.run();
    expect(h.api.banChatMember).not.toHaveBeenCalled();
  });

  it('says so plainly when the ban fails, and still keeps the sample', async () => {
    const h = makeSpam({ target: { from: { id: 777, is_bot: false, first_name: 'liujing' }, text: 'x' }, banFails: true });
    await h.run();
    const [, text] = h.api.sendMessage.mock.calls[0];
    expect(text).toContain('未能封禁');
    expect(h.warn).toHaveBeenCalledWith('Spam reported by admin', expect.anything());
    expect(h.verificationService.addToBlacklist).not.toHaveBeenCalled();
  });

  it('explains usage when not used as a reply', async () => {
    const h = makeSpam({ target: {}, noReply: true });
    await h.run();
    expect(h.ctx.reply).toHaveBeenCalledWith(expect.stringContaining('回复'));
    expect(h.api.banChatMember).not.toHaveBeenCalled();
  });
});
