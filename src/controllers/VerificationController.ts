import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { CryptoUtils } from '../utils/crypto';
import { VerificationService } from '../services/VerificationService';
import { UserService } from '../services/UserService';
import { GroupService } from '../services/GroupService';
import { AuditService } from '../services/AuditService';
import { TurnstileService } from '../services/TurnstileService';
import { TelegramBot } from '../services/TelegramBot';
import { Logger } from '../utils/logger';
import { config } from '../config/config';

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

        // Verify token
        const tokenData = CryptoUtils.verifyVerificationToken(token);
        if (!tokenData) {
          return reply.view('error', {
            message: '无效或过期的验证链接',
            canRetry: false,
            botUsername: config.bot.username || 'bot'
          });
        }

        // Get session
        const session = await this.verificationService.getSession(tokenData.sessionId);
        if (!session || session.status !== 'pending') {
          return reply.view('error', {
            message: '验证会话不存在或已完成',
            canRetry: false,
            botUsername: config.bot.username || 'bot'
          });
        }

        // Check if expired
        if (new Date() > session.expiresAt) {
          await this.verificationService.incrementAttempts(session.id);
          
          // Send expiration notification to group
          try {
            const user = await this.userService.findById(tokenData.userId);
            const userMention = user?.username ? `@${user.username}` : `[${user?.firstName || '用户'}](tg://user?id=${tokenData.userId})`;
            
            const expireMsg = await this.bot.getBot().api.sendMessage(
              Number(tokenData.groupId),
              `⏰ ${userMention} 尝试使用已过期的验证链接。请返回群组重新获取验证链接。`,
              {
                parse_mode: 'Markdown'
              }
            );
            
            // Schedule deletion after 30 seconds
            setTimeout(async () => {
              try {
                await this.bot.getBot().api.deleteMessage(
                  Number(tokenData.groupId),
                  expireMsg.message_id
                );
              } catch (error) {
                this.logger.error('Failed to delete expiration notification', error);
              }
            }, 30000);
          } catch (error) {
            this.logger.error('Failed to send expiration notification', error);
          }
          
          return reply.view('error', {
            message: '验证已过期，请返回群组重新获取验证链接',
            canRetry: false,
            botUsername: config.bot.username || 'bot'
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
            botUsername: config.bot.username || 'bot'
          });
        }

        // Calculate remaining time
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
          botUsername: config.bot.username || 'bot'
        });
      }
    );

    // Handle verification submission
    fastify.post<{ Body: VerifyBody }>(
      '/api/verify',
      async (request, reply) => {
        this.logger.info('Verification request received', {
          contentType: request.headers['content-type'],
          body: request.body,
          ip: request.ip
        });
        
        const { token, turnstileToken } = request.body;
        const remoteIp = request.ip;

        // Verify token
        const tokenData = CryptoUtils.verifyVerificationToken(token);
        if (!tokenData) {
          return reply.code(400).send({
            success: false,
            message: '无效的验证令牌'
          });
        }

        // Get session
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

          // Send failure notification to group
          try {
            const user = await this.userService.findById(session.userId);
            const userMention = user?.username ? `@${user.username}` : `[${user?.firstName || '用户'}](tg://user?id=${session.userId})`;
            
            const failMsg = await this.bot.getBot().api.sendMessage(
              Number(session.groupId),
              `❌ ${userMention} 验证失败（尝试次数过多），已被移除。`,
              {
                parse_mode: 'Markdown'
              }
            );
            
            // Schedule deletion after 30 seconds
            setTimeout(async () => {
              try {
                await this.bot.getBot().api.deleteMessage(
                  Number(session.groupId),
                  failMsg.message_id
                );
              } catch (error) {
                this.logger.error('Failed to delete failure notification', error);
              }
            }, 30000);
            
            // Kick the user from the group
            try {
              await this.bot.getBot().api.banChatMember(
                Number(session.groupId),
                Number(session.userId)
              );
              // Immediately unban so they can rejoin later
              await this.bot.getBot().api.unbanChatMember(
                Number(session.groupId),
                Number(session.userId)
              );
            } catch (error) {
              this.logger.error('Failed to kick user', error);
            }
          } catch (error) {
            this.logger.error('Failed to send failure notification', error);
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
        try {
          // To completely unrestrict a user, we need to promote and then demote them
          // This is the only way to change status from 'restricted' to 'member'
          const chatId = Number(session.groupId);
          const userId = Number(session.userId);
          
          // First promote with no permissions
          await this.bot.getBot().api.promoteChatMember(chatId, userId, {
            can_manage_chat: false,
            can_post_messages: false,
            can_edit_messages: false,
            can_delete_messages: false,
            can_manage_video_chats: false,
            can_restrict_members: false,
            can_promote_members: false,
            can_change_info: false,
            can_invite_users: false,
            can_pin_messages: false,
          });
          
          // Then immediately demote back to regular member
          await this.bot.getBot().api.promoteChatMember(chatId, userId, {
            can_manage_chat: false,
            can_post_messages: false,
            can_edit_messages: false,
            can_delete_messages: false,
            can_manage_video_chats: false,
            can_restrict_members: false,
            can_promote_members: false,
            can_change_info: false,
            can_invite_users: false,
            can_pin_messages: false,
          });

          this.logger.info('User verified and changed to member status', {
            userId: session.userId,
            groupId: session.groupId
          });
        } catch (error) {
          this.logger.error('Error removing restrictions', error);
          
          // Fallback to the old method if promote/demote fails
          try {
            await this.bot.getBot().api.restrictChatMember(
              Number(session.groupId),
              Number(session.userId),
              {
                can_send_messages: true,
                can_send_audios: true,
                can_send_documents: true,
                can_send_photos: true,
                can_send_videos: true,
                can_send_video_notes: true,
                can_send_voice_notes: true,
                can_send_polls: true,
                can_send_other_messages: true,
                can_add_web_page_previews: true,
                can_change_info: false,
                can_invite_users: true,
                can_pin_messages: false,
              }
            );
            this.logger.info('User verified using fallback method', {
              userId: session.userId,
              groupId: session.groupId
            });
          } catch (fallbackError) {
            this.logger.error('Fallback method also failed', fallbackError);
          }
        }

        // DISABLED: Add user to whitelist - User requested no whitelist
        // await this.verificationService.addToWhitelist(
        //   session.userId,
        //   session.groupId,
        //   'system',
        //   'Auto-added after successful verification'
        // );

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
            Number(session.userId),
            `✅ 验证成功！\n\n您已成功完成 **${groupName}** 的验证，现在可以正常发言了。\n\n感谢您的配合！`,
            {
              parse_mode: 'Markdown'
            }
          );
          
          this.logger.info('Sent verification success notification', {
            userId: session.userId,
            groupId: session.groupId
          });
        } catch (error) {
          this.logger.error('Failed to send success notification', error);
        }

        // Send verification success notification to group
        try {
          const user = await this.userService.findById(session.userId);
          const userMention = user?.username ? `@${user.username}` : `[${user?.firstName || '用户'}](tg://user?id=${session.userId})`;
          
          const successMsg = await this.bot.getBot().api.sendMessage(
            Number(session.groupId),
            `✅ ${userMention} 已成功通过验证，欢迎加入群组！`,
            {
              parse_mode: 'Markdown'
            }
          );
          
          // Schedule deletion of success message after 30 seconds
          setTimeout(async () => {
            try {
              await this.bot.getBot().api.deleteMessage(
                Number(session.groupId),
                successMsg.message_id
              );
            } catch (error) {
              this.logger.error('Failed to delete success notification', error);
            }
          }, 30000);
          
          this.logger.info('Sent verification success notification to group', {
            userId: session.userId,
            groupId: session.groupId
          });
        } catch (error) {
          this.logger.error('Failed to send group notification', error);
        }

        // Delete welcome message from group
        try {
          if (session.messageId) {
            await this.bot.getBot().api.deleteMessage(
              Number(session.groupId),
              session.messageId
            );
            
            this.logger.info('Deleted welcome message from group', {
              messageId: session.messageId,
              groupId: session.groupId
            });
          }
        } catch (error) {
          this.logger.error('Failed to delete welcome message', error);
        }

        return reply.send({
          success: true,
          message: '验证成功！',
          redirectUrl: '/verify/success'
        });
      }
    );

    // Success page
    fastify.get('/verify/success', async (request, reply) => {
      return reply.view('success', {
        botUsername: config.bot.username || 'bot'
      });
    });
  }
}