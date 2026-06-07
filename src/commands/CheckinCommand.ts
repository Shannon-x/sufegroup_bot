import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';
import { LevelService } from '../services/LevelService';
import { sendTemporaryMessage } from '../utils/telegram';
import { buildMention, escapeHtml } from '../utils/markdown';

export class CheckinCommand extends BaseCommand {
  command = 'checkin';
  description = '每日签到';

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

    const userId = ctx.from!.id.toString();
    const groupId = ctx.chat!.id.toString();

    // Auto-delete the invoking message to prevent chat clutter
    try {
      await ctx.deleteMessage();
    } catch (e) {
      // Ignore if no permission to delete
    }

    const settings = await this.groupService.getSettings(groupId);
    const customTitles = settings?.customSettings?.customTitles || null;
    const result = await this.levelService.checkin(userId, groupId, customTitles);

    if (!result.success) {
      if (result.alreadyChecked) {
        await sendTemporaryMessage(
          this.bot,
          ctx.chat!.id,
          `📅 您今天已经签到过了！\n\n🔥 连续签到: ${result.streak} 天\n💰 当前积分: ${result.totalCoins}`,
          { parse_mode: 'Markdown' },
          30000
        );
      }
      return;
    }

    let text = `✅ *签到成功！*\n\n`;
    text += `💰 获得积分: +${result.coins}\n`;
    text += `✨ 获得经验: +${result.xp}\n`;
    text += `🔥 连续签到: ${result.streak} 天\n`;

    if (result.bonusCoins > 0) {
      text += `🎁 里程碑奖励: +${result.bonusCoins} 积分\n`;
    }

    text += `\n💰 当前积分: ${result.totalCoins}`;

    // Streak milestone tips
    if (result.streak === 6) {
      text += `\n\n💡 明天连续签到第7天可获得 *50积分* 奖励！`;
      text += `\n\n💡 明天连续签到第30天可获得 *200积分* 奖励！`;
    }

    await sendTemporaryMessage(
      this.bot,
      ctx.chat!.id,
      text,
      { parse_mode: 'Markdown' },
      30000
    );

    // Check-in also grants XP, which can trigger a level-up. Announce it for
    // parity with the message-XP path (previously the level changed silently).
    if (result.leveledUp) {
      const mention = buildMention(ctx.from);
      await sendTemporaryMessage(
        this.bot,
        ctx.chat!.id,
        `🎉 恭喜 ${mention} 升级到 <b>Lv.${result.newLevel}</b>！\n称号: ${escapeHtml(result.title)}`,
        { parse_mode: 'HTML' },
        30000
      );
    }
  }
}
