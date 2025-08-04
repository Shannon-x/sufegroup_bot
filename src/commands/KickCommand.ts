import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';

export class KickCommand extends BaseCommand {
  command = 'kick';
  description = '踢出用户';

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    if (!await this.requireAdmin(ctx)) return;

    const groupId = ctx.chat!.id.toString();
    const targetUserId = await this.getUserFromMention(ctx);

    if (!targetUserId) {
      await ctx.reply('❌ 请指定要踢出的用户\n用法: /kick @用户 [原因]');
      return;
    }

    // Parse reason
    const commandText = ctx.match?.toString() || '';
    const { reason } = this.parseUserTarget(commandText);

    try {
      // Check if target is admin
      const targetMember = await ctx.api.getChatMember(Number(groupId), Number(targetUserId));
      if (targetMember.status === 'administrator' || targetMember.status === 'creator') {
        await ctx.reply('❌ 不能踢出管理员');
        return;
      }

      // Kick user (ban and immediately unban)
      await ctx.api.banChatMember(Number(groupId), Number(targetUserId));
      await ctx.api.unbanChatMember(Number(groupId), Number(targetUserId));

      const targetUser = await this.userService.findById(targetUserId);
      const kickMessage = `✅ 已踢出用户 ${targetUser?.firstName || '未知用户'}` +
        (targetUser?.username ? ` (@${targetUser.username})` : '') +
        (reason ? `\n原因: ${reason}` : '');

      await ctx.reply(kickMessage);

      // Log action
      await this.auditService.log({
        groupId,
        userId: targetUserId,
        performedBy: ctx.from?.id.toString(),
        action: 'user_kicked',
        details: reason || 'No reason provided',
        metadata: { command: 'kick', reason }
      });

    } catch (error) {
      this.logger.error('Error kicking user', error);
      await ctx.reply('❌ 踢出用户失败，请检查权限');
    }
  }
}