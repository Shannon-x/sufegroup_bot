import { Keyboard, InlineKeyboard } from 'grammy';
import { MyContext } from '../services/TelegramBot';
import { VerificationService } from '../services/VerificationService';
import { GroupService } from '../services/GroupService';
import { redisService } from '../services/RedisService';
import { Logger } from '../utils/logger';
import { config } from '../config/config';

export class PrivateChatHandler {
  private logger: Logger;

  constructor(
    private verificationService: VerificationService,
    private groupService: GroupService
  ) {
    this.logger = new Logger('PrivateChatHandler');
  }

  async handleStartCommand(ctx: MyContext) {
    if (ctx.chat?.type !== 'private') return;

    const startPayload = ctx.message?.text?.split(' ')[1];

    if (startPayload && startPayload.startsWith('verify_')) {
      const sessionId = startPayload.substring(7);

      this.logger.info('User started bot with verification payload', {
        userId: ctx.from?.id,
        sessionId
      });

      const session = await this.verificationService.getSession(sessionId);

      if (!session) {
        await ctx.reply('验证会话不存在或已过期。请返回群组重新获取验证链接。');
        return;
      }

      if (session.userId !== ctx.from?.id.toString()) {
        await ctx.reply('此验证链接不属于您。请使用您自己的验证链接。');
        return;
      }

      if (session.status !== 'pending') {
        await ctx.reply('此验证会话已完成或已过期。');
        return;
      }

      if (new Date() > session.expiresAt) {
        await this.verificationService.updateSessionStatus(session.id, 'expired');
        await ctx.reply('验证已过期。请返回群组重新获取验证链接。');
        return;
      }

      const group = await this.groupService.findById(session.groupId);
      if (!group) {
        await ctx.reply('群组信息不存在。');
        return;
      }

      const remainingMs = session.expiresAt.getTime() - Date.now();
      const remainingMinutes = Math.ceil(remainingMs / 60000);

      const keyboard = new InlineKeyboard();

      if (config.bot.miniAppShortName && config.bot.webhookDomain) {
        // Open verification inside Mini App (no external browser)
        const miniAppUrl = `${config.bot.webhookDomain}/mini-app?startapp=verify_${session.id}`;
        keyboard.webApp('🔐 开始验证', miniAppUrl);
      } else {
        // Fallback: external webpage
        const verifyUrl = this.verificationService.generateVerificationUrl(
          session.userId,
          session.groupId,
          session.id
        );
        keyboard.url('🔐 开始验证', verifyUrl);
      }

      await ctx.reply(
        `您好！请点击下方按钮完成 **${group.title}** 群组的验证。\n\n⏱ 验证有效时间：${remainingMinutes} 分钟\n\n⚠️ 请注意：验证链接仅供您个人使用，请勿分享给他人。`,
        {
          reply_markup: keyboard,
          parse_mode: 'Markdown'
        }
      );
    } else {
      // Mark keyboard as shown so the auto-show fallback doesn't duplicate it
      if (ctx.from?.id) {
        await redisService.set(`kb_shown:${ctx.from.id}`, '1', 86400 * 30).catch(() => {});
      }
      await this.sendWelcomeKeyboard(ctx);
    }
  }

  /** Send the welcome message with persistent reply keyboard. */
  async sendWelcomeKeyboard(ctx: MyContext) {
    const replyKeyboard = new Keyboard();
    if (config.bot.webhookDomain) {
      replyKeyboard.webApp('📱 管理面板', `${config.bot.webhookDomain}/mini-app`);
    }
    replyKeyboard.text('➕ 添加到群聊').resized().persistent();

    await ctx.reply(
      '👋 *你好！我是小菲*\n\n' +
      '我是一个功能完整的群组管理机器人，可以帮助你管理群组成员与内容。\n\n' +
      '*主要功能：*\n' +
      '• 🔐 新成员入群验证，防机器人 & 广告\n' +
      '• 🛡 内容过滤（链接/手机号/关键词/频道转发）\n' +
      '• 🌊 防刷屏保护\n' +
      '• 📊 活跃度等级与称号系统\n' +
      '• 🎰 群内抽奖活动\n\n' +
      '*快速上手：*\n' +
      '1️⃣ 点击聊天框下方「➕ 添加到群聊」按钮\n' +
      '2️⃣ 在群组里将我设置为*管理员*（需要删除消息、封禁用户权限）\n' +
      '3️⃣ 点击「📱 管理面板」按钮进行配置\n\n' +
      '⚠️ *注意：必须先设为管理员，否则机器人无法正常工作。*',
      {
        reply_markup: replyKeyboard,
        parse_mode: 'Markdown',
      }
    );
  }
}
