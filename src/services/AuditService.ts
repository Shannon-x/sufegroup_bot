import { Repository } from 'typeorm';
import { AppDataSource } from '../config/database';
import { AuditLog, AuditAction } from '../entities/AuditLog';
import { Logger } from '../utils/logger';

export interface AuditLogEntry {
  groupId: string;
  userId?: string;
  performedBy?: string;
  action: AuditAction;
  details?: string;
  metadata?: Record<string, any>;
  ip?: string;
}

export class AuditService {
  private auditRepository: Repository<AuditLog>;
  private logger: Logger;

  constructor() {
    this.auditRepository = AppDataSource.getRepository(AuditLog);
    this.logger = new Logger('AuditService');
  }

  async log(entry: AuditLogEntry): Promise<void> {
    const auditLog = this.auditRepository.create(entry);
    await this.auditRepository.save(auditLog);
    
    this.logger.debug(`Audit log created: ${entry.action}`, {
      groupId: entry.groupId,
      userId: entry.userId,
      performedBy: entry.performedBy
    });
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