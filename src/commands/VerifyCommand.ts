import { CommandContext } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';

export class VerifyCommand extends BaseCommand {
  command = 'verify';
  description = '重新发送验证链接';

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    if (!await this.requireGroup(ctx)) return;

    const userId = ctx.from!.id.toString();
    const groupId = ctx.chat!.id.toString();

    try {
      // Check if user has pending verification
      const session = await this.verificationService.getPendingSession(userId, groupId);
      
      if (!session) {
        // Check if user is restricted
        const member = await ctx.api.getChatMember(Number(groupId), Number(userId));
        if (member.status === 'restricted') {
          // User is restricted but has no session, create a new one
          const settings = await this.groupService.getSettings(groupId);
          if (settings && settings.verificationEnabled) {
            const newSession = await this.verificationService.createSession(
              userId,
              groupId,
              0,
              settings.ttlMinutes
            );
            
            const verifyUrl = this.verificationService.generateVerificationUrl(
              userId,
              groupId,
              newSession.id
            );
            
            const keyboard = new InlineKeyboard()
              .url('🔐 点击验证', verifyUrl);
              
            await ctx.reply(
              `⚠️ 您需要完成验证才能在群组中发言\n\n` +
              `请点击下方按钮完成验证\n` +
              `验证有效期: ${settings.ttlMinutes} 分钟`,
              {
                reply_markup: keyboard,
                parse_mode: 'Markdown',
                reply_to_message_id: ctx.message?.message_id
              }
            );
            
            // Delete command message
            try {
              await ctx.deleteMessage();
            } catch (error) {
              // Ignore if can't delete
            }
            
            return;
          }
        }
        
        await ctx.reply('✅ 您已经完成验证或不需要验证', {
          reply_to_message_id: ctx.message?.message_id
        });
        return;
      }

      // Check if session is expired
      if (new Date() > session.expiresAt) {
        await ctx.reply('⏰ 您的验证已过期，请联系管理员', {
          reply_to_message_id: ctx.message?.message_id
        });
        return;
      }

      // Generate new verification URL
      const verifyUrl = this.verificationService.generateVerificationUrl(
        userId,
        groupId,
        session.id
      );

      const keyboard = new InlineKeyboard()
        .url('🔐 点击验证', verifyUrl);

      await this.groupService.getSettings(groupId);
      const remainingMinutes = Math.ceil(
        (session.expiresAt.getTime() - Date.now()) / 60000
      );

      await ctx.reply(
        `🔗 *验证链接*\n\n` +
        `请点击下方按钮完成验证\n` +
        `剩余时间: ${remainingMinutes} 分钟\n\n` +
        `如果按钮无法点击，请复制此链接到浏览器:\n${verifyUrl}`,
        {
          reply_markup: keyboard,
          parse_mode: 'Markdown',
          reply_to_message_id: ctx.message?.message_id
        }
      );

      // Delete command message
      try {
        await ctx.deleteMessage();
      } catch (error) {
        // Ignore if can't delete
      }

    } catch (error) {
      this.logger.error('Error in verify command', error);
      await ctx.reply('❌ 发送验证链接时出错，请稍后重试', {
        reply_to_message_id: ctx.message?.message_id
      });
    }
  }
}