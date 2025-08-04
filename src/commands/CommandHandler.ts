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
            const allowed = await this.rateLimiter.commandLimit(userId, command);
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
}