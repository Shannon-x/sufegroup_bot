import { Bot, Context, SessionFlavor, session } from 'grammy';
import { ChatMember } from 'grammy/types';
import { config } from '../config/config';
import { Logger } from '../utils/logger';
import { UserService } from '../services/UserService';
import { GroupService } from '../services/GroupService';
import { VerificationService } from '../services/VerificationService';
import { AuditService } from '../services/AuditService';
import { redisService } from '../services/RedisService';
import { CommandHandler } from '../commands/CommandHandler';
import { InlineKeyboard } from 'grammy';

export interface SessionData {
  step?: string;
  data?: any;
}

export type MyContext = Context & SessionFlavor<SessionData>;

export class TelegramBot {
  private bot: Bot<MyContext>;
  private logger: Logger;
  private userService: UserService;
  private groupService: GroupService;
  private verificationService: VerificationService;
  private auditService: AuditService;
  private commandHandler: CommandHandler;
  private processingUsers: Set<string> = new Set();
  private lastChatMemberUpdate: Map<string, number> = new Map();

  constructor() {
    this.logger = new Logger('TelegramBot');
    this.bot = new Bot<MyContext>(config.bot.token);
    
    // Initialize services
    this.userService = new UserService();
    this.groupService = new GroupService();
    this.verificationService = new VerificationService();
    this.auditService = new AuditService();
    
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

    // Setup command handlers BEFORE debug logging
    this.commandHandler.setup();
    
    // Debug all messages AFTER command handlers
    this.bot.on('message', async (ctx) => {
      if (ctx.message?.text?.startsWith('/')) {
        this.logger.debug('Command message received', {
          text: ctx.message.text,
          userId: ctx.from?.id,
          chatId: ctx.chat?.id,
          chatType: ctx.chat?.type
        });
      }
    });

    // Error handler
    this.bot.catch((err) => {
      this.logger.error('Bot error', err);
    });
  }

