import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramBot } from '../src/services/TelegramBot';
import { ContentFilterService } from '../src/services/ContentFilterService';
import { ContentFilterHandler } from '../src/handlers/ContentFilterHandler';
import { FloodControlHandler } from '../src/handlers/FloodControlHandler';
import { Logger } from '../src/utils/logger';
import { GROUP_ANONYMOUS_BOT_ID, speaksForGroup } from '../src/utils/sender';

/**
 * Posts that speak for the group itself — an anonymous admin posting as the
 * group, or the linked channel's posts that Telegram auto-forwards into its
 * discussion group — are the admins' own. Their sender ids are service
 * accounts that getChatMember reports as "left", so the admin lookup failed and
 * the filter deleted the owner's announcements as "频道推广".
 */

const CHAT_ID = -1002684741025;
const LINKED_CHANNEL_ID = -1002583634481;
const TELEGRAM_SERVICE_ID = 777000;
const CHANNEL_BOT_ID = 136817688;
const INVITE_TEXT = '本周活动说明，进频道看详情 https://t.me/+AbCdEfGh1234';

const chat = { id: CHAT_ID, type: 'supergroup', title: 'Test Group' };
const linkedChannel = { id: LINKED_CHANNEL_ID, type: 'channel', title: 'Announcements' };

function channelAutoForward() {
  return {
    from: { id: TELEGRAM_SERVICE_ID, is_bot: false, first_name: 'Telegram' },
    message: {
      message_id: 1, chat, text: INVITE_TEXT, sender_chat: linkedChannel, is_automatic_forward: true,
      forward_origin: { type: 'channel', chat: linkedChannel, message_id: 99, date: 0 },
    },
  };
}

function anonymousAdmin() {
  return {
    from: { id: GROUP_ANONYMOUS_BOT_ID, is_bot: true, first_name: 'Group', username: 'GroupAnonymousBot' },
    message: { message_id: 2, chat, text: INVITE_TEXT, sender_chat: chat },
  };
}

function memberAsOwnChannel() {
  const own = { id: -1009999999999, type: 'channel', title: 'Some Channel' };
  return {
    from: { id: CHANNEL_BOT_ID, is_bot: true, first_name: 'Channel', username: 'Channel_Bot' },
    message: { message_id: 3, chat, text: INVITE_TEXT, sender_chat: own },
  };
}

function ordinaryMember() {
  return {
    from: { id: 5550001, is_bot: false, first_name: 'member' },
    message: { message_id: 4, chat, text: INVITE_TEXT },
  };
}

function makeCtx(sample: { from: any; message: any }) {
  const api = {
    getChatMember: vi.fn().mockResolvedValue({ status: 'left' }),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
    deleteMessage: vi.fn().mockResolvedValue(true),
    restrictChatMember: vi.fn().mockResolvedValue(true),
    banChatMember: vi.fn().mockResolvedValue(true),
  };
  return {
    chat, from: sample.from, message: sample.message,
    me: { id: 42, username: 'test_bot' }, api,
    deleteMessage: vi.fn().mockResolvedValue(true),
  } as any;
}

function makeBot(getSettings: () => Promise<any>) {
  const contentFilterService = new ContentFilterService();
  const auditService = { log: vi.fn().mockResolvedValue(undefined) };
  const fakeBot = { api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }), deleteMessage: vi.fn() } };

  const bot = Object.create(TelegramBot.prototype) as any;
  Object.assign(bot, {
    logger: new Logger('test'),
    groupService: {
      getSettings: vi.fn(getSettings),
      // What Telegram actually answers for both service accounts.
      isAdminCached: vi.fn().mockResolvedValue(false),
    },
    contentFilterService,
    auditService,
    floodControlHandler: new FloodControlHandler(fakeBot as any, contentFilterService, auditService as any),
    contentFilterHandler: new ContentFilterHandler(fakeBot as any, contentFilterService, auditService as any),
    levelService: { awardMessageXP: vi.fn().mockResolvedValue(null) },
    userService: { findOrCreate: vi.fn().mockResolvedValue({}) },
    lastKnownFilterEnabled: new Map<string, boolean>(),
    lastDegradedLog: new Map<string, number>(),
    lastDegradedNotice: new Map<string, number>(),
  });
  return bot;
}

const filteringOn = () => Promise.resolve({ customSettings: { filter: { enabled: true } } });

