import { Bot } from 'grammy';
import { MyContext } from '../services/TelegramBot';
import { ContentFilterService, FloodConfig } from '../services/ContentFilterService';
import { AuditService } from '../services/AuditService';
import { redisService } from '../services/RedisService';
import { Logger } from '../utils/logger';
import { sendTemporaryMessage } from '../utils/telegram';
import { buildMention } from '../utils/markdown';

const MUTE_PERMISSIONS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_documents: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
};

// One permission alert per group per window — a flood against a bot without the
// required rights must not turn the failure notice into a second flood.
const PERMISSION_ALERT_COOLDOWN_MS = 10 * 60 * 1000;

// The alert is addressed to admins, so it auto-deletes like every other
// broadcast here instead of staying in the group forever.
const PERMISSION_ALERT_TTL_MS = 2 * 60 * 1000;

export class FloodControlHandler {
  private logger: Logger;
  private lastPermissionAlert: Map<string, number> = new Map();
  // In-process half of the "already acted this window" flag — see
  // hasActedThisWindow() for why it is not just a Redis-down fallback.
  private localActed: Map<string, number> = new Map();

  constructor(
    private bot: Bot<MyContext>,
    private contentFilterService: ContentFilterService,
    private auditService: AuditService
  ) {
    this.logger = new Logger('FloodControlHandler');
  }

  /**
   * Flood control: limit messages per user per time window.
   * Returns true if the message was blocked due to flooding.
   */
  async handle(
    ctx: MyContext,
    settings: import('../entities/GroupSettings').GroupSettings | null,
    isAdmin: boolean
  ): Promise<boolean> {
    const chatId = ctx.chat!.id.toString();
    const userId = ctx.from?.id;
    if (!userId) return false;
    if (!settings) return false;
    if (isAdmin) return false;

    const filterConfig = this.contentFilterService.getFilterConfig(settings.customSettings);
    const floodConfig = filterConfig.flood;
    if (!floodConfig.enabled) return false;

    const { flooding } = await this.contentFilterService.checkFlood(
      chatId,
      userId.toString(),
      floodConfig
    );

    if (!flooding) return false;

    // User is flooding — take action
    const userIdStr = userId.toString();
    const chatIdNum = Number(chatId);

    // Delete the excess message
    let deleted = false;
    if (floodConfig.deleteExcess) {
      try {
        await ctx.deleteMessage();
        deleted = true;
      } catch {
        this.logger.debug('Could not delete flood message');
      }
    }

    // Only act once per flood window, otherwise every message of the burst
    // triggers its own warning/mute broadcast.
    const floodActedKey = `flood_acted:${chatId}:${userIdStr}`;
    if (await this.hasActedThisWindow(floodActedKey, floodConfig.windowSeconds)) {
      return true;
    }

    // ── The real action first: nothing is announced or audited as done until
    // Telegram has confirmed it. ──
    const failure = await this.enforce(ctx, floodConfig, chatIdNum, userId);
    if (failure) {
      await this.reportEnforcementFailure(chatId, userIdStr, floodConfig, failure, deleted);
      return true;
    }

    const userMention = buildMention(ctx.from, userIdStr);
    const notice = this.buildNotice(floodConfig, userMention);
    const noticeDelivered = await this.announce(
      chatIdNum,
      notice,
      floodConfig.action === 'warn' ? 10000 : undefined
    );

    await this.auditService
      .log({
        groupId: chatId,
        userId: userIdStr,
        action: 'message_filtered',
        details: `Flood control: ${floodConfig.action}, ${floodConfig.maxMessages} msgs / ${floodConfig.windowSeconds}s`,
        metadata: {
          type: 'flood',
          action: floodConfig.action,
          messageDeleted: deleted,
          noticeDelivered,
        },
      })
      .catch(e => this.logger.error('Could not write flood audit log', e));

    this.logger.info('Flood control triggered', {
      groupId: chatId,
      userId: userIdStr,
      action: floodConfig.action,
      deleted,
      noticeDelivered,
    });

    return true;
  }

