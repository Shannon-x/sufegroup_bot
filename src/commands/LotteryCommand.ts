import { CommandContext } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';
import { LevelService } from '../services/LevelService';

export class LotteryCommand extends BaseCommand {
  command = 'lottery';
  description = '抽奖系统';

  private levelService: LevelService;

  constructor(...args: ConstructorParameters<typeof BaseCommand>) {
    super(...args);
    this.levelService = new LevelService();
  }

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
    this.bot.command('join', async (ctx) => this.handleJoin(ctx));
    this.bot.command('draw', async (ctx) => this.handleDraw(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    if (!await this.requireGroup(ctx)) return;

    const args = (ctx.match || '').toString().trim();
    const parts = args.split(/\s+/);
    const sub = parts[0]?.toLowerCase();

    switch (sub) {
      case 'create':
        await this.handleCreate(ctx, parts.slice(1));
        break;
      case 'list':
        await this.handleList(ctx);
        break;
      case 'cancel':
        await this.handleCancel(ctx, parts[1]);
        break;
      case '':
      default:
        await this.showHelp(ctx);
        break;
    }
  }

  private async handleCreate(ctx: CommandContext<MyContext>, args: string[]) {
    if (!await this.requireAdmin(ctx)) return;

    // /lottery create <奖品> <人数> [时长m/h] [最低等级] [花费积分]
    if (args.length < 2) {
      await ctx.reply(
        `用法: \`/lottery create <奖品> <人数> [时长] [最低等级] [积分]\`\n\n` +
        `示例:\n` +
        `\`/lottery create 红包10元 3\` → 3人中奖，30分钟\n` +
        `\`/lottery create VIP资格 1 2h 5\` → 1人中奖，2小时，需Lv5\n` +
        `\`/lottery create 神秘奖品 2 1h 10 50\` → 需Lv10，花费50积分`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const prize = args[0];
    const winnerCount = parseInt(args[1], 10);
    if (!winnerCount || winnerCount < 1 || winnerCount > 50) {
      await ctx.reply('❌ 中奖人数范围: 1-50');
      return;
    }

    // Parse duration (default 30m)
    let durationMinutes = 30;
    if (args[2]) {
      const dm = this.parseDuration(args[2]);
      if (dm) durationMinutes = dm;
    }

    const minLevel = parseInt(args[3], 10) || 0;
    const costCoins = parseInt(args[4], 10) || 0;

    const groupId = ctx.chat!.id.toString();
    const lottery = await this.levelService.createLottery(
      groupId,
      ctx.from!.id.toString(),
      prize,
      winnerCount,
      durationMinutes,
      minLevel,
      costCoins,
    );

    let text = `🎰 *新抽奖活动！*  #${lottery.id}\n\n`;
    text += `🎁 奖品: *${prize}*\n`;
    text += `👥 中奖人数: ${winnerCount}\n`;
    text += `⏱ 时长: ${this.formatDuration(durationMinutes)}\n`;
    if (minLevel > 0) text += `📊 最低等级: Lv.${minLevel}\n`;
    if (costCoins > 0) text += `💰 参与费用: ${costCoins} 积分\n`;
    text += `\n发送 \`/join ${lottery.id}\` 参与！`;

    const msg = await ctx.reply(text, { parse_mode: 'Markdown' });

    // Save message ID
    lottery.messageId = msg.message_id;
    await this.levelService.saveLottery(lottery);
  }

  private async handleJoin(ctx: CommandContext<MyContext>) {
    if (!await this.requireGroup(ctx)) return;

    const args = (ctx.match || '').toString().trim();
    const groupId = ctx.chat!.id.toString();
    const userId = ctx.from!.id.toString();

    let lotteryId: number;

    if (args) {
      lotteryId = parseInt(args, 10);
      if (!lotteryId) {
        await ctx.reply('用法: `/join <抽奖ID>`', { parse_mode: 'Markdown' });
        return;
      }
    } else {
      // If no ID given, join the latest active lottery in this group
      const active = await this.levelService.getActiveLotteries(groupId);
      if (active.length === 0) {
        await ctx.reply('当前没有进行中的抽奖');
        return;
      }
      lotteryId = active[0].id;
    }

    const result = await this.levelService.joinLottery(lotteryId, userId, groupId);

    if (!result.success) {
      await ctx.reply(`❌ ${'reason' in result ? result.reason : '操作失败'}`);
      return;
    }

    const lottery = await this.levelService.getLottery(lotteryId);
    const count = lottery?.participants.length || 0;

    await ctx.reply(
      `✅ 已参与抽奖 #${lotteryId}！当前 ${count} 人参与`,
      { parse_mode: 'Markdown' }
    );
  }

  private async handleDraw(ctx: CommandContext<MyContext>) {
    if (!await this.requireAdmin(ctx)) return;

    const args = (ctx.match || '').toString().trim();
    const groupId = ctx.chat!.id.toString();

    let lotteryId: number;

    if (args) {
      lotteryId = parseInt(args, 10);
    } else {
      const active = await this.levelService.getActiveLotteries(groupId);
      if (active.length === 0) {
        await ctx.reply('当前没有进行中的抽奖');
        return;
      }
      lotteryId = active[0].id;
    }

    if (!lotteryId) {
      await ctx.reply('用法: `/draw [抽奖ID]`', { parse_mode: 'Markdown' });
      return;
    }

    const result = await this.levelService.drawLottery(lotteryId);

    if (!result.success) {
      await ctx.reply(`❌ ${result.reason}`);
      return;
    }

    const lottery = result.lottery!;
    const winnerMentions = await Promise.all(
      result.winners!.map(async (wId) => {
        const user = await this.userService.findById(wId);
        return user?.username ? `@${user.username}` : `[${user?.firstName || wId}](tg://user?id=${wId})`;
      })
    );

    let text = `🎉 *抽奖 #${lotteryId} 开奖！*\n\n`;
    text += `🎁 奖品: *${lottery.prize}*\n`;
    text += `👥 参与人数: ${lottery.participants.length}\n\n`;
    text += `🏆 *中奖名单*\n`;
    text += winnerMentions.map((m, i) => `${i + 1}. ${m}`).join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
  }

  private async handleList(ctx: CommandContext<MyContext>) {
    const groupId = ctx.chat!.id.toString();
    const active = await this.levelService.getActiveLotteries(groupId);

    if (active.length === 0) {
      await ctx.reply('当前没有进行中的抽奖\n\n管理员可使用 `/lottery create` 创建', { parse_mode: 'Markdown' });
      return;
    }

    const lines = active.map(l => {
      const remaining = Math.max(0, Math.ceil((l.endsAt.getTime() - Date.now()) / 60000));
      let line = `#${l.id} 🎁 *${l.prize}* — ${l.participants.length}人参与`;
      line += `\n    剩余 ${remaining} 分钟`;
      if (l.minLevel > 0) line += ` · 需Lv.${l.minLevel}`;
      if (l.costCoins > 0) line += ` · ${l.costCoins}积分`;
      return line;
    });

    await ctx.reply(`🎰 *进行中的抽奖*\n\n${lines.join('\n\n')}\n\n发送 \`/join <ID>\` 参与`, { parse_mode: 'Markdown' });
  }

  private async handleCancel(ctx: CommandContext<MyContext>, idStr?: string) {
    if (!idStr) {
      await ctx.reply('用法: `/lottery cancel <ID>`', { parse_mode: 'Markdown' });
      return;
    }

    const id = parseInt(idStr, 10);
    if (!id) return;

    const isAdmin = await this.isAdmin(ctx);
    const userId = ctx.from!.id.toString();

    // Admins can cancel any, creators can cancel their own
    const lottery = await this.levelService.getLottery(id);
    if (!lottery) {
      await ctx.reply('❌ 抽奖不存在');
      return;
    }

    if (!isAdmin && lottery.createdBy !== userId) {
      await ctx.reply('❌ 只有管理员或创建者可以取消');
      return;
    }

    // Override createdBy check for admins
    if (isAdmin && lottery.createdBy !== userId) {
      lottery.status = 'cancelled';
      if (lottery.costCoins > 0) {
        for (const pid of lottery.participants) {
          await this.levelService.addCoins(pid, lottery.groupId, lottery.costCoins);
        }
      }
      await this.levelService.saveLottery(lottery);
      await ctx.reply(`✅ 抽奖 #${id} 已取消${lottery.costCoins > 0 ? '，积分已退还' : ''}`);
      return;
    }

    const result = await this.levelService.cancelLottery(id, userId);
    if (result.success) {
      await ctx.reply(`✅ 抽奖 #${id} 已取消${lottery.costCoins > 0 ? '，积分已退还' : ''}`);
    } else {
      await ctx.reply(`❌ ${result.reason}`);
    }
  }

  private async showHelp(ctx: CommandContext<MyContext>) {
    let text = `🎰 *抽奖系统*\n\n`;
    text += `*/lottery create* <奖品> <人数> [时长] [等级] [积分]\n`;
    text += `  创建抽奖（管理员）\n`;
    text += `*/lottery list* — 查看进行中的抽奖\n`;
    text += `*/join* [ID] — 参与抽奖\n`;
    text += `*/draw* [ID] — 手动开奖（管理员）\n`;
    text += `*/lottery cancel* <ID> — 取消抽奖\n\n`;
    text += `到期后自动开奖`;
    await ctx.reply(text, { parse_mode: 'Markdown' });
  }
}

