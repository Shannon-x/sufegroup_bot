import { CommandContext } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';

export class ReverifyCommand extends BaseCommand {
  command = 'reverify';
  description = '为指定用户重新发送验证消息（管理员专用）';

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    if (!await this.requireGroup(ctx)) return;
    if (!await this.requireAdmin(ctx)) return;

    const groupId = ctx.chat!.id.toString();
    const args = ctx.message?.text?.split(' ') || [];

    // Check if user ID or username is provided
    if (args.length < 2) {
      await ctx.reply('❌ 用法: /reverify @username 或 /reverify <用户ID>', {
        reply_to_message_id: ctx.message?.message_id
      });
      return;
    }

    try {
      let userId: string;
      let user: any;

      // Handle @username
      if (args[1].startsWith('@')) {
        const username = args[1].substring(1);
        const dbUser = await this.userService.findByUsername(username);
        if (!dbUser) {
          await ctx.reply('❌ 找不到该用户', {
            reply_to_message_id: ctx.message?.message_id
          });
          return;
        }
        userId = dbUser.id;
        user = dbUser;
      } else {
        // Handle user ID
        userId = args[1];
        const dbUser = await this.userService.findById(userId);
        if (!dbUser) {
          await ctx.reply('❌ 找不到该用户', {
            reply_to_message_id: ctx.message?.message_id
          });
          return;
        }
        user = dbUser;
      }

      // Check if user is in the group and restricted
      try {
        const member = await ctx.api.getChatMember(Number(groupId), Number(userId));
        if (member.status === 'left' || member.status === 'kicked') {
          await ctx.reply('❌ 该用户不在群组中', {
            reply_to_message_id: ctx.message?.message_id
          });
          return;
        }

        if (member.status !== 'restricted') {
          await ctx.reply('❌ 该用户未被限制，不需要验证', {
            reply_to_message_id: ctx.message?.message_id
          });
          return;
        }
      } catch (error) {
        await ctx.reply('❌ 无法获取用户状态', {
          reply_to_message_id: ctx.message?.message_id
        });
        return;
      }

      // Get group settings
      const settings = await this.groupService.getSettings(groupId);
      if (!settings || !settings.verificationEnabled) {
        await ctx.reply('❌ 该群组未启用验证功能', {
          reply_to_message_id: ctx.message?.message_id
        });
        return;
      }

      // Cancel any existing pending session
      const existingSession = await this.verificationService.getPendingSession(userId, groupId);
      if (existingSession) {
        existingSession.status = 'cancelled';
        await this.verificationService['sessionRepository'].save(existingSession);
      }

      // Create new verification session
      const session = await this.verificationService.createSession(
        userId,
        groupId,
        0,
        settings.ttlMinutes
      );

      // Generate verification URL
      const verifyUrl = this.verificationService.generateVerificationUrl(userId, groupId, session.id);

      // Send welcome message
      const welcomeText = settings.welcomeTemplate
        .replace('{group_name}', ctx.chat!.title || '本群')
        .replace('{user_name}', user.firstName || '用户')
        .replace('{ttl}', settings.ttlMinutes.toString());

      const keyboard = new InlineKeyboard()
        .url('🔐 点击验证', verifyUrl);

      const message = await ctx.api.sendMessage(
        Number(groupId),
        welcomeText,
        {
          reply_markup: keyboard,
          parse_mode: 'Markdown'
        }
      );

      // Update session with message ID
      session.messageId = message.message_id;
      await this.verificationService['sessionRepository'].save(session);

      // Log action
      await this.auditService.log({
        groupId,
        userId: userId,
        performedBy: ctx.from!.id.toString(),
        action: 'reverify_triggered',
        details: `Admin manually triggered re-verification for user ${user.username || user.firstName}`
      });

      await ctx.reply('✅ 已为该用户重新发送验证消息', {
        reply_to_message_id: ctx.message?.message_id
      });

      // Delete command message
      try {
        await ctx.deleteMessage();
      } catch (error) {
        // Ignore if can't delete
      }

    } catch (error) {
      this.logger.error('Error in reverify command', error);
      await ctx.reply('❌ 发送验证消息时出错', {
        reply_to_message_id: ctx.message?.message_id
      });
    }
  }
}