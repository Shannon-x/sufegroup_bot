import { Bot } from 'grammy';
import { MyContext } from '../services/TelegramBot';
import { ContentFilterService, FilterConfig } from '../services/ContentFilterService';
import { AuditService } from '../services/AuditService';
import { Logger } from '../utils/logger';
import { sendTemporaryMessage } from '../utils/telegram';

export class ContentFilterHandler {
  private logger: Logger;

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

    // Gather text from message (text, caption, etc.)
    const text = ctx.message?.text || ctx.message?.caption || '';

    // 1. Check forwarded from channel
    if (filterConfig.blockForwards && ctx.message?.forward_origin) {
      const origin = ctx.message.forward_origin;
      if (origin.type === 'channel') {
        return this.executeFilterAction(ctx, chatId, userId.toString(), filterConfig, ['频道转发']);
      }
    }

    // 2. New user link restriction
    if (text && filterConfig.newUserLinkDelay > 0) {
      const hasUrl = /https?:\/\/|www\.|t\.me\//i.test(text);
      if (hasUrl) {
        const isNew = await this.contentFilterService.isNewUser(chatId, userId.toString(), filterConfig.newUserLinkDelay);
        if (isNew) {
          return this.executeFilterAction(ctx, chatId, userId.toString(), filterConfig, ['新用户发链接']);
        }
      }
    }

    // 3. Analyze text content
    if (text) {
      const result = this.contentFilterService.analyzeText(text, filterConfig);
      if (result.blocked) {
        return this.executeFilterAction(ctx, chatId, userId.toString(), filterConfig, result.reasons);
      }
    }

    return false;
  }

  /**
   * Execute filter action: delete message, warn/mute/ban user.
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
    const reasonStr = reasons.join(', ');

    // Always delete the offending message
    try {
      await ctx.deleteMessage();
    } catch {
      this.logger.debug('Could not delete filtered message');
    }

    // Track violations
    const violations = await this.contentFilterService.addViolation(groupId, userId);
    const action = this.contentFilterService.determineAction(violations, config);

    // Get user display name
    const firstName = ctx.from?.first_name || '用户';
    const userMention = ctx.from?.username
      ? `@${ctx.from.username}`
      : `[${firstName}](tg://user?id=${userId})`;

    switch (action) {
      case 'warn': {
        const warnText = `⚠️ ${userMention} 您的消息包含违禁内容已被删除（${reasonStr}）\n累计警告 ${violations}/${config.maxWarnings}，达到上限将被禁言`;
        await sendTemporaryMessage(this.bot, chatIdNum, warnText, { parse_mode: 'Markdown' }, 15000);
        break;
      }

      case 'mute': {
        const until = Math.floor(Date.now() / 1000) + config.muteDuration * 60;
        try {
          await ctx.api.restrictChatMember(chatIdNum, userIdNum, {
            can_send_messages: false,
            can_send_audios: false,
            can_send_photos: false,
            can_send_videos: false,
            can_send_documents: false,
            can_send_polls: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
          }, { until_date: until });
        } catch (e) {
          this.logger.error('Failed to mute user', e);
        }

        const muteText = `🔇 ${userMention} 因发送违禁内容（${reasonStr}）已被禁言 ${config.muteDuration} 分钟`;
        await sendTemporaryMessage(this.bot, chatIdNum, muteText, { parse_mode: 'Markdown' });
        break;
      }

      case 'ban': {
        try {
          await ctx.api.banChatMember(chatIdNum, userIdNum);
        } catch (e) {
          this.logger.error('Failed to ban user', e);
        }

        const banText = `🚫 ${userMention} 因多次发送违禁内容（${reasonStr}）已被封禁`;
        await sendTemporaryMessage(this.bot, chatIdNum, banText, { parse_mode: 'Markdown' });
        break;
      }

      default:
        break;
    }

    // Audit log
    await this.auditService.log({
      groupId,
      userId,
      action: 'message_filtered',
      details: `Action: ${action}, Reasons: ${reasonStr}, Violations: ${violations}`,
      metadata: { reasons, violations, action },
    });

    this.logger.info('Message filtered', { groupId, userId, action, reasons, violations });
    return true;
  }
}
