import { Bot, Context, SessionFlavor, session } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { InlineKeyboard } from 'grammy';
import { config } from '../config/config';
import { Logger } from '../utils/logger';
import { UserService } from '../services/UserService';
import { GroupService } from '../services/GroupService';
import { VerificationService } from '../services/VerificationService';
import { AuditService } from '../services/AuditService';
import { ContentFilterService } from '../services/ContentFilterService';
import { LevelService } from '../services/LevelService';
import { redisService } from '../services/RedisService';
import { CommandHandler } from '../commands/CommandHandler';
import { sendTemporaryMessage } from '../utils/telegram';
import { FloodControlHandler } from '../handlers/FloodControlHandler';
import { ContentFilterHandler } from '../handlers/ContentFilterHandler';
import { MembershipHandler } from '../handlers/MembershipHandler';
import { PrivateChatHandler } from '../handlers/PrivateChatHandler';

export interface SessionData {
  step?: string;
  data?: any;
}

export type MyContext = Context & SessionFlavor<SessionData>;

// Max age for debounce entries before cleanup (5 minutes)
const DEBOUNCE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const DEBOUNCE_MAX_AGE_MS = 2 * 60 * 1000;

export class TelegramBot {
  private bot: Bot<MyContext>;
  private logger: Logger;
  private userService: UserService;
  private groupService: GroupService;
  private verificationService: VerificationService;
  private auditService: AuditService;
  private contentFilterService: ContentFilterService;
  private levelService: LevelService;
  private commandHandler: CommandHandler;
  private lastChatMemberUpdate: Map<string, number> = new Map();
  private debounceCleanupTimer: NodeJS.Timeout | null = null;

  // Extracted handlers
  private floodControlHandler: FloodControlHandler;
  private contentFilterHandler: ContentFilterHandler;
  private membershipHandler: MembershipHandler;
  private privateChatHandler: PrivateChatHandler;

  constructor() {
    this.logger = new Logger('TelegramBot');
    this.bot = new Bot<MyContext>(config.bot.token);

    // Auto-retry on 429 (Too Many Requests) from Telegram API
    this.bot.api.config.use(autoRetry({
      maxRetryAttempts: 3,
      maxDelaySeconds: 5,
    }));

    // Initialize services
    this.userService = new UserService();
    this.groupService = new GroupService();
    this.verificationService = new VerificationService();
    this.auditService = new AuditService();
    this.contentFilterService = new ContentFilterService();
    this.levelService = new LevelService();

    // Initialize handlers
    this.floodControlHandler = new FloodControlHandler(
      this.bot, this.contentFilterService, this.auditService
    );
    this.contentFilterHandler = new ContentFilterHandler(
      this.bot, this.contentFilterService, this.auditService
    );
    this.membershipHandler = new MembershipHandler(
      this.bot, this.userService, this.groupService,
      this.verificationService, this.auditService, this.contentFilterService
    );
    this.privateChatHandler = new PrivateChatHandler(
      this.verificationService, this.groupService
    );

    // Setup session
    this.bot.use(session({
      initial: (): SessionData => ({})
    }));

    // Initialize command handler
    this.commandHandler = new CommandHandler(
      this.bot,
      this.userService,
      this.groupService,
      this.verificationService,
      this.auditService
    );

    this.setupHandlers();
    this.startDebounceCleanup();
  }

