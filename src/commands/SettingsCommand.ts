import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';
import { GroupSettings } from '../entities/GroupSettings';

export class SettingsCommand extends BaseCommand {
  command = 'settings';
  description = '管理群组设置';

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    if (!await this.requireAdmin(ctx)) return;

    const args = ctx.match?.toString().trim().split(/\s+/) || [];
    const subCommand = args[0]?.toLowerCase();
    const groupId = ctx.chat!.id.toString();

    switch (subCommand) {
      case 'show':
        await this.showSettings(ctx, groupId);
        break;
      case 'set':
        await this.setSetting(ctx, groupId, args.slice(1));
        break;
      default:
        await ctx.reply(
          '❌ 用法:\n' +
          '/settings show - 显示当前设置\n' +
          '/settings set <key> <value> - 修改设置'
        );
    }
  }

  private async showSettings(ctx: CommandContext<MyContext>, groupId: string) {
    try {
      const settings = await this.groupService.getSettings(groupId);
      if (!settings) {
        await ctx.reply('❌ 无法获取群组设置');
        return;
      }

      const text = `⚙️ *当前群组设置*\n\n` +
        `• 验证功能: ${settings.verificationEnabled ? '✅ 启用' : '❌ 禁用'}\n` +
        `• 验证超时: ${settings.ttlMinutes} 分钟\n` +
        `• 超时操作: ${settings.autoAction === 'kick' ? '踢出' : '禁言'}\n` +
        `• 删除入群消息: ${settings.deleteJoinMessage ? '是' : '否'}\n` +
        `• 删除欢迎消息: ${settings.deleteWelcomeMessage ? '是' : '否'}\n` +
        `• 欢迎消息延迟删除: ${settings.deleteWelcomeMessageAfter} 秒\n` +
        `• 速率限制: ${settings.rateLimitPerMinute} 次/分钟\n` +
        `• 管理员免验证: ${settings.adminBypassVerification ? '是' : '否'}\n\n` +
        `• 欢迎消息模板:\n\`${settings.welcomeTemplate}\``;

      await ctx.reply(text, { parse_mode: 'Markdown' });

      await this.auditService.log({
        groupId,
        performedBy: ctx.from?.id.toString(),
        action: 'command_executed',
        details: 'settings show'
      });

    } catch (error) {
      this.logger.error('Error showing settings', error);
      await ctx.reply('❌ 获取设置时出错');
    }
  }

  private async setSetting(ctx: CommandContext<MyContext>, groupId: string, args: string[]) {
    if (args.length < 2) {
      await ctx.reply('❌ 用法: /settings set <key> <value>');
      return;
    }

    const key = args[0];
    const value = args.slice(1).join(' ');

    try {
      const updates: Partial<GroupSettings> = {};

      switch (key) {
        case 'verificationEnabled':
          if (!['true', 'false'].includes(value.toLowerCase())) {
            await ctx.reply('❌ 值必须是 true 或 false');
            return;
          }
          updates.verificationEnabled = value.toLowerCase() === 'true';
          break;

        case 'ttlMinutes':
          const ttl = parseInt(value);
          if (isNaN(ttl) || ttl < 1 || ttl > 1440) {
            await ctx.reply('❌ 值必须是 1-1440 之间的数字（分钟）');
            return;
          }
          updates.ttlMinutes = ttl;
          break;

        case 'autoAction':
          if (!['mute', 'kick'].includes(value.toLowerCase())) {
            await ctx.reply('❌ 值必须是 mute 或 kick');
            return;
          }
          updates.autoAction = value.toLowerCase() as 'mute' | 'kick';
          break;

        case 'welcomeTemplate':
          if (value.length > 1000) {
            await ctx.reply('❌ 欢迎消息不能超过 1000 个字符');
            return;
          }
          updates.welcomeTemplate = value;
          break;

        case 'deleteJoinMessage':
          if (!['true', 'false'].includes(value.toLowerCase())) {
            await ctx.reply('❌ 值必须是 true 或 false');
            return;
          }
          updates.deleteJoinMessage = value.toLowerCase() === 'true';
          break;

        case 'deleteWelcomeMessage':
          if (!['true', 'false'].includes(value.toLowerCase())) {
            await ctx.reply('❌ 值必须是 true 或 false');
            return;
          }
          updates.deleteWelcomeMessage = value.toLowerCase() === 'true';
          break;

        case 'deleteWelcomeMessageAfter':
          const delay = parseInt(value);
          if (isNaN(delay) || delay < 0 || delay > 3600) {
            await ctx.reply('❌ 值必须是 0-3600 之间的数字（秒）');
            return;
          }
          updates.deleteWelcomeMessageAfter = delay;
          break;

        case 'rateLimitPerMinute':
          const limit = parseInt(value);
          if (isNaN(limit) || limit < 1 || limit > 100) {
            await ctx.reply('❌ 值必须是 1-100 之间的数字');
            return;
          }
          updates.rateLimitPerMinute = limit;
          break;

        case 'adminBypassVerification':
          if (!['true', 'false'].includes(value.toLowerCase())) {
            await ctx.reply('❌ 值必须是 true 或 false');
            return;
          }
          updates.adminBypassVerification = value.toLowerCase() === 'true';
          break;

        default:
          await ctx.reply('❌ 未知的设置项: ' + key);
          return;
      }

      await this.groupService.updateSettings(groupId, updates);
      await ctx.reply(`✅ 已更新设置: ${key} = ${value}`);

      await this.auditService.log({
        groupId,
        performedBy: ctx.from?.id.toString(),
        action: 'settings_changed',
        details: `Set ${key} = ${value}`,
        metadata: { key, value }
      });

    } catch (error) {
      this.logger.error('Error setting configuration', error);
      await ctx.reply('❌ 更新设置时出错');
    }
  }
}