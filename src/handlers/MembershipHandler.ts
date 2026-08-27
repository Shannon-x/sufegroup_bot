import { Bot } from 'grammy';
import { ChatMember, ChatMemberRestricted } from 'grammy/types';
import { InlineKeyboard } from 'grammy';
import { MyContext } from '../services/TelegramBot';
import { UserService } from '../services/UserService';
import { GroupService } from '../services/GroupService';
import { VerificationService } from '../services/VerificationService';
import { AuditService } from '../services/AuditService';
import { ContentFilterService } from '../services/ContentFilterService';
import { LevelService } from '../services/LevelService';
import { Logger } from '../utils/logger';
import { config } from '../config/config';
import { escapeHtml } from '../utils/markdown';
import { redisService } from '../services/RedisService';
import { renderWelcomeTemplate } from '../utils/welcomeTemplate';

export class MembershipHandler {
  private logger: Logger;
  private processingUsers: Set<string> = new Set();

  constructor(
    private bot: Bot<MyContext>,
    private userService: UserService,
    private groupService: GroupService,
    private verificationService: VerificationService,
    private auditService: AuditService,
    private contentFilterService: ContentFilterService,
    private levelService: LevelService
  ) {
    this.logger = new Logger('MembershipHandler');
  }

  async handleChatMemberUpdate(ctx: MyContext, lastChatMemberUpdate: Map<string, number>) {
    const update = ctx.update.chat_member;
    if (!update) return;

    const { new_chat_member, old_chat_member, chat } = update;

    // Debounce check
    const userId = new_chat_member?.user?.id;
    const chatId = chat?.id;

    if (userId && chatId) {
      const key = `${userId}-${chatId}`;
      const lastUpdate = lastChatMemberUpdate.get(key) || 0;
      const now = Date.now();

      if (now - lastUpdate < 2000) {
        this.logger.debug('Skipping duplicate chat member update', { userId, chatId });
        return;
      }
      lastChatMemberUpdate.set(key, now);
    }

    this.logger.debug('Chat member update', {
      oldStatus: old_chat_member?.status,
      newStatus: new_chat_member?.status,
      userId: new_chat_member?.user?.id,
      chatId: chat?.id
    });

    // Check if user joined
    if (this.isMemberJoined(old_chat_member, new_chat_member)) {
      await this.processNewMember(ctx, new_chat_member.user, chat, update.from);
      return;
    }

    // Check if user left
    if (this.isMemberLeft(old_chat_member, new_chat_member)) {
      await this.processLeavingMember(ctx, new_chat_member.user, chat);
      return;
    }

    // Check if user is restricted and needs re-verification.
    //
    // Only act when the bot itself applied the restriction. When a human admin
    // mutes someone, `from` is that admin — and starting a verification flow
    // there turned every manual mute into a self-service unmute: the muted user
    // solved a captcha and the bot lifted the admin's punishment for them.
    if (old_chat_member.status === 'restricted' && new_chat_member.status === 'restricted') {
      const restrictedByBot = update.from?.id === ctx.me.id;
      if (!restrictedByBot) {
        this.logger.debug('Restriction applied by an admin, not starting verification', {
          userId: new_chat_member.user.id,
          chatId: chat.id,
          by: update.from?.id,
        });
        return;
      }

      const memberId = new_chat_member.user.id.toString();
      const groupId = chat.id.toString();
      const pendingSession = await this.verificationService.getPendingSession(memberId, groupId);

      const canSendMessages = (new_chat_member as ChatMemberRestricted).can_send_messages;
      if (!pendingSession && canSendMessages === false) {
        this.logger.info('Restricted user cannot send messages and has no pending session, triggering verification', {
          userId: memberId,
          groupId
        });
        await this.processNewMember(ctx, new_chat_member.user, chat, update.from);
      }
      return;
    }

    // Check if user joined from outside (might show as restricted immediately)
    if ('is_member' in old_chat_member && 'is_member' in new_chat_member &&
        (old_chat_member as ChatMemberRestricted).is_member === false &&
        (new_chat_member as ChatMemberRestricted).is_member === true) {
      this.logger.info('User joined the group (is_member changed)', {
        userId: new_chat_member.user.id,
        chatId: chat.id
      });
      await this.processNewMember(ctx, new_chat_member.user, chat, update.from);
    }
  }