  private async handleStartCommand(ctx: MyContext) {
    // Check if this is a private chat
    if (ctx.chat?.type !== 'private') {
      return;
    }

    const startPayload = ctx.message?.text?.split(' ')[1];
    
    // Check if this is a verification request
    if (startPayload && startPayload.startsWith('verify_')) {
      const sessionId = startPayload.substring(7);
      
      this.logger.info('User started bot with verification payload', {
        userId: ctx.from?.id,
        sessionId: sessionId
      });
      
      // Get the session
      const session = await this.verificationService.getSession(sessionId);
      
      if (!session) {
        await ctx.reply('验证会话不存在或已过期。请返回群组重新获取验证链接。');
        return;
      }
      
      // Check if the session belongs to this user
      if (session.userId !== ctx.from?.id.toString()) {
        await ctx.reply('此验证链接不属于您。请使用您自己的验证链接。');
        return;
      }
      
      // Check if session is still pending
      if (session.status !== 'pending') {
        await ctx.reply('此验证会话已完成或已过期。');
        return;
      }
      
      // Check if expired
      if (new Date() > session.expiresAt) {
        session.status = 'expired';
        await this.verificationService['sessionRepository'].save(session);
        await ctx.reply('验证已过期。请返回群组重新获取验证链接。');
        return;
      }
      
      // Get group info
      const group = await this.groupService.findById(session.groupId);
      if (!group) {
        await ctx.reply('群组信息不存在。');
        return;
      }
      
      // Send verification link
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
      // Normal start command
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
    
    // Check if bot was added to a group
    if ((chat.type === 'group' || chat.type === 'supergroup') &&
        new_chat_member.user.id === ctx.me.id &&
        (new_chat_member.status === 'member' || new_chat_member.status === 'administrator')) {
      
      this.logger.info('Bot added to group', {
        groupId: chat.id,
        groupTitle: chat.title,
        addedBy: from.id
      });

      // Create or get group in database
      const { group, settings } = await this.groupService.findOrCreate(chat);
      
      // Send welcome message
      const welcomeMsg = `🎉 感谢将我添加到 **${chat.title}**！\n\n` +
        `为了让我正常工作，请：\n` +
        `1. 授予我管理员权限（删除消息、限制用户）\n` +
        `2. 使用 /settings 命令配置验证选项\n` +
        `3. 新成员加入时我会自动发送验证\n\n` +
        `输入 /help 查看所有可用命令。`;
      
      await ctx.api.sendMessage(chat.id, welcomeMsg, {
        parse_mode: 'Markdown'
      });

      // Log the event
      await this.auditService.log({
        groupId: group.id,
        performedBy: from.id.toString(),
        action: 'bot_added',
        details: `Bot added to group by ${from.first_name}`
      });
    }
    
    // Check if bot was removed from a group
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
    this.logger.info('handleChatMemberUpdate called', {
      updateType: ctx.update.update_id,
      hasChatMember: !!ctx.update.chat_member
    });
    
    const update = ctx.update.chat_member;
    if (!update) return;

    const { new_chat_member, old_chat_member, chat } = update;
    
    // Add debounce check
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
    
    this.logger.info('Chat member update', {
      oldStatus: old_chat_member?.status,
      newStatus: new_chat_member?.status,
      userId: new_chat_member?.user?.id,
      chatId: chat?.id
    });
    
    // Check if user joined
    if (this.isMemberJoined(old_chat_member, new_chat_member)) {
      await this.processNewMember(ctx, new_chat_member.user, chat);
    }
    
    // Check if user left
    if (this.isMemberLeft(old_chat_member, new_chat_member)) {
      await this.processLeavingMember(ctx, new_chat_member.user, chat);
    }
    
    // Check if user is restricted and needs re-verification
    if (old_chat_member.status === 'restricted' && new_chat_member.status === 'restricted') {
      this.logger.info('User is still restricted, checking if re-verification is needed', {
        userId: new_chat_member.user.id,
        chatId: chat.id,
        canSendMessages: (new_chat_member as any).can_send_messages
      });
      
      // Check if user has a pending verification session
      const userId = new_chat_member.user.id.toString();
      const groupId = chat.id.toString();
      const pendingSession = await this.verificationService.getPendingSession(userId, groupId);
      
      // If user is restricted and CANNOT send messages, they need verification
      const canSendMessages = (new_chat_member as any).can_send_messages;
      if (!pendingSession && canSendMessages === false) {
        this.logger.info('Restricted user cannot send messages and has no pending session, triggering verification', {
          userId: userId,
          groupId: groupId
        });
        await this.processNewMember(ctx, new_chat_member.user, chat);
      }
    }
    
    // Also check if user joined from outside (might show as restricted immediately)
    if ((old_chat_member as any).is_member === false && (new_chat_member as any).is_member === true) {
      this.logger.info('User joined the group (is_member changed)', {
        userId: new_chat_member.user.id,
        chatId: chat.id,
        oldStatus: old_chat_member.status,
        newStatus: new_chat_member.status
      });
      await this.processNewMember(ctx, new_chat_member.user, chat);
    }
  }

  private async handleNewChatMembers(ctx: MyContext) {
    this.logger.info('handleNewChatMembers called', {
      hasMessage: !!ctx.message,
      hasNewMembers: !!ctx.message?.new_chat_members,
      memberCount: ctx.message?.new_chat_members?.length || 0
    });
    
    if (!ctx.message?.new_chat_members) return;
    
    const chat = ctx.chat;
    if (!chat) return;

    for (const member of ctx.message.new_chat_members) {
      await this.processNewMember(ctx, member, chat);
    }
  }

  private isMemberJoined(oldMember: ChatMember, newMember: ChatMember): boolean {
    const oldStatus = oldMember.status;
    const newStatus = newMember.status;
    const oldIsMember = (oldMember as any).is_member;
    const newIsMember = (newMember as any).is_member;
    
    // Consider it a "join" if:
    // 1. User was not in the group and now is
    // 2. User status changes from left/kicked to any active status
    // 3. is_member changes from false to true
    // 4. User rejoins as member (from left to member) - force re-verification
    return (
      ((oldStatus === 'left' || oldStatus === 'kicked') &&
       (newStatus === 'member' || newStatus === 'administrator' || newStatus === 'creator' || newStatus === 'restricted')) ||
      (oldIsMember === false && newIsMember === true)
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
        username: telegramUser.username,
        chatId: chat.id,
        chatTitle: chat.title
      });

      // Get user and group
      const user = await this.userService.findById(telegramUser.id.toString());
      if (!user) return;

      const group = await this.groupService.findById(chat.id.toString());
      if (!group) return;

      // Cancel any pending verification sessions
      const pendingSession = await this.verificationService.getPendingSession(user.id, group.id);
      if (pendingSession) {
        this.logger.info('Cancelling pending session for leaving user', {
          userId: user.id,
          groupId: group.id,
          sessionId: pendingSession.id
        });
        
        pendingSession.status = 'cancelled';
        await this.verificationService['sessionRepository'].save(pendingSession);

        // Try to delete the welcome message
        if (pendingSession.messageId) {
          try {
            await ctx.api.deleteMessage(Number(group.id), pendingSession.messageId);
          } catch (error) {
            this.logger.debug('Could not delete welcome message for leaving user', error);
          }
        }
      }

      // Log leave event
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
      this.logger.info('Processing new member', {
        userId: telegramUser.id,
        username: telegramUser.username,
        chatId: chat.id,
        chatTitle: chat.title
      });

      // Skip bots if configured
      if (telegramUser.is_bot) {
        this.logger.info(`Bot ${telegramUser.id} joined, skipping verification`);
        return;
      }

      // Get or create user and group
      const user = await this.userService.findOrCreate(telegramUser);
      const { group, settings } = await this.groupService.findOrCreate(chat);

      // Log join event
      await this.auditService.log({
        groupId: group.id,
        userId: user.id,
        action: 'user_joined',
        details: `User @${user.username || user.firstName} joined the group`
      });

      // Check if verification is enabled
      if (!settings.verificationEnabled) {
        this.logger.info(`Verification disabled for group ${group.id}`);
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

      // DISABLED: Check whitelist - User requested all users must verify every time
      // if (await this.verificationService.isWhitelisted(user.id, group.id)) {
      //   // Check if user is currently restricted
      //   try {
      //     const member = await ctx.api.getChatMember(Number(group.id), Number(user.id));
      //     if (member.status === 'restricted') {
      //       this.logger.info('Whitelisted user is restricted, removing restrictions', {
      //         userId: user.id,
      //         groupId: group.id
      //       });
      //       
      //       // Remove restrictions
      //       await ctx.api.restrictChatMember(
      //         Number(group.id),
      //         Number(user.id),
      //         {
      //           can_send_messages: true,
      //           can_send_audios: true,
      //           can_send_polls: true,
      //           can_send_other_messages: true,
      //           can_add_web_page_previews: true,
      //           can_change_info: false,
      //           can_invite_users: true,
      //           can_pin_messages: false,
      //         }
      //       );
      //     }
      //   } catch (error) {
      //     this.logger.error('Error checking/removing restrictions for whitelisted user', error);
      //   }
      //   
      //   await this.auditService.log({
      //     groupId: group.id,
      //     userId: user.id,
      //     action: 'user_verified',
      //     details: 'User is whitelisted'
      //   });
      //   return;
      // }

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

      // Prevent concurrent processing
      const lockKey = `${user.id}-${group.id}`;
      if (this.processingUsers.has(lockKey)) {
        this.logger.info('User is already being processed, skipping', {
          userId: user.id,
          groupId: group.id
        });
        return;
      }
      
      this.processingUsers.add(lockKey);
      
      try {
        // Check for existing pending session and cancel it
        const existingSession = await this.verificationService.getPendingSession(user.id, group.id);
      if (existingSession) {
        this.logger.info('Cancelling existing session for user', {
          userId: user.id,
          groupId: group.id,
          sessionId: existingSession.id
        });
        existingSession.status = 'cancelled';
        await this.verificationService['sessionRepository'].save(existingSession);
      }

      // Create verification session first
      const session = await this.verificationService.createSession(
        user.id,
        group.id,
        0, // We'll update this with the actual message ID later
        settings.ttlMinutes
      );

      // Send welcome message with the session ID
      const welcomeMsg = await this.sendWelcomeMessage(ctx, user, group, settings, session.id);
      if (!welcomeMsg) return;

      // Update session with message ID
      session.messageId = welcomeMsg.message_id;
      await this.verificationService['sessionRepository'].save(session);

      // Schedule cleanup
      setTimeout(async () => {
        await this.handleVerificationTimeout(group.id, user.id, session.id, settings);
      }, settings.ttlMinutes * 60 * 1000);

      } finally {
        // Remove lock after a delay
        setTimeout(() => {
          this.processingUsers.delete(lockKey);
        }, 3000);
      }
    } catch (error) {
      this.logger.error('Error processing new member', error);
    }
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
    user: any,
    group: any,
    settings: any,
    sessionId: string
  ): Promise<any> {
    try {
      this.logger.info('Sending welcome message', {
        userId: user.id,
        groupId: group.id,
        sessionId: sessionId
      });
      
      // Format welcome text with new template
      const welcomeText = `新成员【${user.firstName}】 你好！
小菲欢迎您加入${group.title}
您当前需要完成验证才能解除限制，验证有效时间不超过${settings.ttlMinutes * 60} 秒。
过期会被踢出或封禁，请尽快。`;

      const botUsername = config.bot.username || 'bot';
      const verifyStartUrl = `https://t.me/${botUsername}?start=verify_${sessionId}`;
      
      this.logger.info('Creating verification button', {
        botUsername: botUsername,
        sessionId: sessionId,
        verifyStartUrl: verifyStartUrl
      });
      
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
          } catch (error) {
            this.logger.debug('Could not delete welcome message', error);
          }
        }, settings.deleteWelcomeMessageAfter * 1000);
      }

      return message;
    } catch (error) {
      this.logger.error('Error sending welcome message', error);
      return null;
    }
  }

  private async handleVerificationTimeout(
    groupId: string,
    userId: string,
    sessionId: string,
    settings: any
  ) {
    try {
      const session = await this.verificationService.getSession(sessionId);
      if (!session || session.status !== 'pending') {
        return;
      }

      // Mark session as expired
      session.status = 'expired';
      await this.verificationService['sessionRepository'].save(session);

      // Always kick user on timeout
      await this.bot.api.banChatMember(Number(groupId), Number(userId));
      // Immediately unban to allow rejoining later
      await this.bot.api.unbanChatMember(Number(groupId), Number(userId));
      
      await this.auditService.log({
        groupId,
        userId,
        action: 'user_kicked',
        details: 'Verification timeout - auto kicked'
      });

      this.logger.info('User kicked due to verification timeout', {
        userId: userId,
        groupId: groupId
      });
    } catch (error) {
      this.logger.error('Error handling verification timeout', error);
    }
  }

  private async setBotCommands() {
    try {
      // Define commands for private chats
      const privateCommands = [
        { command: 'start', description: '开始使用机器人' },
        { command: 'help', description: '显示帮助信息' },
      ];

      // Define commands for group chats
      const groupCommands = [
        { command: 'help', description: '显示帮助信息' },
        { command: 'settings', description: '管理群组设置（管理员）' },
        { command: 'stats', description: '查看群组统计' },
        { command: 'kick', description: '踢出用户（管理员）' },
        { command: 'ban', description: '封禁用户（管理员）' },
        { command: 'unban', description: '解封用户（管理员）' },
        { command: 'mute', description: '禁言用户（管理员）' },
        { command: 'unmute', description: '解除禁言（管理员）' },
      ];

      // Set commands for different scopes
      await this.bot.api.setMyCommands(privateCommands, {
        scope: { type: 'all_private_chats' }
      });
      
      await this.bot.api.setMyCommands(groupCommands, {
        scope: { type: 'all_group_chats' }
      });
      
      await this.bot.api.setMyCommands(groupCommands, {
        scope: { type: 'all_chat_administrators' }
      });

      // Set default commands (for all chats)
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
    // Initialize bot info
    await this.bot.init();
    
    // Set bot commands
    await this.setBotCommands();
    
    if (config.bot.webhookDomain) {
      // Webhook mode
      const webhookUrl = `${config.bot.webhookDomain}/telegram-webhook`;
      await this.bot.api.setWebhook(webhookUrl, {
        secret_token: config.bot.webhookSecret,
        allowed_updates: ['message', 'chat_member', 'callback_query', 'my_chat_member']
      });
      this.logger.info(`Webhook set to: ${webhookUrl}`);
    } else {
      // Polling mode
      this.bot.start({
        onStart: () => this.logger.info('Bot started in polling mode'),
      });
    }
  }

  async stop() {
    await this.bot.stop();
    this.logger.info('Bot stopped');
  }

  getBot() {
    return this.bot;
  }
}