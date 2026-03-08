import { FastifyInstance } from 'fastify';
import { CryptoUtils } from '../utils/crypto';
import { VerificationService } from '../services/VerificationService';
import { UserService } from '../services/UserService';
import { GroupService } from '../services/GroupService';
import { AuditService } from '../services/AuditService';
import { TurnstileService } from '../services/TurnstileService';
import { TelegramBot } from '../services/TelegramBot';
import { Logger } from '../utils/logger';
import { config } from '../config/config';
import { sendTemporaryMessage, kickUser, unrestrictUser, formatUserMention } from '../utils/telegram';

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
  private bot: TelegramBot;
  private logger: Logger;

  constructor(bot: TelegramBot) {
    this.verificationService = new VerificationService();
    this.userService = new UserService();
    this.groupService = new GroupService();
    this.auditService = new AuditService();
    this.turnstileService = new TurnstileService();
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
              { parse_mode: 'Markdown' }
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

        // Get user and group info
        const user = await this.userService.findById(tokenData.userId);
        const group = await this.groupService.findOrCreate({
          id: parseInt(tokenData.groupId),
          type: 'group',
          title: 'Group'
        });

        if (!user) {
          return reply.view('error', {
            message: '用户信息不存在',
            canRetry: false,
            botUsername
          });
        }

        const remainingMs = session.expiresAt.getTime() - Date.now();
        const remainingMinutes = Math.ceil(remainingMs / 60000);

        return reply.view('verify', {
          token,
          siteKey: this.turnstileService.getSiteKey(),
          groupName: group.group.title,
          userFirstName: user.firstName,
          userLastName: user.lastName,
          username: user.username,
          ttlMinutes: remainingMinutes,
          botUsername
        });
      }
    );

    // Handle verification submission
    fastify.post<{ Body: VerifyBody }>(
      '/api/verify',
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
              { parse_mode: 'Markdown' }
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

        // Increment attempts
        await this.verificationService.incrementAttempts(session.id);

        // Verify Turnstile
        const turnstileResult = await this.turnstileService.verify(turnstileToken, remoteIp);
        if (!turnstileResult.success) {
          this.logger.warn('Turnstile verification failed', {
            userId: session.userId,
            groupId: session.groupId,
            errors: turnstileResult['error-codes']
          });

          return reply.code(400).send({
            success: false,
            message: '人机验证失败，请重试'
          });
        }

        // Mark session as verified
        const verified = await this.verificationService.verifySession(
          session.id,
          remoteIp,
          request.headers['user-agent']
        );

        if (!verified) {
          return reply.code(400).send({
            success: false,
            message: '验证失败，请重试'
          });
        }

        // Remove restrictions from user
        const chatId = Number(session.groupId);
        const userId = Number(session.userId);

        try {
          await unrestrictUser(this.bot.getBot(), chatId, userId);
          this.logger.info('User verified and unrestricted', {
            userId: session.userId,
            groupId: session.groupId
          });
        } catch (error) {
          this.logger.error('Failed to unrestrict user', error);
        }

        // Log verification
        await this.auditService.log({
          groupId: session.groupId,
          userId: session.userId,
          action: 'user_verified',
          details: 'Verification completed successfully',
          ip: remoteIp
        });

        // Send success notification via private message
        try {
          const group = await this.groupService.findById(session.groupId);
          const groupName = group?.title || '群组';

          await this.bot.getBot().api.sendMessage(
            userId,
            `✅ 验证成功！\n\n您已成功完成 **${groupName}** 的验证，现在可以正常发言了。\n\n感谢您的配合！`,
            { parse_mode: 'Markdown' }
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
            { parse_mode: 'Markdown' }
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