  async handleNewChatMembers(ctx: MyContext) {
    if (!ctx.message?.new_chat_members || !ctx.chat) return;

    for (const member of ctx.message.new_chat_members) {
      await this.processNewMember(ctx, member, ctx.chat, ctx.from);
    }
  }

  private isMemberJoined(oldMember: ChatMember, newMember: ChatMember): boolean {
    const oldStatus = oldMember.status;
    const newStatus = newMember.status;

    return (
      ((oldStatus === 'left' || oldStatus === 'kicked') &&
       (newStatus === 'member' || newStatus === 'administrator' || newStatus === 'creator' || newStatus === 'restricted')) ||
      ('is_member' in oldMember && 'is_member' in newMember &&
       (oldMember as ChatMemberRestricted).is_member === false &&
       (newMember as ChatMemberRestricted).is_member === true)
    );
  }

  private isMemberLeft(oldMember: ChatMember, newMember: ChatMember): boolean {
    const oldStatus = oldMember.status;
    const newStatus = newMember.status;

    return (
      (oldStatus === 'member' || oldStatus === 'restricted' || oldStatus === 'administrator') &&
      (newStatus === 'left' || newStatus === 'kicked')
    );
  }

  private async processLeavingMember(ctx: MyContext, telegramUser: any, chat: any) {
    try {
      this.logger.info('Processing leaving member', {
        userId: telegramUser.id,
        chatId: chat.id
      });

      // Drop the member out of leaderboards/ranks. Done up-front (independent of
      // the User/Group rows) so it also covers kicks/bans, which surface here as
      // a left/kicked status change.
      await this.levelService
        .markInactive(telegramUser.id.toString(), chat.id.toString())
        .catch((e) => this.logger.debug('markInactive failed', e));

      const user = await this.userService.findById(telegramUser.id.toString());
      if (!user) return;

      const group = await this.groupService.findById(chat.id.toString());
      if (!group) return;

      // Cancel any pending verification sessions
      const pendingSession = await this.verificationService.getPendingSession(user.id, group.id);
      if (pendingSession) {
        this.logger.info('Cancelling pending session for leaving user', {
          userId: user.id,
          sessionId: pendingSession.id
        });

        await this.verificationService.cancelSession(pendingSession.id);

        if (pendingSession.messageId) {
          try {
            await ctx.api.deleteMessage(Number(group.id), pendingSession.messageId);
          } catch (error) {
            this.logger.debug('Could not delete welcome message for leaving user');
          }
        }
      }

      await this.auditService.log({
        groupId: group.id,
        userId: user.id,
        action: 'user_left',
        details: `User @${user.username || user.firstName} left the group`
      });
    } catch (error) {
      this.logger.error('Error processing leaving member', error);
    }
  }

