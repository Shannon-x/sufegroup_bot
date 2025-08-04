import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';

export class HelpCommand extends BaseCommand {
  command = 'help';
  description = '显示帮助信息';

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    const isGroup = ctx.chat?.type !== 'private';
    const isAdmin = isGroup ? await this.isAdmin(ctx) : false;

    let helpText = `🤖 *小菲群组管理机器人*\n\n`;
    
    helpText += `📌 *可用命令*\n`;
    helpText += `/help - 显示此帮助信息\n`;
    helpText += `/stats - 查看群组统计信息\n\n`;

    if (isAdmin) {
      helpText += `👮 *管理员命令*\n`;
      helpText += `/settings - 查看和修改群组设置\n`;
      helpText += `/kick @用户 [原因] - 踢出用户\n`;
      helpText += `/ban @用户 [时长] [原因] - 封禁用户\n`;
      helpText += `/unban @用户 - 解封用户\n`;
      helpText += `/mute @用户 [时长] - 禁言用户\n`;
      helpText += `/unmute @用户 - 解除禁言\n\n`;
      
      helpText += `⚙️ *设置说明*\n`;
      helpText += `使用 /settings 命令可以配置：\n`;
      helpText += `• 验证超时时间\n`;
      helpText += `• 超时后的处理方式\n`;
      helpText += `• 欢迎消息内容\n`;
      helpText += `• 其他高级选项\n\n`;
      
      helpText += `⏱ *时长格式*\n`;
      helpText += `• 5m = 5分钟\n`;
      helpText += `• 2h = 2小时\n`;
      helpText += `• 1d = 1天\n`;
      helpText += `• 不指定 = 永久\n`;
    }

    helpText += `\n💡 *使用说明*\n`;
    helpText += `1. 将机器人添加到群组\n`;
    helpText += `2. 授予管理员权限\n`;
    helpText += `3. 新成员加入时会自动触发验证\n`;
    helpText += `4. 未完成验证的用户将被限制发言\n`;

    await ctx.reply(helpText, { 
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true }
    });

    // Only log if in a group chat
    if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
      try {
        // Ensure group exists in database
        const chat = ctx.chat;
        await this.groupService.findOrCreate(chat);
        
        await this.auditService.log({
          groupId: ctx.chat.id.toString(),
          performedBy: ctx.from?.id.toString(),
          action: 'command_executed',
          details: 'help command'
        });
      } catch (error) {
        // Ignore audit log errors for help command
      }
    }
  }
}