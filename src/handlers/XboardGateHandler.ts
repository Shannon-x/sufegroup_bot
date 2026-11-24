import { Api, InlineKeyboard } from 'grammy';
import type { User } from 'grammy/types';
import { MyContext } from '../services/TelegramBot';
import { GroupService } from '../services/GroupService';
import { VerificationService } from '../services/VerificationService';
import { AuditService } from '../services/AuditService';
import { XboardGateService, extractUrl } from '../services/XboardGateService';
import { redisService } from '../services/RedisService';
import { Logger } from '../utils/logger';
import { config } from '../config/config';
import { escapeHtml } from '../utils/markdown';

/** A join request the bot is holding open until the applicant binds. */
interface PendingRequest {
  chatId: number;
  title: string;
}

/**
 * Telegram keeps a join request open until someone answers it, so the pending
 * list only needs to outlive a reasonable "I'll do it tonight" delay.
 */
const PENDING_TTL_SECONDS = 3 * 24 * 60 * 60;
/** Lets the join that follows our approval skip the captcha. */
const APPROVED_FLAG_TTL_SECONDS = 10 * 60;
/** Bind attempts per user per window — a subscription token cannot be guessed, but there is no reason to let anyone try. */
const BIND_ATTEMPT_LIMIT = 8;
const BIND_ATTEMPT_WINDOW_SECONDS = 10 * 60;

export const GATE_RECHECK_CALLBACK = 'xbg:recheck';

const pendingKey = (userId: number | string) => `xbgate:pending:${userId}`;
const approvedKey = (chatId: number | string, userId: number | string) => `xbgate:ok:${chatId}:${userId}`;

/**
 * "Only registered panel users may join."
 *
 * The group is set to approve new members. Each join request is checked
 * against the panel:
 *   - bound and not banned → approved at once (and spared the captcha);
 *   - banned               → declined;
 *   - not bound            → kept pending while the bot privately asks for the
 *                            applicant's subscription link, binds it, and then
 *                            approves — the applicant never has to leave
 *                            Telegram or wait for a human;
 *   - panel unreachable    → kept pending with a "check again" button. A panel
 *                            outage never turns into a rejection.
 */
export class XboardGateHandler {
  private logger = new Logger('XboardGateHandler');

  constructor(
    private groupService: GroupService,
    private verificationService: VerificationService,
    private auditService: AuditService,
    private gate: XboardGateService = new XboardGateService()
  ) {}

  /** True when we approved this user into this chat a moment ago. */
  static async wasApprovedByGate(chatId: number | string, userId: number | string): Promise<boolean> {
    try {
      return await redisService.exists(approvedKey(chatId, userId));
    } catch {
      return false;
    }
  }

  // ── Join requests ─────────────────────────────────────────────────────────

  async handleJoinRequest(ctx: MyContext): Promise<void> {
    const request = ctx.chatJoinRequest;
    if (!request) return;
    const { chat, from } = request;
    if (from.is_bot) return;

    const settings = await this.groupService.getSettings(chat.id.toString()).catch(() => null);
    if (!this.gate.isEnabledFor(settings)) return; // Not ours to decide; admins handle it.

    const title = 'title' in chat && chat.title ? chat.title : '本群';
    // A join request lets the bot message the applicant (for a few minutes)
    // even if they never started it.
    const dmChatId = request.user_chat_id ?? from.id;

    if (await this.verificationService.isBlacklisted(from.id.toString(), chat.id.toString()).catch(() => false)) {
      await this.decline(ctx.api, chat.id, from.id);
      return;
    }

    const status = await this.gate.check(from.id);
    this.logger.info('Gate verdict for join request', { chatId: chat.id, userId: from.id, status });

    if (status === 'member') {
      await this.approve(ctx.api, chat.id, from.id);
      return;
    }

    if (status === 'banned') {
      await this.decline(ctx.api, chat.id, from.id);
      await this.dm(ctx.api, dmChatId, `你的${escapeHtml(config.xboardGate.panelName)}账号已被停用，无法加入「${escapeHtml(title)}」。如有疑问请联系客服。`);
      return;
    }

    await this.addPending(from.id, { chatId: chat.id, title });

    if (status === 'unbound') {
      await this.dm(ctx.api, dmChatId, this.bindGuide(from.first_name, title), this.guideKeyboard(from));
    } else {
      await this.dm(
        ctx.api,
        dmChatId,
        `你申请加入「${escapeHtml(title)}」，但暂时无法连接${escapeHtml(config.xboardGate.panelName)}确认你的账号。\n` +
          '你的申请已保留，请稍后点下方按钮重新检查。',
        this.guideKeyboard(from)
      );
    }
  }

  // ── Private chat: subscription link and "check again" ─────────────────────

