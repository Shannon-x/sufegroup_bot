import { FastifyInstance } from 'fastify';
import { CryptoUtils } from '../utils/crypto';
import { VerificationService } from '../services/VerificationService';
import { UserService } from '../services/UserService';
import { GroupService } from '../services/GroupService';
import { AuditService } from '../services/AuditService';
import { TurnstileService } from '../services/TurnstileService';
import { TelegramBot } from '../services/TelegramBot';
import { RateLimitMiddleware } from '../middleware/RateLimitMiddleware';
import { Logger } from '../utils/logger';
import { config } from '../config/config';
import { sendTemporaryMessage, kickUser, formatUserMention } from '../utils/telegram';
import { escapeHtml } from '../utils/markdown';
import { avatarInitial } from '../utils/avatar';
import { getUserAvatarDataUrl } from '../utils/avatarPhoto';
import { assessCaptchaResult } from './captchaGuard';
import {
  acquireCommitLock,
  handleFailedCommit,
  releaseCommitLock,
  unrestrictThenCommit,
  VERIFY_COMMIT_LOCK_SECONDS,
} from './verificationCommit';

interface VerifyQuerystring {
  token: string;
}

interface VerifyBody {
  token: string;
  turnstileToken: string;
}

export class VerificationController {
  private verificationService: VerificationService;
  private userService: UserService;
  private groupService: GroupService;
  private auditService: AuditService;
  private turnstileService: TurnstileService;
  private rateLimiter: RateLimitMiddleware;
  private bot: TelegramBot;
  private logger: Logger;

  constructor(bot: TelegramBot) {
    this.verificationService = new VerificationService();
    this.userService = new UserService();
    this.groupService = new GroupService();
    this.auditService = new AuditService();
    this.turnstileService = new TurnstileService();
    this.rateLimiter = new RateLimitMiddleware();
    this.bot = bot;
    this.logger = new Logger('VerificationController');
  }

