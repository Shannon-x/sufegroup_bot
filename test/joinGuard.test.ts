import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MembershipHandler } from '../src/handlers/MembershipHandler';

/**
 * Regression tests for the join guard.
 *
 * The bug class these cover is "fail open": a dependency error anywhere in the
 * join path used to abort processing and let the new member into the group
 * completely unrestricted, while the surrounding code recorded the join as
 * handled. Every test here asserts on whether restrictChatMember was actually
 * called and whether a verification session was created — never on log output.
 */

type Harness = ReturnType<typeof makeHarness>;

let seq = 0;

function makeHarness(overrides: Record<string, any> = {}) {
  const api = {
    restrictChatMember: vi.fn().mockResolvedValue(true),
    banChatMember: vi.fn().mockResolvedValue(true),
    unbanChatMember: vi.fn().mockResolvedValue(true),
    getChatMember: vi.fn().mockResolvedValue({ status: 'member' }),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 999 }),
    deleteMessage: vi.fn().mockResolvedValue(true),
  };

  // A distinct user id per harness keeps MembershipHandler's in-memory
  // processing lock (which lingers for 3s) from suppressing later tests.
  const userId = String(1000 + seq++);
  const groupId = '-1001234567890';

  const userService = {
    findOrCreate: vi.fn().mockResolvedValue({ id: userId, firstName: 'Alice', username: 'alice' }),
  };

  const settings = {
    verificationEnabled: true,
    ttlMinutes: 10,
    autoAction: 'kick',
    adminBypassVerification: false,
    deleteWelcomeMessage: false,
    deleteWelcomeMessageAfter: 300,
    ...(overrides.settings || {}),
  };

  const groupService = {
    findOrCreate: vi.fn().mockResolvedValue({
      group: { id: groupId, title: 'Test Group' },
      settings,
    }),
  };

  const verificationService = {
    isBlacklisted: vi.fn().mockResolvedValue(false),
    isWhitelisted: vi.fn().mockResolvedValue(false),
    getPendingSession: vi.fn().mockResolvedValue(null),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue({ id: 'session-1' }),
    updateSessionMessageId: vi.fn().mockResolvedValue(undefined),
    markRestrictionApplied: vi.fn().mockResolvedValue(undefined),
  };

  const auditService = { log: vi.fn().mockResolvedValue(undefined) };
  const contentFilterService = { recordUserJoinTime: vi.fn().mockResolvedValue(undefined) };
  const levelService = {
    reactivateProfile: vi.fn().mockResolvedValue(undefined),
    markInactive: vi.fn().mockResolvedValue(undefined),
  };

  Object.assign(userService, overrides.userService || {});
  Object.assign(groupService, overrides.groupService || {});
  Object.assign(verificationService, overrides.verificationService || {});
  Object.assign(contentFilterService, overrides.contentFilterService || {});
  Object.assign(api, overrides.api || {});

  const handler = new MembershipHandler(
    {} as any,
    userService as any,
    groupService as any,
    verificationService as any,
    auditService as any,
    contentFilterService as any,
    levelService as any
  );

  const ctx = { api } as any;
  const telegramUser = { id: Number(userId), is_bot: false, first_name: 'Alice', username: 'alice' };
  const chat = { id: Number(groupId), type: 'supergroup', title: 'Test Group' };

  return {
    handler,
    ctx,
    api,
    chat,
    telegramUser,
    userService,
    groupService,
    verificationService,
    auditService,
    contentFilterService,
    levelService,
    run: () => handler.processNewMember(ctx, telegramUser, chat),
  };
}

describe('join guard — dependency failures must not let members through', () => {
  let h: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('still restricts the member when Redis (recordUserJoinTime) fails', async () => {
    h = makeHarness({
      contentFilterService: {
        recordUserJoinTime: vi.fn().mockRejectedValue(new Error('ECONNREFUSED redis')),
      },
    });

    await h.run();

    // The original defect: this assertion failed with 0 calls, because the
    // Redis write happened before the restriction and threw past it.
    expect(h.api.restrictChatMember).toHaveBeenCalledTimes(1);
    expect(h.verificationService.createSession).toHaveBeenCalledTimes(1);
  });

  it('still restricts the member when the audit log write fails', async () => {
    h = makeHarness();
    h.auditService.log.mockRejectedValue(new Error('db write failed'));

    await h.run();

    expect(h.api.restrictChatMember).toHaveBeenCalledTimes(1);
    expect(h.verificationService.createSession).toHaveBeenCalledTimes(1);
  });

  it('still restricts the member when profile reactivation fails', async () => {
    h = makeHarness();
    h.levelService.reactivateProfile.mockRejectedValue(new Error('boom'));

    await h.run();

    expect(h.api.restrictChatMember).toHaveBeenCalledTimes(1);
  });

  it('falls back to an emergency restriction when the database is unreachable', async () => {
    h = makeHarness({
      groupService: {
        findOrCreate: vi.fn().mockRejectedValue(new Error('ECONNREFUSED postgres')),
      },
    });

    await h.run();

    // Cannot decide anything, so deny speech rather than default to granting it.
    expect(h.api.restrictChatMember).toHaveBeenCalledTimes(1);
    expect(h.verificationService.createSession).not.toHaveBeenCalled();
  });
});

