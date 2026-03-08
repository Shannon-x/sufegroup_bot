import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';
import { LevelService } from '../services/LevelService';

export class ProfileCommand extends BaseCommand {
  command = 'profile';
  description = '查看个人资料';

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

    // Allow viewing another user's profile via reply or mention
    let targetId = ctx.from!.id.toString();
    let targetName = ctx.from!.first_name;

    if (ctx.message?.reply_to_message?.from && !ctx.message.reply_to_message.from.is_bot) {
      targetId = ctx.message.reply_to_message.from.id.toString();
      targetName = ctx.message.reply_to_message.from.first_name;
    }

    const groupId = ctx.chat!.id.toString();
    const profile = await this.levelService.getOrCreateProfile(targetId, groupId);
    const rank = await this.levelService.getRank(targetId, groupId);
    const settings = await this.groupService.getSettings(groupId);
    const customTitles = settings?.customSettings?.customTitles || null;
    const title = LevelService.getTitle(profile.level, customTitles);

    const nextLevel = profile.level + 1;
    const currentLevelXP = LevelService.xpForLevel(profile.level);
    const nextLevelXP = LevelService.xpForLevel(nextLevel);
    const progressXP = profile.xp - currentLevelXP;
    const neededXP = nextLevelXP - currentLevelXP;
    const progressPct = Math.floor((progressXP / neededXP) * 100);

    // Progress bar
    const filled = Math.floor(progressPct / 10);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

    let text = `📊 *${targetName} 的资料*\n\n`;
    text += `${title}  •  Lv.${profile.level}\n`;
    text += `${bar} ${progressPct}%\n`;
    text += `XP: ${profile.xp} / ${nextLevelXP}\n\n`;
    text += `💬 消息数: ${profile.totalMessages}\n`;
    text += `💰 积分: ${profile.coins}\n`;
    text += `🔥 签到连续: ${profile.checkinStreak} 天\n`;
    text += `🏅 排名: #${rank || '-'}`;

    await ctx.reply(text, { parse_mode: 'Markdown' });
  }
}
