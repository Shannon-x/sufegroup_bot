import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MembershipHandler } from '../src/handlers/MembershipHandler';
import { ContentFilterService } from '../src/services/ContentFilterService';

/**
 * Policy for bots invited into a group.
 *
 * Recording the event and moving on is what allowed advertising bots to
 * operate: any member who could invite people could bring one in, and it then
 * posted freely. The rule keys on who did the inviting — an admin installing a
 * bot is ordinary administration, a regular member doing it is not.
 */

let seq = 0;

function makeHarness(overrides: Record<string, any> = {}) {
  const api = {
    banChatMember: vi.fn().mockResolvedValue(true),
    restrictChatMember: vi.fn().mockResolvedValue(true),
    getChatMember: vi.fn().mockResolvedValue({ status: 'member' }),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    deleteMessage: vi.fn().mockResolvedValue(true),
  };
  const botId = 9000 + seq++;
  const groupId = '-1001234567890';

  const userService = {
    findOrCreate: vi.fn().mockResolvedValue({ id: String(botId), firstName: 'Group Help', username: 'grouphelp_bot' }),
  };
  const groupService = {
    findOrCreate: vi.fn().mockResolvedValue({
      group: { id: groupId, title: 'Test Group' },
      settings: { verificationEnabled: true, ttlMinutes: 10, adminBypassVerification: false,
        deleteWelcomeMessage: false, deleteWelcomeMessageAfter: 300, customSettings: {} },
    }),
    getSettings: vi.fn().mockResolvedValue({ customSettings: {} }),
    isAdminCached: vi.fn().mockResolvedValue(false),
  };
  const verificationService = {
    isBlacklisted: vi.fn().mockResolvedValue(false),
    isWhitelisted: vi.fn().mockResolvedValue(false),
    getPendingSession: vi.fn().mockResolvedValue(null),
    cancelSession: vi.fn(), createSession: vi.fn().mockResolvedValue({ id: 's1' }),
    updateSessionMessageId: vi.fn(), markRestrictionApplied: vi.fn(),
  };
  const auditService = { log: vi.fn().mockResolvedValue(undefined) };
  const levelService = { reactivateProfile: vi.fn().mockResolvedValue(undefined), markInactive: vi.fn() };

  Object.assign(groupService, overrides.groupService || {});
  Object.assign(api, overrides.api || {});

  const handler = new MembershipHandler(
    {} as any, userService as any, groupService as any, verificationService as any,
    auditService as any, new ContentFilterService() as any, levelService as any
  );

  const ctx = { api, me: { id: 42 } } as any;
  const theBot = { id: botId, is_bot: true, first_name: 'Group Help', username: 'grouphelp_bot' };
  const chat = { id: Number(groupId), type: 'supergroup', title: 'Test Group' };

  return { handler, ctx, api, chat, theBot, groupService, auditService, verificationService,
    run: (addedBy?: any) => handler.processNewMember(ctx, theBot, chat, addedBy) };
}

describe('bot invited by a regular member', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is removed from the group', async () => {
    const h = makeHarness();
    await h.run({ id: 777, first_name: 'huanshi' });
    expect(h.api.banChatMember).toHaveBeenCalledWith(Number(h.chat.id), h.theBot.id);
  });

  it('tells the group who invited it', async () => {
    const h = makeHarness();
    await h.run({ id: 777, first_name: 'huanshi' });
    const [, text] = h.api.sendMessage.mock.calls[0];
    expect(text).toContain('已移除未授权机器人');
    expect(text).toContain('huanshi');
  });

  it('says so plainly when it lacks the rights to remove it', async () => {
    const h = makeHarness({ api: { banChatMember: vi.fn().mockRejectedValue(new Error('not enough rights')) } });
    await h.run({ id: 777, first_name: 'huanshi' });
    const [, text] = h.api.sendMessage.mock.calls[0];
    expect(text).toContain('无法自动移除');
  });

  it('never starts a verification session for a bot', async () => {
    const h = makeHarness();
    await h.run({ id: 777, first_name: 'huanshi' });
    expect(h.verificationService.createSession).not.toHaveBeenCalled();
  });
});

describe('bot invited by an admin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is left alone', async () => {
    const h = makeHarness({ groupService: { isAdminCached: vi.fn().mockResolvedValue(true) } });
    await h.run({ id: 777, first_name: 'owner' });
    expect(h.api.banChatMember).not.toHaveBeenCalled();
  });

  it('is still recorded in the audit log', async () => {
    const h = makeHarness({ groupService: { isAdminCached: vi.fn().mockResolvedValue(true) } });
    await h.run({ id: 777, first_name: 'owner' });
    expect(h.auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'bot_joined' }));
  });
});

describe('safety rails', () => {
  beforeEach(() => vi.clearAllMocks());

  it('never removes itself', async () => {
    const h = makeHarness();
    h.theBot.id = 42; // same as ctx.me.id
    await h.run({ id: 777, first_name: 'huanshi' });
    expect(h.api.banChatMember).not.toHaveBeenCalled();
  });

  it('does not guess when the inviter is unknown', async () => {
    // Removing on a missing field would evict a bot an owner installed.
    const h = makeHarness();
    await h.run(undefined);
    expect(h.api.banChatMember).not.toHaveBeenCalled();
  });

  it('leaves the bot alone when the group opted out', async () => {
    const h = makeHarness({
      groupService: { getSettings: vi.fn().mockResolvedValue({ customSettings: { botPolicy: 'allow' } }) },
    });
    await h.run({ id: 777, first_name: 'huanshi' });
    expect(h.api.banChatMember).not.toHaveBeenCalled();
  });

  it('does not remove anyone when the settings lookup fails', async () => {
    const h = makeHarness({
      groupService: { getSettings: vi.fn().mockRejectedValue(new Error('db down')) },
    });
    await h.run({ id: 777, first_name: 'huanshi' });
    expect(h.api.banChatMember).not.toHaveBeenCalled();
  });
});
