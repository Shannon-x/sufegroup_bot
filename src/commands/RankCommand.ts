import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';
import { LevelService } from '../services/LevelService';

export class RankCommand extends BaseCommand {
  command = 'rank';
  description = '查看排行榜';

  private levelService: LevelService;

  constructor(...args: ConstructorParameters<typeof BaseCommand>) {
    super(...args);
    this.levelService = new LevelService();
  }

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    if (!await this.requireGroup(ctx)) return;

    const groupId = ctx.chat!.id.toString();
    const top = await this.levelService.getLeaderboard(groupId, 10);

    if (top.length === 0) {
      await ctx.reply('暂无排行数据，大家多聊天多签到吧！');
      return;
    }

    const settings = await this.groupService.getSettings(groupId);
    const customTitles = settings?.customSettings?.customTitles || null;

    const medals = ['🥇', '🥈', '🥉'];
    const lines = await Promise.all(
      top.map(async (p, i) => {
        const prefix = i < 3 ? medals[i] : `${i + 1}.`;
        const title = LevelService.getTitle(p.level, customTitles);
        const user = await this.userService.findById(p.userId);
        const name = user?.firstName || user?.username || p.userId;
        return `${prefix} *${name}*  Lv.${p.level} ${title}\n    XP: ${p.xp}  💬${p.totalMessages}  💰${p.coins}`;
      })
    );

    // Show caller's rank
    const myRank = await this.levelService.getRank(ctx.from!.id.toString(), groupId);
    let footer = '';
    if (myRank > 10) {
      footer = `\n\n── 您的排名: #${myRank}`;
    }

    await ctx.reply(`🏆 *活跃排行榜*\n\n${lines.join('\n\n')}${footer}`, { parse_mode: 'Markdown' });
  }
}