  private startDebounceCleanup() {
    this.debounceCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, timestamp] of this.lastChatMemberUpdate.entries()) {
        if (now - timestamp > DEBOUNCE_MAX_AGE_MS) {
          this.lastChatMemberUpdate.delete(key);
        }
      }
    }, DEBOUNCE_CLEANUP_INTERVAL_MS);
  }

  private setupHandlers() {
    // Handle new chat members
    this.bot.on('chat_member', async (ctx) => {
      try {
        await this.membershipHandler.handleChatMemberUpdate(ctx, this.lastChatMemberUpdate);
      } catch (error) {
        this.logger.error('Error handling chat member update', error);
      }
    });

    // Handle message from new chat members (fallback)
    this.bot.on('message:new_chat_members', async (ctx) => {
      try {
        await this.membershipHandler.handleNewChatMembers(ctx);
      } catch (error) {
        this.logger.error('Error handling new chat members', error);
      }
    });

    // Handle /start command for verification
    this.bot.command('start', async (ctx) => {
      try {
        await this.privateChatHandler.handleStartCommand(ctx);
      } catch (error) {
        this.logger.error('Error handling start command', error);
      }
    });

    // Handle "添加到群聊" reply-keyboard button tap (private chat only)
    this.bot.hears('➕ 添加到群聊', async (ctx) => {
      if (ctx.chat?.type !== 'private') return;
      try {
        const botUsername = config.bot.username || 'bot';
        const addToGroupUrl = `https://t.me/${botUsername}?startgroup=true`;
        await ctx.reply(
          '点击下方按钮将我添加到你的群组，添加后请将我设置为管理员（需要删除消息、封禁用户权限）。',
          { reply_markup: new InlineKeyboard().url('➕ 添加到群聊', addToGroupUrl) }
        );
      } catch (error) {
        this.logger.error('Error handling add-to-group button', error);
      }
    });

    // Handle bot being added to groups
    this.bot.on('my_chat_member', async (ctx) => {
      try {
        await this.membershipHandler.handleBotStatusUpdate(ctx);
      } catch (error) {
        this.logger.error('Error handling bot status update', error);
      }
    });

    // Setup command handlers BEFORE content filter
    this.commandHandler.setup();

    // Flood control + content filter for group messages
    this.bot.on('message', async (ctx, next) => {
      if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
        // Skip bot commands
        if (ctx.message?.text?.startsWith('/')) {
          await next();
          return;
        }

        try {
          const chatId = ctx.chat!.id.toString();
          const userId = ctx.from?.id;

          // Pre-fetch settings and admin status ONCE for the entire pipeline
          const settings = await this.groupService.getSettings(chatId);
          const isAdmin = userId
            ? await this.groupService.isAdminCached(Number(chatId), userId, ctx.api)
            : false;

          // 1. Flood control (runs on ALL messages, even non-text)
          const flooded = await this.floodControlHandler.handle(ctx, settings, isAdmin);
          if (flooded) return;

          // 2. Content filter (spam/ads/keywords)
          const filtered = await this.contentFilterHandler.handle(ctx, settings, isAdmin);
          if (filtered) return;

          // 3. Award XP for legitimate messages
          if (userId) {
            try {
              const customTitles = settings?.customSettings?.customTitles || null;
              const result = await this.levelService.awardMessageXP(
                userId.toString(),
                chatId,
                customTitles
              );
              if (result?.leveledUp) {
                await sendTemporaryMessage(
                  this.bot,
                  ctx.chat!.id,
                  `🎉 恭喜 ${ctx.from!.first_name} 升级到 *Lv.${result.newLevel}*！\n称号: ${result.title}`,
                  { parse_mode: 'Markdown' },
                  15000
                );
              }
            } catch {
              // XP tracking failure should not block messages
            }
          }
        } catch (error) {
          this.logger.error('Error in message filter', error);
        }
      } else if (ctx.chat?.type === 'private' && ctx.from?.id) {
        // Private chat: ensure the persistent keyboard is visible.
        const userId = ctx.from.id;
        const cacheKey = `kb_shown:${userId}`;
        try {
          const already = await redisService.get(cacheKey);
          if (!already) {
            await redisService.set(cacheKey, '1', 86400 * 30); // 30 days
            await this.privateChatHandler.sendWelcomeKeyboard(ctx);
          }
        } catch {
          // Non-critical: keyboard display failure should not break other handling
        }
      }
      await next();
    });

    // Error handler
    this.bot.catch((err) => {
      this.logger.error('Bot error', err);
    });
  }

  private async setBotCommands() {
    try {
      const privateCommands = [
        { command: 'start', description: '开始使用机器人' },
        { command: 'help', description: '显示帮助信息' },
      ];

      const groupCommands = [
        { command: 'help', description: '显示帮助信息' },
        { command: 'settings', description: '管理群组设置（管理员）' },
        { command: 'admin', description: '管理面板（管理员）' },
        { command: 'filter', description: '内容过滤管理（管理员）' },
        { command: 'stats', description: '查看群组统计' },
        { command: 'kick', description: '踢出用户（管理员）' },
        { command: 'ban', description: '封禁用户（管理员）' },
        { command: 'unban', description: '解封用户（管理员）' },
        { command: 'mute', description: '禁言用户（管理员）' },
        { command: 'unmute', description: '解除禁言（管理员）' },
        { command: 'checkin', description: '每日签到' },
        { command: 'profile', description: '查看个人资料' },
        { command: 'rank', description: '活跃排行榜' },
        { command: 'lottery', description: '抽奖系统' },
      ];

      await this.bot.api.setMyCommands(privateCommands, {
        scope: { type: 'all_private_chats' }
      });

      await this.bot.api.setMyCommands(groupCommands, {
        scope: { type: 'all_group_chats' }
      });

      await this.bot.api.setMyCommands(groupCommands, {
        scope: { type: 'all_chat_administrators' }
      });

      await this.bot.api.setMyCommands([
        { command: 'start', description: '开始使用机器人' },
        { command: 'help', description: '显示帮助信息' },
      ]);

      // Set persistent Mini App menu button for all private chats
      if (config.bot.webhookDomain) {
        await this.bot.api.setChatMenuButton({
          menu_button: {
            type: 'web_app',
            text: '📱 管理面板',
            web_app: { url: `${config.bot.webhookDomain}/mini-app` },
          } as any,
        });
      }

      this.logger.info('Bot commands updated successfully');
    } catch (error) {
      this.logger.error('Error setting bot commands', error);
    }
  }

  async start() {
    await this.bot.init();
    await this.setBotCommands();

    if (config.bot.webhookDomain) {
      const webhookUrl = `${config.bot.webhookDomain}/telegram-webhook`;
      await this.bot.api.setWebhook(webhookUrl, {
        secret_token: config.bot.webhookSecret,
        allowed_updates: ['message', 'chat_member', 'callback_query', 'my_chat_member']
      });
      this.logger.info(`Webhook set to: ${webhookUrl}`);
    } else {
      this.bot.start({
        onStart: () => this.logger.info('Bot started in polling mode'),
      });
    }
  }

  async stop() {
    if (this.debounceCleanupTimer) {
      clearInterval(this.debounceCleanupTimer);
      this.debounceCleanupTimer = null;
    }
    await this.bot.stop();
    this.logger.info('Bot stopped');
  }

  getBot() {
    return this.bot;
  }
}
