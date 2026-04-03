import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { z } from 'zod';
import { GroupService } from '../services/GroupService';
import { ContentFilterService } from '../services/ContentFilterService';
import { LevelService } from '../services/LevelService';
import { UserService } from '../services/UserService';
import { VerificationService } from '../services/VerificationService';
import { TurnstileService } from '../services/TurnstileService';
import { HCaptchaService } from '../services/HCaptchaService';
import { AuditService } from '../services/AuditService';
import { Logger } from '../utils/logger';
import { config } from '../config/config';
import { TelegramBot } from '../services/TelegramBot';
import { sendTemporaryMessage, unrestrictUser, formatUserMention } from '../utils/telegram';

// ── Request body schemas ──

const InitDataBody = z.object({
  initData: z.string().min(1),
});

const GroupBody = z.object({
  initData: z.string().min(1),
  groupId: z.string().min(1),
});

const FloodConfigSchema = z.object({
  enabled: z.boolean().optional(),
  maxMessages: z.number().int().min(3).max(100).optional(),
  windowSeconds: z.number().int().min(5).max(300).optional(),
  action: z.enum(['warn', 'mute', 'ban']).optional(),
  muteDuration: z.number().int().min(1).max(1440).optional(),
  deleteExcess: z.boolean().optional(),
}).optional();

const FilterUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  blockUrls: z.boolean().optional(),
  blockInviteLinks: z.boolean().optional(),
  blockPhoneNumbers: z.boolean().optional(),
  blockForwards: z.boolean().optional(),
  newUserLinkDelay: z.number().int().min(0).max(1440).optional(),
  customKeywords: z.array(z.string().max(100)).max(200).optional(),
  whitelistUrls: z.array(z.string().max(200)).max(50).optional(),
  action: z.enum(['warn', 'mute', 'ban']).optional(),
  muteDuration: z.number().int().min(1).max(1440).optional(),
  maxWarnings: z.number().int().min(1).max(20).optional(),
  flood: FloodConfigSchema,
}).optional();

const UpdateSettingsBody = z.object({
  initData: z.string().min(1),
  groupId: z.string().min(1),
  updates: z.object({
    verificationEnabled: z.boolean().optional(),
    ttlMinutes: z.number().int().min(1).max(60).optional(),
    autoAction: z.enum(['mute', 'kick']).optional(),
    filter: FilterUpdateSchema,
    customTitles: z.array(z.object({
      minLevel: z.number().int().min(1).max(100),
      title: z.string().min(1).max(50),
    })).max(20).nullable().optional(),
  }),
});

const CreateLotteryBody = z.object({
  initData: z.string().min(1),
  groupId: z.string().min(1),
  prize: z.string().min(1).max(500),
  winnerCount: z.number().int().min(1).max(50),
  durationMinutes: z.number().int().min(1).max(10080),
  minLevel: z.number().int().min(0).max(100).default(0),
  costCoins: z.number().int().min(0).max(100000).default(0),
});

const LotteryActionBody = z.object({
  initData: z.string().min(1),
  lotteryId: z.number().int().positive(),
});

export class MiniAppController {
  private groupService: GroupService;
  private contentFilter: ContentFilterService;
  private levelService: LevelService;
  private userService: UserService;
  private verificationService: VerificationService;
  private turnstileService: TurnstileService;
  private hcaptchaService: HCaptchaService;
  private auditService: AuditService;
  private bot: TelegramBot;
  private logger: Logger;

  constructor(bot: TelegramBot) {
    this.groupService = new GroupService();
    this.contentFilter = new ContentFilterService();
    this.levelService = new LevelService();
    this.userService = new UserService();
    this.verificationService = new VerificationService();
    this.turnstileService = new TurnstileService();
    this.hcaptchaService = new HCaptchaService();
    this.auditService = new AuditService();
    this.bot = bot;
    this.logger = new Logger('MiniAppController');
  }

