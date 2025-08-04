import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';

export class StatsCommand extends BaseCommand {
  command = 'stats';
  description = '查看群组统计信息';

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    if (!await this.requireGroup(ctx)) return;

    const groupId = ctx.chat!.id.toString();
    const isAdmin = await this.isAdmin(ctx);

    try {
      // Get basic stats
      const [joinCount7d, joinCount30d, verificationStats7d, verificationStats30d] = await Promise.all([
        this.auditService.getUserJoinCount(groupId, 7),
        this.auditService.getUserJoinCount(groupId, 30),
        this.auditService.getVerificationStats(groupId, 7),
        this.auditService.getVerificationStats(groupId, 30),
      ]);

      let message = `📊 *群组统计信息*\n\n`;

      // Join statistics
      message += `👥 *加入统计*\n`;
      message += `• 最近 7 天: ${joinCount7d} 人\n`;
      message += `• 最近 30 天: ${joinCount30d} 人\n\n`;

      // Verification statistics
      message += `✅ *验证统计*\n`;
      message += `*最近 7 天:*\n`;
      message += `• 总人数: ${verificationStats7d.total}\n`;
      message += `• 通过验证: ${verificationStats7d.verified}\n`;
      message += `• 验证失败: ${verificationStats7d.failed}\n`;
      message += `• 通过率: ${verificationStats7d.rate.toFixed(1)}%\n\n`;

      message += `*最近 30 天:*\n`;
      message += `• 总人数: ${verificationStats30d.total}\n`;
      message += `• 通过验证: ${verificationStats30d.verified}\n`;
      message += `• 验证失败: ${verificationStats30d.failed}\n`;
      message += `• 通过率: ${verificationStats30d.rate.toFixed(1)}%\n`;

      if (isAdmin) {
        // Get whitelist and blacklist counts
        const [whitelistCount, blacklistCount] = await Promise.all([
          this.verificationService['whitelistRepository'].count({ where: { groupId } }),
          this.verificationService['blacklistRepository'].count({ where: { groupId } }),
        ]);

        message += `\n📋 *名单统计*\n`;
        message += `• 白名单用户: ${whitelistCount}\n`;
        message += `• 黑名单用户: ${blacklistCount}\n`;

        // Get current settings
        const settings = await this.groupService.getSettings(groupId);
        if (settings) {
          message += `\n⚙️ *当前设置*\n`;
          message += `• 验证功能: ${settings.verificationEnabled ? '启用' : '禁用'}\n`;
          message += `• 验证超时: ${settings.ttlMinutes} 分钟\n`;
          message += `• 超时操作: ${settings.autoAction === 'kick' ? '踢出' : '禁言'}\n`;
        }
      }

      await ctx.reply(message, { parse_mode: 'Markdown' });

      // Log command execution
      await this.auditService.log({
        groupId,
        performedBy: ctx.from?.id.toString(),
        action: 'command_executed',
        details: 'stats command'
      });

    } catch (error) {
      this.logger.error('Error getting stats', error);
      await ctx.reply('❌ 获取统计信息失败');
    }
  }
}