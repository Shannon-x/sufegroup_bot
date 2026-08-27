import { Bot } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import { MyContext } from '../services/TelegramBot';
import { ContentFilterService, FilterConfig } from '../services/ContentFilterService';
import { AuditService } from '../services/AuditService';
import { Logger } from '../utils/logger';
import { sendTemporaryMessage } from '../utils/telegram';
import { buildMention, escapeHtml } from '../utils/markdown';

// The three punishments the filter can actually hand out. `determineAction`
// still *declares* a legacy 'delete' member it never returns; carrying it here
// only bought an unreachable label and an unreachable `buildNotice` branch that
// made the notice nullable for no reason.
type FilterAction = 'warn' | 'mute' | 'ban';

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

// One permission alert per group per window. A spam burst against a bot that
// lacks the required rights would otherwise turn the failure notice into a
// flood of its own. The audit row is written every time regardless.
const PERMISSION_ALERT_COOLDOWN_MS = 10 * 60 * 1000;

// The permission alert is addressed to admins, not to the group, so it cleans
// itself up like every other broadcast in this file instead of staying as a
// permanent notice that the bot is understaffed.
const PERMISSION_ALERT_TTL_MS = 2 * 60 * 1000;

// Separator between the visible text and the hidden entity targets. It must not
// let a pattern match *across* the seam: `\n` stops the dot-based spam patterns
// (JS `.` never matches a newline) and the `|` stops PHONE_REGEX, whose group
// separator class `[\s.-]` would otherwise happily glue the tail of the text to
// the head of a URL into a fake phone number.
const SCAN_SEPARATOR = '\n|\n';

export class ContentFilterHandler {
  private logger: Logger;
  private lastPermissionAlert: Map<string, number> = new Map();

  constructor(
    private bot: Bot<MyContext>,
    private contentFilterService: ContentFilterService,
    private auditService: AuditService
  ) {
    this.logger = new Logger('ContentFilterHandler');
  }

  /**
   * Content filter: analyze group messages for spam/ads.
   * Returns true if the message was blocked.
   */
  async handle(
    ctx: MyContext,
    settings: import('../entities/GroupSettings').GroupSettings | null,
    isAdmin: boolean
  ): Promise<boolean> {
    const chatId = ctx.chat!.id.toString();
    const userId = ctx.from?.id;
    if (!userId) return false;
    if (isAdmin) return false;
    if (!settings) return false;

    const filterConfig = this.contentFilterService.getFilterConfig(settings.customSettings);
    if (!filterConfig.enabled) return false;

    // Gather everything the client actually renders as content: the visible
    // text/caption plus the URLs hidden in message entities. Scanning only the
    // visible characters missed the most common payload of all — a `text_link`
    // entity whose anchor text says "点击查看" while pointing at the ad.
    const text = ctx.message?.text || ctx.message?.caption || '';
    const scanTarget = [
      text,
      ...this.collectEntityUrls(ctx),
      ...this.collectKeyboardContent(ctx),
    ]
      .filter(Boolean)
      .join(SCAN_SEPARATOR);

    // 1. Check forwarded messages (channel / group / hidden sender)
    if (filterConfig.blockForwards) {
      const forwardReason = this.contentFilterService.forwardBlockReason(ctx.message?.forward_origin);
      if (forwardReason) {
        return this.executeFilterAction(ctx, chatId, userId.toString(), filterConfig, [forwardReason]);
      }
    }

    // 2. New user link restriction
    if (scanTarget && filterConfig.newUserLinkDelay > 0) {
      if (this.contentFilterService.containsLinkSignal(scanTarget)) {
        const isNew = await this.contentFilterService.isNewUser(chatId, userId.toString(), filterConfig.newUserLinkDelay);
        if (isNew) {
          return this.executeFilterAction(ctx, chatId, userId.toString(), filterConfig, ['新用户发链接']);
        }
      }
    }

    // 3. Analyze text content
    if (scanTarget) {
      const result = this.contentFilterService.analyzeText(scanTarget, filterConfig);
      if (result.blocked) {
        return this.executeFilterAction(ctx, chatId, userId.toString(), filterConfig, result.reasons);
      }
    }

    return false;
  }