  async register(fastify: FastifyInstance) {
    // ── Mini App page ──
    fastify.get('/mini-app', async (_request, reply) => {
      return reply.view('mini-app', {
        botUsername: config.bot.username || 'bot',
        siteKey: this.turnstileService.getSiteKey(),
        hcaptchaSiteKey: this.hcaptchaService.getSiteKey() || '',
      });
    });

    // ── Groups ──
    fastify.post('/api/admin/groups', async (request, reply) => {
      const parsed = InitDataBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request', details: parsed.error.issues });

      const userId = this.validateInitData(parsed.data.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const groups = await this.groupService.getAdminGroups(userId, this.bot.getBot().api);
      return reply.send({
        groups: groups.map(g => ({ id: g.id, title: g.title, username: g.username })),
      });
    });

    // ── Settings: get ──
    fastify.post('/api/admin/settings', async (request, reply) => {
      const parsed = GroupBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request', details: parsed.error.issues });

      const userId = this.validateInitData(parsed.data.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { groupId } = parsed.data;
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
    fastify.post('/api/admin/settings/update', async (request, reply) => {
      const parsed = UpdateSettingsBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request', details: parsed.error.issues });

      const userId = this.validateInitData(parsed.data.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { groupId, updates } = parsed.data;
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
    fastify.post('/api/admin/lottery/list', async (request, reply) => {
      const parsed = GroupBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request', details: parsed.error.issues });

      const userId = this.validateInitData(parsed.data.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { groupId } = parsed.data;
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
    fastify.post('/api/admin/lottery/create', async (request, reply) => {
      const parsed = CreateLotteryBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request', details: parsed.error.issues });

      const userId = this.validateInitData(parsed.data.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { groupId, prize, winnerCount, durationMinutes, minLevel, costCoins } = parsed.data;
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
    fastify.post('/api/admin/lottery/draw', async (request, reply) => {
      const parsed = LotteryActionBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request', details: parsed.error.issues });

      const userId = this.validateInitData(parsed.data.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { lotteryId } = parsed.data;
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
    fastify.post('/api/admin/lottery/cancel', async (request, reply) => {
      const parsed = LotteryActionBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request', details: parsed.error.issues });

      const userId = this.validateInitData(parsed.data.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { lotteryId } = parsed.data;
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
    // ── Verification: get session info ──
    fastify.post('/api/miniapp/verify/session', async (request, reply) => {
      const parsed = z.object({
        initData: z.string().min(1),
        sessionId: z.string().min(1),
      }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });

      const userId = this.validateInitData(parsed.data.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const session = await this.verificationService.getSession(parsed.data.sessionId);
      if (!session) {
        return reply.code(404).send({ error: 'session_not_found', message: '验证会话不存在' });
      }

      if (session.userId !== userId) {
        return reply.code(403).send({ error: 'wrong_user', message: '此验证链接不属于您' });
      }

      if (session.status !== 'pending') {
        return reply.code(400).send({ error: 'session_completed', message: '验证会话已完成或已过期' });
      }

      if (new Date() > session.expiresAt) {
        return reply.code(400).send({ error: 'session_expired', message: '验证已过期，请返回群组重新获取' });
      }

      const user = await this.userService.findById(userId);
      const group = await this.groupService.findById(session.groupId);

      const remainingMs = session.expiresAt.getTime() - Date.now();
      const remainingSeconds = Math.ceil(remainingMs / 1000);

      return reply.send({
        groupName: group?.title || '群组',
        userFirstName: user?.firstName || '',
        userLastName: user?.lastName || '',
        username: user?.username || '',
        ttlSeconds: remainingSeconds,
        siteKey: this.turnstileService.getSiteKey(),
        hcaptchaSiteKey: this.hcaptchaService.getSiteKey() || '',
      });
    });

    // ── Verification: submit ──
    fastify.post('/api/miniapp/verify', async (request, reply) => {
      const parsed = z.object({
        initData: z.string().min(1),
        sessionId: z.string().min(1),
        turnstileToken: z.string().optional(),
        hcaptchaToken: z.string().optional(),
      }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });

      const userId = this.validateInitData(parsed.data.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const remoteIp = request.ip;
      const { sessionId, turnstileToken, hcaptchaToken } = parsed.data;

      if (!turnstileToken && !hcaptchaToken) {
        return reply.code(400).send({ success: false, message: '请完成人机交互验证' });
      }

      this.logger.info('Mini App verification request', { userId, sessionId, ip: remoteIp });

      const session = await this.verificationService.getSession(sessionId);
      if (!session || session.status !== 'pending') {
        return reply.code(400).send({ success: false, message: '验证会话不存在或已完成' });
      }

      if (session.userId !== userId) {
        return reply.code(403).send({ success: false, message: '此验证链接不属于您' });
      }

      // Check attempts
      if (session.attemptCount >= 5) {
        await this.auditService.log({
          groupId: session.groupId,
          userId: session.userId,
          action: 'user_failed_verification',
          details: 'Too many attempts (Mini App)',
          ip: remoteIp,
        });
        return reply.code(429).send({ success: false, message: '尝试次数过多，请稍后再试' });
      }

      // Increment attempts
      await this.verificationService.incrementAttempts(session.id);

      // Verify Provider
      if (hcaptchaToken) {
        const hcResult = await this.hcaptchaService.verify(hcaptchaToken, remoteIp);
        if (!hcResult.success) {
          this.logger.warn('Mini App HCaptcha verification failed', {
            userId, sessionId,
            errors: hcResult['error-codes'],
          });
          return reply.code(400).send({ success: false, message: 'hCaptcha 人机验证失败，请重试' });
        }
      } else if (turnstileToken) {
        const turnstileResult = await this.turnstileService.verify(turnstileToken, remoteIp);
        if (!turnstileResult.success) {
          this.logger.warn('Mini App Turnstile verification failed', {
            userId, sessionId,
            errors: turnstileResult['error-codes'],
          });
          return reply.code(400).send({ success: false, message: 'CF 人机验证失败，请重试' });
        }
      }

      // Mark session as verified
      const verified = await this.verificationService.verifySession(
        session.id, remoteIp, request.headers['user-agent'],
      );
      if (!verified) {
        return reply.code(400).send({ success: false, message: '验证失败，请重试' });
      }

      // Remove restrictions from user
      const chatId = Number(session.groupId);
      const numericUserId = Number(session.userId);

      try {
        await unrestrictUser(this.bot.getBot(), chatId, numericUserId);
        this.logger.info('User verified via Mini App and unrestricted', { userId, groupId: session.groupId });
      } catch (error) {
        this.logger.error('Failed to unrestrict user', error);
      }

      // Log verification
      await this.auditService.log({
        groupId: session.groupId,
        userId: session.userId,
        action: 'user_verified',
        details: 'Verification completed via Mini App',
        ip: remoteIp,
      });

      // Send success notification to group (auto-deletes after 30s)
      const group = await this.groupService.findById(session.groupId);
      const groupName = group?.title || '群组';
      try {
        const user = await this.userService.findById(session.userId);
        const userMention = formatUserMention(user, session.userId);
        await sendTemporaryMessage(
          this.bot.getBot(), chatId,
          `✅ ${userMention} 已成功通过验证，欢迎加入群组！`,
          { parse_mode: 'Markdown' },
        );
      } catch (error) {
        this.logger.error('Failed to send group notification', error);
      }

      // Delete welcome message from group
      if (session.messageId) {
        try {
          await this.bot.getBot().api.deleteMessage(chatId, session.messageId);
        } catch (error) {
          this.logger.debug('Could not delete welcome message');
        }
      }

      return reply.send({ success: true, message: '验证成功！', groupName });
    });

    // ── Leaderboard ──
    fastify.post('/api/miniapp/leaderboard', async (request, reply) => {
      const parsed = z.object({
        initData: z.string().min(1),
        groupId: z.string().min(1),
      }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });

      const userId = this.validateInitData(parsed.data.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { groupId } = parsed.data;

      // Ensure the group exists
      const group = await this.groupService.findById(groupId);
      if (!group) return reply.code(404).send({ error: 'Group not found' });

      const settings = await this.groupService.getSettings(groupId);
      const customTitles = settings?.customSettings?.customTitles || null;

      // Fetch Top 30 for both XP and Coins
      const topXpProfiles = await this.levelService.getLeaderboard(groupId, 30);
      const topCoinsProfiles = await this.levelService.getCoinsLeaderboard(groupId, 30);

      // Helper to map profiles to user infos
      const mapProfile = async (p: any) => {
        const user = await this.userService.findById(p.userId);
        const name = user?.firstName || user?.username || p.userId;
        return {
          userId: p.userId,
          name,
          username: user?.username,
          avatarChar: name.charAt(0).toUpperCase(),
          level: p.level,
          xp: p.xp,
          coins: p.coins,
          title: LevelService.getTitle(p.level, customTitles),
        };
      };

      const xpList = await Promise.all(topXpProfiles.map(mapProfile));
      const coinsList = await Promise.all(topCoinsProfiles.map(mapProfile));

      // Current user's info
      const myProfile = await this.levelService.getOrCreateProfile(userId, groupId);
      const myXpRank = await this.levelService.getRank(userId, groupId);
      const myCoinsRank = await this.levelService.getCoinsRank(userId, groupId);

      return reply.send({
        groupName: group.title,
        xpList,
        coinsList,
        myStats: {
          level: myProfile.level,
          xp: myProfile.xp,
          coins: myProfile.coins,
          xpRank: myXpRank,
          coinsRank: myCoinsRank,
          title: LevelService.getTitle(myProfile.level, customTitles)
        }
      });
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