  /**
   * Handle a member joining.
   *
   * Ordering here is load-bearing. Everything that is not required to decide
   * "should this user be muted?" now runs *after* the mute, and only in a
   * best-effort wrapper. The previous version wrote the join timestamp to Redis
   * and an audit row to Postgres before restricting anyone, so a single Redis
   * hiccup threw straight to the outer catch and the member was never
   * restricted, never given a session, and never verified — they simply walked
   * in. Any unexpected failure now falls back to muting the newcomer rather
   * than letting them through.
   */
  async processNewMember(ctx: MyContext, telegramUser: any, chat: any, addedBy?: { id: number; first_name?: string; username?: string }) {
    const userId = telegramUser.id.toString();
    const chatId = chat.id.toString();
    const lockKey = `${userId}-${chatId}`;

    if (this.processingUsers.has(lockKey)) {
      this.logger.debug('User is already being processed, skipping', { userId, chatId });
      return;
    }
    this.processingUsers.add(lockKey);

    // Cross-instance guard on top of the in-process Set, which only ever
    // deduplicated within a single replica. Telegram can deliver the same join
    // as both a chat_member update and a new_chat_members message, and with
    // several replicas each would process it independently. acquireLock is
    // fail-open, so a Redis outage simply degrades to the in-process behaviour.
    const redisLockKey = `lock:join:${lockKey}`;
    const gotRedisLock = await redisService.acquireLock(redisLockKey, 30);
    if (!gotRedisLock) {
      this.logger.debug('Another instance is processing this join, skipping', { userId, chatId });
      this.processingUsers.delete(lockKey);
      return;
    }

    try {
      // Identity and settings are the only prerequisites for the mute decision.
      const user = await this.userService.findOrCreate(telegramUser);
      const { group, settings } = await this.groupService.findOrCreate(chat);

      // Genuine Telegram bots cannot solve a captcha, so verification does not
      // apply — but this is no longer a silent return. Bots added by ordinary
      // members are a common spam vector, so the event is audited and visible.
      if (telegramUser.is_bot) {
        await this.handleBotJoin(ctx, Number(telegramUser.id), user, group, addedBy);
        return;
      }

      if (!settings.verificationEnabled) {
        this.logger.debug(`Verification disabled for group ${group.id}`);
        await this.recordJoinBookkeeping(user, group);
        return;
      }

      // Blacklist: ban outright. A failed ban must not look like a success.
      if (await this.verificationService.isBlacklisted(user.id, group.id)) {
        try {
          await ctx.api.banChatMember(Number(group.id), Number(user.id));
          await this.bestEffort('audit blacklist ban', () =>
            this.auditService.log({
              groupId: group.id,
              userId: user.id,
              action: 'user_kicked',
              details: 'User is blacklisted',
            })
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.error('Failed to ban blacklisted user', { userId: user.id, reason });
          await this.handleRestrictionFailure(ctx, user, group, `封禁黑名单用户失败: ${reason}`);
        }
        return;
      }

      // Whitelist: trusted members skip verification. This check existed in
      // VerificationService but was never wired into the join path, so
      // whitelisted users were still muted and challenged like everyone else.
      if (await this.verificationService.isWhitelisted(user.id, group.id)) {
        this.logger.info('Whitelisted user joined, skipping verification', {
          userId: user.id,
          groupId: group.id,
        });
        await this.bestEffort('audit whitelist bypass', () =>
          this.auditService.log({
            groupId: group.id,
            userId: user.id,
            action: 'user_verified',
            details: 'Whitelist bypass',
          })
        );
        await this.recordJoinBookkeeping(user, group);
        return;
      }

      if (settings.adminBypassVerification) {
        // A failure to read admin status must not grant the bypass.
        const isAdmin = await ctx.api
          .getChatMember(Number(group.id), Number(user.id))
          .then((m) => m.status === 'administrator' || m.status === 'creator')
          .catch((e) => {
            this.logger.warn('Could not read admin status, treating as non-admin', e);
            return false;
          });

        if (isAdmin) {
          await this.bestEffort('audit admin bypass', () =>
            this.auditService.log({
              groupId: group.id,
              userId: user.id,
              action: 'user_verified',
              details: 'Admin bypass',
            })
          );
          await this.recordJoinBookkeeping(user, group);
          return;
        }
      }

      // ── The security-critical step. Nothing optional runs before this. ──
      const restriction = await this.applyRestrictions(ctx, group.id, user.id);
      if (!restriction.ok) {
        await this.handleRestrictionFailure(ctx, user, group, restriction.error ?? 'unknown error');
        // Still record the join. This member is unrestricted and unverified —
        // exactly the case where the content filter's new-user link delay is
        // the only remaining guard — and that delay is driven entirely by the
        // join timestamp written here.
        await this.recordJoinBookkeeping(user, group);
        return;
      }

      const existingSession = await this.verificationService.getPendingSession(user.id, group.id);
      if (existingSession) {
        this.logger.info('Cancelling existing session for user', {
          userId: user.id,
          sessionId: existingSession.id,
        });
        await this.verificationService.cancelSession(existingSession.id);
        // Remove the superseded prompt too. Leaving it up stranded a button in
        // the group that always failed when pressed, since its session was gone.
        if (existingSession.messageId) {
          await this.bestEffort('delete superseded welcome message', () =>
            ctx.api.deleteMessage(Number(group.id), existingSession.messageId)
          );
        }
      }

      const session = await this.verificationService.createSession(
        user.id,
        group.id,
        0,
        settings.ttlMinutes
      );
      await this.bestEffort('mark restriction applied', () =>
        this.verificationService.markRestrictionApplied(session.id, true)
      );

      const welcomeMsg = await this.sendWelcomeMessage(ctx, user, group, settings, session.id);
      if (welcomeMsg) {
        await this.verificationService.updateSessionMessageId(session.id, welcomeMsg.message_id);
      } else {
        // The user is muted and holds a pending session, but never received a
        // verification link — they would sit silent until the timeout removed
        // them, with no way to act and no signal to anyone. Make it visible.
        this.logger.error('Welcome message failed; user is muted with no way to verify', {
          groupId: group.id,
          userId: user.id,
          sessionId: session.id,
        });
        await this.bestEffort('notify verification-link failure', () =>
          ctx.api.sendMessage(
            Number(group.id),
            `⚠️ 无法向 ${escapeHtml(user.firstName)} 发送验证链接，该成员已被限制但收不到验证入口。\n` +
              `请管理员使用 /reverify 重新下发，或检查机器人发言权限。`,
            { parse_mode: 'HTML' }
          )
        );
      }
      // Timeout is handled by SchedulerService's periodic cleanup.

      // Bookkeeping last: useful, but never a reason to let someone in.
      await this.recordJoinBookkeeping(user, group);
    } catch (error) {
      this.logger.error('Error processing new member', error);
      // Fail closed. We could not complete the decision, so deny speech rather
      // than default to granting it, and tell the group why.
      await this.emergencyRestrict(ctx, chatId, userId, error);
    } finally {
      await this.bestEffort('release join lock', () => redisService.delete(redisLockKey));
      setTimeout(() => {
        this.processingUsers.delete(lockKey);
      }, 3000);
    }
  }

  /**
   * Non-critical work that must never abort the join guard. Each call is logged
   * on failure and otherwise ignored.
   */
  private async bestEffort(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.warn(`Best-effort step failed: ${what}`, error);
    }
  }

