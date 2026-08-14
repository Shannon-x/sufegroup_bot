import { Bot, CommandContext } from 'grammy';
import { MyContext } from '../services/TelegramBot';
import { UserService } from '../services/UserService';
import { GroupService } from '../services/GroupService';
import { VerificationService } from '../services/VerificationService';
import { AuditService } from '../services/AuditService';
import { Logger } from '../utils/logger';
import { config } from '../config/config';
import { escapeHtml } from '../utils/markdown';

/**
 * Telegram admin rights a command can demand on top of the plain
 * administrator/creator status. Names match the `ChatMemberAdministrator`
 * fields returned by getChatMember.
 *
 * Telegram lets an owner promote someone to "administrator" with every right
 * switched off. Such an account is still `status === 'administrator'`, so a
 * status-only check handed it the same power as the owner — it could disable
 * join verification, change the verification TTL or mint/refund lottery coins.
 * High-risk commands therefore name the right they actually need.
 */
export type AdminRight =
  | 'can_restrict_members'
  | 'can_delete_messages'
  | 'can_promote_members'
  | 'can_change_info'
  | 'can_invite_users'
  | 'can_pin_messages';

const ADMIN_RIGHT_LABELS: Record<AdminRight, string> = {
  can_restrict_members: '封禁用户',
  can_delete_messages: '删除消息',
  can_promote_members: '添加新的管理员',
  can_change_info: '更改群组信息',
  can_invite_users: '添加成员',
  can_pin_messages: '置顶消息',
};

/** Telegram's fixed user id for the "GroupAnonymousBot" identity. */
const ANONYMOUS_ADMIN_BOT_ID = 1087968824;

type AdminDenialReason =
  /** Not an administrator at all (or the status could not be read). */
  | 'not_admin'
  /** Administrator, but without every right the command demands. */
  | 'missing_rights'
  /** Posting anonymously: the rights of the human behind the group identity
   *  cannot be looked up, so a right-gated command cannot be authorised. */
  | 'anonymous_unverifiable';

export type AdminCheck =
  | { ok: true }
  | { ok: false; reason: AdminDenialReason; missing: AdminRight[] };

/**
 * Tags Telegram accepts in `parse_mode: 'HTML'`. Anything else — including a
 * bare `<` — makes the Bot API reject the whole message with 400
 * "can't parse entities", which for the welcome template means a muted newcomer
 * never receives their verification entry point.
 */
const TELEGRAM_HTML_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'span', 'tg-spoiler', 'a', 'code', 'pre', 'blockquote',
]);

