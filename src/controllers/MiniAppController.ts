import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { GroupService } from '../services/GroupService';
import { ContentFilterService } from '../services/ContentFilterService';
import { LevelService } from '../services/LevelService';
import { UserService } from '../services/UserService';
import { Logger } from '../utils/logger';
import { config } from '../config/config';
import { TelegramBot } from '../services/TelegramBot';

export class MiniAppController {
  private groupService: GroupService;
  private contentFilter: ContentFilterService;
  private levelService: LevelService;
  private userService: UserService;
  private bot: TelegramBot;
  private logger: Logger;

  constructor(bot: TelegramBot) {
    this.groupService = new GroupService();
    this.contentFilter = new ContentFilterService();
    this.levelService = new LevelService();
    this.userService = new UserService();
    this.bot = bot;
    this.logger = new Logger('MiniAppController');
  }

  async register(fastify: FastifyInstance) {
    // ── Mini App page ──
    fastify.get('/mini-app', async (_request, reply) => {
      return reply.view('mini-app', {
        botUsername: config.bot.username || 'bot',
      });
    });

    // ── Groups ──
    fastify.post<{ Body: { initData: string } }>('/api/admin/groups', async (request, reply) => {
      const userId = this.validateInitData(request.body?.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const groups = await this.groupService.getAdminGroups(userId, this.bot.getBot().api);
      return reply.send({
        groups: groups.map(g => ({ id: g.id, title: g.title, username: g.username })),
      });
    });

    // ── Settings: get ──
    fastify.post<{ Body: { initData: string; groupId: string } }>('/api/admin/settings', async (request, reply) => {
      const userId = this.validateInitData(request.body?.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { groupId } = request.body;
      const isAdmin = await this.groupService.isAdminCached(Number(groupId), Number(userId), this.bot.getBot().api);
      if (!isAdmin) return reply.code(403).send({ error: 'Not admin of this group' });

      const settings = await this.groupService.getSettings(groupId);
      if (!settings) return reply.code(404).send({ error: 'Group not found' });

      const filterConfig = this.contentFilter.getFilterConfig(settings.customSettings);
      const customTitles = settings.customSettings?.customTitles || null;

      return reply.send({
        verificationEnabled: settings.verificationEnabled,
        ttlMinutes: settings.ttlMinutes,
        autoAction: settings.autoAction,
        filter: filterConfig,
        customTitles: customTitles || LevelService.getDefaultTitles(),
      });
    });

    // ── Settings: update ──
    fastify.post<{ Body: { initData: string; groupId: string; updates: any } }>('/api/admin/settings/update', async (request, reply) => {
      const userId = this.validateInitData(request.body?.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { groupId, updates } = request.body;
      const isAdmin = await this.groupService.isAdminCached(Number(groupId), Number(userId), this.bot.getBot().api);
      if (!isAdmin) return reply.code(403).send({ error: 'Not admin of this group' });

      const settings = await this.groupService.getSettings(groupId);
      if (!settings) return reply.code(404).send({ error: 'Group not found' });

      const allowed: Record<string, boolean> = {
        verificationEnabled: true,
        ttlMinutes: true,
        autoAction: true,
      };

      const safeUpdates: any = {};
      for (const key of Object.keys(updates)) {
        if (allowed[key]) safeUpdates[key] = updates[key];
      }

      // Nested: filter settings (including customKeywords, flood, etc.)
      if (updates.filter) {
        const cs = settings.customSettings || {};
        // Deep-merge flood separately to avoid overwriting unrelated flood keys
        const existingFilter = this.contentFilter.getFilterConfig(cs);
        const incoming = updates.filter as Record<string, any>;
        const mergedFilter: any = { ...existingFilter, ...incoming };
        if (incoming.flood && typeof incoming.flood === 'object') {
          mergedFilter.flood = { ...existingFilter.flood, ...incoming.flood };
        }
        cs.filter = mergedFilter;
        safeUpdates.customSettings = cs;
      }

      // customTitles: null = reset to defaults, array = set custom titles
      if ('customTitles' in updates) {
        const cs = safeUpdates.customSettings || settings.customSettings || {};
        if (updates.customTitles === null || updates.customTitles === undefined) {
          delete cs.customTitles;
        } else if (Array.isArray(updates.customTitles)) {
          cs.customTitles = updates.customTitles;
        }
        safeUpdates.customSettings = cs;
      }

      await this.groupService.updateSettings(groupId, safeUpdates);
      return reply.send({ success: true });
    });

    // ── Lottery: list active ──
    fastify.post<{ Body: { initData: string; groupId: string } }>('/api/admin/lottery/list', async (request, reply) => {
      const userId = this.validateInitData(request.body?.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { groupId } = request.body;
      const isAdmin = await this.groupService.isAdminCached(Number(groupId), Number(userId), this.bot.getBot().api);
      if (!isAdmin) return reply.code(403).send({ error: 'Forbidden' });

      const lotteries = await this.levelService.getActiveLotteries(groupId);
      return reply.send({
        lotteries: lotteries.map(l => ({
          id: l.id,
          prize: l.prize,
          winnerCount: l.winnerCount,
          participants: l.participants.length,
          minLevel: l.minLevel,
          costCoins: l.costCoins,
          endsAt: l.endsAt,
          status: l.status,
        })),
      });
    });

    // ── Lottery: create ──
    fastify.post<{
      Body: {
        initData: string;
        groupId: string;
        prize: string;
        winnerCount: number;
        durationMinutes: number;
        minLevel: number;
        costCoins: number;
      };
    }>('/api/admin/lottery/create', async (request, reply) => {
      const userId = this.validateInitData(request.body?.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { groupId, prize, winnerCount, durationMinutes, minLevel, costCoins } = request.body;
      const isAdmin = await this.groupService.isAdminCached(Number(groupId), Number(userId), this.bot.getBot().api);
      if (!isAdmin) return reply.code(403).send({ error: 'Forbidden' });

      const cleanPrize = (prize || '').trim();
      if (!cleanPrize) return reply.code(400).send({ error: '奖品名称不能为空' });
      const cleanCount = Math.min(50, Math.max(1, Number(winnerCount) || 1));
      const cleanDuration = Math.min(10080, Math.max(1, Number(durationMinutes) || 30));
      const cleanLevel = Math.max(0, Number(minLevel) || 0);
      const cleanCoins = Math.max(0, Number(costCoins) || 0);

      const lottery = await this.levelService.createLottery(
        groupId, userId, cleanPrize, cleanCount, cleanDuration, cleanLevel, cleanCoins,
      );

      // Send group announcement
      try {
        let text = `🎰 *新抽奖活动！*  #${lottery.id}\n\n`;
        text += `🎁 奖品: *${cleanPrize}*\n`;
        text += `👥 中奖人数: ${cleanCount}\n`;
        text += `⏱ 时长: ${cleanDuration < 60 ? cleanDuration + '分钟' : (cleanDuration / 60) + '小时'}\n`;
        if (cleanLevel > 0) text += `📊 最低等级: Lv.${cleanLevel}\n`;
        if (cleanCoins > 0) text += `💰 参与费用: ${cleanCoins} 积分\n`;
        text += `\n发送 \`/join ${lottery.id}\` 参与！`;

        const msg = await this.bot.getBot().api.sendMessage(groupId, text, { parse_mode: 'Markdown' });
        lottery.messageId = msg.message_id;
        await this.levelService.saveLottery(lottery);
      } catch (e) {
        this.logger.warn('Failed to send lottery announcement', e);
      }

      return reply.send({ success: true, lottery: { id: lottery.id, prize: lottery.prize } });
    });

    // ── Lottery: draw ──
    fastify.post<{ Body: { initData: string; lotteryId: number } }>('/api/admin/lottery/draw', async (request, reply) => {
      const userId = this.validateInitData(request.body?.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { lotteryId } = request.body;
      const lottery = await this.levelService.getLottery(Number(lotteryId));
      if (!lottery) return reply.code(404).send({ error: '抽奖不存在' });

      const isAdmin = await this.groupService.isAdminCached(Number(lottery.groupId), Number(userId), this.bot.getBot().api);
      if (!isAdmin) return reply.code(403).send({ error: 'Forbidden' });

      const result = await this.levelService.drawLottery(Number(lotteryId));
      if (!result.success) return reply.code(400).send({ error: result.reason });

      // Send draw result announcement
      try {
        const winners = result.winners || [];
        const winnerMentions = await Promise.all(
          winners.map(async (wId) => {
            const user = await this.userService.findById(wId);
            return user?.username ? `@${user.username}` : (user?.firstName || `用户${wId}`);
          })
        );
        let text = `🎉 *抽奖 #${lotteryId} 开奖！*\n\n`;
        text += `🎁 奖品: *${lottery.prize}*\n`;
        text += `👥 参与人数: ${lottery.participants.length}\n\n`;
        text += `🏆 *中奖名单*\n`;
        text += winnerMentions.map((m, i) => `${i + 1}. ${m}`).join('\n');
        await this.bot.getBot().api.sendMessage(lottery.groupId, text, { parse_mode: 'Markdown' });
      } catch (e) {
        this.logger.warn('Failed to send draw announcement', e);
      }

      return reply.send({ success: true, winnersCount: (result.winners || []).length });
    });

    // ── Lottery: cancel ──
    fastify.post<{ Body: { initData: string; lotteryId: number } }>('/api/admin/lottery/cancel', async (request, reply) => {
      const userId = this.validateInitData(request.body?.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { lotteryId } = request.body;
      const lottery = await this.levelService.getLottery(Number(lotteryId));
      if (!lottery) return reply.code(404).send({ error: '抽奖不存在' });

      const isAdmin = await this.groupService.isAdminCached(Number(lottery.groupId), Number(userId), this.bot.getBot().api);
      if (!isAdmin) return reply.code(403).send({ error: 'Forbidden' });

      if (lottery.status !== 'active') return reply.code(400).send({ error: '抽奖已结束' });

      // Refund coins if any
      if (lottery.costCoins > 0) {
        for (const pid of lottery.participants) {
          await this.levelService.addCoins(pid, lottery.groupId, lottery.costCoins);
        }
      }
      lottery.status = 'cancelled';
      await this.levelService.saveLottery(lottery);

      return reply.send({ success: true });
    });
  }

  private validateInitData(initData: string | undefined): string | null {
    if (!initData) return null;

    try {
      const params = new URLSearchParams(initData);
      const hash = params.get('hash');
      if (!hash) return null;

      params.delete('hash');
      const entries = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

      const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(config.bot.token)
        .digest();

      const computedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

      if (computedHash !== hash) return null;

      const authDate = parseInt(params.get('auth_date') || '0', 10);
      if (Date.now() / 1000 - authDate > 3600) return null;

      const user = params.get('user');
      if (!user) return null;

      const userData = JSON.parse(user);
      return userData.id?.toString() || null;
    } catch {
      return null;
    }
  }
}
