import { Bot } from 'grammy';
import { MyContext } from '../services/TelegramBot';
import { ContentFilterService } from '../services/ContentFilterService';
import { AuditService } from '../services/AuditService';
import { redisService } from '../services/RedisService';
import { Logger } from '../utils/logger';
import { sendTemporaryMessage } from '../utils/telegram';

export class FloodControlHandler {
  private logger: Logger;

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
    if (floodConfig.deleteExcess) {
      try {
        await ctx.deleteMessage();
      } catch {
        this.logger.debug('Could not delete flood message');
      }
    }

    // Use a Redis flag to avoid spamming warnings (only act once per flood window)
    const floodActedKey = `flood_acted:${chatId}:${userIdStr}`;
    const alreadyActed = await redisService.exists(floodActedKey);
    if (alreadyActed) {
      // Already warned/muted this user in this window, just delete
      return true;
    }

    // Set the flag for the window duration
    await redisService.set(floodActedKey, '1', floodConfig.windowSeconds);

    const firstName = ctx.from?.first_name || '用户';
    const userMention = ctx.from?.username
      ? `@${ctx.from.username}`
      : `[${firstName}](tg://user?id=${userIdStr})`;

    switch (floodConfig.action) {
      case 'warn': {
        const warnText = `⚠️ ${userMention} 请勿刷屏！您在 ${floodConfig.windowSeconds} 秒内发送了过多消息。`;
        await sendTemporaryMessage(this.bot, chatIdNum, warnText, { parse_mode: 'Markdown' }, 10000);
        break;
      }

      case 'mute': {
        const until = Math.floor(Date.now() / 1000) + floodConfig.muteDuration * 60;
        try {
          await ctx.api.restrictChatMember(chatIdNum, userId, {
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
          this.logger.error('Failed to mute flooding user', e);
        }

        const muteText = `🔇 ${userMention} 因刷屏已被禁言 ${floodConfig.muteDuration} 分钟`;
        await sendTemporaryMessage(this.bot, chatIdNum, muteText, { parse_mode: 'Markdown' });
        break;
      }

      case 'ban': {
        try {
          await ctx.api.banChatMember(chatIdNum, userId);
        } catch (e) {
          this.logger.error('Failed to ban flooding user', e);
        }

        const banText = `🚫 ${userMention} 因恶意刷屏已被封禁`;
        await sendTemporaryMessage(this.bot, chatIdNum, banText, { parse_mode: 'Markdown' });
        break;
      }
    }

    await this.auditService.log({
      groupId: chatId,
      userId: userIdStr,
      action: 'message_filtered',
      details: `Flood control: ${floodConfig.action}, ${floodConfig.maxMessages} msgs / ${floodConfig.windowSeconds}s`,
      metadata: { type: 'flood', action: floodConfig.action },
    });

    this.logger.info('Flood control triggered', {
      groupId: chatId,
      userId: userIdStr,
      action: floodConfig.action,
    });

    return true;
  }
}