  /**
   * Handles a private message from someone with a held join request. Returns
   * false when the message is not ours, so the caller passes it on.
   */
  async handlePrivateMessage(ctx: MyContext): Promise<boolean> {
    if (ctx.chat?.type !== 'private' || !ctx.from || !ctx.message) return false;
    const text = ctx.message.text ?? ctx.message.caption;
    if (!text || text.startsWith('/')) return false;

    const pending = await this.getPending(ctx.from.id);
    if (pending.length === 0) return false;

    const url = extractUrl(text);
    if (!url) {
      await ctx.reply('请直接发送你的订阅链接（以 https:// 开头的那一整串），我来帮你完成绑定。', {
        reply_markup: this.guideKeyboard(ctx.from),
      });
      return true;
    }

    // The link is a credential: get it out of the chat history first.
    await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => undefined);

    const attempts = await redisService
      .increment(`xbgate:bind-attempts:${ctx.from.id}`, BIND_ATTEMPT_WINDOW_SECONDS)
      .catch(() => 0);
    if (attempts > BIND_ATTEMPT_LIMIT) {
      await ctx.reply('尝试次数太多了，请过 10 分钟再试。');
      return true;
    }

    const status = await this.gate.bind(ctx.from.id, url);
    this.logger.info('Gate bind attempt', { userId: ctx.from.id, status });
    const panel = escapeHtml(config.xboardGate.panelName);

