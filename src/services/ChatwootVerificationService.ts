import { Repository, MoreThan } from 'typeorm';
import { AppDataSource } from '../config/database';
import { ChatwootVerificationSession } from '../entities/ChatwootVerificationSession';
import { config } from '../config/config';
import { Logger } from '../utils/logger';

export interface ChatwootVerificationUser {
  inboxId: string;
  userId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export interface ChatwootGateResult {
  allowed: boolean;
  status: 'verified' | 'pending' | 'expired' | 'failed';
  session: ChatwootVerificationSession;
  verificationUrl: string;
  promptAllowed: boolean;
}

export class ChatwootVerificationService {
  private sessionRepository: Repository<ChatwootVerificationSession>;
  private logger: Logger;

  constructor() {
    this.sessionRepository = AppDataSource.getRepository(ChatwootVerificationSession);
    this.logger = new Logger('ChatwootVerificationService');
  }

  async gate(user: ChatwootVerificationUser): Promise<ChatwootGateResult> {
    const verified = await this.findVerifiedSession(user.inboxId, user.userId);
    if (verified) {
      return {
        allowed: true,
        status: 'verified',
        session: verified,
        verificationUrl: this.generateMiniAppUrl(verified),
        promptAllowed: false,
      };
    }

    const session = await this.getOrCreatePendingSession(user);
    const promptAllowed = await this.markPromptIfAllowed(session);

    return {
      allowed: false,
      status: session.status,
      session,
      verificationUrl: this.generateMiniAppUrl(session),
      promptAllowed,
    };
  }

  async getSession(sessionId: string): Promise<ChatwootVerificationSession | null> {
    return this.sessionRepository.findOne({ where: { id: sessionId } });
  }

  async incrementAttempts(sessionId: string): Promise<number> {
    await this.sessionRepository
      .createQueryBuilder()
      .update(ChatwootVerificationSession)
      .set({ attemptCount: () => '"attemptCount" + 1' })
      .where('id = :id', { id: sessionId })
      .execute();

    const session = await this.getSession(sessionId);
    return session?.attemptCount ?? 0;
  }

  async verifySession(sessionId: string, userIp?: string, userAgent?: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session || session.status !== 'pending') return false;

    if (new Date() > session.expiresAt) {
      session.status = 'expired';
      await this.sessionRepository.save(session);
      return false;
    }

    const verifiedUntil = new Date();
    verifiedUntil.setDate(verifiedUntil.getDate() + config.chatwootVerification.verifiedTtlDays);

    session.status = 'verified';
    session.verifiedAt = new Date();
    session.verifiedUntil = verifiedUntil;
    session.userIp = userIp;
    session.userAgent = userAgent;

    await this.sessionRepository.save(session);
    this.logger.info('Chatwoot Telegram user verified', {
      inboxId: session.inboxId,
      userId: session.userId,
      sessionId: session.id,
    });

    return true;
  }

  generateMiniAppUrl(session: ChatwootVerificationSession): string {
    if (!config.bot.username || !config.bot.miniAppShortName) {
      throw new Error('BOT_USERNAME and BOT_MINIAPP_SHORT_NAME are required for Chatwoot Mini App verification');
    }
    return `https://t.me/${config.bot.username}/${config.bot.miniAppShortName}?startapp=chatwoot_${session.id}`;
  }

  private async findVerifiedSession(inboxId: string, userId: string): Promise<ChatwootVerificationSession | null> {
    return this.sessionRepository.findOne({
      where: {
        inboxId,
        userId,
        status: 'verified',
        verifiedUntil: MoreThan(new Date()),
      },
      order: { verifiedUntil: 'DESC' },
    });
  }

  private async getOrCreatePendingSession(user: ChatwootVerificationUser): Promise<ChatwootVerificationSession> {
    const existing = await this.sessionRepository.findOne({
      where: {
        inboxId: user.inboxId,
        userId: user.userId,
        status: 'pending',
      },
      order: { createdAt: 'DESC' },
    });

    if (existing && existing.expiresAt > new Date()) {
      this.applyUserSnapshot(existing, user);
      return this.sessionRepository.save(existing);
    }

    if (existing) {
      existing.status = 'expired';
      await this.sessionRepository.save(existing);
    }

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + config.chatwootVerification.ttlMinutes);

    const session = this.sessionRepository.create({
      inboxId: user.inboxId,
      userId: user.userId,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      status: 'pending',
      expiresAt,
    });

    return this.sessionRepository.save(session);
  }

  private async markPromptIfAllowed(session: ChatwootVerificationSession): Promise<boolean> {
    const cooldownMs = config.chatwootVerification.promptCooldownSeconds * 1000;
    const allowed = !session.lastPromptAt || Date.now() - session.lastPromptAt.getTime() > cooldownMs;
    if (!allowed) return false;

    session.lastPromptAt = new Date();
    await this.sessionRepository.save(session);
    return true;
  }

  private applyUserSnapshot(session: ChatwootVerificationSession, user: ChatwootVerificationUser) {
    session.username = user.username || session.username;
    session.firstName = user.firstName || session.firstName;
    session.lastName = user.lastName || session.lastName;
  }
}
