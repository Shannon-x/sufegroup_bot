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

    // HTML, not legacy Markdown: the rest of the bot standardised on HTML and
    // this text mixes `*` with `_`-bearing command names, which legacy Markdown
    // can reject outright (400 can't parse entities) — the help text is the one
    // message that must never fail to render.
    let helpText = `🤖 <b>小菲群组管理机器人</b>\n\n`;

    helpText += `📌 <b>可用命令</b>\n`;
    helpText += `/help - 显示此帮助信息\n`;
    helpText += `/stats - 查看群组统计信息\n`;
    helpText += `/checkin - 每日签到领积分\n`;
    helpText += `/profile - 查看个人等级和资料\n`;
    helpText += `/rank - 活跃排行榜\n`;
    helpText += `/verify - 重新获取自己的验证链接\n\n`;
    helpText += `🎰 <b>抽奖系统</b>\n`;
    helpText += `/lottery - 抽奖帮助\n`;
    helpText += `/lottery list - 查看进行中的抽奖\n`;
    helpText += `/join [ID] - 参与抽奖\n\n`;

    if (isAdmin) {
      helpText += `👮 <b>管理员命令</b>\n`;
      helpText += `/settings - 查看和修改群组设置\n`;
      helpText += `/kick @用户 [原因] - 踢出用户\n`;
      helpText += `/ban @用户 [时长] [原因] - 封禁用户\n`;
      helpText += `/spam - 回复广告消息：删除 + 封禁发送者 + 记录样本\n`;
      helpText += `/unban @用户 - 解封用户\n`;
      helpText += `/mute @用户 [时长] - 禁言用户\n`;
      helpText += `/unmute @用户 - 解除禁言\n\n`;

      helpText += `🔐 <b>验证与名单</b>\n`;
      helpText += `/reverify @用户 - 为该用户重发验证链接\n`;
      helpText += `/whitelist add|remove|list @用户 - 白名单\n`;
      helpText += `/blacklist add|remove|list @用户 [原因] - 黑名单\n`;
      helpText += `/audit recent [数量] - 查看审计日志\n\n`;

      helpText += `🛡 <b>内容过滤</b>\n`;
      helpText += `/filter - 查看过滤状态\n`;
      helpText += `/filter on|off - 开关过滤\n`;
      helpText += `/filter add 词1 词2 - 添加关键词\n`;
      helpText += `/filter del 词1 - 删除关键词\n`;
      helpText += `/filter list - 查看关键词列表\n`;
      helpText += `/filter action warn|mute|ban - 违规处理\n`;
      helpText += `/filter url|invite|phone|forward on|off\n`;
      helpText += `/filter flood - 防刷屏设置\n`;
      helpText += `/filter flood on|off - 开关防刷屏\n`;
      helpText += `/filter flood limit 10 10 - 频率限制\n\n`;

      helpText += `⚙️ <b>设置说明</b>\n`;
      helpText += `使用 /settings 命令可以配置：\n`;
      helpText += `• 验证超时时间\n`;
      helpText += `• 超时后的处理方式\n`;
      helpText += `• 欢迎消息内容\n`;
      helpText += `• 其他高级选项\n\n`;
      
      helpText += `⏱ <b>时长格式</b>\n`;
      helpText += `• 5m = 5分钟\n`;
      helpText += `• 2h = 2小时\n`;
      helpText += `• 1d = 1天\n`;
      helpText += `• 不指定 = 永久\n`;
    }

    helpText += `\n💡 <b>使用说明</b>\n`;
    helpText += `1. 将机器人添加到群组\n`;
    helpText += `2. 授予管理员权限\n`;
    helpText += `3. 新成员加入时会自动触发验证\n`;
    helpText += `4. 未完成验证的用户将被限制发言\n`;

    await ctx.reply(helpText, { 
      parse_mode: 'HTML',
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