  /**
   * Claim the "acted in this window" flag. Returns true if the claim failed
   * because somebody already acted.
   *
   * Both halves of the claim are atomic, which the previous `exists()` then
   * `set()` pair was not: the await between them was a window in which two
   * concurrent updates for the same chat could both read "not set", and a flood
   * is exactly the situation where updates for one chat arrive together — so
   * the burst got muted twice and announced twice.
   *
   * The in-process claim goes first and is pure synchronous Map work, so no
   * interleaving is possible within this instance. Redis then settles it across
   * instances with SET NX. Note that acquireLock fails *open* (Redis down ⇒
   * "you got the lock"): acceptable here precisely because the local claim
   * already caps this instance at one action per window, so an outage costs at
   * most one duplicate notice per running instance rather than one per message.
   * The opposite choice — treating an outage as "someone else acted" — would
   * disable flood enforcement entirely whenever Redis blinks.
   */
  private async hasActedThisWindow(key: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    const heldUntil = this.localActed.get(key) || 0;
    if (heldUntil > now) return true;

    this.localActed.set(key, now + ttlSeconds * 1000);
    for (const [k, until] of this.localActed) {
      if (until <= now) this.localActed.delete(k);
    }

    return !(await redisService.acquireLock(key, ttlSeconds));
  }

  /**
   * Carry out the punishment. Returns null on success, or the error message so
   * the caller can report the failure instead of pretending it worked.
   */
  private async enforce(
    ctx: MyContext,
    config: FloodConfig,
    chatId: number,
    userId: number
  ): Promise<string | null> {
    try {
      if (config.action === 'mute') {
        const until = Math.floor(Date.now() / 1000) + config.muteDuration * 60;
        await ctx.api.restrictChatMember(chatId, userId, { ...MUTE_PERMISSIONS }, { until_date: until });
      } else if (config.action === 'ban') {
        await ctx.api.banChatMember(chatId, userId);
      }
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to ${config.action} flooding user`, { chatId, userId, error: message });
      return message;
    }
  }

  /** Group notice for a punishment that has already been applied. */
  private buildNotice(config: FloodConfig, userMention: string): string {
    switch (config.action) {
      case 'mute':
        return `🔇 ${userMention} 因刷屏已被禁言 ${config.muteDuration} 分钟`;
      case 'ban':
        return `🚫 ${userMention} 因恶意刷屏已被封禁`;
      default:
        return `⚠️ ${userMention} 请勿刷屏！您在 ${config.windowSeconds} 秒内发送了过多消息。`;
    }
  }

  /** Broadcast helper that never throws, so a failed notice cannot skip the audit. */
  private async announce(chatId: number, text: string, deleteAfterMs?: number): Promise<boolean> {
    try {
      await sendTemporaryMessage(this.bot, chatId, text, { parse_mode: 'HTML' }, deleteAfterMs);
      return true;
    } catch (error) {
      this.logger.warn('Could not post flood control notice', error);
      return false;
    }
  }

  /**
   * A punishment we could not carry out: audited as 'moderation_failed' rather
   * than as a completed action, with the raw Telegram error kept in the log and
   * the audit row only.
   *
   * The group notice used to carry that raw error — internal method names and
   * ids in front of every member — and stated that the flooder was "未被处置",
   * which is an invitation to keep going. It is now a neutral, self-deleting
   * hint for admins.
   */
  private async reportEnforcementFailure(
    groupId: string,
    userId: string,
    config: FloodConfig,
    error: string,
    deleted: boolean
  ): Promise<void> {
    this.logger.error('Flood control action failed', { groupId, userId, action: config.action, error });

    await this.auditService
      .log({
        groupId,
        userId,
        action: 'moderation_failed',
        details: `Flood control could not ${config.action} user: ${error}`,
        metadata: { type: 'flood', intendedAction: config.action, error, messageDeleted: deleted },
      })
      .catch(e => this.logger.error('Could not write moderation_failed audit log', e));

    if (!this.shouldSendPermissionAlert(groupId)) return;

    const hint = /not enough rights|CHAT_ADMIN_REQUIRED|can_restrict/i.test(error)
      ? '机器人缺少「限制成员 / 封禁用户」管理员权限，请群管理员补齐。'
      : /supergroup|method is available/i.test(error)
        ? '本群还是普通群组，请升级为超级群组后群管理功能才可用。'
        : '请群管理员检查机器人的管理员权限。';

    const alert = `⚠️ <b>机器人权限不足</b>\n${hint}`;

    await this.announce(Number(groupId), alert, PERMISSION_ALERT_TTL_MS);
  }

  /** Throttle the permission alert per group (the audit row is never throttled). */
  private shouldSendPermissionAlert(groupId: string): boolean {
    const now = Date.now();
    const last = this.lastPermissionAlert.get(groupId) || 0;
    if (now - last < PERMISSION_ALERT_COOLDOWN_MS) return false;

    this.lastPermissionAlert.set(groupId, now);
    for (const [key, timestamp] of this.lastPermissionAlert) {
      if (now - timestamp > PERMISSION_ALERT_COOLDOWN_MS) this.lastPermissionAlert.delete(key);
    }
    return true;
  }
}
