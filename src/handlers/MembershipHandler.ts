import { Bot } from 'grammy';
import { ChatMember, ChatMemberRestricted } from 'grammy/types';
import { InlineKeyboard } from 'grammy';
import { MyContext } from '../services/TelegramBot';
import { UserService } from '../services/UserService';
import { GroupService } from '../services/GroupService';
import { VerificationService } from '../services/VerificationService';
import { AuditService } from '../services/AuditService';
import { ContentFilterService } from '../services/ContentFilterService';
import { Logger } from '../utils/logger';
import { config } from '../config/config';

export class MembershipHandler {
  private logger: Logger;
  private processingUsers: Set<string> = new Set();

  constructor(
    private bot: Bot<MyContext>,
    private userService: UserService,
    private groupService: GroupService,
    private verificationService: VerificationService,
    private auditService: AuditService,
    private contentFilterService: ContentFilterService
  ) {
    this.logger = new Logger('MembershipHandler');
  }

  async handleChatMemberUpdate(ctx: MyContext, lastChatMemberUpdate: Map<string, number>) {
    const update = ctx.update.chat_member;
    if (!update) return;

    const { new_chat_member, old_chat_member, chat } = update;

    // Debounce check
    const userId = new_chat_member?.user?.id;
    const chatId = chat?.id;

    if (userId && chatId) {
      const key = `${userId}-${chatId}`;
      const lastUpdate = lastChatMemberUpdate.get(key) || 0;
      const now = Date.now();

      if (now - lastUpdate < 2000) {
        this.logger.debug('Skipping duplicate chat member update', { userId, chatId });
        return;
      }
      lastChatMemberUpdate.set(key, now);
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
    if ('is_member' in old_chat_member && 'is_member' in new_chat_member &&
        (old_chat_member as ChatMemberRestricted).is_member === false &&
        (new_chat_member as ChatMemberRestricted).is_member === true) {
      this.logger.info('User joined the group (is_member changed)', {
        userId: new_chat_member.user.id,
        chatId: chat.id
      });
      await this.processNewMember(ctx, new_chat_member.user, chat);
    }
  }

  async handleNewChatMembers(ctx: MyContext) {
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
      ('is_member' in oldMember && 'is_member' in newMember &&
       (oldMember as ChatMemberRestricted).is_member === false &&
       (newMember as ChatMemberRestricted).is_member === true)
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

  async processNewMember(ctx: MyContext, telegramUser: any, chat: any) {
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
      const keyboard = new InlineKeyboard();

      if (config.bot.miniAppShortName && config.bot.webhookDomain) {
        // Direct Mini App link — single click, no external browser
        const miniAppUrl = `https://t.me/${botUsername}/${config.bot.miniAppShortName}?startapp=verify_${sessionId}`;
        keyboard.url('🔐 点击验证', miniAppUrl);
      } else {
        // Fallback: bot private chat → external webpage
        const verifyStartUrl = `https://t.me/${botUsername}?start=verify_${sessionId}`;
        keyboard.url('🔐 点击验证', verifyStartUrl);
      }

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

  async handleBotStatusUpdate(ctx: MyContext) {
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
}
