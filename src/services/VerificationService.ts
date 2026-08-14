import { Repository } from 'typeorm';
import { AppDataSource } from '../config/database';
import { JoinSession, SessionStatus } from '../entities/JoinSession';
import { GroupSettings, AutoAction } from '../entities/GroupSettings';
import { AuditLog } from '../entities/AuditLog';
import { Whitelist } from '../entities/Whitelist';
import { Blacklist } from '../entities/Blacklist';
import { Logger } from '../utils/logger';
import { CryptoUtils } from '../utils/crypto';
import { config } from '../config/config';
import { sendTemporaryMessage, kickUser, formatUserMention } from '../utils/telegram';
import { Bot } from 'grammy';

const CLEANUP_BATCH_SIZE = 100;
/** Upper bound on batches per run, so a persistent failure can't pin the scheduler. */
const MAX_CLEANUP_ROUNDS = 20;
/** Removal attempts before a session is escalated for manual intervention. */
const MAX_REMOVAL_ATTEMPTS = 5;
/** Backoff before retrying a failed removal, so transient API errors settle. */
const REMOVAL_RETRY_DELAY_MS = 60 * 1000;

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
      // Deliberately does NOT persist a status change.
      //
      // This branch is reachable by the account being policed — it just has to
      // open its verification link after the deadline. Writing 'expired' here
      // moved the row out of the cleanup job's claim query, so the scheduler
      // never removed it: an unverified account simply stayed in the group
      // forever by clicking its own link late. Every transition out of
      // 'pending' now belongs to the scheduler alone.
      this.logger.info('Verification attempted after expiry; leaving enforcement to the scheduler', {
        sessionId,
        userId: session.userId,
      });
      return false;
    }

    // Conditional update rather than read-modify-write. Two submissions racing
    // on the same session (double-click, retried request) could both observe
    // 'pending' and both "succeed", firing the unrestrict and the announcement
    // twice. Exactly one caller can win this UPDATE.
    const result = await this.sessionRepository
      .createQueryBuilder()
      .update(JoinSession)
      .set({
        status: 'verified',
        verifiedAt: new Date(),
        userIp,
        userAgent,
      })
      .where('id = :id', { id: sessionId })
      .andWhere('status = :status', { status: 'pending' })
      .andWhere('"expiresAt" > :now', { now: new Date() })
      .execute();

    const won = (result.affected ?? 0) > 0;
    if (won) {
      this.logger.info(`Verified session ${sessionId} for user ${session.userId}`);
    } else {
      this.logger.debug('Lost the race to verify this session', { sessionId });
    }
    return won;
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

    // Bounded rounds. The old loop re-queried the same `pending` rows every
    // iteration and relied on processExpiredSession having flipped their status
    // to advance; a DB write failure there meant the identical batch came back
    // forever and pinned the scheduler. Claiming is now atomic and the round
    // count is capped, so a persistent failure degrades instead of hanging.
    for (let round = 0; round < MAX_CLEANUP_ROUNDS; round++) {
      const claimed = await this.claimExpiredSessions(CLEANUP_BATCH_SIZE);
      if (claimed.length === 0) break;

      for (const session of claimed) {
        try {
          await this.processClaimedSession(session, bot);
          totalProcessed++;
        } catch (error) {
          this.logger.error(`Failed to process expired session ${session.id}`, error);
          await this.recordRemovalFailure(session, error);
        }
      }

      if (claimed.length < CLEANUP_BATCH_SIZE) break;
    }

    if (totalProcessed > 0) {
      this.logger.info(`Cleaned up ${totalProcessed} expired sessions`);
    }
    return totalProcessed;
  }

  /**
   * Atomically move a batch of due sessions into `removal_pending` and return
   * them. The conditional UPDATE is the concurrency guard: with several bot
   * instances running, exactly one wins each row, so a user is never kicked
   * twice and never announced twice.
   *
   * Picks up both freshly expired `pending` sessions and `removal_pending`
   * sessions whose removal previously failed and are due for a retry.
   */
  private async claimExpiredSessions(limit: number): Promise<JoinSession[]> {
    const now = new Date();
    const retryCutoff = new Date(now.getTime() - REMOVAL_RETRY_DELAY_MS);

    const candidates = await this.sessionRepository
      .createQueryBuilder('session')
      .select('session.id')
      .where('session.expiresAt < :now', { now })
      .andWhere(
        `(session.status = 'pending'
          OR (session.status = 'removal_pending'
              AND session.removalAttempts < :maxAttempts
              AND session.updatedAt < :retryCutoff))`,
        { maxAttempts: MAX_REMOVAL_ATTEMPTS, retryCutoff }
      )
      .orderBy('session.expiresAt', 'ASC')
      .take(limit)
      .getMany();

    if (candidates.length === 0) return [];

    const claimedIds: string[] = [];
    for (const candidate of candidates) {
      const result = await this.sessionRepository
        .createQueryBuilder()
        .update(JoinSession)
        .set({ status: 'removal_pending' })
        .where('id = :id', { id: candidate.id })
        .andWhere(`(status = 'pending' OR status = 'removal_pending')`)
        .execute();

      if (result.affected && result.affected > 0) {
        claimedIds.push(candidate.id);
      }
    }

    if (claimedIds.length === 0) return [];

    return this.sessionRepository
      .createQueryBuilder('session')
      .leftJoinAndSelect('session.user', 'user')
      .leftJoinAndSelect('session.group', 'group')
      .where('session.id IN (:...ids)', { ids: claimedIds })
      .getMany();
  }

  /**
   * Carry out the group's configured timeout policy for a claimed session.
   *
   * Two rules matter here, and both were violated by the previous version:
   * the session only reaches a terminal state once the Telegram call actually
   * succeeded, and the group is only told the user was removed once they
   * really were.
   */
  private async processClaimedSession(session: JoinSession, bot?: Bot<any>): Promise<void> {
    if (!bot) {
      // No bot handle (should not happen in production) — leave the row claimed
      // so a later run with a live bot retries rather than losing the work.
      return;
    }

    const chatId = Number(session.groupId);
    const userId = Number(session.userId);
    const action = await this.resolveAutoAction(session.groupId);

    if (action === 'mute') {
      // Policy is to leave the user muted rather than remove them.
      //
      // This re-applies the restriction instead of assuming the join-time one
      // still holds. It often does not: a verification submission lifts the
      // mute before marking the session verified, so a submission that fails
      // afterwards leaves an unverified account unmuted with its session still
      // pending. Announcing "已被禁言" without re-muting made that permanent.
      // Re-applying is also idempotent for the common case where the user was
      // never unmuted at all.
      await this.reapplyRestriction(bot, chatId, userId);

      await this.finalizeSession(session, 'expired');
      await this.auditTimeout(session, 'mute');
      await this.announceTimeout(bot, chatId, session, 'mute');
      await this.deleteWelcomeMessage(bot, chatId, session);
      return;
    }

    // kick policy: the removal must succeed before anything is announced or the
    // session is closed. A throw here propagates to recordRemovalFailure().
    await kickUser(bot, chatId, userId);

    await this.finalizeSession(session, 'removed');
    await this.auditTimeout(session, 'kick');
    await this.announceTimeout(bot, chatId, session, 'kick');
    await this.deleteWelcomeMessage(bot, chatId, session);
  }

  /**
   * Timeout enforcement had no audit trail at all, so a group could not tell
   * afterwards who was removed for failing verification, or how often it happened.
   */
  private async auditTimeout(session: JoinSession, action: AutoAction): Promise<void> {
    try {
      await AppDataSource.getRepository(AuditLog).save({
        groupId: session.groupId,
        userId: session.userId,
        action: 'timeout_enforced' as const,
        details: `Verification timed out; policy=${action}`,
      });
    } catch (error) {
      this.logger.warn('Could not write timeout audit entry', error);
    }
  }

  /**
   * Re-assert the verification mute. Throws on failure so the caller records a
   * failed enforcement and retries — a mute policy that silently fails to mute
   * is the same false-success this whole state machine exists to eliminate.
   */
  private async reapplyRestriction(bot: Bot<any>, chatId: number, userId: number): Promise<void> {
    await bot.api.restrictChatMember(chatId, userId, {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false,
    });
  }

  /** Read the group's timeout policy, defaulting to the configured fallback. */
  private async resolveAutoAction(groupId: string): Promise<AutoAction> {
    try {
      const settings = await AppDataSource.getRepository(GroupSettings).findOne({
        where: { groupId },
      });
      return settings?.autoAction ?? config.defaults.autoAction;
    } catch (error) {
      this.logger.warn('Could not read autoAction, using default', error);
      return config.defaults.autoAction;
    }
  }

  private async finalizeSession(session: JoinSession, status: SessionStatus): Promise<void> {
    await this.sessionRepository.update({ id: session.id }, { status, lastError: undefined });
  }

  /**
   * Record a failed removal so it is retried and, once retries are exhausted,
   * left visible rather than silently dropped. The session deliberately stays
   * in `removal_pending` — an unremoved user is unfinished business.
   */
  private async recordRemovalFailure(session: JoinSession, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = (session.removalAttempts ?? 0) + 1;

    try {
      await this.sessionRepository.update(
        { id: session.id },
        { removalAttempts: attempts, lastError: message.slice(0, 500) }
      );
    } catch (updateError) {
      this.logger.error('Failed to record removal failure', updateError);
    }

    if (attempts >= MAX_REMOVAL_ATTEMPTS) {
      this.logger.error('Removal permanently failed — manual intervention required', {
        sessionId: session.id,
        userId: session.userId,
        groupId: session.groupId,
        attempts,
        lastError: message,
      });
    } else {
      this.logger.warn('Removal failed, will retry', {
        sessionId: session.id,
        attempts,
        lastError: message,
      });
    }
  }

  private async announceTimeout(
    bot: Bot<any>,
    chatId: number,
    session: JoinSession,
    action: AutoAction
  ): Promise<void> {
    if (!session.user) return;
    const userMention = formatUserMention(session.user, session.userId);
    const text =
      action === 'kick'
        ? `⏰ ${userMention} 未在规定时间内完成验证，已被移除。`
        : `⏰ ${userMention} 未在规定时间内完成验证，已被禁言。`;

    try {
      await sendTemporaryMessage(bot, chatId, text, { parse_mode: 'HTML' });
    } catch (error) {
      this.logger.error('Failed to send timeout notification', error);
    }
  }

  private async deleteWelcomeMessage(
    bot: Bot<any>,
    chatId: number,
    session: JoinSession
  ): Promise<void> {
    if (!session.messageId) return;
    try {
      await bot.api.deleteMessage(chatId, session.messageId);
    } catch {
      this.logger.debug('Could not delete welcome message', { sessionId: session.id });
    }
  }

  /**
   * Sessions stuck in `removal_pending` past their retry budget — the group has
   * an unverified member the bot could not remove. Surfaced for alerting.
   */
  async getStuckRemovals(): Promise<JoinSession[]> {
    return this.sessionRepository
      .createQueryBuilder('session')
      .leftJoinAndSelect('session.user', 'user')
      .where('session.status = :status', { status: 'removal_pending' })
      .andWhere('session.removalAttempts >= :maxAttempts', { maxAttempts: MAX_REMOVAL_ATTEMPTS })
      .getMany();
  }

  /** Mark that the join-time restriction call genuinely succeeded. */
  async markRestrictionApplied(sessionId: string, applied: boolean): Promise<void> {
    await this.sessionRepository.update({ id: sessionId }, { restrictionApplied: applied });
  }

  generateVerificationUrl(userId: string, groupId: string, sessionId: string): string {
    const token = CryptoUtils.generateVerificationToken(userId, groupId, sessionId);
    const baseUrl = config.bot.webhookDomain || `http://${config.server.host}:${config.server.port}`;
    return `${baseUrl}/verify?token=${token}`;
  }
}
