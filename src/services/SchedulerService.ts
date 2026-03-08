import { Logger } from '../utils/logger';
import { VerificationService } from './VerificationService';
import { AuditService } from './AuditService';
import { LevelService } from './LevelService';
import { UserService } from './UserService';
import { TelegramBot } from './TelegramBot';
import { sendTemporaryMessage } from '../utils/telegram';

export class SchedulerService {
  private logger: Logger;
  private verificationService: VerificationService;
  private auditService: AuditService;
  private levelService: LevelService;
  private userService: UserService;
  private intervals: NodeJS.Timeout[] = [];
  private bot: TelegramBot;

  constructor(bot: TelegramBot) {
    this.logger = new Logger('SchedulerService');
    this.verificationService = new VerificationService();
    this.auditService = new AuditService();
    this.levelService = new LevelService();
    this.userService = new UserService();
    this.bot = bot;
  }

  start() {
    this.logger.info('Starting scheduler service');

    // Clean up expired sessions every 1 minute (reduced from 5 minutes since
    // this is now the sole timeout mechanism - no per-session setTimeout)
    this.intervals.push(
      setInterval(async () => {
        try {
          const count = await this.verificationService.cleanupExpiredSessions(this.bot.getBot());
          if (count > 0) {
            this.logger.info(`Cleaned up ${count} expired sessions`);
          }
        } catch (error) {
          this.logger.error('Error cleaning up expired sessions', error);
        }
      }, 60 * 1000)
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

    // Auto-draw expired lotteries every 30 seconds
    this.intervals.push(
      setInterval(async () => {
        try {
          await this.processExpiredLotteries();
        } catch (error) {
          this.logger.error('Error processing expired lotteries', error);
        }
      }, 30 * 1000)
    );
  }

  stop() {
    this.logger.info('Stopping scheduler service');
    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    this.intervals = [];
  }

  private async processExpiredLotteries() {
    const drawn = await this.levelService.processExpiredLotteries();
    for (const lottery of drawn) {
      try {
        if (!lottery.winners || lottery.winners.length === 0) continue;

        const winnerMentions = await Promise.all(
          lottery.winners.map(async (wId) => {
            const user = await this.userService.findById(wId);
            return user?.username ? `@${user.username}` : `[${user?.firstName || wId}](tg://user?id=${wId})`;
          })
        );

        let text = `🎉 *抽奖 #${lottery.id} 自动开奖！*\n\n`;
        text += `🎁 奖品: *${lottery.prize}*\n`;
        text += `👥 参与: ${lottery.participants.length}人\n\n`;
        text += `🏆 *中奖*\n`;
        text += winnerMentions.map((m, i) => `${i + 1}. ${m}`).join('\n');

        await this.bot.getBot().api.sendMessage(
          Number(lottery.groupId),
          text,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        this.logger.error(`Failed to announce lottery #${lottery.id} results`, error);
      }
    }
  }

  private async cleanupOldAuditLogs() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);

    const result = await this.auditService.deleteOldLogs(cutoffDate);

    if (result > 0) {
      this.logger.info(`Cleaned up ${result} old audit logs`);
    }
  }
}
