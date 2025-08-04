import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';

export class UnbanCommand extends BaseCommand {
  command = 'unban';
  description = '解封用户';

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    if (!await this.requireAdmin(ctx)) return;

    const groupId = ctx.chat!.id.toString();
    const targetUserId = await this.getUserFromMention(ctx);

    if (!targetUserId) {
      await ctx.reply('❌ 请指定要解封的用户\n用法: /unban @用户');
      return;
    }

    try {
      // Unban user
      await ctx.api.unbanChatMember(Number(groupId), Number(targetUserId), {
        only_if_banned: true
      });

      // Remove from blacklist
      await this.verificationService.removeFromBlacklist(targetUserId, groupId);

      const targetUser = await this.userService.findById(targetUserId);
      const unbanMessage = `✅ 已解封用户 ${targetUser?.firstName || '未知用户'}` +
        (targetUser?.username ? ` (@${targetUser.username})` : '');

      await ctx.reply(unbanMessage);

      // Log action
      await this.auditService.log({
        groupId,
        userId: targetUserId,
        performedBy: ctx.from?.id.toString(),
        action: 'user_unbanned',
        details: 'User unbanned',
        metadata: { command: 'unban' }
      });

    } catch (error) {
      this.logger.error('Error unbanning user', error);
      await ctx.reply('❌ 解封用户失败，请检查用户是否已被封禁');
    }
  }
}