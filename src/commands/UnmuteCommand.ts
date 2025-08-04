import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';

export class UnmuteCommand extends BaseCommand {
  command = 'unmute';
  description = '解除禁言';

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    if (!await this.requireAdmin(ctx)) return;

    const groupId = ctx.chat!.id.toString();
    const targetUserId = await this.getUserFromMention(ctx);

    if (!targetUserId) {
      await ctx.reply('❌ 请指定要解除禁言的用户\n用法: /unmute @用户');
      return;
    }

    try {
      // Unmute user
      await ctx.api.restrictChatMember(Number(groupId), Number(targetUserId), {
        can_send_messages: true,
        can_send_audios: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
        can_change_info: false,
        can_invite_users: true,
        can_pin_messages: false
      });

      const targetUser = await this.userService.findById(targetUserId);
      const unmuteMessage = `🔊 已解除禁言 ${targetUser?.firstName || '未知用户'}` +
        (targetUser?.username ? ` (@${targetUser.username})` : '');

      await ctx.reply(unmuteMessage);

      // Log action
      await this.auditService.log({
        groupId,
        userId: targetUserId,
        performedBy: ctx.from?.id.toString(),
        action: 'user_unmuted',
        details: 'User unmuted',
        metadata: { command: 'unmute' }
      });

    } catch (error) {
      this.logger.error('Error unmuting user', error);
      await ctx.reply('❌ 解除禁言失败，请检查权限');
    }
  }
}