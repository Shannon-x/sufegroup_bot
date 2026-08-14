import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';
import { escapeHtml } from '../utils/markdown';

export class BlacklistCommand extends BaseCommand {
  command = 'blacklist';
  description = '管理黑名单';

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    // Blacklisting bans the target, so it needs the ban right rather than bare
    // administrator status.
    if (!await this.requireAdmin(ctx, ['can_restrict_members'])) return;

    const subCommand = this.commandArgs(ctx).split(/\s+/)[0]?.toLowerCase();
    const groupId = ctx.chat!.id.toString();

    switch (subCommand) {
      case 'add':
        await this.addToBlacklist(ctx, groupId);
        break;
      case 'remove':
        await this.removeFromBlacklist(ctx, groupId);
        break;
      case 'list':
        await this.listBlacklist(ctx, groupId);
        break;
      default:
        await ctx.reply(
          '❌ 用法:\n' +
          '/blacklist add @用户 [原因] - 添加黑名单\n' +
          '/blacklist remove @用户 - 移除黑名单\n' +
          '/blacklist list - 查看黑名单\n' +
          '（也可回复某人的消息后使用 /blacklist add [原因]）'
        );
    }
  }

  private async addToBlacklist(ctx: CommandContext<MyContext>, groupId: string) {
    // skipTokens = 1 drops the "add" sub-command; without it parseUserTarget
    // read "add" as the target, so no user was ever resolved and the reason was
    // taken from the wrong offset.
    const { userId: targetUserId, username, reason } = await this.resolveTarget(ctx, 1);

    if (!targetUserId) {
      await ctx.reply(
        username
          ? `❌ 无法找到用户 @${username}\n请确保该用户曾在本群发言，或改用回复其消息的方式`
          : '❌ 请指定要添加到黑名单的用户'
      );
      return;
    }

    try {
      // Check if already blacklisted
      if (await this.verificationService.isBlacklisted(targetUserId, groupId)) {
        await ctx.reply('⚠️ 该用户已在黑名单中');
        return;
      }

      // Add to blacklist
      await this.verificationService.addToBlacklist(
        targetUserId,
        groupId,
        ctx.from!.id.toString(),
        reason
      );

      // Try to ban the user if they're in the group
      try {
        await ctx.api.banChatMember(Number(groupId), Number(targetUserId));
      } catch {
        // User might not be in the group
      }

      const targetUser = await this.userService.findById(targetUserId);
      await ctx.reply(
        `🚫 已将 ${targetUser?.firstName || '未知用户'}` +
        (targetUser?.username ? ` (@${targetUser.username})` : '') +
        ' 添加到黑名单' +
        (reason ? `\n原因: ${reason}` : '')
      );

      // Log action
      await this.auditService.log({
        groupId,
        userId: targetUserId,
        performedBy: ctx.from?.id.toString(),
        action: 'blacklist_added',
        details: reason || 'User added to blacklist',
        metadata: { reason }
      });

    } catch (error) {
      this.logger.error('Error adding to blacklist', error);
      await ctx.reply('❌ 添加黑名单失败');
    }
  }

  private async removeFromBlacklist(ctx: CommandContext<MyContext>, groupId: string) {
    const { userId: targetUserId, username } = await this.resolveTarget(ctx, 1);

    if (!targetUserId) {
      await ctx.reply(
        username
          ? `❌ 无法找到用户 @${username}\n请确保该用户曾在本群发言，或改用回复其消息的方式`
          : '❌ 请指定要从黑名单移除的用户'
      );
      return;
    }

    try {
      const removed = await this.verificationService.removeFromBlacklist(targetUserId, groupId);

      if (!removed) {
        await ctx.reply('⚠️ 该用户不在黑名单中');
        return;
      }

      const targetUser = await this.userService.findById(targetUserId);
      await ctx.reply(
        `✅ 已将 ${targetUser?.firstName || '未知用户'}` +
        (targetUser?.username ? ` (@${targetUser.username})` : '') +
        ' 从黑名单移除'
      );

      // Log action
      await this.auditService.log({
        groupId,
        userId: targetUserId,
        performedBy: ctx.from?.id.toString(),
        action: 'blacklist_removed',
        details: 'User removed from blacklist'
      });

    } catch (error) {
      this.logger.error('Error removing from blacklist', error);
      await ctx.reply('❌ 移除黑名单失败');
    }
  }

  private async listBlacklist(ctx: CommandContext<MyContext>, groupId: string) {
    try {
      const blacklists = await this.verificationService['blacklistRepository'].find({
        where: { groupId },
        relations: ['user'],
        order: { createdAt: 'DESC' },
        take: 50
      });

      if (blacklists.length === 0) {
        await ctx.reply('📋 黑名单为空');
        return;
      }

      // HTML + escaping: nicknames and reasons are free text and would otherwise
      // break (or forge markup in) the whole listing under Markdown.
      let message = '🚫 <b>黑名单用户</b>\n\n';
      for (const entry of blacklists) {
        const user = entry.user;
        message += `• ${escapeHtml(user.firstName)}`;
        if (user.username) {
          message += ` (@${escapeHtml(user.username)})`;
        }
        message += ` - ID: ${user.id}`;
        if (entry.reason) {
          message += `\n  原因: ${escapeHtml(entry.reason)}`;
        }
        message += '\n';
      }

      await ctx.reply(message, { parse_mode: 'HTML' });

    } catch (error) {
      this.logger.error('Error listing blacklist', error);
      await ctx.reply('❌ 获取黑名单失败');
    }
  }
}