  async register(fastify: FastifyInstance) {
    // Render verification page
    fastify.get<{ Querystring: VerifyQuerystring }>(
      '/verify',
      async (request, reply) => {
        const { token } = request.query;
        const botUsername = config.bot.username || 'bot';

        const tokenData = CryptoUtils.verifyVerificationToken(token);
        if (!tokenData) {
          return reply.view('error', {
            message: '无效或过期的验证链接',
            canRetry: false,
            botUsername
          });
        }

        const session = await this.verificationService.getSession(tokenData.sessionId);
        if (!session || session.status !== 'pending') {
          return reply.view('error', {
            message: '验证会话不存在或已完成',
            canRetry: false,
            botUsername
          });
        }

        // Check if expired
        if (new Date() > session.expiresAt) {
          await this.verificationService.incrementAttempts(session.id);

          try {
            const user = await this.userService.findById(tokenData.userId);
            const userMention = formatUserMention(user, tokenData.userId);

            await sendTemporaryMessage(
              this.bot.getBot(),
              Number(tokenData.groupId),
              `⏰ ${userMention} 尝试使用已过期的验证链接。请返回群组重新获取验证链接。`,
              { parse_mode: 'HTML' }
            );
          } catch (error) {
            this.logger.error('Failed to send expiration notification', error);
          }

          return reply.view('error', {
            message: '验证已过期，请返回群组重新获取验证链接',
            canRetry: false,
            botUsername
          });
        }

        // Get user and group info. Read-only on purpose: the old findOrCreate
        // passed a synthetic chat titled 'Group', which overwrote the group's
        // real title in the DB on every page load.
        const user = await this.userService.findById(tokenData.userId);
        const group = await this.groupService.findById(tokenData.groupId);
        const groupName = group?.title || '群组';

        if (!user) {
          return reply.view('error', {
            message: '用户信息不存在',
            canRetry: false,
            botUsername
          });
        }

        const remainingMs = session.expiresAt.getTime() - Date.now();
        const remainingMinutes = Math.ceil(remainingMs / 60000);

        const avatarUrl = await getUserAvatarDataUrl(this.bot.getBot().api, user.id);

        return reply.view('verify', {
          token,
          siteKey: this.turnstileService.getSiteKey(),
          // Binds the solved token to this session. Turnstile echoes cData back
          // in the siteverify response, so a token solved for someone else's
          // session and relayed here is rejected.
          sessionId: session.id,
          groupName,
          userFirstName: user.firstName,
          userLastName: user.lastName,
          username: user.username,
          avatarChar: avatarInitial(user.firstName),
          avatarUrl,
          ttlMinutes: remainingMinutes,
          botUsername
        });
      }
    );

    // Handle verification submission
    fastify.post<{ Body: VerifyBody }>(
      '/api/verify',
      {
        // Returning the reply short-circuits the lifecycle. Without it Fastify
        // runs the handler anyway and the 429 body races a second send, so the
        // limit costs the client nothing.
        preHandler: async (request, reply) => {
          if (!(await this.rateLimiter.apiVerifyLimit(request, reply))) return reply;
        },
      },
      async (request, reply) => {
        const { token, turnstileToken } = request.body;
        const remoteIp = request.ip;

        this.logger.info('Verification request received', {
          ip: remoteIp,
          hasToken: !!token,
          hasTurnstileToken: !!turnstileToken
        });

        const tokenData = CryptoUtils.verifyVerificationToken(token);
        if (!tokenData) {
          return reply.code(400).send({
            success: false,
            message: '无效的验证令牌'
          });
        }

        const session = await this.verificationService.getSession(tokenData.sessionId);
        if (!session || session.status !== 'pending') {
          return reply.code(400).send({
            success: false,
            message: '验证会话不存在或已完成'
          });
        }

        // Expiry is checked up front, not only inside verifySession: below we
        // lift the restriction *before* the session is closed out, and an
        // expired window must never reach that call.
        if (new Date() > session.expiresAt) {
          return reply.code(400).send({
            success: false,
            message: '验证已过期，请返回群组重新获取验证链接'
          });
        }

        // Check attempts
        if (session.attemptCount >= 5) {
          await this.auditService.log({
            groupId: session.groupId,
            userId: session.userId,
            action: 'user_failed_verification',
            details: 'Too many attempts',
            ip: remoteIp
          });

          try {
            const user = await this.userService.findById(session.userId);
            const userMention = formatUserMention(user, session.userId);

            await sendTemporaryMessage(
              this.bot.getBot(),
              Number(session.groupId),
              `❌ ${userMention} 验证失败（尝试次数过多），已被移除。`,
              { parse_mode: 'HTML' }
            );

            await kickUser(this.bot.getBot(), Number(session.groupId), Number(session.userId));
          } catch (error) {
            this.logger.error('Failed to handle too-many-attempts', error);
          }

          return reply.code(429).send({
            success: false,
            message: '尝试次数过多，请稍后再试'
          });
        }

        // Verify Turnstile. The same acceptance rules as the Mini App endpoint —
        // this page hands out the identical pass, so `success` alone was the
        // cheap way past hostname, freshness and single-use checks.
        const turnstileResult = await this.turnstileService.verify(turnstileToken, remoteIp);
        const assessment = await assessCaptchaResult({
          provider: 'turnstile',
          result: turnstileResult,
          token: turnstileToken,
          sessionId: session.id,
          // views/verify.ejs renders Turnstile implicitly, and implicit
          // rendering does accept data-cdata — the earlier claim that this page
          // "has no way to pass cData" was simply wrong, and it left the
          // binding switched off on the one endpoint an attacker can reach
          // without a Telegram client.
          requireCdata: true,
        });

        if (!assessment.ok) {
          if (assessment.kind === 'infrastructure') {
            // Undecidable, not failed. Charging an attempt here is how a user
            // who *had* passed the challenge got kicked for following our own
            // "please retry" advice five times.
            this.logger.error('Turnstile result could not be assessed', {
              userId: session.userId,
              groupId: session.groupId,
              reason: assessment.reason
            });

            return reply.code(503).send({
              success: false,
              message: '验证服务暂时不可用，请稍后重试'
            });
          }

          // A real rejection is the only thing that counts against the user.
          await this.verificationService.incrementAttempts(session.id);
          this.logger.warn('Turnstile verification failed', {
            userId: session.userId,
            groupId: session.groupId,
            reason: assessment.reason,
            errors: turnstileResult['error-codes']
          });

          return reply.code(400).send({
            success: false,
            message: '人机验证失败，请重试'
          });
        }

        // Single-flight the commit. Concurrent submits for one session would
        // otherwise each unrestrict, each flip the session to verified and each
        // announce it. The lock is taken only after Turnstile passed, so a user
        // retrying a failed challenge is never blocked by their own attempt.
        const lockResult = await acquireCommitLock(`verify-commit:${session.id}`, VERIFY_COMMIT_LOCK_SECONDS);
        if (lockResult.state === 'busy') {
          return reply.code(409).send({
            success: false,
            message: '验证正在处理中，请稍候'
          });
        }
        if (lockResult.state === 'unavailable') {
          // No lock, no commit: the alternative is two concurrent submits both
          // unrestricting and both announcing.
          return reply.code(503).send({
            success: false,
            message: '验证服务暂时不可用，请稍后重试'
          });
        }
        const commitLock = lockResult.lock;

        const chatId = Number(session.groupId);
        const userId = Number(session.userId);

        // Unrestrict and record the verification as one reversible step: if the
        // session write loses its race the mute goes back on, so a submission
        // timed to land just as the session expires cannot leave an unverified
        // account permanently able to speak.
        const commit = await unrestrictThenCommit({
          bot: this.bot.getBot(),
          chatId,
          userId,
          commit: () => this.verificationService.verifySession(
            session.id,
            remoteIp,
            request.headers['user-agent']
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
            source: 'verify page',
            audit: async ({ action, details }) => {
              try {
                await this.auditService.log({
                  groupId: session.groupId,
                  userId: session.userId,
                  action,
                  details,
                  ip: remoteIp
                });
              } catch (error) {
                this.logger.error(`Failed to write ${action} audit log`, error);
              }
            },
            mention: async () => formatUserMention(
              await this.userService.findById(session.userId),
              session.userId
            ),
          });

          return reply.code(failure.statusCode).send({
            success: false,
            message: failure.message
          });
        }

        this.logger.info('User verified and unrestricted', {
          userId: session.userId,
          groupId: session.groupId
        });

        // Log verification
        try {
          await this.auditService.log({
            groupId: session.groupId,
            userId: session.userId,
            action: 'user_verified',
            details: 'Verification completed successfully',
            ip: remoteIp
          });
        } catch (error) {
          this.logger.error('Failed to write user_verified audit log', error);
        }

        // Send success notification via private message
        try {
          const group = await this.groupService.findById(session.groupId);
          const groupName = group?.title || '群组';

          await this.bot.getBot().api.sendMessage(
            userId,
            `✅ 验证成功！\n\n您已成功完成 <b>${escapeHtml(groupName)}</b> 的验证，现在可以正常发言了。\n\n感谢您的配合！`,
            { parse_mode: 'HTML' }
          );
        } catch (error) {
          this.logger.debug('Could not send private success notification (user may not have started the bot)');
        }

        // Send success notification to group (auto-deletes after 30s)
        try {
          const user = await this.userService.findById(session.userId);
          const userMention = formatUserMention(user, session.userId);

          await sendTemporaryMessage(
            this.bot.getBot(),
            chatId,
            `✅ ${userMention} 已成功通过验证，欢迎加入群组！`,
            { parse_mode: 'HTML' }
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

        return reply.send({
          success: true,
          message: '验证成功！',
          redirectUrl: '/verify/success'
        });
      }
    );

    // Success page
    fastify.get('/verify/success', async (_request, reply) => {
      return reply.view('success', {
        botUsername: config.bot.username || 'bot'
      });
    });
  }

}
