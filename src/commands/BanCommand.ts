import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';

export class BanCommand extends BaseCommand {
  command = 'ban';
  description = '封禁用户';

  setup() {
    // Grammy's command() method should handle commands with bot username automatically
    // But we need to ensure it's working correctly
    this.bot.command(this.command, async (ctx) => {
      this.logger.info('Ban command handler triggered', {
        messageText: ctx.message?.text,
        userId: ctx.from?.id,
        chatId: ctx.chat?.id,
        username: ctx.from?.username
      });
      await this.execute(ctx);
    });
  }

  private async execute(ctx: CommandContext<MyContext>) {
    // Moderation acts on other members, so require the ban right instead of
    // bare administrator status (Telegram allows admins with zero rights).
    if (!await this.requireAdmin(ctx, ['can_restrict_members'])) return;

    const groupId = ctx.chat!.id.toString();
    
    // Check if bot has admin permissions
    try {
      const botMember = await ctx.api.getChatMember(Number(groupId), ctx.me.id);
      if (botMember.status !== 'administrator') {
        await ctx.reply('⚠️ 机器人需要管理员权限才能执行此操作\n请将机器人设置为管理员');
        return;
      }
    } catch (error) {
      this.logger.error('Error checking bot permissions', error);
      await ctx.reply('❌ 无法检查机器人权限');
      return;
    }
    
    const targetUserId = await this.getUserFromMention(ctx);

    const commandText = ctx.match?.toString() || '';
    const parsed = this.parseUserTarget(commandText);
    
    // Check if username was provided but couldn't be resolved
    if (parsed.username && !targetUserId) {
      await ctx.reply(`❌ 无法找到用户 @${parsed.username}\n请确保用户曾在本群发言或使用回复方式`);
      return;
    }
    
    if (!targetUserId) {
      await ctx.reply('❌ 请指定要封禁的用户\n用法: /ban @用户 [时长] [原因]\n或回复用户消息后使用 /ban');
      return;
    }

    // Parse duration and reason from remaining text
    const parts = commandText.trim().split(/\s+/).slice(1); // Skip username/id
    
    let duration: number | undefined;
    let reason: string | undefined;

    if (parts.length > 0) {
      const durationParsed = this.parseDuration(parts[0]);
      if (durationParsed) {
        duration = durationParsed;
        reason = parts.slice(1).join(' ');
      } else {
        reason = parts.join(' ');
      }
    }

    try {
      // Check if target is admin
      const targetMember = await ctx.api.getChatMember(Number(groupId), Number(targetUserId));
      if (targetMember.status === 'administrator' || targetMember.status === 'creator') {
        await ctx.reply('❌ 不能封禁管理��');
        return;
      }

      // Ban user
      const untilDate = duration ? Math.floor(Date.now() / 1000) + (duration * 60) : undefined;
      await ctx.api.banChatMember(Number(groupId), Number(targetUserId), { until_date: untilDate });

      const targetUser = await this.userService.findById(targetUserId);
      const banMessage = `🚫 已封禁用户 ${targetUser?.firstName || '未知用户'}` +
        (targetUser?.username ? ` (@${targetUser.username})` : '') +
        `\n时长: ${this.formatDuration(duration)}` +
        (reason ? `\n原因: ${reason}` : '');

      await ctx.reply(banMessage);

      // Add to blacklist
      await this.verificationService.addToBlacklist(
        targetUserId,
        groupId,
        ctx.from!.id.toString(),
        reason
      );

      // Log action
      await this.auditService.log({
        groupId,
        userId: targetUserId,
        performedBy: ctx.from?.id.toString(),
        action: 'user_banned',
        details: reason || 'No reason provided',
        metadata: { command: 'ban', duration, reason }
      });

    } catch (error) {
      this.logger.error('Error banning user', error);
      await ctx.reply('❌ 封禁用户失败，请检查权限');
    }
  }
}