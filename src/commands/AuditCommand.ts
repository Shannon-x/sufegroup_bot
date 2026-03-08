import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';

export class AuditCommand extends BaseCommand {
  command = 'audit';
  description = '查看审计日志';

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    if (!await this.requireAdmin(ctx)) return;

    const args = ctx.match?.toString().trim().split(/\s+/) || [];
    const subCommand = args[0]?.toLowerCase() || 'recent';
    const groupId = ctx.chat!.id.toString();

    switch (subCommand) {
      case 'recent': {
        const limit = parseInt(args[1]) || 10;
        await this.showRecentLogs(ctx, groupId, Math.min(limit, 50));
        break;
      }
      default:
        await ctx.reply('❌ 用法: /audit recent [数量]');
    }
  }

  private async showRecentLogs(ctx: CommandContext<MyContext>, groupId: string, limit: number) {
    try {
      const logs = await this.auditService.getRecentLogs(groupId, limit);

      if (logs.length === 0) {
        await ctx.reply('📋 暂无审计日志');
        return;
      }

      let message = `📋 *最近 ${logs.length} 条审计日志*\n\n`;

      for (const log of logs) {
        const time = new Date(log.createdAt).toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });

        message += `*${time}* - `;

        switch (log.action) {
          case 'user_joined':
            message += `👋 用户加入`;
            break;
          case 'user_verified':
            message += `✅ 用户验证通过`;
            break;
          case 'user_failed_verification':
            message += `❌ 用户验证失败`;
            break;
          case 'user_kicked':
            message += `🚪 用户被踢出`;
            break;
          case 'user_banned':
            message += `🚫 用户被封禁`;
            break;
          case 'user_unbanned':
            message += `✅ 用户被解封`;
            break;
          case 'user_muted':
            message += `🔇 用户被禁言`;
            break;
          case 'user_unmuted':
            message += `🔊 用户被解除禁言`;
            break;
          case 'whitelist_added':
            message += `➕ 添加白名单`;
            break;
          case 'whitelist_removed':
            message += `➖ 移除白名单`;
            break;
          case 'blacklist_added':
            message += `🚫 添加黑名单`;
            break;
          case 'blacklist_removed':
            message += `✅ 移除黑名单`;
            break;
          case 'settings_changed':
            message += `⚙️ 设置更改`;
            break;
          case 'command_executed':
            message += `💻 命令执行`;
            break;
          default:
            message += log.action;
        }

        if (log.user) {
          message += `\n  用户: ${log.user.firstName}`;
          if (log.user.username) {
            message += ` (@${log.user.username})`;
          }
        }

        if (log.performedBy) {
          const performer = await this.userService.findById(log.performedBy);
          if (performer) {
            message += `\n  操作者: ${performer.firstName}`;
            if (performer.username) {
              message += ` (@${performer.username})`;
            }
          }
        }

        if (log.details && log.action !== 'command_executed') {
          message += `\n  详情: ${log.details}`;
        }

        message += '\n\n';
      }

      // Split message if too long
      const maxLength = 4000;
      if (message.length > maxLength) {
        const messages = [];
        let currentMessage = '';
        
        for (const line of message.split('\n')) {
          if (currentMessage.length + line.length > maxLength) {
            messages.push(currentMessage);
            currentMessage = line + '\n';
          } else {
            currentMessage += line + '\n';
          }
        }
        
        if (currentMessage) {
          messages.push(currentMessage);
        }

        for (const msg of messages) {
          await ctx.reply(msg, { parse_mode: 'Markdown' });
        }
      } else {
        await ctx.reply(message, { parse_mode: 'Markdown' });
      }

    } catch (error) {
      this.logger.error('Error showing audit logs', error);
      await ctx.reply('❌ 获取审计日志失败');
    }
  }
}