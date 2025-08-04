import { Repository } from 'typeorm';
import { AppDataSource } from '../config/database';
import { JoinSession, SessionStatus } from '../entities/JoinSession';
import { Whitelist } from '../entities/Whitelist';
import { Blacklist } from '../entities/Blacklist';
import { GroupSettings } from '../entities/GroupSettings';
import { Logger } from '../utils/logger';
import { CryptoUtils } from '../utils/crypto';
import { config } from '../config/config';

export class VerificationService {
  private sessionRepository: Repository<JoinSession>;
  private whitelistRepository: Repository<Whitelist>;
  private blacklistRepository: Repository<Blacklist>;
  private logger: Logger;

  constructor() {
    this.sessionRepository = AppDataSource.getRepository(JoinSession);
    this.whitelistRepository = AppDataSource.getRepository(Whitelist);
    this.blacklistRepository = AppDataSource.getRepository(Blacklist);
    this.logger = new Logger('VerificationService');
  }

  async createSession(
    userId: string,
    groupId: string,
    messageId: number,
    ttlMinutes: number
  ): Promise<JoinSession> {
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + ttlMinutes);

    const session = this.sessionRepository.create({
      userId,
      groupId,
      messageId,
      expiresAt,
      status: 'pending',
    });

    await this.sessionRepository.save(session);
    this.logger.info(`Created verification session for user ${userId} in group ${groupId}`);

    return session;
  }

  async getSession(sessionId: string): Promise<JoinSession | null> {
    return this.sessionRepository.findOne({
      where: { id: sessionId },
      relations: ['user', 'group']
    });
  }

  async getPendingSession(userId: string, groupId: string): Promise<JoinSession | null> {
    return this.sessionRepository.findOne({
      where: {
        userId,
        groupId,
        status: 'pending'
      },
      order: { createdAt: 'DESC' }
    });
  }

  async verifySession(sessionId: string, userIp?: string, userAgent?: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    
    if (!session || session.status !== 'pending') {
      return false;
    }

    if (new Date() > session.expiresAt) {
      session.status = 'expired';
      await this.sessionRepository.save(session);
      return false;
    }

    session.status = 'verified';
    session.verifiedAt = new Date();
    session.userIp = userIp;
    session.userAgent = userAgent;

    await this.sessionRepository.save(session);
    this.logger.info(`Verified session ${sessionId} for user ${session.userId}`);

    return true;
  }

  async incrementAttempts(sessionId: string): Promise<number> {
    const session = await this.getSession(sessionId);
    if (!session) return 0;

    session.attemptCount += 1;
    await this.sessionRepository.save(session);
    
    return session.attemptCount;
  }

  async isWhitelisted(userId: string, groupId: string): Promise<boolean> {
    const entry = await this.whitelistRepository.findOne({
      where: { userId, groupId }
    });
    return !!entry;
  }

  async isBlacklisted(userId: string, groupId: string): Promise<boolean> {
    const entry = await this.blacklistRepository.findOne({
      where: { userId, groupId }
    });
    return !!entry;
  }

  async addToWhitelist(userId: string, groupId: string, addedBy: string, reason?: string): Promise<void> {
    const existing = await this.whitelistRepository.findOne({
      where: { userId, groupId }
    });

    if (!existing) {
      const entry = this.whitelistRepository.create({
        userId,
        groupId,
        addedBy,
        reason
      });
      await this.whitelistRepository.save(entry);
      this.logger.info(`Added user ${userId} to whitelist in group ${groupId}`);
    }
  }

  async removeFromWhitelist(userId: string, groupId: string): Promise<boolean> {
    const result = await this.whitelistRepository.delete({ userId, groupId });
    if (result.affected) {
      this.logger.info(`Removed user ${userId} from whitelist in group ${groupId}`);
      return true;
    }
    return false;
  }

  async addToBlacklist(userId: string, groupId: string, addedBy: string, reason?: string): Promise<void> {
    const existing = await this.blacklistRepository.findOne({
      where: { userId, groupId }
    });

    if (!existing) {
      const entry = this.blacklistRepository.create({
        userId,
        groupId,
        addedBy,
        reason
      });
      await this.blacklistRepository.save(entry);
      this.logger.info(`Added user ${userId} to blacklist in group ${groupId}`);
    }
  }

  async removeFromBlacklist(userId: string, groupId: string): Promise<boolean> {
    const result = await this.blacklistRepository.delete({ userId, groupId });
    if (result.affected) {
      this.logger.info(`Removed user ${userId} from blacklist in group ${groupId}`);
      return true;
    }
    return false;
  }

  async cleanupExpiredSessions(bot?: any): Promise<number> {
    // Get all pending sessions that have expired
    const expiredSessions = await this.sessionRepository
      .createQueryBuilder('session')
      .leftJoinAndSelect('session.user', 'user')
      .leftJoinAndSelect('session.group', 'group')
      .where('session.status = :status', { status: 'pending' })
      .andWhere('session.expiresAt < :now', { now: new Date() })
      .getMany();

    if (expiredSessions.length === 0) {
      return 0;
    }

    // Process each expired session
    for (const session of expiredSessions) {
      try {
        // Send timeout notification to group if bot is provided
        if (bot && session.user && session.group) {
          try {
            const userMention = session.user.username 
              ? `@${session.user.username}` 
              : `[${session.user.firstName || '用户'}](tg://user?id=${session.userId})`;
            
            const timeoutMsg = await bot.getBot().api.sendMessage(
              Number(session.groupId),
              `⏰ ${userMention} 未在规定时间内完成验证，已被移除。`,
              {
                parse_mode: 'Markdown'
              }
            );
            
            // Schedule deletion after 30 seconds
            setTimeout(async () => {
              try {
                await bot.getBot().api.deleteMessage(
                  Number(session.groupId),
                  timeoutMsg.message_id
                );
              } catch (error) {
                this.logger.error('Failed to delete timeout notification', error);
              }
            }, 30000);
            
            // Delete the original welcome message
            if (session.messageId) {
              try {
                await bot.getBot().api.deleteMessage(
                  Number(session.groupId),
                  session.messageId
                );
              } catch (error) {
                this.logger.error('Failed to delete welcome message', error);
              }
            }
            
            // Kick the user from the group
            try {
              await bot.getBot().api.banChatMember(
                Number(session.groupId),
                Number(session.userId)
              );
              // Immediately unban so they can rejoin later
              await bot.getBot().api.unbanChatMember(
                Number(session.groupId),
                Number(session.userId)
              );
            } catch (error) {
              this.logger.error('Failed to kick user on timeout', error);
            }
          } catch (error) {
            this.logger.error('Failed to handle timeout notification', error);
          }
        }

        // Update session status
        session.status = 'expired';
        await this.sessionRepository.save(session);
      } catch (error) {
        this.logger.error(`Failed to process expired session ${session.id}`, error);
      }
    }

    this.logger.info(`Marked ${expiredSessions.length} sessions as expired`);
    return expiredSessions.length;
  }

  generateVerificationUrl(userId: string, groupId: string, sessionId: string): string {
    const token = CryptoUtils.generateVerificationToken(userId, groupId, sessionId);
    const baseUrl = config.bot.webhookDomain || `http://${config.server.host}:${config.server.port}`;
    return `${baseUrl}/verify?token=${token}`;
  }
}