describe('join guard — a failed restriction must not look like success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates no verification session when restrictChatMember fails', async () => {
    const h = makeHarness({
      api: {
        restrictChatMember: vi
          .fn()
          .mockRejectedValue(new Error('Bad Request: not enough rights to restrict/unrestrict chat member')),
      },
    });

    await h.run();

    expect(h.api.restrictChatMember).toHaveBeenCalled();
    // A pending session here would be a lie: the user is not restricted.
    expect(h.verificationService.createSession).not.toHaveBeenCalled();
  });

  it('warns the group when it lacks the permission to restrict', async () => {
    const h = makeHarness({
      api: {
        restrictChatMember: vi
          .fn()
          .mockRejectedValue(new Error('Bad Request: not enough rights to restrict/unrestrict chat member')),
      },
    });

    await h.run();

    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);
    const [, text] = h.api.sendMessage.mock.calls[0];
    expect(text).toContain('验证功能未生效');
    expect(text).toContain('限制成员');
  });

  it('explains the basic-group case rather than reporting a generic error', async () => {
    const h = makeHarness({
      api: {
        restrictChatMember: vi
          .fn()
          .mockRejectedValue(new Error('Bad Request: method is available for supergroup chats only')),
      },
    });

    await h.run();

    const [, text] = h.api.sendMessage.mock.calls[0];
    expect(text).toContain('超级群组');
  });

  it('records restrictionApplied only after the restriction succeeded', async () => {
    const ok = makeHarness();
    await ok.run();
    expect(ok.verificationService.markRestrictionApplied).toHaveBeenCalledWith('session-1', true);

    vi.clearAllMocks();

    const failed = makeHarness({
      api: { restrictChatMember: vi.fn().mockRejectedValue(new Error('nope')) },
    });
    await failed.run();
    expect(failed.verificationService.markRestrictionApplied).not.toHaveBeenCalled();
  });
});

describe('join guard — bypass rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips verification for whitelisted users', async () => {
    const h = makeHarness({
      verificationService: { isWhitelisted: vi.fn().mockResolvedValue(true) },
    });

    await h.run();

    expect(h.api.restrictChatMember).not.toHaveBeenCalled();
    expect(h.verificationService.createSession).not.toHaveBeenCalled();
  });

  it('bans blacklisted users instead of verifying them', async () => {
    const h = makeHarness({
      verificationService: { isBlacklisted: vi.fn().mockResolvedValue(true) },
    });

    await h.run();

    expect(h.api.banChatMember).toHaveBeenCalledTimes(1);
    expect(h.verificationService.createSession).not.toHaveBeenCalled();
  });

  it('alerts the group when banning a blacklisted user fails', async () => {
    const h = makeHarness({
      verificationService: { isBlacklisted: vi.fn().mockResolvedValue(true) },
      api: { banChatMember: vi.fn().mockRejectedValue(new Error('not enough rights')) },
    });

    await h.run();

    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not grant the admin bypass when the admin lookup fails', async () => {
    const h = makeHarness({
      settings: { adminBypassVerification: true },
      api: { getChatMember: vi.fn().mockRejectedValue(new Error('timeout')) },
    });

    await h.run();

    // Unknown status must be treated as "not an admin", i.e. still verified.
    expect(h.api.restrictChatMember).toHaveBeenCalledTimes(1);
    expect(h.verificationService.createSession).toHaveBeenCalledTimes(1);
  });

  it('does not restrict genuine Telegram bots but does audit them', async () => {
    const h = makeHarness();
    h.telegramUser.is_bot = true;

    await h.run();

    expect(h.api.restrictChatMember).not.toHaveBeenCalled();
    expect(h.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'bot_joined' })
    );
  });

  it('skips verification entirely when the group disabled it', async () => {
    const h = makeHarness({ settings: { verificationEnabled: false } });

    await h.run();

    expect(h.api.restrictChatMember).not.toHaveBeenCalled();
    expect(h.verificationService.createSession).not.toHaveBeenCalled();
  });
});