  private async recordJoinBookkeeping(
    user: { id: string; username?: string | null; firstName: string },
    group: { id: string }
  ): Promise<void> {
    // A former member rejoining: revive their existing profile so prior
    // XP/level/coins reappear on the leaderboard (no-op if none exists).
    await this.bestEffort('reactivateProfile', () =>
      this.levelService.reactivateProfile(user.id, group.id)
    );
    // Join time backs the content filter's new-user link delay.
    await this.bestEffort('recordUserJoinTime', () =>
      this.contentFilterService.recordUserJoinTime(group.id, user.id)
    );
    await this.bestEffort('audit user_joined', () =>
      this.auditService.log({
        groupId: group.id,
        userId: user.id,
        action: 'user_joined',
        details: `User @${user.username || user.firstName} joined the group`,
      })
    );
  }

  /**
   * Last-resort mute when the normal path threw before a decision was reached
   * (database down, Redis down, unexpected bug). Muting a legitimate user is
   * recoverable by an admin; letting an automated account in is not.
   */
  private async emergencyRestrict(
    ctx: MyContext,
    groupId: string,
    userId: string,
    cause: unknown
  ): Promise<void> {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const result = await this.applyRestrictions(ctx, groupId, userId);

    if (result.ok) {
      this.logger.warn('Applied emergency restriction after join-processing failure', {
        groupId,
        userId,
        reason,
      });
      try {
        await ctx.api.sendMessage(
          Number(groupId),
          `⚠️ 处理新成员时发生内部错误，已先行限制该成员以策安全。\n` +
            `请管理员确认后使用 /unmute 解除，或让其重新入群。`,
          { parse_mode: 'HTML' }
        );
      } catch (error) {
        this.logger.debug('Could not post emergency restriction notice', error);
      }
    } else {
      this.logger.error('Emergency restriction also failed — member is unguarded', {
        groupId,
        userId,
        reason,
        restrictError: result.error,
      });
    }
  }

