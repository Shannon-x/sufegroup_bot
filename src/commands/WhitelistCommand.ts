import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';
import { escapeHtml } from '../utils/markdown';

export class WhitelistCommand extends BaseCommand {
  command = 'whitelist';
  description = '管理白名单';

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    if (!await this.requireGroup(ctx)) return;

    const subCommand = this.commandArgs(ctx).split(/\s+/)[0]?.toLowerCase();
    const groupId = ctx.chat!.id.toString();

    switch (subCommand) {
      case 'add':
      case 'remove': {
        // A whitelist entry waives join verification for that account entirely,
        // so it needs the same moderation right as /blacklist rather than bare
        // administrator status (Telegram allows admins with zero rights).
        if (!await this.requireAdmin(ctx, ['can_restrict_members'])) return;
        if (subCommand === 'add') await this.addToWhitelist(ctx, groupId);
        else await this.removeFromWhitelist(ctx, groupId);
        break;
      }
      case 'list':
        // Read-only: plain administrator status is enough.
        if (!await this.requireAdmin(ctx)) return;
        await this.listWhitelist(ctx, groupId);
        break;
      default:
        if (!await this.requireAdmin(ctx)) return;
        await ctx.reply(
          '❌ 用法:\n' +
          '/whitelist add @用户 - 添加白名单\n' +
          '/whitelist remove @用户 - 移除白名单\n' +
          '/whitelist list - 查看白名单\n' +
          '（也可回复某人的消息后使用 /whitelist add）'
        );
    }
  }

  private async addToWhitelist(ctx: CommandContext<MyContext>, groupId: string) {
    // skipTokens = 1 drops the "add" sub-command; without it parseUserTarget
    // read "add" as the target and no user could ever be resolved.
    const { userId: targetUserId, username } = await this.resolveTarget(ctx, 1);

    if (!targetUserId) {
      await ctx.reply(
        username
          ? `❌ 无法找到用户 @${username}\n请确保该用户曾在本群发言，或改用回复其消息的方式`
          : '❌ 请指定要添加到白名单的用户'
      );
      return;
    }

    try {
      // Check if already whitelisted
      if (await this.verificationService.isWhitelisted(targetUserId, groupId)) {
        await ctx.reply('⚠️ 该用户已在白名单中');
        return;
      }

      // Add to whitelist
      await this.verificationService.addToWhitelist(
        targetUserId,
        groupId,
        ctx.from!.id.toString()
      );

      const targetUser = await this.userService.findById(targetUserId);
      await ctx.reply(
        `✅ 已将 ${targetUser?.firstName || '未知用户'}` +
        (targetUser?.username ? ` (@${targetUser.username})` : '') +
        ' 添加到白名单'
      );

      // Log action
      await this.auditService.log({
        groupId,
        userId: targetUserId,
        performedBy: ctx.from?.id.toString(),
        action: 'whitelist_added',
        details: 'User added to whitelist'
      });

    } catch (error) {
      this.logger.error('Error adding to whitelist', error);
      await ctx.reply('❌ 添加白名单失败');
    }
  }

  private async removeFromWhitelist(ctx: CommandContext<MyContext>, groupId: string) {
    const { userId: targetUserId, username } = await this.resolveTarget(ctx, 1);

    if (!targetUserId) {
      await ctx.reply(
        username
          ? `❌ 无法找到用户 @${username}\n请确保该用户曾在本群发言，或改用回复其消息的方式`
          : '❌ 请指定要从白名单移除的用户'
      );
      return;
    }

    try {
      const removed = await this.verificationService.removeFromWhitelist(targetUserId, groupId);

      if (!removed) {
        await ctx.reply('⚠️ 该用户不在白名单中');
        return;
      }

      const targetUser = await this.userService.findById(targetUserId);
      await ctx.reply(
        `✅ 已将 ${targetUser?.firstName || '未知用户'}` +
        (targetUser?.username ? ` (@${targetUser.username})` : '') +
        ' 从白名单移除'
      );

      // Log action
      await this.auditService.log({
        groupId,
        userId: targetUserId,
        performedBy: ctx.from?.id.toString(),
        action: 'whitelist_removed',
        details: 'User removed from whitelist'
      });

    } catch (error) {
      this.logger.error('Error removing from whitelist', error);
      await ctx.reply('❌ 移除白名单失败');
    }
  }

  private async listWhitelist(ctx: CommandContext<MyContext>, groupId: string) {
    try {
      const whitelists = await this.verificationService['whitelistRepository'].find({
        where: { groupId },
        relations: ['user'],
        order: { createdAt: 'DESC' },
        take: 50
      });

      if (whitelists.length === 0) {
        await ctx.reply('📋 白名单为空');
        return;
      }

      // HTML + escaping: a nickname containing `_`/`*` used to make Telegram
      // reject the whole listing under Markdown.
      let message = '📋 <b>白名单用户</b>\n\n';
      for (const entry of whitelists) {
        const user = entry.user;
        message += `• ${escapeHtml(user.firstName)}`;
        if (user.username) {
          message += ` (@${escapeHtml(user.username)})`;
        }
        message += ` - ID: ${user.id}\n`;
      }

      await ctx.reply(message, { parse_mode: 'HTML' });

    } catch (error) {
      this.logger.error('Error listing whitelist', error);
      await ctx.reply('❌ 获取白名单失败');
    }
  }
}