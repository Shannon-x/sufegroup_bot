import { CommandContext } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';
import { ContentFilterService } from '../services/ContentFilterService';
import { LevelService } from '../services/LevelService';
import { config } from '../config/config';

/**
 * Admin panel with inline keyboard buttons.
 * Handles /admin command and all callback queries starting with 'ap:'.
 */
export class AdminPanelCommand extends BaseCommand {
  command = 'admin';
  description = '管理面板';

  private contentFilter: ContentFilterService;

  constructor(...args: ConstructorParameters<typeof BaseCommand>) {
    super(...args);
    this.contentFilter = new ContentFilterService();
  }

  setup() {
    this.bot.command(this.command, async (ctx) => this.showMainMenu(ctx));

    // Handle all admin panel callback queries
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (!data.startsWith('ap:')) return;

      // Verify admin
      const chatId = ctx.callbackQuery.message?.chat?.id;
      if (!chatId) return;

      const userId = ctx.from.id;
      try {
        const member = await ctx.api.getChatMember(chatId, userId);
        if (member.status !== 'administrator' && member.status !== 'creator') {
          await ctx.answerCallbackQuery({ text: '❌ 需要管理员权限', show_alert: true });
          return;
        }
      } catch {
        await ctx.answerCallbackQuery({ text: '❌ 权限检查失败' });
        return;
      }

      const groupId = chatId.toString();
      const action = data.substring(3); // Remove 'ap:' prefix

      try {
        await this.handleCallback(ctx, groupId, action);
      } catch (error) {
        this.logger.error('Admin panel callback error', error);
        await ctx.answerCallbackQuery({ text: '❌ 操作失败' });
      }
    });
  }

  private async showMainMenu(ctx: CommandContext<MyContext>) {
    if (!await this.requireAdmin(ctx)) return;

    const groupId = ctx.chat!.id.toString();
    const settings = await this.groupService.getSettings(groupId);
    if (!settings) return;

    const filterConfig = this.contentFilter.getFilterConfig(settings.customSettings);
    const on = '✅';
    const off = '❌';

    const keyboard = new InlineKeyboard()
      .text(`${settings.verificationEnabled ? on : off} 入群验证`, 'ap:toggle_verify')
      .text(`${filterConfig.enabled ? on : off} 内容过滤`, 'ap:toggle_filter').row()
      .text(`${filterConfig.flood.enabled ? on : off} 防刷屏`, 'ap:toggle_flood')
      .text('⏱ 验证时长', 'ap:menu_ttl').row()
      .text('🛡 过滤设置', 'ap:menu_filter')
      .text('🌊 刷屏设置', 'ap:menu_flood').row()
      .text('🏷 自定义称号', 'ap:menu_titles')
      .text('📊 群组统计', 'ap:show_stats').row();

    // Mini App button if webhook domain is configured
    if (config.bot.webhookDomain) {
      keyboard.webApp('📱 管理面板', `${config.bot.webhookDomain}/mini-app`);
    }

    await ctx.reply('⚙️ *管理面板*\n\n点击按钮快速切换设置：', {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }

  private async handleCallback(ctx: any, groupId: string, action: string) {
    const settings = await this.groupService.getSettings(groupId);
    if (!settings) return;

    const filterConfig = this.contentFilter.getFilterConfig(settings.customSettings);

    // ── Quick toggles ──
    if (action === 'toggle_verify') {
      await this.groupService.updateSettings(groupId, { verificationEnabled: !settings.verificationEnabled });
      await ctx.answerCallbackQuery({ text: `入群验证已${!settings.verificationEnabled ? '开启' : '关闭'}` });
      await this.refreshMainMenu(ctx, groupId);
      return;
    }

    if (action === 'toggle_filter') {
      filterConfig.enabled = !filterConfig.enabled;
      await this.saveFilterConfig(groupId, settings, filterConfig);
      await ctx.answerCallbackQuery({ text: `内容过滤已${filterConfig.enabled ? '开启' : '关闭'}` });
      await this.refreshMainMenu(ctx, groupId);
      return;
    }

    if (action === 'toggle_flood') {
      filterConfig.flood.enabled = !filterConfig.flood.enabled;
      await this.saveFilterConfig(groupId, settings, filterConfig);
      await ctx.answerCallbackQuery({ text: `防刷屏已${filterConfig.flood.enabled ? '开启' : '关闭'}` });
      await this.refreshMainMenu(ctx, groupId);
      return;
    }

    // ── Sub-menus ──
    if (action === 'menu_ttl') {
      const keyboard = new InlineKeyboard()
        .text('3 分钟', 'ap:set_ttl_3').text('5 分钟', 'ap:set_ttl_5').text('10 分钟', 'ap:set_ttl_10').row()
        .text('15 分钟', 'ap:set_ttl_15').text('30 分钟', 'ap:set_ttl_30').row()
        .text('◀ 返回', 'ap:back');

      await ctx.editMessageText(`⏱ *验证时长设置*\n\n当前: ${settings.ttlMinutes} 分钟\n\n选择新的验证超时时间:`, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
      await ctx.answerCallbackQuery();
      return;
    }

    if (action.startsWith('set_ttl_')) {
      const ttl = parseInt(action.substring(8), 10);
      await this.groupService.updateSettings(groupId, { ttlMinutes: ttl });
      await ctx.answerCallbackQuery({ text: `验证时长已设为 ${ttl} 分钟` });
      await this.refreshMainMenu(ctx, groupId);
      return;
    }

    if (action === 'menu_filter') {
      const on = '✅', off = '❌';
      const keyboard = new InlineKeyboard()
        .text(`${filterConfig.blockUrls ? on : off} 链接`, 'ap:ft_urls')
        .text(`${filterConfig.blockInviteLinks ? on : off} 邀请链接`, 'ap:ft_invite').row()
        .text(`${filterConfig.blockPhoneNumbers ? on : off} 手机号`, 'ap:ft_phone')
        .text(`${filterConfig.blockForwards ? on : off} 频道转发`, 'ap:ft_forward').row()
        .text(`处理: ${filterConfig.action}`, 'ap:ft_action')
        .text(`警告上限: ${filterConfig.maxWarnings}`, 'ap:ft_warn').row()
        .text('◀ 返回', 'ap:back');

      await ctx.editMessageText('🛡 *内容过滤设置*\n\n点击切换开关:', {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
      await ctx.answerCallbackQuery();
      return;
    }

    if (action === 'ft_urls') { filterConfig.blockUrls = !filterConfig.blockUrls; await this.saveFilterConfig(groupId, settings, filterConfig); await ctx.answerCallbackQuery({ text: `链接过滤已${filterConfig.blockUrls ? '开启' : '关闭'}` }); await this.handleCallback(ctx, groupId, 'menu_filter'); return; }
    if (action === 'ft_invite') { filterConfig.blockInviteLinks = !filterConfig.blockInviteLinks; await this.saveFilterConfig(groupId, settings, filterConfig); await ctx.answerCallbackQuery({ text: `邀请链接过滤已${filterConfig.blockInviteLinks ? '开启' : '关闭'}` }); await this.handleCallback(ctx, groupId, 'menu_filter'); return; }
    if (action === 'ft_phone') { filterConfig.blockPhoneNumbers = !filterConfig.blockPhoneNumbers; await this.saveFilterConfig(groupId, settings, filterConfig); await ctx.answerCallbackQuery({ text: `手机号过滤已${filterConfig.blockPhoneNumbers ? '开启' : '关闭'}` }); await this.handleCallback(ctx, groupId, 'menu_filter'); return; }
    if (action === 'ft_forward') { filterConfig.blockForwards = !filterConfig.blockForwards; await this.saveFilterConfig(groupId, settings, filterConfig); await ctx.answerCallbackQuery({ text: `频道转发过滤已${filterConfig.blockForwards ? '开启' : '关闭'}` }); await this.handleCallback(ctx, groupId, 'menu_filter'); return; }

    if (action === 'ft_action') {
      const next: Record<string, string> = { warn: 'mute', mute: 'ban', ban: 'warn' };
      filterConfig.action = next[filterConfig.action] as any;
      await this.saveFilterConfig(groupId, settings, filterConfig);
      await ctx.answerCallbackQuery({ text: `处理方式: ${filterConfig.action}` });
      await this.handleCallback(ctx, groupId, 'menu_filter');
      return;
    }

    if (action === 'ft_warn') {
      const nextVal = filterConfig.maxWarnings >= 10 ? 3 : filterConfig.maxWarnings + 1;
      filterConfig.maxWarnings = nextVal;
      await this.saveFilterConfig(groupId, settings, filterConfig);
      await ctx.answerCallbackQuery({ text: `警告上限: ${nextVal}` });
      await this.handleCallback(ctx, groupId, 'menu_filter');
      return;
    }

    if (action === 'menu_flood') {
      const f = filterConfig.flood;
      const keyboard = new InlineKeyboard()
        .text(`限制: ${f.maxMessages}条/${f.windowSeconds}秒`, 'ap:flood_cycle').row()
        .text(`处理: ${f.action}`, 'ap:flood_action')
        .text(`禁言: ${f.muteDuration}分钟`, 'ap:flood_mute').row()
        .text('◀ 返回', 'ap:back');

      await ctx.editMessageText('🌊 *防刷屏设置*\n\n点击调整:', {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
      await ctx.answerCallbackQuery();
      return;
    }

    if (action === 'flood_cycle') {
      // Cycle through presets: 10/10 → 8/10 → 5/10 → 15/10 → 10/10
      const presets = [[10,10],[8,10],[5,10],[15,10],[20,15]];
      const current = presets.findIndex(p => p[0] === filterConfig.flood.maxMessages && p[1] === filterConfig.flood.windowSeconds);
      const next = presets[(current + 1) % presets.length];
      filterConfig.flood.maxMessages = next[0];
      filterConfig.flood.windowSeconds = next[1];
      await this.saveFilterConfig(groupId, settings, filterConfig);
      await ctx.answerCallbackQuery({ text: `${next[0]}条/${next[1]}秒` });
      await this.handleCallback(ctx, groupId, 'menu_flood');
      return;
    }

    if (action === 'flood_action') {
      const next: Record<string, string> = { warn: 'mute', mute: 'ban', ban: 'warn' };
      filterConfig.flood.action = next[filterConfig.flood.action] as any;
      await this.saveFilterConfig(groupId, settings, filterConfig);
      await ctx.answerCallbackQuery({ text: `处理: ${filterConfig.flood.action}` });
      await this.handleCallback(ctx, groupId, 'menu_flood');
      return;
    }

    if (action === 'flood_mute') {
      const presets = [1, 5, 15, 30, 60];
      const current = presets.indexOf(filterConfig.flood.muteDuration);
      filterConfig.flood.muteDuration = presets[(current + 1) % presets.length];
      await this.saveFilterConfig(groupId, settings, filterConfig);
      await ctx.answerCallbackQuery({ text: `禁言: ${filterConfig.flood.muteDuration}分钟` });
      await this.handleCallback(ctx, groupId, 'menu_flood');
      return;
    }

    // ── Custom titles ──
    if (action === 'menu_titles') {
      const customSettings = settings.customSettings || {};
      const customTitles = customSettings.customTitles as Array<{minLevel: number; title: string}> | undefined;
      const titles = customTitles && customTitles.length > 0 ? customTitles : LevelService.getDefaultTitles();

      let text = '🏷 *自定义等级称号*\n\n';
      text += titles.map(t => `Lv.${t.minLevel}+ → ${t.title}`).join('\n');
      text += '\n\n发送 `/title <等级> <称号>` 设置\n发送 `/title reset` 恢复默认';

      const keyboard = new InlineKeyboard()
        .text('恢复默认称号', 'ap:reset_titles').row()
        .text('◀ 返回', 'ap:back');

      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
      await ctx.answerCallbackQuery();
      return;
    }

    if (action === 'reset_titles') {
      const customSettings = settings.customSettings || {};
      delete customSettings.customTitles;
      await this.groupService.updateSettings(groupId, { customSettings });
      await ctx.answerCallbackQuery({ text: '已恢复默认称号' });
      await this.handleCallback(ctx, groupId, 'menu_titles');
      return;
    }

    // ── Stats ──
    if (action === 'show_stats') {
      const stats = await this.auditService.getVerificationStats(groupId, 7);
      let text = `📊 *群组统计 (近7天)*\n\n`;
      text += `新成员: ${stats.total}\n`;
      text += `已验证: ${stats.verified}\n`;
      text += `验证率: ${stats.rate.toFixed(1)}%`;

      await ctx.answerCallbackQuery();
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text('◀ 返回', 'ap:back'),
      });
      return;
    }

    // ── Back ──
    if (action === 'back') {
      await ctx.answerCallbackQuery();
      await this.refreshMainMenu(ctx, groupId);
      return;
    }
  }

  private async refreshMainMenu(ctx: any, groupId: string) {
    const settings = await this.groupService.getSettings(groupId);
    if (!settings) return;

    const filterConfig = this.contentFilter.getFilterConfig(settings.customSettings);
    const on = '✅', off = '❌';

    const keyboard = new InlineKeyboard()
      .text(`${settings.verificationEnabled ? on : off} 入群验证`, 'ap:toggle_verify')
      .text(`${filterConfig.enabled ? on : off} 内容过滤`, 'ap:toggle_filter').row()
      .text(`${filterConfig.flood.enabled ? on : off} 防刷屏`, 'ap:toggle_flood')
      .text('⏱ 验证时长', 'ap:menu_ttl').row()
      .text('🛡 过滤设置', 'ap:menu_filter')
      .text('🌊 刷屏设置', 'ap:menu_flood').row()
      .text('🏷 自定义称号', 'ap:menu_titles')
      .text('📊 群组统计', 'ap:show_stats').row();

    if (config.bot.webhookDomain) {
      keyboard.webApp('📱 管理面板', `${config.bot.webhookDomain}/mini-app`);
    }

    try {
      await ctx.editMessageText('⚙️ *管理面板*\n\n点击按钮快速切换设置：', {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    } catch {
      // Message might not have changed
    }
  }

  private async saveFilterConfig(groupId: string, settings: any, filterConfig: any) {
    const customSettings = settings.customSettings || {};
    customSettings.filter = filterConfig;
    await this.groupService.updateSettings(groupId, { customSettings });
  }
}