  /**
   * Pull the *hidden* link targets out of message entities.
   *
   * Only `text_link` qualifies: it carries its target in `entity.url`, which
   * never appears in the message body — the "点击查看" anchor whose real
   * destination the reader cannot see. `url` entities were appended as well,
   * but their text is by definition already in the body, so every plain link
   * got scanned twice: a message consisting of one `https://a.com` counted as
   * two links, was announced to the group as "链接: 2个" and scored five points
   * above its real severity. The same reasoning drops targets that are also
   * typed out in the text, and identical targets repeated across anchors.
   */
  private collectEntityUrls(ctx: MyContext): string[] {
    const message = ctx.message;
    if (!message) return [];

    const text = message.text || message.caption || '';
    const entities: MessageEntity[] = [
      ...(message.entities || []),
      ...(message.caption_entities || []),
    ];

    const urls = new Set<string>();
    for (const entity of entities) {
      if (entity.type !== 'text_link') continue;
      if (!entity.url || text.includes(entity.url)) continue;
      urls.add(entity.url);
    }
    return [...urls];
  }

  /**
   * Content carried by an inline keyboard.
   *
   * This was a blind spot with a real-world cost: an advertising bot posts one
   * innocuous line of text and hangs the entire payload off the buttons — a
   * dozen URL buttons whose captions are the advertisement itself ("0 本金搬砖",
   * "一天七八万随便拿"). Nothing in the message text trips a rule, so the filter
   * passed it, while every member saw a screen full of ads.
   *
   * Both halves are collected. The captions are what a reader actually reads,
   * so they belong in the spam-pattern scan, and the targets are links that no
   * link rule had ever been applied to.
   */
  private collectKeyboardContent(ctx: MyContext): string[] {
    const keyboard = ctx.message?.reply_markup?.inline_keyboard;
    if (!keyboard) return [];

    const parts = new Set<string>();
    for (const row of keyboard) {
      for (const button of row) {
        if (button.text) parts.add(button.text);
        if ('url' in button && button.url) parts.add(button.url);
        if ('login_url' in button && button.login_url?.url) parts.add(button.login_url.url);
        // An inline-query button prefills a search in another chat; the payload
        // is attacker-controlled text that the client shows on tap.
        if ('switch_inline_query' in button && button.switch_inline_query) {
          parts.add(button.switch_inline_query);
        }
        if ('switch_inline_query_chosen_chat' in button && button.switch_inline_query_chosen_chat?.query) {
          parts.add(button.switch_inline_query_chosen_chat.query);
        }
      }
    }
    return [...parts];
  }

  /**
   * Execute filter action: delete message, warn/mute/ban user.
   *
   * Every line this posts to the group is a claim about something that already
   * happened, so nothing is announced — or audited as done — before the
   * Telegram call it describes has succeeded. The previous version told the
   * group a member had been muted or banned even when restrictChatMember /
   * banChatMember had just thrown, and wrote a success audit row for it; it
   * also lost the audit row entirely whenever the broadcast itself failed,
   * because that exception escaped before the log was written.
   *
   * Returns true in all cases: the message did violate the rules, so it must
   * not fall through to the XP/reply pipeline even when we could not punish it.
   */
  private async executeFilterAction(
    ctx: MyContext,
    groupId: string,
    userId: string,
    config: FilterConfig,
    reasons: string[]
  ): Promise<boolean> {
    const chatIdNum = Number(groupId);
    const userIdNum = Number(userId);

    const deleted = await this.tryDeleteMessage(ctx);
    const violations = await this.countViolation(groupId, userId);
    const action = this.toFilterAction(this.contentFilterService.determineAction(violations, config));

    // ── The real action first ──
    const failure = await this.enforce(ctx, action, chatIdNum, userIdNum, config);
    if (failure) {
      await this.reportEnforcementFailure(groupId, userId, action, reasons, failure, deleted);
      return true;
    }

    const userMention = buildMention(ctx.from, userId);
    const notice = this.buildNotice(action, userMention, reasons, config, violations, deleted);
    const noticeDelivered = await this.announce(
      chatIdNum,
      notice,
      action === 'warn' ? 15000 : undefined
    );

    await this.auditService
      .log({
        groupId,
        userId,
        action: 'message_filtered',
        details: `Action: ${action}, Reasons: ${reasons.join(', ')}, Violations: ${violations}`,
        metadata: { reasons, violations, action, messageDeleted: deleted, noticeDelivered },
      })
      .catch(e => this.logger.error('Could not write filter audit log', e));

    this.logger.info('Message filtered', {
      groupId,
      userId,
      action,
      reasons,
      violations,
      deleted,
      noticeDelivered,
    });
    return true;
  }

  /**
   * Narrow whatever `determineAction` hands back to a punishment this handler
   * can actually carry out. Its signature still admits the legacy 'delete'
   * value, so the widened compare keeps the mapping total without depending on
   * that declaration; an unknown value degrades to the mildest punishment
   * rather than to no punishment at all.
   */
  private toFilterAction(decided: string): FilterAction {
    return decided === 'mute' || decided === 'ban' ? decided : 'warn';
  }

