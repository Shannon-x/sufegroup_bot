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
import { RateLimitMiddleware } from '../middleware/RateLimitMiddleware';
import { redisService } from '../services/RedisService';
import { sendTemporaryMessage, formatUserMention } from '../utils/telegram';
import { buildMention, displayName, escapeHtml } from '../utils/markdown';
import { avatarInitial } from '../utils/avatar';
import { getUserAvatarDataUrl } from '../utils/avatarPhoto';
import { assessCaptchaResult, CaptchaAssessment } from './captchaGuard';
import {
  acquireCommitLock,
  handleFailedCommit,
  releaseCommitLock,
  unrestrictThenCommit,
  VERIFY_COMMIT_LOCK_SECONDS,
} from './verificationCommit';

/**
 * Cache TTL for a confirmed membership. Short-lived because the only way out of
 * the cache is expiry — the controller sees no leave/join events.
 */
const MEMBER_CACHE_TTL = 60;
/**
 * Cache TTL for a *negative* answer. Much shorter than the positive one: a
 * member who just joined (or whose lookup failed once) would otherwise be told
 * "you are not in this group" for a full minute with no way to refresh it.
 */
const MEMBER_NEGATIVE_CACHE_TTL = 10;

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
  private rateLimiter: RateLimitMiddleware;
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
    this.rateLimiter = new RateLimitMiddleware();
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
    // Every call fans a getChatMember out over all known groups, so an
    // unlimited endpoint is both a Bot API amplifier and a group-enumeration
    // oracle. Budget it by IP here and by identity below.
    fastify.post('/api/admin/groups', {
      preHandler: async (request, reply) => {
        if (!(await this.rateLimiter.adminApiLimit(request, reply))) return reply;
      },
    }, async (request, reply) => {
      const parsed = InitDataBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request', details: parsed.error.issues });

      const userId = this.validateInitData(parsed.data.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      // initData stays valid for an hour and can be replayed from any address,
      // so the IP budget alone does not cap the fan-out per account.
      if (!(await this.rateLimiter.userActionLimit(userId, 'admin-groups', 60000, 10))) {
        return reply.code(429).send({ error: 'Too Many Requests', message: '请求过于频繁，请稍后再试' });
      }

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
      const updatesRecord = updates as Record<string, any>;
      for (const key of Object.keys(updates)) {
        if (allowed[key]) safeUpdates[key] = updatesRecord[key];
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
        let text = `🎰 <b>新抽奖活动！</b>  #${lottery.id}\n\n`;
        text += `🎁 奖品: <b>${escapeHtml(cleanPrize)}</b>\n`;
        text += `👥 中奖人数: ${cleanCount}\n`;
        text += `⏱ 时长: ${cleanDuration < 60 ? cleanDuration + '分钟' : (cleanDuration / 60) + '小时'}\n`;
        if (cleanLevel > 0) text += `📊 最低等级: Lv.${cleanLevel}\n`;
        if (cleanCoins > 0) text += `💰 参与费用: ${cleanCoins} 积分\n`;
        text += `\n发送 <code>/join ${lottery.id}</code> 参与！`;

        const msg = await this.bot.getBot().api.sendMessage(groupId, text, { parse_mode: 'HTML' });
        lottery.messageId = msg.message_id;
        await this.levelService.saveLottery(lottery);
      } catch (e) {
        this.logger.warn('Failed to send lottery announcement', e);
      }

      try {
        await this.auditService.log({
          groupId, userId, performedBy: userId,
          action: 'lottery_created',
          details: `#${lottery.id} ${cleanPrize} ×${cleanCount}${cleanCoins > 0 ? ` 费用${cleanCoins}` : ''}`,
        });
      } catch (e) { this.logger.warn('Failed to write lottery audit log', e); }

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

      // Destructive action: re-check admin status without cache so a just-demoted
      // user can't draw within the cache TTL window.
      const isAdmin = await this.groupService.isAdminCached(Number(lottery.groupId), Number(userId), this.bot.getBot().api, true);
      if (!isAdmin) return reply.code(403).send({ error: 'Forbidden' });

      const result = await this.levelService.drawLottery(Number(lotteryId));
      if (!result.success) return reply.code(400).send({ error: result.reason });

      // Send draw result announcement
      try {
        const winners = result.winners || [];
        const winnerMentions = await Promise.all(
          winners.map(async (wId) => {
            const user = await this.userService.findById(wId);
            return buildMention(user, wId);
          })
        );
        let text = `🎉 <b>抽奖 #${escapeHtml(lotteryId)} 开奖！</b>\n\n`;
        text += `🎁 奖品: <b>${escapeHtml(lottery.prize)}</b>\n`;
        text += `👥 参与人数: ${lottery.participants.length}\n\n`;
        text += `🏆 <b>中奖名单</b>\n`;
        text += winnerMentions.map((m, i) => `${i + 1}. ${m}`).join('\n');
        await this.bot.getBot().api.sendMessage(lottery.groupId, text, { parse_mode: 'HTML' });
      } catch (e) {
        this.logger.warn('Failed to send draw announcement', e);
      }

      try {
        await this.auditService.log({
          groupId: lottery.groupId, userId, performedBy: userId,
          action: 'lottery_drawn',
          details: `#${lotteryId} 参与${lottery.participants.length} 中奖${(result.winners || []).length}`,
        });
      } catch (e) { this.logger.warn('Failed to write lottery audit log', e); }

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

      // Destructive action: re-check admin status without cache.
      const isAdmin = await this.groupService.isAdminCached(Number(lottery.groupId), Number(userId), this.bot.getBot().api, true);
      if (!isAdmin) return reply.code(403).send({ error: 'Forbidden' });

      if (lottery.status !== 'active') return reply.code(400).send({ error: '抽奖已结束' });

      // Atomic cancel + transactional refund (prevents double-refund on
      // concurrent cancels — the inline non-atomic loop was a race).
      const cancelResult = await this.levelService.adminCancelLottery(Number(lotteryId));
      if (!cancelResult.success) return reply.code(400).send({ error: cancelResult.reason });

      try {
        await this.auditService.log({
          groupId: lottery.groupId, userId, performedBy: userId,
          action: 'lottery_cancelled',
          details: `#${lotteryId} ${lottery.prize}`,
        });
      } catch (e) { this.logger.warn('Failed to write lottery audit log', e); }

      return reply.send({ success: true });
    });
    // ── Verification: get session info ──
    fastify.post('/api/miniapp/verify/session', {
      // Returning the reply short-circuits the lifecycle. Without it Fastify
      // runs the handler anyway and the 429 body races a second send, so the
      // limit costs the client nothing.
      preHandler: async (request, reply) => {
        if (!(await this.rateLimiter.verifyPageLimit(request, reply))) return reply;
      },
    }, async (request, reply) => {
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

      // Real Telegram profile photo (cached, null if none/private → client falls
      // back to the initial-letter avatar).
      const avatarUrl = await getUserAvatarDataUrl(this.bot.getBot().api, userId);

      return reply.send({
        groupName: group?.title || '群组',
        userFirstName: user?.firstName || '',
        userLastName: user?.lastName || '',
        username: user?.username || '',
        avatarUrl,
        ttlSeconds: remainingSeconds,
        siteKey: this.turnstileService.getSiteKey(),
        hcaptchaSiteKey: this.hcaptchaService.getSiteKey() || '',
      });
    });

    // ── Verification: submit ──
    fastify.post('/api/miniapp/verify', {
      preHandler: async (request, reply) => {
        if (!(await this.rateLimiter.apiVerifyLimit(request, reply))) return reply;
      },
    }, async (request, reply) => {
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

      // Expiry is checked up front, not only inside verifySession: below we lift
      // the restriction *before* the session is closed out, and an expired
      // window must never reach that call.
      if (new Date() > session.expiresAt) {
        return reply.code(400).send({ success: false, message: '验证已过期，请返回群组重新获取' });
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

      // Verify provider. Attempts are charged *after* the provider answers, and
      // only for a genuine rejection: counting one up front meant every
      // infrastructure failure — whose own message asks the user to retry —
      // walked the user into the too-many-attempts branch above.
      let assessment: CaptchaAssessment;
      let providerLabel: string;
      let providerErrors: string[] | undefined;

      if (hcaptchaToken) {
        const hcResult = await this.hcaptchaService.verify(hcaptchaToken, remoteIp);
        providerErrors = hcResult['error-codes'];
        providerLabel = 'hCaptcha';
        assessment = await assessCaptchaResult({
          provider: 'hcaptcha',
          result: hcResult,
          token: hcaptchaToken,
          sessionId: session.id,
          // Our Mini App widget code always binds the session id where the
          // provider supports it; hCaptcha has no cData equivalent.
          requireCdata: true,
        });
      } else {
        const turnstileResult = await this.turnstileService.verify(turnstileToken as string, remoteIp);
        providerErrors = turnstileResult['error-codes'];
        providerLabel = 'CF';
        assessment = await assessCaptchaResult({
          provider: 'turnstile',
          result: turnstileResult,
          token: turnstileToken as string,
          sessionId: session.id,
          requireCdata: true,
        });
      }

      if (!assessment.ok) {
        if (assessment.kind === 'infrastructure') {
          // Undecidable, not failed: no attempt is charged and no verdict is
          // implied about the user.
          this.logger.error('Mini App captcha could not be assessed', {
            userId, sessionId, reason: assessment.reason,
          });
          return reply.code(503).send({ success: false, message: '验证服务暂时不可用，请稍后重试' });
        }

        await this.verificationService.incrementAttempts(session.id);
        this.logger.warn('Mini App captcha verification failed', {
          userId, sessionId,
          provider: providerLabel,
          reason: assessment.reason,
          errors: providerErrors,
        });
        return reply.code(400).send({ success: false, message: `${providerLabel} 人机验证失败，请重试` });
      }

      // Single-flight the commit. Concurrent submits for one session would
      // otherwise each unrestrict, each flip the session to verified and each
      // announce it. The lock is taken only after the captcha passed, so a user
      // retrying a failed challenge is never blocked by their own attempt.
      const lockResult = await acquireCommitLock(`verify-commit:${session.id}`, VERIFY_COMMIT_LOCK_SECONDS);
      if (lockResult.state === 'busy') {
        return reply.code(409).send({ success: false, message: '验证正在处理中，请稍候' });
      }
      if (lockResult.state === 'unavailable') {
        // No lock, no commit: the alternative is two concurrent submits both
        // unrestricting and both announcing.
        return reply.code(503).send({ success: false, message: '验证服务暂时不可用，请稍后重试' });
      }
      const commitLock = lockResult.lock;

      const chatId = Number(session.groupId);
      const numericUserId = Number(session.userId);

      // Unrestrict and record the verification as one reversible step: if the
      // session write loses its race the mute goes back on, so a submission
      // timed to land just as the session expires cannot leave an unverified
      // account permanently able to speak.
      const commit = await unrestrictThenCommit({
        bot: this.bot.getBot(),
        chatId,
        userId: numericUserId,
        commit: () => this.verificationService.verifySession(
          session.id, remoteIp, request.headers['user-agent'],
        ),
      });

      if (commit.status !== 'committed') {
        // The session is still pending, so let the user retry as soon as the
        // underlying problem is fixed.
        await releaseCommitLock(commitLock);

        const failure = await handleFailedCommit({
          bot: this.bot.getBot(),
          chatId,
          groupId: session.groupId,
          userId: session.userId,
          result: commit,
          source: 'Mini App',
          audit: async ({ action, details }) => {
            try {
              await this.auditService.log({
                groupId: session.groupId, userId: session.userId, action, details, ip: remoteIp,
              });
            } catch (error) {
              this.logger.error(`Failed to write ${action} audit log`, error);
            }
          },
          mention: async () => formatUserMention(
            await this.userService.findById(session.userId), session.userId,
          ),
        });

        return reply.code(failure.statusCode).send({ success: false, message: failure.message });
      }

      this.logger.info('User verified via Mini App and unrestricted', { userId, groupId: session.groupId });

      // Log verification
      try {
        await this.auditService.log({
          groupId: session.groupId,
          userId: session.userId,
          action: 'user_verified',
          details: 'Verification completed via Mini App',
          ip: remoteIp,
        });
      } catch (error) {
        this.logger.error('Failed to write user_verified audit log', error);
      }

      // Send success notification to group (auto-deletes after 30s)
      const group = await this.groupService.findById(session.groupId);
      const groupName = group?.title || '群组';
      try {
        const user = await this.userService.findById(session.userId);
        const userMention = formatUserMention(user, session.userId);
        await sendTemporaryMessage(
          this.bot.getBot(), chatId,
          `✅ ${userMention} 已成功通过验证，欢迎加入群组！`,
          { parse_mode: 'HTML' },
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
    fastify.post('/api/miniapp/leaderboard', {
      preHandler: async (request, reply) => {
        if (!(await this.rateLimiter.verifyPageLimit(request, reply))) return reply;
      },
    }, async (request, reply) => {
      const parsed = z.object({
        initData: z.string().min(1),
        groupId: z.string().min(1),
      }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });

      const userId = this.validateInitData(parsed.data.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { groupId } = parsed.data;

      // Membership gate *first*. Being a valid Telegram user used to be enough:
      // anyone who learned a group id could read its roster and stats.
      // Fail-closed — if Telegram cannot confirm membership we refuse rather
      // than leak it. It also runs before any lookup that could answer a
      // different way for a known group than for an unknown one: the 404 that
      // used to come first was a free "does this group exist?" oracle.
      if (!(await this.isGroupMember(Number(groupId), Number(userId)))) {
        return reply.code(403).send({ error: 'not_a_member', message: '您不在该群组内，无法查看排行榜' });
      }

      const group = await this.groupService.findById(groupId);
      if (!group) return reply.code(404).send({ error: 'Group not found' });

      const settings = await this.groupService.getSettings(groupId);
      const customTitles = settings?.customSettings?.customTitles || null;

      // Fetch Top 30 for both XP and Coins
      const topXpProfiles = await this.levelService.getLeaderboard(groupId, 30);
      const topCoinsProfiles = await this.levelService.getCoinsLeaderboard(groupId, 30);

      // Batch-fetch all referenced users in one query to avoid N+1
      const userMap = await this.userService.findByIds(
        [...topXpProfiles, ...topCoinsProfiles].map((p) => p.userId)
      );

      // Helper to map profiles to user infos
      const mapProfile = (p: any) => {
        const user = userMap.get(p.userId);
        // Unified resolution: full name → @username → "用户XXXX" placeholder.
        // Never surface the raw numeric id (happens when the users table has no
        // row for a member who only ever sent messages).
        const name = displayName(user, p.userId);
        // The raw numeric id stays server-side: the client renders none of it,
        // and shipping it turned the leaderboard into a user-id harvester.
        return {
          name,
          username: user?.username,
          avatarChar: avatarInitial(name.replace(/^@/, '')),
          level: p.level,
          xp: p.xp,
          coins: p.coins,
          title: LevelService.getTitle(p.level, customTitles),
        };
      };

      const xpList = topXpProfiles.map(mapProfile);
      const coinsList = topCoinsProfiles.map(mapProfile);

      // Current user's info. Creating the profile row here is only safe because
      // membership was confirmed above — the unguarded version seeded isActive
      // rows for outsiders and polluted the ranking.
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

  /**
   * Is this user actually in the chat? Cached briefly, and fail-closed: an
   * unreachable Bot API must not turn a membership check into a rubber stamp.
   */
  private async isGroupMember(chatId: number, userId: number): Promise<boolean> {
    const cacheKey = `member:${chatId}:${userId}`;

    try {
      const cached = await redisService.get(cacheKey);
      if (cached !== null) return cached === '1';
    } catch (error) {
      this.logger.warn('Membership cache read failed, asking Telegram', error);
    }

    try {
      const member = await this.bot.getBot().api.getChatMember(chatId, userId);
      // 'restricted' still counts while is_member holds — a muted member is a
      // member. 'left' / 'kicked' do not.
      const isMember =
        member.status === 'creator' ||
        member.status === 'administrator' ||
        member.status === 'member' ||
        (member.status === 'restricted' && member.is_member);

      try {
        // A "no" expires quickly on purpose — see MEMBER_NEGATIVE_CACHE_TTL.
        await redisService.set(
          cacheKey,
          isMember ? '1' : '0',
          isMember ? MEMBER_CACHE_TTL : MEMBER_NEGATIVE_CACHE_TTL,
        );
      } catch (error) {
        this.logger.debug('Could not cache membership result', error);
      }

      return isMember;
    } catch (error) {
      // Not cached: a Bot API blip must not pin a real member out for a whole
      // cache window.
      this.logger.warn('getChatMember failed, denying membership', { chatId, userId, error });
      return false;
    }
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

      // Constant-time comparison to avoid timing attacks (guard length first
      // since timingSafeEqual throws on mismatched buffer lengths).
      const computedBuf = Buffer.from(computedHash, 'hex');
      const hashBuf = Buffer.from(hash, 'hex');
      if (computedBuf.length !== hashBuf.length || !crypto.timingSafeEqual(computedBuf, hashBuf)) {
        return null;
      }

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
