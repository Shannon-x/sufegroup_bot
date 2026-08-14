import { FastifyInstance } from 'fastify';
import crypto, { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { ChatwootVerificationService } from '../services/ChatwootVerificationService';
import { TurnstileService } from '../services/TurnstileService';
import { HCaptchaService } from '../services/HCaptchaService';
import { RateLimitMiddleware } from '../middleware/RateLimitMiddleware';
import { config } from '../config/config';
import { Logger } from '../utils/logger';
import { assessCaptchaResult, CaptchaAssessment } from './captchaGuard';
import { acquireCommitLock, releaseCommitLock, VERIFY_COMMIT_LOCK_SECONDS } from './verificationCommit';

const MiniAppSessionBody = z.object({
  initData: z.string().min(1),
  sessionId: z.string().min(1),
});

const MiniAppVerifyBody = z.object({
  initData: z.string().min(1),
  sessionId: z.string().min(1),
  turnstileToken: z.string().optional(),
  hcaptchaToken: z.string().optional(),
});

export class ChatwootVerificationController {
  private verificationService: ChatwootVerificationService;
  private turnstileService: TurnstileService;
  private hcaptchaService: HCaptchaService;
  private rateLimiter: RateLimitMiddleware;
  private logger: Logger;

  constructor() {
    this.verificationService = new ChatwootVerificationService();
    this.turnstileService = new TurnstileService();
    this.hcaptchaService = new HCaptchaService();
    this.rateLimiter = new RateLimitMiddleware();
    this.logger = new Logger('ChatwootVerificationController');
  }

  async register(fastify: FastifyInstance) {
    // Same budgets as the group verification endpoints — this gate hands out the
    // same kind of pass, so leaving it unlimited let codes be redeemed in bulk.
    // Returning the reply short-circuits the lifecycle; without it Fastify runs
    // the handler anyway and the 429 body races a second send.
    fastify.post('/api/miniapp/chatwoot/verify/session', {
      preHandler: async (request, reply) => {
        if (!(await this.rateLimiter.verifyPageLimit(request, reply))) return reply;
      },
    }, async (request, reply) => {
      const parsed = MiniAppSessionBody.safeParse(request.body);
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

      if (session.status === 'verified') {
        return reply.code(400).send({ error: 'session_completed', message: '您已经完成验证' });
      }

      if (session.status !== 'pending' || new Date() > session.expiresAt) {
        return reply.code(400).send({ error: 'session_expired', message: '验证已过期，请重新发送消息获取验证入口' });
      }

      const remainingSeconds = Math.max(1, Math.ceil((session.expiresAt.getTime() - Date.now()) / 1000));

      return reply.send({
        groupName: '客服消息验证',
        userFirstName: session.firstName || 'Telegram 用户',
        userLastName: session.lastName || '',
        username: session.username || '',
        ttlSeconds: remainingSeconds,
        siteKey: this.turnstileService.getSiteKey(),
        hcaptchaSiteKey: this.hcaptchaService.getSiteKey() || '',
      });
    });

    fastify.post('/api/miniapp/chatwoot/verify', {
      preHandler: async (request, reply) => {
        if (!(await this.rateLimiter.apiVerifyLimit(request, reply))) return reply;
      },
    }, async (request, reply) => {
      const parsed = MiniAppVerifyBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ success: false, message: 'Invalid request' });

      const userId = this.validateInitData(parsed.data.initData);
      if (!userId) return reply.code(401).send({ success: false, message: 'Unauthorized' });

      const { sessionId, turnstileToken, hcaptchaToken } = parsed.data;
      const session = await this.verificationService.getSession(sessionId);

      if (!session || session.userId !== userId || session.status !== 'pending') {
        return reply.code(400).send({ success: false, message: '验证会话不存在或已完成' });
      }

      if (new Date() > session.expiresAt) {
        return reply.code(400).send({ success: false, message: '验证已过期，请重新发送消息获取验证入口' });
      }

      if (session.attemptCount >= 5) {
        return reply.code(429).send({ success: false, message: '尝试次数过多，请稍后再试' });
      }

      if (!turnstileToken && !hcaptchaToken) {
        return reply.code(400).send({ success: false, message: '请完成人机验证' });
      }

      // Same acceptance rules as the group endpoints — this gate hands out an
      // equivalent pass, and checking only `success` here made it the weakest
      // of the three. Attempts are charged only for a genuine rejection.
      let assessment: CaptchaAssessment;
      let providerLabel: string;

      if (hcaptchaToken) {
        const result = await this.hcaptchaService.verify(hcaptchaToken, request.ip);
        providerLabel = 'hCaptcha';
        assessment = await assessCaptchaResult({
          provider: 'hcaptcha',
          result,
          token: hcaptchaToken,
          sessionId: session.id,
          requireCdata: true,
        });
      } else {
        const result = await this.turnstileService.verify(turnstileToken as string, request.ip);
        providerLabel = 'CF';
        assessment = await assessCaptchaResult({
          provider: 'turnstile',
          result,
          token: turnstileToken as string,
          sessionId: session.id,
          // Served by the same Mini App page, whose widget always sets cData.
          requireCdata: true,
        });
      }

      if (!assessment.ok) {
        if (assessment.kind === 'infrastructure') {
          this.logger.error('Chatwoot captcha could not be assessed', {
            sessionId, reason: assessment.reason,
          });
          return reply.code(503).send({ success: false, message: '验证服务暂时不可用，请稍后重试' });
        }

        await this.verificationService.incrementAttempts(session.id);
        this.logger.warn('Chatwoot captcha verification failed', {
          sessionId, provider: providerLabel, reason: assessment.reason,
        });
        return reply.code(400).send({ success: false, message: `${providerLabel} 人机验证失败，请重试` });
      }

      // Single-flight the commit so concurrent submits can't redeem the same
      // session twice. Strict: a fail-open lock stops being a guard exactly
      // when Redis is down and requests pile up.
      const lockResult = await acquireCommitLock(
        `chatwoot-verify-commit:${session.id}`, VERIFY_COMMIT_LOCK_SECONDS,
      );
      if (lockResult.state === 'busy') {
        return reply.code(409).send({ success: false, message: '验证正在处理中，请稍候' });
      }
      if (lockResult.state === 'unavailable') {
        return reply.code(503).send({ success: false, message: '验证服务暂时不可用，请稍后重试' });
      }
      const commitLock = lockResult.lock;

      const verified = await this.verificationService.verifySession(
        session.id,
        request.ip,
        request.headers['user-agent']
      );
      if (!verified) {
        // Release rather than sitting on the lock for its full TTL: the session
        // is still pending and the user is being told to retry.
        await releaseCommitLock(commitLock);
        return reply.code(400).send({ success: false, message: '验证失败，请重试' });
      }

      return reply.send({
        success: true,
        message: '验证成功！请返回客服聊天并重新发送您的消息。',
        groupName: '客服消息',
      });
    });
  }

  private safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
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

      if (!this.safeEqual(computedHash, hash)) return null;

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
