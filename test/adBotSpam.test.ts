import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentFilterHandler } from '../src/handlers/ContentFilterHandler';
import { ContentFilterService } from '../src/services/ContentFilterService';

/**
 * Reproduces a real advertising post that the filter let through.
 *
 * An advertising bot was invited into a group and posted one short line of
 * text with the entire payload hung off an inline keyboard: a dozen URL
 * buttons whose captions were the advertisement. Nothing in the message text
 * was decisive on its own, and the keyboard was never examined at all, so the
 * message passed while every member saw a screen full of ads.
 */

function settingsWith(filter: Record<string, unknown>) {
  return { customSettings: { filter: { enabled: true, ...filter } } } as never;
}

// The captions and the invite target are taken from the reported message.
const SPAM_BUTTONS = [
  '💰 财富入口 💰',
  '💰 0本金搬砖 💰',
  '💰 抓紧致富 💰',
  '💰 一天七八万随便拿 💰',
  '💰 大胆干来一天一万 💰',
  '💰 过年前带你提迈巴赫..',
  '💰 无风险项木..',
  '💰 一天搞个几千..',
  '💰 2026年想翻身找我就对了..',
  '💰 当代年轻人的致富之路 💰',
];

function adMessage() {
  return {
    message_id: 42,
    text: '还在打工吗，还在啃老吗？ 不要错过财富入口',
    reply_markup: {
      inline_keyboard: SPAM_BUTTONS.map((text) => [
        { text, url: 'https://t.me/+qSxg1c_Apeo1NGZI' },
      ]),
    },
  };
}

function makeHandler() {
  const api = {
    deleteMessage: vi.fn().mockResolvedValue(true),
    restrictChatMember: vi.fn().mockResolvedValue(true),
    banChatMember: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  };
  const auditService = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new ContentFilterService();
  vi.spyOn(service, 'addViolation').mockResolvedValue(1 as never);
  vi.spyOn(service, 'isNewUser').mockResolvedValue(false as never);

  const handler = new ContentFilterHandler({} as never, service, auditService as never);
  const ctx = {
    chat: { id: -1001234567890 },
    from: { id: 555, first_name: 'Group Help', is_bot: true },
    message: adMessage(),
    api,
    deleteMessage: api.deleteMessage,
  } as never;

  return { handler, ctx, api, auditService };
}

describe('advertising bot with an inline-keyboard payload', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks the reported message once the keyboard is scanned', async () => {
    const { handler, ctx } = makeHandler();

    const blocked = await handler.handle(ctx, settingsWith({ blockInviteLinks: true }), false);

    expect(blocked).toBe(true);
  });

  it('deletes it rather than only warning', async () => {
    const { handler, ctx, api } = makeHandler();

    await handler.handle(ctx, settingsWith({ blockInviteLinks: true }), false);

    expect(api.deleteMessage).toHaveBeenCalled();
  });

  it('catches it on the button captions alone, with no link rule enabled', async () => {
    // Even a group that has every link rule switched off should notice ten
    // "get rich quick" captions.
    const { handler, ctx } = makeHandler();
    ctx.message.reply_markup.inline_keyboard = SPAM_BUTTONS.map((text) => [{ text }]);

    const blocked = await handler.handle(
      ctx,
      settingsWith({ blockUrls: false, blockInviteLinks: false, blockPhoneNumbers: false }),
      false
    );

    expect(blocked).toBe(true);
  });

  it('catches a button whose caption is innocent but whose target is an invite', async () => {
    const { handler, ctx } = makeHandler();
    ctx.message.text = '大家好';
    ctx.message.reply_markup.inline_keyboard = [
      [{ text: '点击查看', url: 'https://t.me/+qSxg1c_Apeo1NGZI' }],
    ];

    const blocked = await handler.handle(ctx, settingsWith({ blockInviteLinks: true }), false);

    expect(blocked).toBe(true);
  });

  it('leaves an ordinary keyboard alone', async () => {
    const { handler, ctx } = makeHandler();
    ctx.message.text = '今天的签到';
    ctx.message.reply_markup.inline_keyboard = [
      [{ text: '✅ 签到', callback_data: 'checkin' }],
      [{ text: '📊 我的积分', callback_data: 'points' }],
    ];

    const blocked = await handler.handle(ctx, settingsWith({}), false);

    expect(blocked).toBe(false);
  });

  it('does nothing when the group has not enabled the filter', async () => {
    // The filter is opt-in; this is why the reported group saw no action at all.
    const { handler, ctx } = makeHandler();

    const blocked = await handler.handle(
      ctx,
      { customSettings: { filter: { enabled: false } } } as never,
      false
    );

    expect(blocked).toBe(false);
  });
});
