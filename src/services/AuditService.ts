import { Repository } from 'typeorm';
import { AppDataSource } from '../config/database';
import { AuditLog, AuditAction } from '../entities/AuditLog';
import { User } from '../entities/User';
import { Logger } from '../utils/logger';

export interface AuditLogEntry {
  groupId: string;
  userId?: string;
  performedBy?: string;
  action: AuditAction;
  details?: string;
  metadata?: Record<string, any>;
  ip?: string;
  /**
   * What we know about the target user. Only used to fill in a `users` row
   * when the user has never been registered; an existing row is left alone.
   */
  userProfile?: AuditUserProfile;
}

export interface AuditUserProfile {
  username?: string;
  firstName?: string;
  lastName?: string;
  isBot?: boolean;
  languageCode?: string;
}

export class AuditService {
  private auditRepository: Repository<AuditLog>;
  private userRepository: Repository<User>;
  private logger: Logger;

  constructor() {
    this.auditRepository = AppDataSource.getRepository(AuditLog);
    this.userRepository = AppDataSource.getRepository(User);
    this.logger = new Logger('AuditService');
  }

  async log(entry: AuditLogEntry): Promise<void> {
    const { userProfile, ...fields } = entry;

    // audit_logs.userId has a foreign key to users.id (FK_audit_logs_user).
    // Many targets were never registered: people who were in the group before
    // the bot, or whose first message is spam and gets filtered before any
    // other code path creates their row. Without a users row the insert is
    // rejected and the audit entry is silently lost, so make sure one exists.
    if (fields.userId) {
      await this.ensureUserRow(fields.userId, userProfile);
    }

    const auditLog = this.auditRepository.create(fields);
    await this.auditRepository.save(auditLog);
    
    this.logger.debug(`Audit log created: ${entry.action}`, {
      groupId: entry.groupId,
      userId: entry.userId,
      performedBy: entry.performedBy
    });
  }

  /**
   * Insert a minimal users row if none exists. ON CONFLICT DO NOTHING keeps an
   * existing row (and its real profile) untouched and is safe under races.
   */
  private async ensureUserRow(userId: string, profile?: AuditUserProfile): Promise<void> {
    await this.userRepository
      .createQueryBuilder()
      .insert()
      .into(User)
      .values({
        id: userId,
        username: profile?.username,
        // firstName is NOT NULL; fall back to the id so /audit still shows something.
        firstName: profile?.firstName || userId,
        lastName: profile?.lastName,
        isBot: profile?.isBot ?? false,
        languageCode: profile?.languageCode,
      })
      .orIgnore()
      .execute();
  }

  async getRecentLogs(groupId: string, limit: number = 10): Promise<AuditLog[]> {
    return this.auditRepository.find({
      where: { groupId },
      order: { createdAt: 'DESC' },
      take: limit,
      relations: ['user']
    });
  }

  async getLogsByAction(groupId: string, action: AuditAction, limit: number = 10): Promise<AuditLog[]> {
    return this.auditRepository.find({
      where: { groupId, action },
      order: { createdAt: 'DESC' },
      take: limit,
      relations: ['user']
    });
  }

  async getLogsByUser(groupId: string, userId: string, limit: number = 10): Promise<AuditLog[]> {
    return this.auditRepository.find({
      where: { groupId, userId },
      order: { createdAt: 'DESC' },
      take: limit,
      relations: ['user']
    });
  }

  async getUserJoinCount(groupId: string, days: number = 7): Promise<number> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const result = await this.auditRepository
      .createQueryBuilder('audit')
      .where('audit.groupId = :groupId', { groupId })
      .andWhere('audit.action = :action', { action: 'user_joined' })
      .andWhere('audit.createdAt >= :since', { since })
      .getCount();

    return result;
  }

  async deleteOldLogs(cutoffDate: Date): Promise<number> {
    const result = await this.auditRepository
      .createQueryBuilder()
      .delete()
      .where('createdAt < :cutoffDate', { cutoffDate })
      .execute();

    return result.affected || 0;
  }

  async getVerificationStats(groupId: string, days: number = 7): Promise<{
    total: number;
    verified: number;
    failed: number;
    rate: number;
  }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [total, verified, failed] = await Promise.all([
      this.auditRepository
        .createQueryBuilder('audit')
        .where('audit.groupId = :groupId', { groupId })
        .andWhere('audit.action = :action', { action: 'user_joined' })
        .andWhere('audit.createdAt >= :since', { since })
        .getCount(),
      
      this.auditRepository
        .createQueryBuilder('audit')
        .where('audit.groupId = :groupId', { groupId })
        .andWhere('audit.action = :action', { action: 'user_verified' })
        .andWhere('audit.createdAt >= :since', { since })
        .getCount(),
      
      this.auditRepository
        .createQueryBuilder('audit')
        .where('audit.groupId = :groupId', { groupId })
        .andWhere('audit.action = :action', { action: 'user_failed_verification' })
        .andWhere('audit.createdAt >= :since', { since })
        .getCount(),
    ]);

    const rate = total > 0 ? (verified / total) * 100 : 0;

    return { total, verified, failed, rate };
  }
}