  /** Delete the offending message. Returns whether it actually went away. */
  private async tryDeleteMessage(ctx: MyContext): Promise<boolean> {
    try {
      await ctx.deleteMessage();
      return true;
    } catch {
      this.logger.debug('Could not delete filtered message');
      return false;
    }
  }

  /**
   * Redis holds the violation ledger. If it is unreachable we still act on the
   * message — losing the escalation history is much better than letting the
   * content through — but we deliberately fall back to a first-offence count so
   * a Redis blip can never escalate a regular member straight to a ban.
   */
  private async countViolation(groupId: string, userId: string): Promise<number> {
    try {
      return await this.contentFilterService.addViolation(groupId, userId);
    } catch (error) {
      this.logger.warn('Violation counter unavailable, treating as first offence', error);
      return 1;
    }
  }

  /**
   * Carry out the punishment. Returns null on success, or the error message so
   * the caller can report the failure instead of pretending it worked.
   */
  private async enforce(
    ctx: MyContext,
    action: FilterAction,
    chatId: number,
    userId: number,
    config: FilterConfig
  ): Promise<string | null> {
    try {
      if (action === 'mute') {
        const until = Math.floor(Date.now() / 1000) + config.muteDuration * 60;
        await ctx.api.restrictChatMember(chatId, userId, { ...MUTE_PERMISSIONS }, { until_date: until });
      } else if (action === 'ban') {
        await ctx.api.banChatMember(chatId, userId);
      }
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to ${action} user`, { chatId, userId, error: message });
      return message;
    }
  }

  /** Group notice for a punishment that has already been applied. */
  private buildNotice(
    action: FilterAction,
    userMention: string,
    reasons: string[],
    config: FilterConfig,
    violations: number,
    deleted: boolean
  ): string {
    const reasonStr = escapeHtml(reasons.join(', '));
    // Never claim the message is gone when the delete failed.
    const undeletedHint = deleted ? '' : '\n⚠️ 原消息未能删除，请管理员检查机器人的删除消息权限';

    switch (action) {
      case 'mute':
        return `🔇 ${userMention} 因发送违禁内容（${reasonStr}）已被禁言 ${config.muteDuration} 分钟${undeletedHint}`;
      case 'ban':
        return `🚫 ${userMention} 因多次发送违禁内容（${reasonStr}）已被封禁${undeletedHint}`;
      case 'warn':
        return (
          `⚠️ ${userMention} 您的消息包含违禁内容（${reasonStr}）${deleted ? '已被删除' : ''}\n` +
          `累计警告 ${violations}/${config.maxWarnings}，达到上限将被禁言${undeletedHint}`
        );
    }
  }

  /** Broadcast helper that never throws, so a failed notice cannot skip the audit. */
  private async announce(chatId: number, text: string, deleteAfterMs?: number): Promise<boolean> {
    try {
      await sendTemporaryMessage(this.bot, chatId, text, { parse_mode: 'HTML' }, deleteAfterMs);
      return true;
    } catch (error) {
      this.logger.warn('Could not post content filter notice', error);
      return false;
    }
  }

  /**
   * A punishment we could not carry out. The failure is audited as
   * 'moderation_failed' (never as a completed action) together with the raw
   * Telegram error, and the group gets a short-lived permission hint.
   *
   * What that hint may *not* contain is the previous version's content: the raw
   * error string exposed internals (API method names, chat ids) to every
   * member, and announcing "该用户未被处置" told the spammer, in writing, that
   * the bot cannot touch them. Diagnostics belong in the log and the audit row;
   * the group only needs to know an admin has to look at the bot's rights.
   */
  private async reportEnforcementFailure(
    groupId: string,
    userId: string,
    action: FilterAction,
    reasons: string[],
    error: string,
    deleted: boolean
  ): Promise<void> {
    this.logger.error('Content filter action failed', { groupId, userId, action, error });

    await this.auditService
      .log({
        groupId,
        userId,
        action: 'moderation_failed',
        details: `Content filter could not ${action} user: ${error}`,
        metadata: { intendedAction: action, reasons, error, messageDeleted: deleted },
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
    // Cheap prune so the map cannot outgrow the set of currently active groups.
    for (const [key, timestamp] of this.lastPermissionAlert) {
      if (now - timestamp > PERMISSION_ALERT_COOLDOWN_MS) this.lastPermissionAlert.delete(key);
    }
    return true;
  }
}