  /**
   * Mute a joining member until they verify.
   *
   * Returns the outcome instead of swallowing it. The previous version caught
   * every error and returned void, so a bot that was not an admin, lacked
   * can_restrict_members, or sat in a basic group (where restrictChatMember is
   * not supported at all) still had a verification session created and a
   * welcome message posted — the user was completely unrestricted while the
   * system recorded them as safely pending.
   */
  private async applyRestrictions(
    ctx: MyContext,
    groupId: string,
    userId: string
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await ctx.api.restrictChatMember(Number(groupId), Number(userId), {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false,
      });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Error applying restrictions', { groupId, userId, error: message });
      return { ok: false, error: message };
    }
  }

  /**
   * Decide what to do about a bot that was just added to the group.
   *
   * A captcha is meaningless for a bot, so verification never applied — but the
   * previous behaviour of simply recording the event and moving on is what let
   * advertising bots operate. Anyone who can invite members could bring one in,
   * and it would then post freely: the group in the report that prompted this
   * had a bot pushing a dozen ad buttons at a time.
   *
   * The rule is about *who* invited it, not about the bot itself. An admin
   * adding a bot is ordinary administration and is left alone. A regular member
   * adding one is not something they should be able to do unilaterally, so the
   * bot is removed and the admins are told who brought it in.
   */
  private async handleBotJoin(
    ctx: MyContext,
    botId: number,
    user: { id: string; firstName: string; username?: string | null },
    group: { id: string; title: string },
    addedBy?: { id: number; first_name?: string; username?: string }
  ): Promise<void> {
    // Never act on ourselves. Compared against the id Telegram sent, not the
    // one that came back from the database — the update is the authority on
    // who joined, and a stale or mismatched row must not be able to point this
    // at the wrong account.
    if (botId === ctx.me?.id) return;

    const policy = await this.resolveBotPolicy(group.id);
    if (policy === 'allow') {
      await this.auditBotJoin(group, user, 'policy=allow');
      return;
    }

    // No actor means we could not attribute the invite (it can be absent on
    // some update shapes). Removing on a guess would let a missing field kick
    // a bot an owner had deliberately installed, so this only reports.
    if (!addedBy) {
      this.logger.warn('Bot joined without an identifiable inviter', {
        botId: user.id,
        groupId: group.id,
      });
      await this.auditBotJoin(group, user, 'inviter unknown, not removed');
      return;
    }

    const inviterIsAdmin = await this.groupService.isAdminCached(
      Number(group.id),
      addedBy.id,
      ctx.api
    );

    if (inviterIsAdmin) {
      await this.auditBotJoin(group, user, `invited by admin ${addedBy.id}`);
      return;
    }

    const botLabel = user.username ? `@${user.username}` : user.firstName;
    const inviterLabel = addedBy.username
      ? `@${addedBy.username}`
      : addedBy.first_name || String(addedBy.id);

    try {
      await ctx.api.banChatMember(Number(group.id), botId);
      this.logger.info('Removed a bot added by a non-admin', {
        botId: user.id,
        groupId: group.id,
        invitedBy: addedBy.id,
      });
      await this.auditBotJoin(group, user, `removed; invited by non-admin ${addedBy.id}`);

      await this.bestEffort('notify unauthorised bot removal', () =>
        ctx.api.sendMessage(
          Number(group.id),
          `🤖 已移除未授权机器人 <b>${escapeHtml(botLabel)}</b>\n` +
            `邀请者: ${escapeHtml(inviterLabel)}（非管理员）\n\n` +
            `如需添加机器人，请由管理员操作。`,
          { parse_mode: 'HTML' }
        )
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error('Could not remove an unauthorised bot', {
        botId: user.id,
        groupId: group.id,
        reason,
      });
      await this.auditBotJoin(group, user, `removal failed: ${reason}`);

      // Say so rather than staying silent: an admin has to act, and the group
      // must not be left believing the bot was handled.
      await this.bestEffort('notify unauthorised bot removal failure', () =>
        ctx.api.sendMessage(
          Number(group.id),
          `⚠️ 检测到未授权机器人 <b>${escapeHtml(botLabel)}</b>（由 ${escapeHtml(inviterLabel)} 邀请），` +
            `但机器人权限不足，无法自动移除。请管理员手动处理。`,
          { parse_mode: 'HTML' }
        )
      );
    }
  }

  /** Group policy for bots invited by ordinary members. */
  private async resolveBotPolicy(groupId: string): Promise<'remove' | 'allow'> {
    try {
      const settings = await this.groupService.getSettings(groupId);
      const configured = (settings?.customSettings as Record<string, unknown> | undefined)?.botPolicy;
      return configured === 'allow' ? 'allow' : 'remove';
    } catch (error) {
      // Defaulting to 'remove' on a lookup failure would delete bots on an
      // outage; defaulting to 'allow' only postpones a decision an admin can
      // still make by hand.
      this.logger.warn('Could not read bot policy, leaving the bot in place', error);
      return 'allow';
    }
  }

  private async auditBotJoin(
    group: { id: string },
    user: { id: string; firstName: string; username?: string | null },
    outcome: string
  ): Promise<void> {
    await this.bestEffort('audit bot join', () =>
      this.auditService.log({
        groupId: group.id,
        userId: user.id,
        action: 'bot_joined',
        details: `Bot @${user.username || user.firstName} was added to the group (${outcome})`,
      })
    );
  }

  /**
   * The bot could not mute a new member. This is a hard failure of the join
   * guard, so it must be loud: no verification session is created (that would
   * record a false "pending" state), admins are told what is wrong, and the
   * event is audited.
   */
  private async handleRestrictionFailure(
    ctx: MyContext,
    user: { id: string; firstName: string },
    group: { id: string; title: string },
    reason: string
  ): Promise<void> {
    this.logger.error('Join guard failed: could not restrict new member', {
      groupId: group.id,
      userId: user.id,
      reason,
    });

    await this.auditService
      .log({
        groupId: group.id,
        userId: user.id,
        action: 'restriction_failed',
        details: `Failed to restrict joining member: ${reason}`,
      })
      .catch((e) => this.logger.debug('audit log failed', e));

    const hint = /not enough rights|CHAT_ADMIN_REQUIRED|can_restrict/i.test(reason)
      ? '机器人缺少「限制成员」管理员权限。'
      : /supergroup|method is available/i.test(reason)
        ? '本群还是普通群组，请升级为超级群组后验证功能才可用。'
        : '请检查机器人的管理员权限。';

    const alert =
      `⚠️ <b>验证功能未生效</b>\n\n` +
      `无法限制新成员 ${escapeHtml(user.firstName)}，该用户当前<b>未被限制</b>。\n` +
      `原因：${hint}\n\n` +
      `<code>${escapeHtml(reason.slice(0, 200))}</code>`;

    try {
      await ctx.api.sendMessage(Number(group.id), alert, { parse_mode: 'HTML' });
    } catch (error) {
      this.logger.error('Could not notify group about restriction failure', error);
    }
  }

  private async sendWelcomeMessage(
    ctx: MyContext,
    user: { id: string; firstName: string },
    group: { id: string; title: string },
    settings: {
      ttlMinutes: number;
      deleteWelcomeMessage: boolean;
      deleteWelcomeMessageAfter: number;
      welcomeTemplate?: string;
    },
    sessionId: string
  ): Promise<any> {
    try {
      // Honour the group's configured template. /settings let admins edit this
      // and showed the result back to them, but the join path ignored it and
      // always posted the hardcoded copy below.
      const welcomeText = this.renderWelcomeTemplate(settings.welcomeTemplate, user, group, settings.ttlMinutes);

      const botUsername = config.bot.username || 'bot';
      const keyboard = new InlineKeyboard();

      if (config.bot.miniAppShortName && config.bot.webhookDomain) {
        // Direct Mini App link — single click, no external browser
        const miniAppUrl = `https://t.me/${botUsername}/${config.bot.miniAppShortName}?startapp=verify_${sessionId}`;
        keyboard.url('🔐 点击验证', miniAppUrl);
      } else {
        // Fallback: bot private chat → external webpage
        const verifyStartUrl = `https://t.me/${botUsername}?start=verify_${sessionId}`;
        keyboard.url('🔐 点击验证', verifyStartUrl);
      }

      const message = await ctx.api.sendMessage(
        Number(group.id),
        welcomeText,
        {
          reply_markup: keyboard,
          parse_mode: 'HTML'
        }
      );

      // Schedule message deletion if configured
      if (settings.deleteWelcomeMessage) {
        setTimeout(async () => {
          try {
            await ctx.api.deleteMessage(Number(group.id), message.message_id);
          } catch {
            // Message may already be deleted
          }
        }, settings.deleteWelcomeMessageAfter * 1000);
      }

      return message;
    } catch (error) {
      this.logger.error('Error sending welcome message', error);
      return null;
    }
  }

  /**
   * Fill the group's welcome template via the shared implementation. This used
   * to be a second, subtly different copy: it escaped the stored template
   * unconditionally, so a template an admin wrote with <b> rendered as bold
   * through /reverify but as literal tags when someone actually joined.
   */
  private renderWelcomeTemplate(
    template: string | undefined,
    user: { firstName: string },
    group: { title: string },
    ttlMinutes: number
  ): string {
    return renderWelcomeTemplate(
      template,
      { userName: user.firstName, groupName: group.title, ttlMinutes },
      (error) =>
        this.logger.warn('Welcome template is not valid Telegram HTML; sending it as plain text', { error })
    );
  }

  async handleBotStatusUpdate(ctx: MyContext) {
    const update = ctx.update.my_chat_member;
    if (!update) return;

    const { new_chat_member, chat, from } = update;

    if ((chat.type === 'group' || chat.type === 'supergroup') &&
        new_chat_member.user.id === ctx.me.id &&
        (new_chat_member.status === 'member' || new_chat_member.status === 'administrator')) {

      this.logger.info('Bot added to group', {
        groupId: chat.id,
        groupTitle: chat.title,
        addedBy: from.id
      });

      const { group } = await this.groupService.findOrCreate(chat);

      const welcomeMsg = `🎉 感谢将我添加到 <b>${escapeHtml(chat.title)}</b>！\n\n` +
        `为了让我正常工作，请：\n` +
        `1. 授予我管理员权限（删除消息、限制用户）\n` +
        `2. 使用 /settings 命令配置验证选项\n` +
        `3. 新成员加入时我会自动发送验证\n\n` +
        `输入 /help 查看所有可用命令。`;

      await ctx.api.sendMessage(chat.id, welcomeMsg, {
        parse_mode: 'HTML'
      });

      await this.auditService.log({
        groupId: group.id,
        performedBy: from.id.toString(),
        action: 'bot_added',
        details: `Bot added to group by ${from.first_name}`
      });
    }

    if ((chat.type === 'group' || chat.type === 'supergroup') &&
        new_chat_member.user.id === ctx.me.id &&
        (new_chat_member.status === 'left' || new_chat_member.status === 'kicked')) {

      this.logger.info('Bot removed from group', {
        groupId: chat.id,
        groupTitle: chat.title,
        removedBy: from.id
      });
    }
  }
}
