import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';
import { ContentFilterService, FilterConfig } from '../services/ContentFilterService';

export class FilterCommand extends BaseCommand {
  command = 'filter';
  description = '管理内容过滤（管理员）';

  private contentFilter: ContentFilterService;

  constructor(...args: ConstructorParameters<typeof BaseCommand>) {
    super(...args);
    this.contentFilter = new ContentFilterService();
  }

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    if (!await this.requireAdmin(ctx)) return;

    const args = (ctx.match || '').toString().trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase();

    const groupId = ctx.chat!.id.toString();
    const settings = await this.groupService.getSettings(groupId);
    if (!settings) {
      await ctx.reply('❌ 群组设置不存在');
      return;
    }

    const filterConfig = this.contentFilter.getFilterConfig(settings.customSettings);

    switch (subcommand) {
      case 'on':
        await this.toggleFilter(ctx, groupId, settings, true);
        break;
      case 'off':
        await this.toggleFilter(ctx, groupId, settings, false);
        break;
      case 'add':
        await this.addKeyword(ctx, groupId, settings, filterConfig, parts.slice(1));
        break;
      case 'del':
      case 'remove':
        await this.removeKeyword(ctx, groupId, settings, filterConfig, parts.slice(1));
        break;
      case 'list':
        await this.listKeywords(ctx, filterConfig);
        break;
      case 'action':
        await this.setAction(ctx, groupId, settings, filterConfig, parts[1]);
        break;
      case 'url':
        await this.toggleOption(ctx, groupId, settings, filterConfig, 'blockUrls', parts[1]);
        break;
      case 'invite':
        await this.toggleOption(ctx, groupId, settings, filterConfig, 'blockInviteLinks', parts[1]);
        break;
      case 'phone':
        await this.toggleOption(ctx, groupId, settings, filterConfig, 'blockPhoneNumbers', parts[1]);
        break;
      case 'forward':
        await this.toggleOption(ctx, groupId, settings, filterConfig, 'blockForwards', parts[1]);
        break;
      case 'linkdelay':
        await this.setLinkDelay(ctx, groupId, settings, filterConfig, parts[1]);
        break;
      case 'allowurl':
        await this.manageWhitelistUrl(ctx, groupId, settings, filterConfig, 'add', parts.slice(1));
        break;
      case 'denyurl':
        await this.manageWhitelistUrl(ctx, groupId, settings, filterConfig, 'remove', parts.slice(1));
        break;
      case 'warnings':
        await this.setMaxWarnings(ctx, groupId, settings, filterConfig, parts[1]);
        break;
      case 'flood':
        await this.handleFloodSubcommand(ctx, groupId, settings, filterConfig, parts.slice(1));
        break;
      case 'status':
      default:
        await this.showStatus(ctx, filterConfig);
        break;
    }
  }

  private async toggleFilter(ctx: CommandContext<MyContext>, groupId: string, settings: any, enabled: boolean) {
    const filterConfig = this.contentFilter.getFilterConfig(settings.customSettings);
    filterConfig.enabled = enabled;
    await this.saveFilterConfig(groupId, settings, filterConfig);

    await ctx.reply(enabled ? '✅ 内容过滤已开启' : '⏹ 内容过滤已关闭');
    await this.auditService.log({
      groupId,
      performedBy: ctx.from?.id.toString(),
      action: 'settings_changed',
      details: `Content filter ${enabled ? 'enabled' : 'disabled'}`
    });
  }

  private async addKeyword(ctx: CommandContext<MyContext>, groupId: string, settings: any, config: FilterConfig, words: string[]) {
    if (words.length === 0) {
      await ctx.reply('用法: `/filter add 关键词1 关键词2 ...`', { parse_mode: 'Markdown' });
      return;
    }

    const added: string[] = [];
    for (const word of words) {
      const lower = word.toLowerCase();
      if (!config.customKeywords.some(k => k.toLowerCase() === lower)) {
        config.customKeywords.push(word);
        added.push(word);
      }
    }

    if (added.length === 0) {
      await ctx.reply('这些关键词已存在');
      return;
    }

    await this.saveFilterConfig(groupId, settings, config);
    await ctx.reply(`✅ 已添加 ${added.length} 个关键词: ${added.join(', ')}`);
  }

  private async removeKeyword(ctx: CommandContext<MyContext>, groupId: string, settings: any, config: FilterConfig, words: string[]) {
    if (words.length === 0) {
      await ctx.reply('用法: `/filter del 关键词1 关键词2 ...`', { parse_mode: 'Markdown' });
      return;
    }

    const removed: string[] = [];
    for (const word of words) {
      const lower = word.toLowerCase();
      const idx = config.customKeywords.findIndex(k => k.toLowerCase() === lower);
      if (idx !== -1) {
        removed.push(config.customKeywords[idx]);
        config.customKeywords.splice(idx, 1);
      }
    }

    if (removed.length === 0) {
      await ctx.reply('未找到这些关键词');
      return;
    }

    await this.saveFilterConfig(groupId, settings, config);
    await ctx.reply(`✅ 已移除 ${removed.length} 个关键词: ${removed.join(', ')}`);
  }

  private async listKeywords(ctx: CommandContext<MyContext>, config: FilterConfig) {
    if (config.customKeywords.length === 0) {
      await ctx.reply('当前没有自定义关键词\n\n使用 `/filter add 关键词` 添加', { parse_mode: 'Markdown' });
      return;
    }

    const list = config.customKeywords.map((k, i) => `${i + 1}. ${k}`).join('\n');
    await ctx.reply(`📋 *自定义关键词* (${config.customKeywords.length}个)\n\n${list}`, { parse_mode: 'Markdown' });
  }

  private async setAction(ctx: CommandContext<MyContext>, groupId: string, settings: any, config: FilterConfig, action?: string) {
    if (!action || !['warn', 'mute', 'ban'].includes(action)) {
      await ctx.reply('用法: `/filter action warn|mute|ban`\n\n• warn - 警告（累计后自动禁言）\n• mute - 直接禁言\n• ban - 直接封禁', { parse_mode: 'Markdown' });
      return;
    }

    config.action = action as 'warn' | 'mute' | 'ban';
    await this.saveFilterConfig(groupId, settings, config);
    const labels: Record<string, string> = { warn: '警告', mute: '禁言', ban: '封禁' };
    await ctx.reply(`✅ 违规处理方式已设为: ${labels[action]}`);
  }

  private async toggleOption(ctx: CommandContext<MyContext>, groupId: string, settings: any, config: FilterConfig, key: keyof FilterConfig, value?: string) {
    if (!value || !['on', 'off'].includes(value)) {
      const current = config[key] ? '开启' : '关闭';
      const labels: Record<string, string> = {
        blockUrls: '链接过滤',
        blockInviteLinks: '邀请链接过滤',
        blockPhoneNumbers: '手机号过滤',
        blockForwards: '频道转发过滤',
      };
      await ctx.reply(`${labels[key] || key} 当前: ${current}\n\n使用 \`on\` 或 \`off\` 切换`, { parse_mode: 'Markdown' });
      return;
    }

    (config as any)[key] = value === 'on';
    await this.saveFilterConfig(groupId, settings, config);
    await ctx.reply(`✅ 已${value === 'on' ? '开启' : '关闭'}`);
  }

  private async setLinkDelay(ctx: CommandContext<MyContext>, groupId: string, settings: any, config: FilterConfig, value?: string) {
    if (!value) {
      await ctx.reply(`新用户发链接延迟: ${config.newUserLinkDelay} 分钟\n\n用法: \`/filter linkdelay 分钟数\`（0=关闭）`, { parse_mode: 'Markdown' });
      return;
    }

    const minutes = parseInt(value, 10);
    if (isNaN(minutes) || minutes < 0) {
      await ctx.reply('请输入有效的分钟数');
      return;
    }

    config.newUserLinkDelay = minutes;
    await this.saveFilterConfig(groupId, settings, config);
    await ctx.reply(minutes === 0 ? '✅ 新用户链接限制已关闭' : `✅ 新用户入群 ${minutes} 分钟内禁止发链接`);
  }

  private async manageWhitelistUrl(ctx: CommandContext<MyContext>, groupId: string, settings: any, config: FilterConfig, action: 'add' | 'remove', domains: string[]) {
    if (domains.length === 0) {
      const list = config.whitelistUrls.length > 0
        ? config.whitelistUrls.join(', ')
        : '（空）';
      await ctx.reply(`📋 URL白名单: ${list}\n\n\`/filter allowurl 域名\` 添加\n\`/filter denyurl 域名\` 移除`, { parse_mode: 'Markdown' });
      return;
    }

    if (action === 'add') {
      for (const d of domains) {
        if (!config.whitelistUrls.includes(d)) {
          config.whitelistUrls.push(d);
        }
      }
      await this.saveFilterConfig(groupId, settings, config);
      await ctx.reply(`✅ 已添加到URL白名单: ${domains.join(', ')}`);
    } else {
      config.whitelistUrls = config.whitelistUrls.filter(u => !domains.includes(u));
      await this.saveFilterConfig(groupId, settings, config);
      await ctx.reply(`✅ 已从URL白名单移除: ${domains.join(', ')}`);
    }
  }

  private async setMaxWarnings(ctx: CommandContext<MyContext>, groupId: string, settings: any, config: FilterConfig, value?: string) {
    if (!value) {
      await ctx.reply(`最大警告次数: ${config.maxWarnings}\n\n用法: \`/filter warnings 次数\``, { parse_mode: 'Markdown' });
      return;
    }

    const n = parseInt(value, 10);
    if (isNaN(n) || n < 1 || n > 20) {
      await ctx.reply('请输入 1-20 之间的数字');
      return;
    }

    config.maxWarnings = n;
    await this.saveFilterConfig(groupId, settings, config);
    await ctx.reply(`✅ 最大警告次数已设为 ${n}`);
  }

  private async handleFloodSubcommand(ctx: CommandContext<MyContext>, groupId: string, settings: any, config: FilterConfig, args: string[]) {
    const sub = args[0]?.toLowerCase();
    const flood = config.flood;

    switch (sub) {
      case 'on':
        flood.enabled = true;
        await this.saveFilterConfig(groupId, settings, config);
        await ctx.reply('✅ 防刷屏已开启');
        await this.auditService.log({
          groupId,
          performedBy: ctx.from?.id.toString(),
          action: 'settings_changed',
          details: 'Flood control enabled'
        });
        break;

      case 'off':
        flood.enabled = false;
        await this.saveFilterConfig(groupId, settings, config);
        await ctx.reply('⏹ 防刷屏已关闭');
        await this.auditService.log({
          groupId,
          performedBy: ctx.from?.id.toString(),
          action: 'settings_changed',
          details: 'Flood control disabled'
        });
        break;

      case 'limit': {
        const maxMsg = parseInt(args[1], 10);
        const windowSec = parseInt(args[2], 10);
        if (!maxMsg || !windowSec || maxMsg < 3 || maxMsg > 100 || windowSec < 5 || windowSec > 300) {
          await ctx.reply(
            `当前限制: ${flood.maxMessages} 条 / ${flood.windowSeconds} 秒\n\n` +
            `用法: \`/filter flood limit <条数> <秒数>\`\n` +
            `条数范围: 3-100, 秒数范围: 5-300\n` +
            `例: \`/filter flood limit 8 10\` → 10秒内最多8条`,
            { parse_mode: 'Markdown' }
          );
          return;
        }
        flood.maxMessages = maxMsg;
        flood.windowSeconds = windowSec;
        await this.saveFilterConfig(groupId, settings, config);
        await ctx.reply(`✅ 防刷屏限制: ${maxMsg} 条 / ${windowSec} 秒`);
        break;
      }

      case 'action': {
        const action = args[1]?.toLowerCase();
        if (!action || !['warn', 'mute', 'ban'].includes(action)) {
          await ctx.reply(
            `当前处理方式: ${flood.action}\n\n` +
            `用法: \`/filter flood action warn|mute|ban\`\n` +
            `• warn - 警告（仅删除消息+提醒）\n` +
            `• mute - 禁言（默认）\n` +
            `• ban - 封禁`,
            { parse_mode: 'Markdown' }
          );
          return;
        }
        flood.action = action as 'warn' | 'mute' | 'ban';
        await this.saveFilterConfig(groupId, settings, config);
        const labels: Record<string, string> = { warn: '警告', mute: '禁言', ban: '封禁' };
        await ctx.reply(`✅ 防刷屏处理方式: ${labels[action]}`);
        break;
      }

      case 'mute': {
        const dur = parseInt(args[1], 10);
        if (!dur || dur < 1 || dur > 1440) {
          await ctx.reply(
            `当前禁言时长: ${flood.muteDuration} 分钟\n\n` +
            `用法: \`/filter flood mute <分钟数>\`（1-1440）`,
            { parse_mode: 'Markdown' }
          );
          return;
        }
        flood.muteDuration = dur;
        await this.saveFilterConfig(groupId, settings, config);
        await ctx.reply(`✅ 刷屏禁言时长: ${dur} 分钟`);
        break;
      }

      default: {
        const on = '🟢';
        const off = '⚫';
        const actionLabels: Record<string, string> = { warn: '警告', mute: '禁言', ban: '封禁' };

        let text = `🌊 *防刷屏设置*\n\n`;
        text += `状态: ${flood.enabled ? on + ' 已开启' : off + ' 已关闭'}\n`;
        text += `限制: ${flood.maxMessages} 条 / ${flood.windowSeconds} 秒\n`;
        text += `处理: ${actionLabels[flood.action]}\n`;
        text += `禁言时长: ${flood.muteDuration} 分钟\n`;
        text += `删除超限消息: ${flood.deleteExcess ? '是' : '否'}\n\n`;
        text += `*命令*\n`;
        text += `\`/filter flood on\` - 开启\n`;
        text += `\`/filter flood off\` - 关闭\n`;
        text += `\`/filter flood limit 10 10\` - 10秒内最多10条\n`;
        text += `\`/filter flood action mute\` - 处理方式\n`;
        text += `\`/filter flood mute 5\` - 禁言时长`;

        await ctx.reply(text, { parse_mode: 'Markdown' });
        break;
      }
    }
  }

  private async showStatus(ctx: CommandContext<MyContext>, config: FilterConfig) {
    const on = '🟢';
    const off = '⚫';
    const actionLabels: Record<string, string> = { warn: '警告', mute: '禁言', ban: '封禁' };

    let text = `🛡 *内容过滤设置*\n\n`;
    text += `状态: ${config.enabled ? on + ' 已开启' : off + ' 已关闭'}\n\n`;
    text += `*过滤规则*\n`;
    text += `${config.blockUrls ? on : off} 链接过滤 (\`/filter url\`)\n`;
    text += `${config.blockInviteLinks ? on : off} 邀请链接过滤 (\`/filter invite\`)\n`;
    text += `${config.blockPhoneNumbers ? on : off} 手机号过滤 (\`/filter phone\`)\n`;
    text += `${config.blockForwards ? on : off} 频道转发过滤 (\`/filter forward\`)\n`;
    text += `⏱ 新用户链接延迟: ${config.newUserLinkDelay}分钟\n\n`;
    text += `*违规处理*\n`;
    text += `处理方式: ${actionLabels[config.action]}\n`;
    text += `最大警告: ${config.maxWarnings}次\n`;
    text += `禁言时长: ${config.muteDuration}分钟\n\n`;
    text += `*自定义关键词*: ${config.customKeywords.length}个\n`;
    text += `*URL白名单*: ${config.whitelistUrls.length}个\n\n`;
    const floodStatus = config.flood.enabled
      ? `${on} ${config.flood.maxMessages}条/${config.flood.windowSeconds}秒`
      : off + ' 已关闭';
    text += `🌊 *防刷屏*: ${floodStatus} (\`/filter flood\`)\n\n`;
    text += `使用 \`/filter on\` 开启, \`/filter off\` 关闭`;

    await ctx.reply(text, { parse_mode: 'Markdown' });
  }

  private async saveFilterConfig(groupId: string, settings: any, config: FilterConfig) {
    const customSettings = settings.customSettings || {};
    customSettings.filter = config;
    await this.groupService.updateSettings(groupId, { customSettings });
  }
}
