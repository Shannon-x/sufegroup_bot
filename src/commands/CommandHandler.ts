import { Bot } from 'grammy';
import { MyContext } from '../services/TelegramBot';
import { UserService } from '../services/UserService';
import { GroupService } from '../services/GroupService';
import { VerificationService } from '../services/VerificationService';
import { AuditService } from '../services/AuditService';
import { RateLimitMiddleware } from '../middleware/RateLimitMiddleware';
import { Logger } from '../utils/logger';

// Import all commands
import { HelpCommand } from './HelpCommand';
import { SettingsCommand } from './SettingsCommand';
import { StatsCommand } from './StatsCommand';
import { KickCommand } from './KickCommand';
import { BanCommand } from './BanCommand';
import { UnbanCommand } from './UnbanCommand';
import { MuteCommand } from './MuteCommand';
import { UnmuteCommand } from './UnmuteCommand';
import { FilterCommand } from './FilterCommand';
import { CheckinCommand } from './CheckinCommand';
import { ProfileCommand } from './ProfileCommand';
import { RankCommand } from './RankCommand';
import { LotteryCommand } from './LotteryCommand';
import { AdminPanelCommand } from './AdminPanelCommand';
import { TitleCommand } from './TitleCommand';
import { WhitelistCommand } from './WhitelistCommand';
import { BlacklistCommand } from './BlacklistCommand';
import { VerifyCommand } from './VerifyCommand';
import { ReverifyCommand } from './ReverifyCommand';
import { AuditCommand } from './AuditCommand';
import { SpamCommand } from './SpamCommand';

export class CommandHandler {
  private commands: Map<string, any>;
  private rateLimiter: RateLimitMiddleware;
  private logger: Logger;

  constructor(
    private bot: Bot<MyContext>,
    private userService: UserService,
    private groupService: GroupService,
    private verificationService: VerificationService,
    private auditService: AuditService
  ) {
    this.commands = new Map();
    this.rateLimiter = new RateLimitMiddleware();
    this.logger = new Logger('CommandHandler');
    this.initializeCommands();
  }

  private initializeCommands() {
    const commandClasses = [
      HelpCommand,
      SettingsCommand,
      StatsCommand,
      KickCommand,
      BanCommand,
      UnbanCommand,
      MuteCommand,
      UnmuteCommand,
      FilterCommand,
      CheckinCommand,
      ProfileCommand,
      RankCommand,
      LotteryCommand,
      AdminPanelCommand,
      TitleCommand,
      // Manual compensation channel for the join guard. These were implemented
      // but never registered, so admins had no way to whitelist/blacklist a
      // member or re-issue a verification link when the join flow misfired.
      WhitelistCommand,
      BlacklistCommand,
      VerifyCommand,
      ReverifyCommand,
      AuditCommand,
      SpamCommand,
    ];

    for (const CommandClass of commandClasses) {
      const command = new CommandClass(
        this.bot,
        this.userService,
        this.groupService,
        this.verificationService,
        this.auditService
      );
      this.commands.set(command.command, command);
    }
  }

  setup() {
    // Setup rate limiting middleware
    this.bot.use(async (ctx, next) => {
      if (ctx.message?.text?.startsWith('/')) {
        const userId = ctx.from?.id.toString();
        // Handle commands with bot username (e.g., /ban@bot_username)
        const commandMatch = ctx.message.text.match(/^\/([^@\s]+)(?:@\w+)?\s*(.*)/);
        if (commandMatch) {
          const command = commandMatch[1];
          
          this.logger.debug('Processing command', {
            fullText: ctx.message.text,
            command: command,
            userId: userId,
            chatType: ctx.chat?.type
          });
          
          if (userId && command) {
            const allowed = await this.isCommandAllowed(userId, command);
            if (!allowed) {
              await ctx.reply('⚠️ 命令使用过于频繁，请稍后再试');
              return;
            }
          }
        }
      }
      
      await next();
    });

    // Setup all commands
    for (const command of this.commands.values()) {
      command.setup();
    }

    // Log available commands
    this.logger.info('Commands registered', {
      commands: Array.from(this.commands.keys())
    });
  }

  getCommands() {
    return Array.from(this.commands.values());
  }

  /**
   * Rate limit a command without ever taking the middleware down with it.
   *
   * A throw here used to escape the middleware, so next() never ran and *every*
   * slash command — including the admin recovery commands — silently stopped
   * working. commandLimit() now owns the Redis-outage case itself (it degrades
   * to a process-local counter instead of throwing), so this catch only covers
   * an unexpected bug in the limiter. Rate limiting is flood protection rather
   * than a security gate, so that case lets the command through and makes the
   * bug loud, rather than duplicating a second counter that can never run.
   */
  private async isCommandAllowed(userId: string, command: string): Promise<boolean> {
    try {
      return await this.rateLimiter.commandLimit(userId, command);
    } catch (error) {
      this.logger.error('Command rate limiter threw unexpectedly; allowing the command', error);
      return true;
    }
  }
}