describe('speaksForGroup', () => {
  it('recognises a post auto-forwarded from the linked channel', () => {
    expect(speaksForGroup(makeCtx(channelAutoForward()))).toBe(true);
  });

  it('recognises an anonymous admin posting as this group', () => {
    expect(speaksForGroup(makeCtx(anonymousAdmin()))).toBe(true);
  });

  it('does not extend to GroupAnonymousBot speaking for a different chat', () => {
    const sample = anonymousAdmin();
    sample.message.sender_chat = { id: -1001111111111, type: 'supergroup', title: 'Elsewhere' } as any;
    expect(speaksForGroup(makeCtx(sample))).toBe(false);
  });

  it('does not extend to a member posting as their own channel', () => {
    expect(speaksForGroup(makeCtx(memberAsOwnChannel()))).toBe(false);
  });

  it('does not extend to an ordinary member', () => {
    expect(speaksForGroup(makeCtx(ordinaryMember()))).toBe(false);
  });
});

describe('moderation pipeline', () => {
  beforeEach(() => vi.clearAllMocks());

  it('leaves a linked-channel post alone', async () => {
    const ctx = makeCtx(channelAutoForward());
    const blocked = await makeBot(filteringOn).moderateGroupMessage(ctx, 'new');
    expect(blocked).toBe(false);
    expect(ctx.deleteMessage).not.toHaveBeenCalled();
  });

  it('leaves a linked-channel post alone even when forwards are blocked', async () => {
    const ctx = makeCtx(channelAutoForward());
    const settings = () => Promise.resolve({ customSettings: { filter: { enabled: true, blockForwards: true } } });
    const blocked = await makeBot(settings).moderateGroupMessage(ctx, 'new');
    expect(blocked).toBe(false);
    expect(ctx.deleteMessage).not.toHaveBeenCalled();
  });

  it('leaves an anonymous admin alone', async () => {
    const ctx = makeCtx(anonymousAdmin());
    const blocked = await makeBot(filteringOn).moderateGroupMessage(ctx, 'new');
    expect(blocked).toBe(false);
    expect(ctx.deleteMessage).not.toHaveBeenCalled();
  });

  it('never flood-limits the linked channel', async () => {
    const settings = () => Promise.resolve({
      customSettings: { filter: { enabled: true, flood: { enabled: true, maxMessages: 1, deleteExcess: true } } },
    });
    const bot = makeBot(settings);
    for (let i = 0; i < 5; i++) {
      const ctx = makeCtx(channelAutoForward());
      ctx.message.text = `频道更新 ${i}`;
      expect(await bot.moderateGroupMessage(ctx, 'new')).toBe(false);
      expect(ctx.deleteMessage).not.toHaveBeenCalled();
    }
  });

  it('still filters a member posting as their own channel', async () => {
    const ctx = makeCtx(memberAsOwnChannel());
    const blocked = await makeBot(filteringOn).moderateGroupMessage(ctx, 'new');
    expect(blocked).toBe(true);
    expect(ctx.deleteMessage).toHaveBeenCalled();
  });

  it('still filters an ordinary member', async () => {
    const ctx = makeCtx(ordinaryMember());
    const blocked = await makeBot(filteringOn).moderateGroupMessage(ctx, 'new');
    expect(blocked).toBe(true);
    expect(ctx.deleteMessage).toHaveBeenCalled();
  });
});

describe('degraded moderation', () => {
  beforeEach(() => vi.clearAllMocks());

  const outage = () => Promise.reject(new Error('redis and postgres down'));

  function degradedBot() {
    const bot = makeBot(outage);
    bot.lastKnownFilterEnabled.set(String(CHAT_ID), true);
    return bot;
  }

  it('leaves a linked-channel post alone', async () => {
    const ctx = makeCtx(channelAutoForward());
    expect(await degradedBot().moderateGroupMessage(ctx, 'new')).toBe(false);
    expect(ctx.deleteMessage).not.toHaveBeenCalled();
  });

  it('leaves an anonymous admin alone', async () => {
    const ctx = makeCtx(anonymousAdmin());
    expect(await degradedBot().moderateGroupMessage(ctx, 'new')).toBe(false);
    expect(ctx.deleteMessage).not.toHaveBeenCalled();
  });

  it('still removes an invite link from an ordinary member', async () => {
    const ctx = makeCtx(ordinaryMember());
    expect(await degradedBot().moderateGroupMessage(ctx, 'new')).toBe(true);
    expect(ctx.deleteMessage).toHaveBeenCalled();
  });
});