    switch (status) {
      case 'bound':
      case 'member': {
        const approved = await this.approveAllPending(ctx.api, ctx.from.id);
        const prefix = status === 'bound' ? `✅ 已绑定${panel}账号（订阅链接那条消息我已删除）。` : '✅ 你的账号已经绑定过了。';
        await ctx.reply(`${prefix}\n${this.approvedSummary(approved)}`, { parse_mode: 'HTML' });
        return true;
      }
      case 'banned':
        await this.declineAllPending(ctx.api, ctx.from.id);
        await ctx.reply(`这个${panel}账号已被停用，无法入群。如有疑问请联系客服。`);
        return true;
      case 'account_taken':
        await ctx.reply(
          `这个${panel}账号已经绑定了另一个 Telegram 账号。\n` +
            '请改用那个 Telegram 账号申请入群；如需换绑，请联系客服。'
        );
        return true;
      case 'invalid_link':
        await ctx.reply(
          `没认出这个订阅链接。请到${panel}里重新复制「订阅链接」完整发给我（不是节点链接，也不是网页地址）。`,
          { reply_markup: this.guideKeyboard(ctx.from) }
        );
        return true;
      default:
        await ctx.reply(`暂时无法连接${panel}，你的入群申请仍然保留。请稍后再发一次订阅链接。`);
        return true;
    }
  }

  /**
   * `/start xbgate`: where the panel's "back to Telegram" button lands after a
   * one-click binding. Approves held join requests straight away, so the
   * member does not have to tap "check again". Returns false when there is
   * nothing held, so the ordinary /start reply runs instead.
   */
  async handleStartReturn(ctx: MyContext): Promise<boolean> {
    const userId = ctx.from?.id;
    if (!userId || ctx.chat?.type !== 'private') return false;
    const pending = await this.getPending(userId);
    if (pending.length === 0) return false;

    const panel = escapeHtml(config.xboardGate.panelName);
    const status = await this.gate.check(userId, { fresh: true });
    if (status === 'member') {
      const approved = await this.approveAllPending(ctx.api, userId);
      await ctx.reply(`✅ 已确认你的${panel}账号。\n${this.approvedSummary(approved)}`, { parse_mode: 'HTML' });
    } else if (status === 'banned') {
      await this.declineAllPending(ctx.api, userId);
      await ctx.reply(`你的${panel}账号已被停用，无法入群。如有疑问请联系客服。`);
    } else if (status === 'unbound') {
      await ctx.reply(`还没有找到绑定记录。请在${panel}页面点「确认绑定」，或者直接把订阅链接发给我。`, {
        reply_markup: this.guideKeyboard(ctx.from),
      });
    } else {
      await ctx.reply(`暂时无法连接${panel}，你的入群申请仍然保留，请稍后点下方按钮重新检查。`, {
        reply_markup: this.guideKeyboard(ctx.from),
      });
    }
    return true;
  }

  async handleRecheck(ctx: MyContext): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const pending = await this.getPending(userId);
    if (pending.length === 0) {
      await ctx.answerCallbackQuery({ text: '没有待处理的入群申请了。' }).catch(() => undefined);
      return;
    }

    const status = await this.gate.check(userId, { fresh: true });
    if (status === 'member') {
      const approved = await this.approveAllPending(ctx.api, userId);
      await ctx.answerCallbackQuery({ text: '已通过 ✅' }).catch(() => undefined);
      await ctx.reply(`✅ 已确认你的${escapeHtml(config.xboardGate.panelName)}账号。\n${this.approvedSummary(approved)}`, {
        parse_mode: 'HTML',
      });
      return;
    }
    if (status === 'banned') {
      await this.declineAllPending(ctx.api, userId);
      await ctx.answerCallbackQuery({ text: '账号已被停用，无法入群', show_alert: true }).catch(() => undefined);
      return;
    }
    await ctx
      .answerCallbackQuery({
        text: status === 'unbound' ? '还没有找到绑定记录。直接把订阅链接发给我就能绑定。' : '暂时无法连接面板，请稍后再试。',
        show_alert: true,
      })
      .catch(() => undefined);
  }

  // ── Telegram actions ──────────────────────────────────────────────────────

  private async approve(api: Api, chatId: number, userId: number): Promise<boolean> {
    await redisService.set(approvedKey(chatId, userId), '1', APPROVED_FLAG_TTL_SECONDS).catch(() => undefined);
    try {
      await api.approveChatJoinRequest(chatId, userId);
      await this.audit(chatId, userId, 'user_verified', 'Xboard gate: registered panel user, join request approved');
      return true;
    } catch (error) {
      // Usually the request is already gone: withdrawn, or answered by an admin.
      this.logger.warn('Could not approve join request', {
        chatId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async decline(api: Api, chatId: number, userId: number): Promise<void> {
    try {
      await api.declineChatJoinRequest(chatId, userId);
      await this.audit(chatId, userId, 'user_kicked', 'Xboard gate: join request declined');
    } catch (error) {
      this.logger.warn('Could not decline join request', {
        chatId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async approveAllPending(api: Api, userId: number): Promise<PendingRequest[]> {
    const pending = await this.getPending(userId);
    const approved: PendingRequest[] = [];
    for (const req of pending) {
      if (await this.approve(api, req.chatId, userId)) approved.push(req);
    }
    await redisService.delete(pendingKey(userId)).catch(() => undefined);
    return approved;
  }

  private async declineAllPending(api: Api, userId: number): Promise<void> {
    for (const req of await this.getPending(userId)) {
      await this.decline(api, req.chatId, userId);
    }
    await redisService.delete(pendingKey(userId)).catch(() => undefined);
  }

  private async dm(api: Api, chatId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    try {
      await api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.debug('Could not message join applicant', {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async audit(chatId: number, userId: number, action: 'user_verified' | 'user_kicked', details: string) {
    // Groups and users may not have rows yet (a join request precedes the join);
    // the audit trail is useful but never a reason to fail the decision.
    await this.auditService
      .log({ groupId: chatId.toString(), userId: userId.toString(), action, details })
      .catch(() => undefined);
  }

  // ── Pending list ──────────────────────────────────────────────────────────

  private async getPending(userId: number): Promise<PendingRequest[]> {
    try {
      const raw = await redisService.get(pendingKey(userId));
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((p) => typeof p?.chatId === 'number') : [];
    } catch {
      return [];
    }
  }

  private async addPending(userId: number, req: PendingRequest): Promise<void> {
    const list = (await this.getPending(userId)).filter((p) => p.chatId !== req.chatId);
    list.push(req);
    await redisService.set(pendingKey(userId), JSON.stringify(list), PENDING_TTL_SECONDS).catch(() => undefined);
  }

  // ── Copy ──────────────────────────────────────────────────────────────────

  private bindGuide(firstName: string, title: string): string {
    const panel = escapeHtml(config.xboardGate.panelName);
    const oneClick = this.gate.bindLink({ id: 0 }) !== null;
    return (
      `👋 ${escapeHtml(firstName)}，你好！\n\n` +
      `「${escapeHtml(title)}」只对${panel}的注册用户开放，但你这个 Telegram 账号还没有绑定${panel}账号。\n\n` +
      (oneClick
        ? `<b>只需一步：</b>点下方「一键绑定」，在${panel}登录后点「确认绑定」，我会自动通过你的入群申请。\n\n` +
          `也可以直接把你的<b>订阅链接</b>发给我（收到后我会立刻删掉那条消息）。\n`
        : `<b>只需一步：</b>把你的<b>订阅链接</b>直接发给我（在${panel}首页复制即可），我会自动绑定并通过你的入群申请。\n\n` +
          '🔒 收到后我会立刻删掉那条消息，订阅链接不会留在聊天记录里。\n') +
      `还没有账号？先去${panel}注册一个，免费账号也可以。`
    );
  }

  private guideKeyboard(user?: User): InlineKeyboard {
    const kb = new InlineKeyboard();
    const link = user
      ? this.gate.bindLink({ id: user.id, firstName: user.first_name, lastName: user.last_name, username: user.username })
      : null;
    if (link) {
      kb.url(`🔗 用${config.xboardGate.panelName}账号一键绑定`, link).row();
    } else if (/^https:\/\//i.test(config.xboardGate.panelUrl)) {
      kb.url(`🌐 打开${config.xboardGate.panelName}`, config.xboardGate.panelUrl).row();
    }
    kb.text('🔄 我已绑定，重新检查', GATE_RECHECK_CALLBACK);
    return kb;
  }

  private approvedSummary(approved: PendingRequest[]): string {
    if (approved.length === 0) {
      return '你的入群申请已经处理过了，可以直接去群里看看。';
    }
    const names = approved.map((r) => `「${escapeHtml(r.title)}」`).join('、');
    return `已通过你加入${names}的申请，欢迎！`;
  }
}
