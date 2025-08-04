import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';

export class MuteCommand extends BaseCommand {
  command = 'mute';
  description = '禁言用户';

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    if (!await this.requireAdmin(ctx)) return;

    const groupId = ctx.chat!.id.toString();
    const targetUserId = await this.getUserFromMention(ctx);

    if (!targetUserId) {
      await ctx.reply('❌ 请指定要禁言的用户\n用法: /mute @用户 [时长]');
      return;
    }

    // Parse duration
    const commandText = ctx.match?.toString() || '';
    const parts = commandText.trim().split(/\s+/).slice(1);
    
    let duration: number | undefined;
    if (parts.length > 0) {
      duration = this.parseDuration(parts[0]);
    }

    try {
      // Check if target is admin
      const targetMember = await ctx.api.getChatMember(Number(groupId), Number(targetUserId));
      if (targetMember.status === 'administrator' || targetMember.status === 'creator') {
        await ctx.reply('❌ 不能禁言管理员');
        return;
      }

      // Mute user
      const untilDate = duration ? Math.floor(Date.now() / 1000) + (duration * 60) : undefined;
      await ctx.api.restrictChatMember(Number(groupId), Number(targetUserId), {
        can_send_messages: false,
        can_send_audios: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false,
      }, {
        until_date: untilDate
      });

      const targetUser = await this.userService.findById(targetUserId);
      const muteMessage = `🔇 已禁言用户 ${targetUser?.firstName || '未知用户'}` +
        (targetUser?.username ? ` (@${targetUser.username})` : '') +
        `\n时长: ${this.formatDuration(duration)}`;

      await ctx.reply(muteMessage);

      // Log action
      await this.auditService.log({
        groupId,
        userId: targetUserId,
        performedBy: ctx.from?.id.toString(),
        action: 'user_muted',
        details: `Muted for ${this.formatDuration(duration)}`,
        metadata: { command: 'mute', duration }
      });

    } catch (error) {
      this.logger.error('Error muting user', error);
      await ctx.reply('❌ 禁言用户失败，请检查权限');
    }
  }
}