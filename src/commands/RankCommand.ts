import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';
import { LevelService } from '../services/LevelService';
import { config } from '../config/config';
import { InlineKeyboard } from 'grammy';
import { sendTemporaryMessage } from '../utils/telegram';

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
    const cleanGroupId = groupId.replace('-', 'm');

    const botUsername = config.bot.username || 'bot';
    const keyboard = new InlineKeyboard();

    if (config.bot.miniAppShortName && config.bot.webhookDomain) {
      const miniAppUrl = `https://t.me/${botUsername}/${config.bot.miniAppShortName}?startapp=rank_${cleanGroupId}`;
      keyboard.url('🏆 查看实时排行榜', miniAppUrl);
    } else if (config.bot.webhookDomain) {
      const fallbackUrl = `${config.bot.webhookDomain}/mini-app?startapp=rank_${cleanGroupId}`;
      keyboard.webApp('🏆 查看实时排行榜', fallbackUrl);
    }

    // Auto-delete the invoking message if possible
    try {
      await ctx.deleteMessage();
    } catch (e) {}

    await sendTemporaryMessage(
      this.bot,
      ctx.chat!.id,
      `🏆 *群组积分与活跃榜单*\n\n点击下方按钮，进入专属的群组数据大盘与排行榜单，查看您的实时排行！`,
      { reply_markup: keyboard, parse_mode: 'Markdown' },
      60000 // 保持 60 秒
    );
  }
}
