import { CommandContext } from 'grammy';
import { AdminRight, BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';
import { LevelService } from '../services/LevelService';
import { Lottery } from '../entities/Lottery';
import { buildMention, escapeHtml } from '../utils/markdown';

/** Rights required to run a lottery — see handleCreate for the rationale. */
const LOTTERY_RIGHTS: AdminRight[] = ['can_delete_messages'];

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
    // Lotteries mint and refund group coins, so a right-less "administrator"
    // must not be able to run them (see BaseCommand.AdminRight).
    //
    // The bit asked for is "delete messages", not "change group info": running
    // a group activity is moderation, not configuration, and real moderators are
    // routinely given can_delete_messages + can_restrict_members while
    // can_change_info stays with the owner. Demanding can_change_info locked the
    // people who actually run these out of them, while can_delete_messages still
    // excludes the decorative zero-right admin this check exists for.
    if (!await this.requireAdmin(ctx, LOTTERY_RIGHTS)) return;

    // /lottery create <奖品> <人数> [时长m/h] [最低等级] [花费积分]
    if (args.length < 2) {
      await ctx.reply(
        `用法: <code>/lottery create &lt;奖品&gt; &lt;人数&gt; [时长] [最低等级] [积分]</code>\n\n` +
        `示例:\n` +
        `<code>/lottery create 红包10元 3</code> → 3人中奖，30分钟\n` +
        `<code>/lottery create VIP资格 1 2h 5</code> → 1人中奖，2小时，需Lv5\n` +
        `<code>/lottery create 神秘奖品 2 1h 10 50</code> → 需Lv10，花费50积分`,
        { parse_mode: 'HTML' }
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

    await this.logLotteryAction(groupId, ctx.from!.id.toString(), 'lottery_created',
      `#${lottery.id} ${prize} ×${winnerCount}${costCoins > 0 ? ` 费用${costCoins}` : ''}`);

    let text = `🎰 <b>新抽奖活动！</b>  #${lottery.id}\n\n`;
    text += `🎁 奖品: <b>${escapeHtml(prize)}</b>\n`;
    text += `👥 中奖人数: ${winnerCount}\n`;
    text += `⏱ 时长: ${this.formatDuration(durationMinutes)}\n`;
    if (minLevel > 0) text += `📊 最低等级: Lv.${minLevel}\n`;
    if (costCoins > 0) text += `💰 参与费用: ${costCoins} 积分\n`;
    text += `\n发送 <code>/join ${lottery.id}</code> 参与！`;

    // The lottery row already exists; if the announcement cannot be delivered we
    // must not stay silent about it, otherwise nobody can join a live lottery.
    try {
      const msg = await ctx.reply(text, { parse_mode: 'HTML' });
      lottery.messageId = msg.message_id;
      await this.levelService.saveLottery(lottery);
    } catch (error) {
      this.logger.error('Failed to announce created lottery', error);
      await ctx.reply(`⚠️ 抽奖 #${lottery.id} 已创建，但公告发送失败，请手动通知成员`).catch(() => {});
    }
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
        await ctx.reply('用法: <code>/join &lt;抽奖ID&gt;</code>', { parse_mode: 'HTML' });
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

    await ctx.reply(`✅ 已参与抽奖 #${lotteryId}！当前 ${count} 人参与`);
  }

  private async handleDraw(ctx: CommandContext<MyContext>) {
    if (!await this.requireAdmin(ctx, LOTTERY_RIGHTS)) return;

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
      await ctx.reply('用法: <code>/draw [抽奖ID]</code>', { parse_mode: 'HTML' });
      return;
    }

    // Lottery ids are global, so ownership must be checked before drawing:
    // otherwise an admin of group A could guess an id and draw group B's lottery.
    const target = await this.levelService.getLottery(lotteryId);
    if (!target || target.groupId !== groupId) {
      await ctx.reply('❌ 本群没有该抽奖');
      return;
    }

    const result = await this.levelService.drawLottery(lotteryId);

    if (!result.success) {
      await ctx.reply(`❌ ${result.reason}`);
      return;
    }

    const lottery = result.lottery!;
    const winners = result.winners || [];

    await this.logLotteryAction(groupId, ctx.from!.id.toString(), 'lottery_drawn',
      `#${lotteryId} 参与${lottery.participants.length} 中奖${winners.length}`);

    await this.announceWinners(ctx, lotteryId, lottery, winners);
  }

  /**
   * The draw is already committed at this point, so a failed announcement may
   * not be retried by re-drawing. Escaping (HTML mode) removes the main reason
   * Telegram used to reject these messages; anything left is logged and the
   * group still gets a plain-text fallback.
   */
  private async announceWinners(
    ctx: CommandContext<MyContext>,
    lotteryId: number,
    lottery: Lottery,
    winners: string[]
  ) {
    const winnerMentions = await Promise.all(
      winners.map(async (wId) => {
        const user = await this.userService.findById(wId);
        return buildMention(user, wId);
      })
    );

    let text = `🎉 <b>抽奖 #${lotteryId} 开奖！</b>\n\n`;
    text += `🎁 奖品: <b>${escapeHtml(lottery.prize)}</b>\n`;
    text += `👥 参与人数: ${lottery.participants.length}\n\n`;
    text += `🏆 <b>中奖名单</b>\n`;
    text += winnerMentions.map((m, i) => `${i + 1}. ${m}`).join('\n');

    try {
      await ctx.reply(text, { parse_mode: 'HTML' });
    } catch (error) {
      this.logger.error('Failed to announce lottery winners', error);
      const plain = `🎉 抽奖 #${lotteryId} 开奖！\n奖品: ${lottery.prize}\n中奖人数: ${winners.length}`;
      await ctx.reply(plain).catch(() => {});
    }
  }

  private async handleList(ctx: CommandContext<MyContext>) {
    const groupId = ctx.chat!.id.toString();
    const active = await this.levelService.getActiveLotteries(groupId);

    if (active.length === 0) {
      await ctx.reply('当前没有进行中的抽奖\n\n管理员可使用 <code>/lottery create</code> 创建', { parse_mode: 'HTML' });
      return;
    }

    const lines = active.map(l => {
      const remaining = Math.max(0, Math.ceil((l.endsAt.getTime() - Date.now()) / 60000));
      let line = `#${l.id} 🎁 <b>${escapeHtml(l.prize)}</b> — ${l.participants.length}人参与`;
      line += `\n    剩余 ${remaining} 分钟`;
      if (l.minLevel > 0) line += ` · 需Lv.${l.minLevel}`;
      if (l.costCoins > 0) line += ` · ${l.costCoins}积分`;
      return line;
    });

    await ctx.reply(`🎰 <b>进行中的抽奖</b>\n\n${lines.join('\n\n')}\n\n发送 <code>/join &lt;ID&gt;</code> 参与`, { parse_mode: 'HTML' });
  }

  private async handleCancel(ctx: CommandContext<MyContext>, idStr?: string) {
    if (!idStr) {
      await ctx.reply('用法: <code>/lottery cancel &lt;ID&gt;</code>', { parse_mode: 'HTML' });
      return;
    }

    const id = parseInt(idStr, 10);
    // `/lottery cancel abc` used to return silently, which reads exactly like
    // the bot being down.
    if (!id || id < 1) {
      await ctx.reply('❌ 抽奖 ID 必须是数字\n用法: <code>/lottery cancel &lt;ID&gt;</code>', { parse_mode: 'HTML' });
      return;
    }

    const groupId = ctx.chat!.id.toString();
    const adminCheck = await this.checkAdmin(ctx, LOTTERY_RIGHTS);
    const isAdmin = adminCheck.ok;
    const userId = ctx.from!.id.toString();

    // Admins can cancel any, creators can cancel their own
    const lottery = await this.levelService.getLottery(id);
    // Ownership check first: ids are global, so without it an admin of another
    // group could cancel (and trigger refunds for) this group's lottery.
    if (!lottery || lottery.groupId !== groupId) {
      await ctx.reply('❌ 本群没有该抽奖');
      return;
    }

    if (!isAdmin && lottery.createdBy !== userId) {
      // Say why: an anonymous admin is refused for a reason they can act on,
      // not because they are not an admin.
      await ctx.reply(
        !adminCheck.ok && adminCheck.reason === 'anonymous_unverifiable'
          ? this.adminDenialMessage(adminCheck)
          : '❌ 只有管理员或创建者可以取消'
      );
      return;
    }

    // Both paths go through the atomic claim-then-refund implementation. The old
    // admin branch refunded in a loop and wrote the status afterwards without
    // checking it first, so repeating the command minted coins on every run.
    const result = isAdmin
      ? await this.levelService.adminCancelLottery(id)
      : await this.levelService.cancelLottery(id, userId);

    if (!result.success) {
      await ctx.reply(`❌ ${result.reason}`);
      return;
    }

    const refunded = lottery.costCoins > 0 && lottery.participants.length > 0;

    await this.logLotteryAction(groupId, userId, 'lottery_cancelled', `#${id} ${lottery.prize}`);
    if (refunded) {
      await this.logLotteryAction(groupId, userId, 'lottery_refunded',
        `#${id} 退还 ${lottery.costCoins} 积分 ×${lottery.participants.length} 人`);
    }

    await ctx.reply(`✅ 抽奖 #${id} 已取消${refunded ? '，积分已退还' : ''}`);
  }

  /** Audit logging must never take down the command itself. */
  private async logLotteryAction(
    groupId: string,
    performedBy: string,
    action: 'lottery_created' | 'lottery_drawn' | 'lottery_cancelled' | 'lottery_refunded',
    details: string
  ) {
    try {
      await this.auditService.log({ groupId, performedBy, action, details });
    } catch (error) {
      this.logger.warn('Failed to write lottery audit log', error);
    }
  }

  private async showHelp(ctx: CommandContext<MyContext>) {
    let text = `🎰 <b>抽奖系统</b>\n\n`;
    text += `<b>/lottery create</b> &lt;奖品&gt; &lt;人数&gt; [时长] [等级] [积分]\n`;
    text += `  创建抽奖（管理员）\n`;
    text += `<b>/lottery list</b> — 查看进行中的抽奖\n`;
    text += `<b>/join</b> [ID] — 参与抽奖\n`;
    text += `<b>/draw</b> [ID] — 手动开奖（管理员）\n`;
    text += `<b>/lottery cancel</b> &lt;ID&gt; — 取消抽奖\n\n`;
    text += `到期后自动开奖`;
    await ctx.reply(text, { parse_mode: 'HTML' });
  }
}
