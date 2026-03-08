import { Bot, Context, SessionFlavor, session } from 'grammy';
import { ChatMember, ChatMemberRestricted } from 'grammy/types';
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
import { InlineKeyboard } from 'grammy';
import { sendTemporaryMessage } from '../utils/telegram';

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
  private processingUsers: Set<string> = new Set();
  private lastChatMemberUpdate: Map<string, number> = new Map();
  private debounceCleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.logger = new Logger('TelegramBot');
    this.bot = new Bot<MyContext>(config.bot.token);

    // Initialize services
    this.userService = new UserService();
    this.groupService = new GroupService();
    this.verificationService = new VerificationService();
    this.auditService = new AuditService();
    this.contentFilterService = new ContentFilterService();
    this.levelService = new LevelService();

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

  /**
   * Periodically clean up stale entries in the debounce map to prevent memory leaks.
   */
  private startDebounceCleanup() {
    this.debounceCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, timestamp] of this.lastChatMemberUpdate) {
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
        await this.handleChatMemberUpdate(ctx);
      } catch (error) {
        this.logger.error('Error handling chat member update', error);
      }
    });

    // Handle message from new chat members (fallback)
    this.bot.on('message:new_chat_members', async (ctx) => {
      try {
        await this.handleNewChatMembers(ctx);
      } catch (error) {
        this.logger.error('Error handling new chat members', error);
      }
    });

    // Handle /start command for verification
    this.bot.command('start', async (ctx) => {
      try {
        await this.handleStartCommand(ctx);
      } catch (error) {
        this.logger.error('Error handling start command', error);
      }
    });

    // Handle bot being added to groups
    this.bot.on('my_chat_member', async (ctx) => {
      try {
        await this.handleBotStatusUpdate(ctx);
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
          // 1. Flood control (runs on ALL messages, even non-text)
          const flooded = await this.handleFloodControl(ctx);
          if (flooded) return;

          // 2. Content filter (spam/ads/keywords)
          const filtered = await this.handleContentFilter(ctx);
          if (filtered) return;

          // 3. Award XP for legitimate messages
          if (ctx.from?.id) {
            try {
              const settings = await this.groupService.getSettings(ctx.chat!.id.toString());
              const customTitles = settings?.customSettings?.customTitles || null;
              const result = await this.levelService.awardMessageXP(
                ctx.from.id.toString(),
                ctx.chat!.id.toString(),
                customTitles
              );
              if (result?.leveledUp) {
                await sendTemporaryMessage(
                  this.bot,
                  ctx.chat!.id,
                  `🎉 恭喜 ${ctx.from.first_name} 升级到 *Lv.${result.newLevel}*！\n称号: ${result.title}`,
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
      }
      await next();
    });

    // Error handler
    this.bot.catch((err) => {
      this.logger.error('Bot error', err);
    });
  }

  private async handleStartCommand(ctx: MyContext) {
    if (ctx.chat?.type !== 'private') return;

    const startPayload = ctx.message?.text?.split(' ')[1];

    if (startPayload && startPayload.startsWith('verify_')) {
      const sessionId = startPayload.substring(7);

      this.logger.info('User started bot with verification payload', {
        userId: ctx.from?.id,
        sessionId
      });

      const session = await this.verificationService.getSession(sessionId);

      if (!session) {
        await ctx.reply('验证会话不存在或已过期。请返回群组重新获取验证链接。');
        return;
      }

      if (session.userId !== ctx.from?.id.toString()) {
        await ctx.reply('此验证链接不属于您。请使用您自己的验证链接。');
        return;
      }

      if (session.status !== 'pending') {
        await ctx.reply('此验证会话已完成或已过期。');
        return;
      }

      if (new Date() > session.expiresAt) {
        await this.verificationService.updateSessionStatus(session.id, 'expired');
        await ctx.reply('验证已过期。请返回群组重新获取验证链接。');
        return;
      }

      const group = await this.groupService.findById(session.groupId);
      if (!group) {
        await ctx.reply('群组信息不存在。');
        return;
      }

      const verifyUrl = this.verificationService.generateVerificationUrl(
        session.userId,
        session.groupId,
        session.id
      );

      const keyboard = new InlineKeyboard()
        .url('🔐 开始验证', verifyUrl);

      const remainingMs = session.expiresAt.getTime() - Date.now();
      const remainingMinutes = Math.ceil(remainingMs / 60000);

      await ctx.reply(
        `您好！请点击下方按钮完成 **${group.title}** 群组的验证。\n\n⏱ 验证有效时间：${remainingMinutes} 分钟\n\n⚠️ 请注意：验证链接仅供您个人使用，请勿分享给他人。`,
        {
          reply_markup: keyboard,
          parse_mode: 'Markdown'
        }
      );
    } else {
      const botUsername = config.bot.username || 'bot';
      const addToGroupUrl = `https://t.me/${botUsername}?startgroup=true`;

      const keyboard = new InlineKeyboard()
        .url('➕ 添加到群聊', addToGroupUrl);

      await ctx.reply(
        '👋 你好！\n\n小菲是一个群组管理验证的机器人。\n\n主要功能：\n• 新成员入群验证\n• 防止机器人和广告\n• 自动清理未验证用户\n\n点击下方按钮将我添加到您的群组：',
        {
          reply_markup: keyboard,
          parse_mode: 'Markdown'
        }
      );
    }
  }

  private async handleBotStatusUpdate(ctx: MyContext) {
    const update = ctx.update.my_chat_member;
    if (!update) return;

    const { new_chat_member, chat, from } = update;

    if ((chat.type === 'group' || chat.type === 'supergroup') &&
        new_chat_member.user.id === ctx.me.id &&
        (new_chat_member.status === 'member' || new_chat_member.status === 'administrator')) {

      this.logger.info('Bot added to group', {
        groupId: chat.id,
        groupTitle: chat.title,
        addedBy: from.id
      });

      const { group } = await this.groupService.findOrCreate(chat);

      const welcomeMsg = `🎉 感谢将我添加到 **${chat.title}**！\n\n` +
        `为了让我正常工作，请：\n` +
        `1. 授予我管理员权限（删除消息、限制用户）\n` +
        `2. 使用 /settings 命令配置验证选项\n` +
        `3. 新成员加入时我会自动发送验证\n\n` +
        `输入 /help 查看所有可用命令。`;

      await ctx.api.sendMessage(chat.id, welcomeMsg, {
        parse_mode: 'Markdown'
      });

      await this.auditService.log({
        groupId: group.id,
        performedBy: from.id.toString(),
        action: 'bot_added',
        details: `Bot added to group by ${from.first_name}`
      });
    }

    if ((chat.type === 'group' || chat.type === 'supergroup') &&
        new_chat_member.user.id === ctx.me.id &&
        (new_chat_member.status === 'left' || new_chat_member.status === 'kicked')) {

      this.logger.info('Bot removed from group', {
        groupId: chat.id,
        groupTitle: chat.title,
        removedBy: from.id
      });
    }
  }

  private async handleChatMemberUpdate(ctx: MyContext) {
    const update = ctx.update.chat_member;
    if (!update) return;

    const { new_chat_member, old_chat_member, chat } = update;

    // Debounce check
    const userId = new_chat_member?.user?.id;
    const chatId = chat?.id;

    if (userId && chatId) {
      const key = `${userId}-${chatId}`;
      const lastUpdate = this.lastChatMemberUpdate.get(key) || 0;
      const now = Date.now();

      if (now - lastUpdate < 2000) {
        this.logger.debug('Skipping duplicate chat member update', { userId, chatId });
        return;
      }
      this.lastChatMemberUpdate.set(key, now);
    }

    this.logger.debug('Chat member update', {
      oldStatus: old_chat_member?.status,
      newStatus: new_chat_member?.status,
      userId: new_chat_member?.user?.id,
      chatId: chat?.id
    });

    // Check if user joined
    if (this.isMemberJoined(old_chat_member, new_chat_member)) {
      await this.processNewMember(ctx, new_chat_member.user, chat);
      return;
    }

    // Check if user left
    if (this.isMemberLeft(old_chat_member, new_chat_member)) {
      await this.processLeavingMember(ctx, new_chat_member.user, chat);
      return;
    }

    // Check if user is restricted and needs re-verification
    if (old_chat_member.status === 'restricted' && new_chat_member.status === 'restricted') {
      const memberId = new_chat_member.user.id.toString();
      const groupId = chat.id.toString();
      const pendingSession = await this.verificationService.getPendingSession(memberId, groupId);

      const canSendMessages = (new_chat_member as ChatMemberRestricted).can_send_messages;
      if (!pendingSession && canSendMessages === false) {
        this.logger.info('Restricted user cannot send messages and has no pending session, triggering verification', {
          userId: memberId,
          groupId
        });
        await this.processNewMember(ctx, new_chat_member.user, chat);
      }
      return;
    }

    // Check if user joined from outside (might show as restricted immediately)
    if ((old_chat_member as any).is_member === false && (new_chat_member as any).is_member === true) {
      this.logger.info('User joined the group (is_member changed)', {
        userId: new_chat_member.user.id,
        chatId: chat.id
      });
      await this.processNewMember(ctx, new_chat_member.user, chat);
    }
  }

  private async handleNewChatMembers(ctx: MyContext) {
    if (!ctx.message?.new_chat_members || !ctx.chat) return;

    for (const member of ctx.message.new_chat_members) {
      await this.processNewMember(ctx, member, ctx.chat);
    }
  }

  private isMemberJoined(oldMember: ChatMember, newMember: ChatMember): boolean {
    const oldStatus = oldMember.status;
    const newStatus = newMember.status;

    return (
      ((oldStatus === 'left' || oldStatus === 'kicked') &&
       (newStatus === 'member' || newStatus === 'administrator' || newStatus === 'creator' || newStatus === 'restricted')) ||
      ((oldMember as any).is_member === false && (newMember as any).is_member === true)
    );
  }

  private isMemberLeft(oldMember: ChatMember, newMember: ChatMember): boolean {
    const oldStatus = oldMember.status;
    const newStatus = newMember.status;

    return (
      (oldStatus === 'member' || oldStatus === 'restricted' || oldStatus === 'administrator') &&
      (newStatus === 'left' || newStatus === 'kicked')
    );
  }

  private async processLeavingMember(ctx: MyContext, telegramUser: any, chat: any) {
    try {
      this.logger.info('Processing leaving member', {
        userId: telegramUser.id,
        chatId: chat.id
      });

      const user = await this.userService.findById(telegramUser.id.toString());
      if (!user) return;

      const group = await this.groupService.findById(chat.id.toString());
      if (!group) return;

      // Cancel any pending verification sessions
      const pendingSession = await this.verificationService.getPendingSession(user.id, group.id);
      if (pendingSession) {
        this.logger.info('Cancelling pending session for leaving user', {
          userId: user.id,
          sessionId: pendingSession.id
        });

        await this.verificationService.cancelSession(pendingSession.id);

        if (pendingSession.messageId) {
          try {
            await ctx.api.deleteMessage(Number(group.id), pendingSession.messageId);
          } catch (error) {
            this.logger.debug('Could not delete welcome message for leaving user');
          }
        }
      }

      await this.auditService.log({
        groupId: group.id,
        userId: user.id,
        action: 'user_left',
        details: `User @${user.username || user.firstName} left the group`
      });
    } catch (error) {
      this.logger.error('Error processing leaving member', error);
    }
  }

  private async processNewMember(ctx: MyContext, telegramUser: any, chat: any) {
    try {
      // Skip bots
      if (telegramUser.is_bot) {
        this.logger.debug(`Bot ${telegramUser.id} joined, skipping verification`);
        return;
      }

      // Prevent concurrent processing
      const userId = telegramUser.id.toString();
      const chatId = chat.id.toString();
      const lockKey = `${userId}-${chatId}`;

      if (this.processingUsers.has(lockKey)) {
        this.logger.debug('User is already being processed, skipping', { userId, chatId });
        return;
      }

      this.processingUsers.add(lockKey);

      try {
        // Get or create user and group
        const user = await this.userService.findOrCreate(telegramUser);
        const { group, settings } = await this.groupService.findOrCreate(chat);

        // Record join time for content filter's newUserLinkDelay
        await this.contentFilterService.recordUserJoinTime(group.id, user.id);

        // Log join event
        await this.auditService.log({
          groupId: group.id,
          userId: user.id,
          action: 'user_joined',
          details: `User @${user.username || user.firstName} joined the group`
        });

        if (!settings.verificationEnabled) {
          this.logger.debug(`Verification disabled for group ${group.id}`);
          return;
        }

        // Check blacklist
        if (await this.verificationService.isBlacklisted(user.id, group.id)) {
          await ctx.api.banChatMember(Number(group.id), Number(user.id));
          await this.auditService.log({
            groupId: group.id,
            userId: user.id,
            action: 'user_kicked',
            details: 'User is blacklisted'
          });
          return;
        }

        // Check if admin and admin bypass is enabled
        if (settings.adminBypassVerification) {
          const member = await ctx.api.getChatMember(Number(group.id), Number(user.id));
          if (member.status === 'administrator' || member.status === 'creator') {
            await this.auditService.log({
              groupId: group.id,
              userId: user.id,
              action: 'user_verified',
              details: 'Admin bypass'
            });
            return;
          }
        }

        // Apply initial restrictions
        await this.applyRestrictions(ctx, group.id, user.id);

        // Cancel existing pending session
        const existingSession = await this.verificationService.getPendingSession(user.id, group.id);
        if (existingSession) {
          this.logger.info('Cancelling existing session for user', {
            userId: user.id,
            sessionId: existingSession.id
          });
          await this.verificationService.cancelSession(existingSession.id);
        }

        // Create verification session
        const session = await this.verificationService.createSession(
          user.id,
          group.id,
          0,
          settings.ttlMinutes
        );

        // Send welcome message
        const welcomeMsg = await this.sendWelcomeMessage(ctx, user, group, settings, session.id);
        if (welcomeMsg) {
          await this.verificationService.updateSessionMessageId(session.id, welcomeMsg.message_id);
        }
        // Note: timeout is handled by SchedulerService's periodic cleanup,
        // no per-session setTimeout needed.

      } finally {
        setTimeout(() => {
          this.processingUsers.delete(lockKey);
        }, 3000);
      }
    } catch (error) {
      this.logger.error('Error processing new member', error);
    }
  }

  /**
   * Flood control: limit messages per user per time window.
   * Returns true if the message was blocked due to flooding.
   */
  private async handleFloodControl(ctx: MyContext): Promise<boolean> {
    const chatId = ctx.chat!.id.toString();
    const userId = ctx.from?.id;
    if (!userId) return false;

    // Get filter config (flood is nested inside)
    const settings = await this.groupService.getSettings(chatId);
    if (!settings) return false;

    const filterConfig = this.contentFilterService.getFilterConfig(settings.customSettings);
    const floodConfig = filterConfig.flood;
    if (!floodConfig.enabled) return false;

    // Admins bypass flood control (cached)
    const isAdmin = await this.groupService.isAdminCached(Number(chatId), userId, ctx.api);
    if (isAdmin) return false;

    const { flooding } = await this.contentFilterService.checkFlood(
      chatId,
      userId.toString(),
      floodConfig
    );

    if (!flooding) return false;

    // User is flooding — take action
    const userIdStr = userId.toString();
    const chatIdNum = Number(chatId);

    // Delete the excess message
    if (floodConfig.deleteExcess) {
      try {
        await ctx.deleteMessage();
      } catch {
        this.logger.debug('Could not delete flood message');
      }
    }

    // Use a Redis flag to avoid spamming warnings (only act once per flood window)
    const floodActedKey = `flood_acted:${chatId}:${userIdStr}`;
    const alreadyActed = await redisService.exists(floodActedKey);
    if (alreadyActed) {
      // Already warned/muted this user in this window, just delete
      return true;
    }

    // Set the flag for the window duration
    await redisService.set(floodActedKey, '1', floodConfig.windowSeconds);

    const firstName = ctx.from?.first_name || '用户';
    const userMention = ctx.from?.username
      ? `@${ctx.from.username}`
      : `[${firstName}](tg://user?id=${userIdStr})`;

    switch (floodConfig.action) {
      case 'warn': {
        const warnText = `⚠️ ${userMention} 请勿刷屏！您在 ${floodConfig.windowSeconds} 秒内发送了过多消息。`;
        await sendTemporaryMessage(this.bot, chatIdNum, warnText, { parse_mode: 'Markdown' }, 10000);
        break;
      }

      case 'mute': {
        const until = Math.floor(Date.now() / 1000) + floodConfig.muteDuration * 60;
        try {
          await ctx.api.restrictChatMember(chatIdNum, userId, {
            can_send_messages: false,
            can_send_audios: false,
            can_send_photos: false,
            can_send_videos: false,
            can_send_documents: false,
            can_send_polls: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
          }, { until_date: until });
        } catch (e) {
          this.logger.error('Failed to mute flooding user', e);
        }

        const muteText = `🔇 ${userMention} 因刷屏已被禁言 ${floodConfig.muteDuration} 分钟`;
        await sendTemporaryMessage(this.bot, chatIdNum, muteText, { parse_mode: 'Markdown' });
        break;
      }

      case 'ban': {
        try {
          await ctx.api.banChatMember(chatIdNum, userId);
        } catch (e) {
          this.logger.error('Failed to ban flooding user', e);
        }

        const banText = `🚫 ${userMention} 因恶意刷屏已被封禁`;
        await sendTemporaryMessage(this.bot, chatIdNum, banText, { parse_mode: 'Markdown' });
        break;
      }
    }

    await this.auditService.log({
      groupId: chatId,
      userId: userIdStr,
      action: 'message_filtered',
      details: `Flood control: ${floodConfig.action}, ${floodConfig.maxMessages} msgs / ${floodConfig.windowSeconds}s`,
      metadata: { type: 'flood', action: floodConfig.action },
    });

    this.logger.info('Flood control triggered', {
      groupId: chatId,
      userId: userIdStr,
      action: floodConfig.action,
    });

    return true;
  }

  /**
   * Content filter: analyze group messages for spam/ads.
   * Returns true if the message was blocked.
   */
  private async handleContentFilter(ctx: MyContext): Promise<boolean> {
    const chatId = ctx.chat!.id.toString();
    const userId = ctx.from?.id;
    if (!userId) return false;

    // Admins bypass filter (cached)
    const isAdmin = await this.groupService.isAdminCached(Number(chatId), userId, ctx.api);
    if (isAdmin) return false;

    // Get group settings & filter config (cached in Redis)
    const settings = await this.groupService.getSettings(chatId);
    if (!settings) return false;

    const filterConfig = this.contentFilterService.getFilterConfig(settings.customSettings);
    if (!filterConfig.enabled) return false;

    // Gather text from message (text, caption, etc.)
    const text = ctx.message?.text || ctx.message?.caption || '';

    // 1. Check forwarded from channel
    if (filterConfig.blockForwards && ctx.message?.forward_origin) {
      const origin = ctx.message.forward_origin as any;
      if (origin.type === 'channel') {
        return this.executeFilterAction(ctx, chatId, userId.toString(), filterConfig, ['频道转发']);
      }
    }

    // 2. New user link restriction
    if (text && filterConfig.newUserLinkDelay > 0) {
      const hasUrl = /https?:\/\/|www\.|t\.me\//i.test(text);
      if (hasUrl) {
        const isNew = await this.contentFilterService.isNewUser(chatId, userId.toString(), filterConfig.newUserLinkDelay);
        if (isNew) {
          return this.executeFilterAction(ctx, chatId, userId.toString(), filterConfig, ['新用户发链接']);
        }
      }
    }

    // 3. Analyze text content
    if (text) {
      const result = this.contentFilterService.analyzeText(text, filterConfig);
      if (result.blocked) {
        return this.executeFilterAction(ctx, chatId, userId.toString(), filterConfig, result.reasons);
      }
    }

    return false;
  }

  /**
   * Execute filter action: delete message, warn/mute/ban user.
   */
  private async executeFilterAction(
    ctx: MyContext,
    groupId: string,
    userId: string,
    config: import('../services/ContentFilterService').FilterConfig,
    reasons: string[]
  ): Promise<boolean> {
    const chatIdNum = Number(groupId);
    const userIdNum = Number(userId);
    const reasonStr = reasons.join(', ');

    // Always delete the offending message
    try {
      await ctx.deleteMessage();
    } catch {
      this.logger.debug('Could not delete filtered message');
    }

    // Track violations
    const violations = await this.contentFilterService.addViolation(groupId, userId);
    const action = this.contentFilterService.determineAction(violations, config);

    // Get user display name
    const firstName = ctx.from?.first_name || '用户';
    const userMention = ctx.from?.username
      ? `@${ctx.from.username}`
      : `[${firstName}](tg://user?id=${userId})`;

    switch (action) {
      case 'warn': {
        const remaining = config.maxWarnings - violations;
        const warnText = `⚠️ ${userMention} 您的消息包含违禁内容已被删除（${reasonStr}）\n累计警告 ${violations}/${config.maxWarnings}，达到上限将被禁言`;
        await sendTemporaryMessage(this.bot, chatIdNum, warnText, { parse_mode: 'Markdown' }, 15000);
        break;
      }

      case 'mute': {
        const until = Math.floor(Date.now() / 1000) + config.muteDuration * 60;
        try {
          await ctx.api.restrictChatMember(chatIdNum, userIdNum, {
            can_send_messages: false,
            can_send_audios: false,
            can_send_photos: false,
            can_send_videos: false,
            can_send_documents: false,
            can_send_polls: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
          }, { until_date: until });
        } catch (e) {
          this.logger.error('Failed to mute user', e);
        }

        const muteText = `🔇 ${userMention} 因发送违禁内容（${reasonStr}）已被禁言 ${config.muteDuration} 分钟`;
        await sendTemporaryMessage(this.bot, chatIdNum, muteText, { parse_mode: 'Markdown' });
        break;
      }

      case 'ban': {
        try {
          await ctx.api.banChatMember(chatIdNum, userIdNum);
        } catch (e) {
          this.logger.error('Failed to ban user', e);
        }

        const banText = `🚫 ${userMention} 因多次发送违禁内容（${reasonStr}）已被封禁`;
        await sendTemporaryMessage(this.bot, chatIdNum, banText, { parse_mode: 'Markdown' });
        break;
      }

      default:
        break;
    }

    // Audit log
    await this.auditService.log({
      groupId,
      userId,
      action: 'message_filtered',
      details: `Action: ${action}, Reasons: ${reasonStr}, Violations: ${violations}`,
      metadata: { reasons, violations, action },
    });

    this.logger.info('Message filtered', { groupId, userId, action, reasons, violations });
    return true;
  }

  private async applyRestrictions(ctx: MyContext, groupId: string, userId: string) {
    try {
      await ctx.api.restrictChatMember(Number(groupId), Number(userId), {
        can_send_messages: false,
        can_send_audios: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false,
      });
    } catch (error) {
      this.logger.error('Error applying restrictions', error);
    }
  }

  private async sendWelcomeMessage(
    ctx: MyContext,
    user: { id: string; firstName: string },
    group: { id: string; title: string },
    settings: { ttlMinutes: number; deleteWelcomeMessage: boolean; deleteWelcomeMessageAfter: number },
    sessionId: string
  ): Promise<any> {
    try {
      const welcomeText = `新成员【${user.firstName}】 你好！
小菲欢迎您加入${group.title}
您当前需要完成验证才能解除限制，验证有效时间不超过${settings.ttlMinutes * 60} 秒。
过期会被踢出或封禁，请尽快。`;

      const botUsername = config.bot.username || 'bot';
      const verifyStartUrl = `https://t.me/${botUsername}?start=verify_${sessionId}`;

      const keyboard = new InlineKeyboard()
        .url('🔐 点击验证', verifyStartUrl);

      const message = await ctx.api.sendMessage(
        Number(group.id),
        welcomeText,
        {
          reply_markup: keyboard,
          parse_mode: 'Markdown'
        }
      );

      // Schedule message deletion if configured
      if (settings.deleteWelcomeMessage) {
        setTimeout(async () => {
          try {
            await ctx.api.deleteMessage(Number(group.id), message.message_id);
          } catch {
            // Message may already be deleted
          }
        }, settings.deleteWelcomeMessageAfter * 1000);
      }

      return message;
    } catch (error) {
      this.logger.error('Error sending welcome message', error);
      return null;
    }
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
