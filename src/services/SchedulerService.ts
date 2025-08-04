import { Logger } from '../utils/logger';
import { VerificationService } from './VerificationService';
import { AuditService } from './AuditService';
import { redisService } from './RedisService';
import { TelegramBot } from './TelegramBot';

export class SchedulerService {
  private logger: Logger;
  private verificationService: VerificationService;
  private auditService: AuditService;
  private intervals: NodeJS.Timeout[] = [];
  private bot: TelegramBot;

  constructor(bot: TelegramBot) {
    this.logger = new Logger('SchedulerService');
    this.verificationService = new VerificationService();
    this.auditService = new AuditService();
    this.bot = bot;
  }

  start() {
    this.logger.info('Starting scheduler service');

    // Clean up expired sessions every 5 minutes
    this.intervals.push(
      setInterval(async () => {
        try {
          const count = await this.verificationService.cleanupExpiredSessions(this.bot);
          if (count > 0) {
            this.logger.info(`Cleaned up ${count} expired sessions`);
          }
        } catch (error) {
          this.logger.error('Error cleaning up expired sessions', error);
        }
      }, 5 * 60 * 1000)
    );

    // Clean up old audit logs every day (keep last 90 days)
    this.intervals.push(
      setInterval(async () => {
        try {
          await this.cleanupOldAuditLogs();
        } catch (error) {
          this.logger.error('Error cleaning up old audit logs', error);
        }
      }, 24 * 60 * 60 * 1000)
    );

    // Clean up old Redis keys every hour
    this.intervals.push(
      setInterval(async () => {
        try {
          await this.cleanupRedisKeys();
        } catch (error) {
          this.logger.error('Error cleaning up Redis keys', error);
        }
      }, 60 * 60 * 1000)
    );
  }

  stop() {
    this.logger.info('Stopping scheduler service');
    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    this.intervals = [];
  }

  private async cleanupOldAuditLogs() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);

    const result = await this.auditService['auditRepository']
      .createQueryBuilder()
      .delete()
      .where('createdAt < :cutoffDate', { cutoffDate })
      .execute();

    if (result.affected) {
      this.logger.info(`Cleaned up ${result.affected} old audit logs`);
    }
  }

  private async cleanupRedisKeys() {
    // This is a placeholder - Redis TTL should handle most cleanup
    // But we can implement pattern-based cleanup if needed
    this.logger.debug('Redis cleanup check completed');
  }
}