import { Repository } from 'typeorm';
import { AppDataSource } from '../config/database';
import { JoinSession, SessionStatus } from '../entities/JoinSession';
import { Whitelist } from '../entities/Whitelist';
import { Blacklist } from '../entities/Blacklist';
import { Logger } from '../utils/logger';
import { CryptoUtils } from '../utils/crypto';
import { config } from '../config/config';
import { sendTemporaryMessage, kickUser, formatUserMention } from '../utils/telegram';
import { Bot } from 'grammy';

const CLEANUP_BATCH_SIZE = 100;

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
    await this.sessionRepository
      .createQueryBuilder()
      .update(JoinSession)
      .set({ attemptCount: () => '"attemptCount" + 1' })
      .where('id = :id', { id: sessionId })
      .execute();

    const session = await this.sessionRepository.findOne({ where: { id: sessionId } });
    return session?.attemptCount ?? 0;
  }

  async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
    await this.sessionRepository.update({ id: sessionId }, { status });
  }

  async updateSessionMessageId(sessionId: string, messageId: number): Promise<void> {
    await this.sessionRepository.update({ id: sessionId }, { messageId });
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.updateSessionStatus(sessionId, 'cancelled');
  }

  async isWhitelisted(userId: string, groupId: string): Promise<boolean> {
    const count = await this.whitelistRepository.count({
      where: { userId, groupId }
    });
    return count > 0;
  }

  async isBlacklisted(userId: string, groupId: string): Promise<boolean> {
    const count = await this.blacklistRepository.count({
      where: { userId, groupId }
    });
    return count > 0;
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

  async cleanupExpiredSessions(bot?: Bot<any>): Promise<number> {
    let totalProcessed = 0;

    // Process in batches to avoid loading too many sessions at once
    while (true) {
      const expiredSessions = await this.sessionRepository
        .createQueryBuilder('session')
        .leftJoinAndSelect('session.user', 'user')
        .leftJoinAndSelect('session.group', 'group')
        .where('session.status = :status', { status: 'pending' })
        .andWhere('session.expiresAt < :now', { now: new Date() })
        .take(CLEANUP_BATCH_SIZE)
        .getMany();

      if (expiredSessions.length === 0) break;

      for (const session of expiredSessions) {
        try {
          await this.processExpiredSession(session, bot);
          totalProcessed++;
        } catch (error) {
          this.logger.error(`Failed to process expired session ${session.id}`, error);
        }
      }

      if (expiredSessions.length < CLEANUP_BATCH_SIZE) break;
    }

    if (totalProcessed > 0) {
      this.logger.info(`Cleaned up ${totalProcessed} expired sessions`);
    }
    return totalProcessed;
  }

  private async processExpiredSession(session: JoinSession, bot?: Bot<any>): Promise<void> {
    // Update session status first to prevent duplicate processing
    session.status = 'expired';
    await this.sessionRepository.save(session);

    if (!bot || !session.user || !session.group) return;

    const chatId = Number(session.groupId);
    const userId = Number(session.userId);
    const userMention = formatUserMention(session.user, session.userId);

    try {
      await sendTemporaryMessage(
        bot,
        chatId,
        `⏰ ${userMention} 未在规定时间内完成验证，已被移除。`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      this.logger.error('Failed to send timeout notification', error);
    }

    // Delete the original welcome message
    if (session.messageId) {
      try {
        await bot.api.deleteMessage(chatId, session.messageId);
      } catch (error) {
        this.logger.debug('Could not delete welcome message', { sessionId: session.id });
      }
    }

    // Kick the user
    try {
      await kickUser(bot, chatId, userId);
    } catch (error) {
      this.logger.error('Failed to kick user on timeout', error);
    }
  }

  generateVerificationUrl(userId: string, groupId: string, sessionId: string): string {
    const token = CryptoUtils.generateVerificationToken(userId, groupId, sessionId);
    const baseUrl = config.bot.webhookDomain || `http://${config.server.host}:${config.server.port}`;
    return `${baseUrl}/verify?token=${token}`;
  }
}
