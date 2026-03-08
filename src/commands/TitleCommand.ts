import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';
import { LevelService } from '../services/LevelService';

export class TitleCommand extends BaseCommand {
  command = 'title';
  description = '设置自定义等级称号（管理员）';

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    if (!await this.requireAdmin(ctx)) return;

    const args = (ctx.match || '').toString().trim();
    const groupId = ctx.chat!.id.toString();
    const settings = await this.groupService.getSettings(groupId);
    if (!settings) return;

    const customSettings = settings.customSettings || {};

    if (args === 'reset') {
      delete customSettings.customTitles;
      await this.groupService.updateSettings(groupId, { customSettings });
      await ctx.reply('✅ 已恢复默认称号');
      return;
    }

    if (args === 'list' || args === '') {
      const titles = (customSettings.customTitles as Array<{minLevel: number; title: string}>) || LevelService.getDefaultTitles();
      let text = '🏷 *等级称号*\n\n';
      text += [...titles].sort((a, b) => a.minLevel - b.minLevel).map(t => `Lv.${t.minLevel}+ → ${t.title}`).join('\n');
      text += '\n\n*设置称号:*\n`/title 5 🌟 活跃`\n`/title reset` 恢复默认';
      await ctx.reply(text, { parse_mode: 'Markdown' });
      return;
    }

    // Parse: /title <level> <title text>
    const parts = args.split(/\s+/);
    const level = parseInt(parts[0], 10);
    const titleText = parts.slice(1).join(' ');

    if (!level || level < 1 || level > 100 || !titleText) {
      await ctx.reply('用法: `/title <等级> <称号>`\n\n示例: `/title 5 🌟 活跃成员`', { parse_mode: 'Markdown' });
      return;
    }

    // Get or init custom titles
    let titles = (customSettings.customTitles as Array<{minLevel: number; title: string}>) || [...LevelService.getDefaultTitles()];

    // Update or add
    const existing = titles.findIndex(t => t.minLevel === level);
    if (existing >= 0) {
      titles[existing].title = titleText;
    } else {
      titles.push({ minLevel: level, title: titleText });
    }

    titles.sort((a, b) => b.minLevel - a.minLevel);

    customSettings.customTitles = titles;
    await this.groupService.updateSettings(groupId, { customSettings });

    await ctx.reply(`✅ 已设置 Lv.${level}+ 称号为: ${titleText}`);
  }
}