/** `&` that does not open one of the entities Telegram understands. */
const BARE_AMPERSAND = /&(?!(?:amp|lt|gt|quot|#\d{1,6}|#x[0-9a-fA-F]{1,6});)/;

export abstract class BaseCommand {
  protected logger: Logger;

  constructor(
    protected bot: Bot<MyContext>,
    protected userService: UserService,
    protected groupService: GroupService,
    protected verificationService: VerificationService,
    protected auditService: AuditService
  ) {
    this.logger = new Logger(this.constructor.name);
  }

  abstract command: string;
  abstract description: string;
  abstract setup(): void;

  /**
   * Resolve the caller's admin standing, including *why* it was refused so the
   * reply can say something actionable.
   *
   * @param requiredRights when given, an `administrator` must additionally hold
   *   every listed right; the `creator` always passes. Omit it to keep the
   *   historical status-only behaviour (used by read-only commands).
   */
  protected async checkAdmin(
    ctx: CommandContext<MyContext>,
    requiredRights?: AdminRight[]
  ): Promise<AdminCheck> {
    if (!ctx.chat || ctx.chat.type === 'private') {
      return { ok: false, reason: 'not_admin', missing: [] };
    }

    try {
      this.logger.debug('Checking admin status', {
        chatId: ctx.chat.id,
        userId: ctx.from?.id,
        chatType: ctx.chat.type,
        requiredRights
      });

      if (this.isAnonymousAdmin(ctx)) {
        // The human behind the group identity cannot be identified, so
        // getChatMember can only describe GroupAnonymousBot — never their
        // individual permission bits.
        //
        // Trade-off: sending as the group already requires an admin right that
        // only an administrator can hold, so *status* is established and
        // status-only commands stay usable (an anonymous owner is not locked
        // out of their own group). What is NOT established is any specific
        // right, and assuming one is exactly what let an anonymous right-less
        // administrator walk through every gate added last round. Right-gated
        // commands are therefore refused, with the fix in the message: turn
        // anonymity off for that one command.
        if (requiredRights?.length) {
          this.logger.warn('Refusing right-gated command for an anonymous admin', {
            chatId: ctx.chat.id,
            requiredRights,
          });
          return { ok: false, reason: 'anonymous_unverifiable', missing: requiredRights };
        }
        return { ok: true };
      }

      if (!ctx.from) return { ok: false, reason: 'not_admin', missing: [] };

      const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
      if (member.status !== 'administrator' && member.status !== 'creator') {
        this.logger.debug('Member is not an admin', { status: member.status, userId: ctx.from.id });
        return { ok: false, reason: 'not_admin', missing: [] };
      }

      const missing = this.missingAdminRights(member, requiredRights);
      if (missing.length > 0) {
        return { ok: false, reason: 'missing_rights', missing };
      }
      return { ok: true };
    } catch (error) {
      this.logger.error('Error checking admin status', { error, chatId: ctx.chat.id, userId: ctx.from?.id });
      return { ok: false, reason: 'not_admin', missing: [] };
    }
  }

  /** Boolean shorthand for callers that only branch on allow/deny. */
  protected async isAdmin(ctx: CommandContext<MyContext>, requiredRights?: AdminRight[]): Promise<boolean> {
    return (await this.checkAdmin(ctx, requiredRights)).ok;
  }

  /**
   * True when this update was posted by an administrator hiding behind the
   * group identity (`GroupAnonymousBot` on behalf of this very chat).
   */
  private isAnonymousAdmin(ctx: CommandContext<MyContext>): boolean {
    if (ctx.from?.id !== ANONYMOUS_ADMIN_BOT_ID) return false;
    const senderChat = ctx.message?.sender_chat;
    return !!senderChat && senderChat.id === ctx.chat?.id;
  }

  /**
   * Which of the required rights this member is missing. The creator holds
   * every right implicitly and Telegram does not send the flags for them.
   */
  private missingAdminRights(
    member: Awaited<ReturnType<CommandContext<MyContext>['api']['getChatMember']>>,
    requiredRights?: AdminRight[]
  ): AdminRight[] {
    if (!requiredRights || requiredRights.length === 0) return [];
    if (member.status === 'creator') return [];
    if (member.status !== 'administrator') return [...requiredRights];
    return requiredRights.filter((right) => member[right] !== true);
  }

  /** Human-readable refusal, so an admin can tell a bug from a missing right. */
  protected adminDenialMessage(check: Extract<AdminCheck, { ok: false }>): string {
    const rights = check.missing.map((r) => ADMIN_RIGHT_LABELS[r]).join('、');
    switch (check.reason) {
      case 'anonymous_unverifiable':
        return `❌ 匿名身份无法核对「${rights}」权限，请关闭匿名发言后重试`;
      case 'missing_rights':
        return `❌ 此命令需要「${rights}」管理员权限`;
      default:
        return '❌ 此命令需要管理员权限';
    }
  }

  protected async requireGroup(ctx: CommandContext<MyContext>): Promise<boolean> {
    if (!ctx.chat || ctx.chat.type === 'private') {
      await ctx.reply('❌ 此命令只能在群组中使用');
      return false;
    }
    return true;
  }

  /**
   * @param requiredRights see checkAdmin(). High-risk commands (settings,
   *   lottery, ban/mute/kick, white/blacklist) pass the right they need so a
   *   right-less "administrator" cannot use them; everything else keeps the
   *   status-only check.
   */
  protected async requireAdmin(ctx: CommandContext<MyContext>, requiredRights?: AdminRight[]): Promise<boolean> {
    if (!await this.requireGroup(ctx)) return false;

    const check = await this.checkAdmin(ctx, requiredRights);
    this.logger.debug('Admin check result', { check, userId: ctx.from?.id, requiredRights });

    if (check.ok) return true;

    // Tell the caller which right is missing — otherwise a right-less admin
    // just sees "需要管理员权限" while Telegram shows them as an admin.
    await ctx.reply(this.adminDenialMessage(check));
    return false;
  }

  protected parseUserTarget(text: string): { username?: string; userId?: string; reason?: string } {
    const parts = text.trim().split(/\s+/);
    if (parts.length === 0) return {};
    
    const target = parts[0];
    const reason = parts.slice(1).join(' ');

    // Handle @username
    if (target.startsWith('@')) {
      return { username: target.substring(1), reason };
    } 
    // Handle user ID
    else if (/^\d+$/.test(target)) {
      return { userId: target, reason };
    }
    // No valid target found
    else {
      return {};
    }
  }

  /**
   * The command's argument text with `skipTokens` leading whitespace-separated
   * tokens removed.
   *
   * Sub-command style commands (`/whitelist add @alice`) must drop their
   * sub-command before the remainder can be read as a target: handing the raw
   * `ctx.match` to parseUserTarget made it read "add" as the target, so those
   * commands could never resolve anyone.
   */
  protected commandArgs(ctx: CommandContext<MyContext>, skipTokens = 0): string {
    const text = (ctx.match ?? '').toString().trim();
    if (!text || skipTokens <= 0) return text;
    return text.split(/\s+/).slice(skipTokens).join(' ');
  }

  /**
   * Resolve the target user (and any trailing free-text reason) of a command,
   * from either a reply or the argument text.
   *
   * @param skipTokens number of leading sub-command tokens to drop first.
   */
  protected async resolveTarget(
    ctx: CommandContext<MyContext>,
    skipTokens = 0
  ): Promise<{ userId: string | null; username?: string; reason?: string }> {
    const argsText = this.commandArgs(ctx, skipTokens);
    const parsed = this.parseUserTarget(argsText);
    const replyFrom = ctx.message?.reply_to_message?.from;

    if (replyFrom) {
      // A reply names the target unambiguously, so it keeps winning over the
      // text (historical behaviour). When the text then carries no target token
      // at all, all of it is the reason — `/blacklist add 刷广告` as a reply.
      const reason = parsed.username || parsed.userId ? parsed.reason : argsText;
      this.logger.debug('Resolved target from reply', { userId: replyFrom.id });
      return { userId: replyFrom.id.toString(), reason: reason || undefined };
    }

    this.logger.debug('Parsing command text', { argsText });

    if (parsed.userId) {
      return { userId: parsed.userId, reason: parsed.reason || undefined };
    }

    if (parsed.username) {
      // A username alone cannot be turned into an id via the Bot API, so this
      // only works for users the bot has already seen.
      const user = await this.userService.findByUsername(parsed.username);
      return {
        userId: user?.id ?? null,
        username: parsed.username,
        reason: parsed.reason || undefined,
      };
    }

    return { userId: null };
  }

  protected async getUserFromMention(ctx: CommandContext<MyContext>): Promise<string | null> {
    return (await this.resolveTarget(ctx)).userId;
  }

  /**
   * Identity-bound entry point into the verification flow, or null when the bot
   * username is not configured.
   *
   * VerificationService.generateVerificationUrl() mints an *identity-free
   * bearer token*: whoever reads that URL can complete the verification on the
   * target's behalf, so it must never be posted in a group. The deep links
   * below carry only the session id, and both landing points
   * (PrivateChatHandler.handleStartCommand and the Mini App
   * /api/miniapp/verify* endpoints) reject a session whose userId is not the
   * caller — which makes them safe to show publicly. Same links as the join
   * path in MembershipHandler.
   */
  protected buildVerificationDeepLink(sessionId: string): string | null {
    const botUsername = config.bot.username;
    if (!botUsername) {
      this.logger.error('BOT_USERNAME is not configured; cannot build a verification deep link');
      return null;
    }

    return config.bot.miniAppShortName && config.bot.webhookDomain
      ? `https://t.me/${botUsername}/${config.bot.miniAppShortName}?startapp=verify_${sessionId}`
      : `https://t.me/${botUsername}?start=verify_${sessionId}`;
  }

  /**
   * Reject a welcome template that Telegram's HTML parser would refuse.
   *
   * The template is admin-supplied free text that gets substituted into a
   * `parse_mode: 'HTML'` message, so a stray `<`, `>` or `&` makes the Bot API
   * answer 400 and the message is dropped entirely — for the join path that
   * means a muted newcomer with no verification entry point. Returns an error
   * message to show the admin, or null when the template is safe.
   */
  protected validateTelegramHtml(text: string): string | null {
    const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)>/g;
    const stack: string[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;

    const checkText = (chunk: string): string | null => {
      if (chunk.includes('<') || chunk.includes('>')) {
        return '❌ 模板里的 < 和 > 必须写成 &lt; 和 &gt;，否则 Telegram 会拒发整条消息';
      }
      if (BARE_AMPERSAND.test(chunk)) {
        return '❌ 模板里的 & 必须写成 &amp;，否则 Telegram 会拒发整条消息';
      }
      return null;
    };

    while ((match = tagPattern.exec(text)) !== null) {
      const textError = checkText(text.slice(cursor, match.index));
      if (textError) return textError;
      cursor = match.index + match[0].length;

      const name = match[1].toLowerCase();
      if (!TELEGRAM_HTML_TAGS.has(name)) {
        return `❌ Telegram 不支持标签 <${name}>，可用: ${[...TELEGRAM_HTML_TAGS].join(' ')}`;
      }

      if (match[0].startsWith('</')) {
        if (stack.pop() !== name) return `❌ HTML 标签闭合不匹配: </${name}>`;
      } else {
        // Only <a href> and <span class> carry attributes; anything else with
        // attributes is rejected rather than guessed at.
        const attrs = match[2].trim();
        if (attrs) {
          const attrError = this.validateTagAttributes(name, attrs);
          if (attrError) return attrError;
        }
        stack.push(name);
      }
    }

    const tailError = checkText(text.slice(cursor));
    if (tailError) return tailError;
    if (stack.length > 0) return `❌ HTML 标签未闭合: <${stack[stack.length - 1]}>`;

    return null;
  }

  private validateTagAttributes(name: string, attrs: string): string | null {
    if (name === 'a') {
      const href = /^href="(https?:\/\/|tg:\/\/)[^"<>]*"$/.test(attrs);
      return href ? null : '❌ <a> 标签只支持 href="http(s)://..." 或 href="tg://..."';
    }
    if (name === 'span') {
      return attrs === 'class="tg-spoiler"' ? null : '❌ <span> 标签只支持 class="tg-spoiler"';
    }
    if (name === 'code' || name === 'pre') {
      return /^class="language-[A-Za-z0-9+#._-]+"$/.test(attrs)
        ? null
        : '❌ <code>/<pre> 只支持 class="language-xxx"';
    }
    return `❌ 标签 <${name}> 不支持属性`;
  }

  /**
   * Fill a group's welcome template. Same placeholder contract and same
   * fallback copy as the join path (MembershipHandler.renderWelcomeTemplate);
   * `{ttl}` is seconds, `{ttl_minutes}` is minutes.
   *
   * Every substituted value is HTML-escaped because a display name is
   * attacker-controlled. Templates stored before validation existed are escaped
   * wholesale rather than sent as-is: a legacy template with a stray `<` would
   * otherwise take the entire message down with a 400.
   */
  protected renderWelcomeTemplate(
    template: string | undefined,
    values: { userName: string; groupName: string; ttlMinutes: number }
  ): string {
    const fallback =
      `新成员【{user_name}】 你好！\n` +
      `小菲欢迎您加入{group_name}\n` +
      `您当前需要完成验证才能解除限制，验证有效时间不超过{ttl} 秒。\n` +
      `过期会被踢出或封禁，请尽快。`;

    let body = template && template.trim() ? template : fallback;
    if (this.validateTelegramHtml(body)) {
      this.logger.warn('Welcome template is not valid Telegram HTML; sending it as plain text');
      body = escapeHtml(body);
    }

    return body
      .replace(/\{user_name\}/g, escapeHtml(values.userName))
      .replace(/\{group_name\}/g, escapeHtml(values.groupName))
      .replace(/\{ttl\}/g, String(values.ttlMinutes * 60))
      .replace(/\{ttl_minutes\}/g, String(values.ttlMinutes));
  }

  protected formatDuration(minutes?: number): string {
    if (!minutes) return '永久';
    
    if (minutes < 60) {
      return `${minutes} 分钟`;
    } else if (minutes < 1440) {
      return `${Math.floor(minutes / 60)} 小时`;
    } else {
      return `${Math.floor(minutes / 1440)} 天`;
    }
  }

  protected parseDuration(text: string): number | undefined {
    const match = text.match(/^(\d+)([mhd])?$/i);
    if (!match) return undefined;

    const value = parseInt(match[1]);
    const unit = match[2]?.toLowerCase() || 'm';

    switch (unit) {
      case 'm': return value;
      case 'h': return value * 60;
      case 'd': return value * 1440;
      default: return value;
    }
  }
}