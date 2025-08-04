import { Bot, CommandContext } from 'grammy';
import { MyContext } from '../services/TelegramBot';
import { UserService } from '../services/UserService';
import { GroupService } from '../services/GroupService';
import { VerificationService } from '../services/VerificationService';
import { AuditService } from '../services/AuditService';
import { Logger } from '../utils/logger';

export abstract class BaseCommand {
  protected logger: Logger;

  constructor(
    protected bot: Bot<MyContext>,
    protected userService: UserService,
    protected groupService: GroupService,
    protected verificationService: VerificationService,
    protected auditService: AuditService
  ) {
    this.logger = new Logger(this.constructor.name);
  }

  abstract command: string;
  abstract description: string;
  abstract setup(): void;

  protected async isAdmin(ctx: CommandContext<MyContext>): Promise<boolean> {
    if (!ctx.chat || ctx.chat.type === 'private') return false;
    
    try {
      this.logger.debug('Checking admin status', { 
        chatId: ctx.chat.id, 
        userId: ctx.from?.id,
        username: ctx.from?.username,
        chatType: ctx.chat.type 
      });
      
      // Check if this is GroupAnonymousBot (anonymous admin)
      if (ctx.from?.id === 1087968824 && ctx.from?.username === 'GroupAnonymousBot') {
        this.logger.debug('Detected anonymous admin');
        // For anonymous admins, we check the sender_chat instead
        const message = ctx.message;
        if (message && 'sender_chat' in message && message.sender_chat) {
          // If sender_chat matches the current chat, it's an anonymous admin
          const isAnonymousAdmin = message.sender_chat.id === ctx.chat.id;
          this.logger.debug('Anonymous admin check', { 
            senderChatId: message.sender_chat.id,
            currentChatId: ctx.chat.id,
            isAnonymousAdmin 
          });
          return isAnonymousAdmin;
        }
      }
      
      // Regular admin check
      const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from!.id);
      
      this.logger.debug('Member status', { 
        status: member.status,
        userId: ctx.from?.id,
        isAdmin: member.status === 'administrator' || member.status === 'creator'
      });
      
      return member.status === 'administrator' || member.status === 'creator';
    } catch (error) {
      this.logger.error('Error checking admin status', { error, chatId: ctx.chat.id, userId: ctx.from?.id });
      return false;
    }
  }

  protected async requireGroup(ctx: CommandContext<MyContext>): Promise<boolean> {
    if (!ctx.chat || ctx.chat.type === 'private') {
      await ctx.reply('❌ 此命令只能在群组中使用');
      return false;
    }
    return true;
  }

  protected async requireAdmin(ctx: CommandContext<MyContext>): Promise<boolean> {
    if (!await this.requireGroup(ctx)) return false;
    
    const isAdmin = await this.isAdmin(ctx);
    this.logger.debug('Admin check result', { isAdmin, userId: ctx.from?.id });
    
    if (!isAdmin) {
      await ctx.reply('❌ 此命令需要管理员权限');
      return false;
    }
    return true;
  }

  protected parseUserTarget(text: string): { username?: string; userId?: string; reason?: string } {
    const parts = text.trim().split(/\s+/);
    if (parts.length === 0) return {};
    
    const target = parts[0];
    const reason = parts.slice(1).join(' ');

    // Handle @username
    if (target.startsWith('@')) {
      return { username: target.substring(1), reason };
    } 
    // Handle user ID
    else if (/^\d+$/.test(target)) {
      return { userId: target, reason };
    }
    // No valid target found
    else {
      return {};
    }
  }

  protected async getUserFromMention(ctx: CommandContext<MyContext>): Promise<string | null> {
    // Check if replying to a message
    if (ctx.message?.reply_to_message?.from) {
      this.logger.debug('Getting user from reply', { userId: ctx.message.reply_to_message.from.id });
      return ctx.message.reply_to_message.from.id.toString();
    }

    // Check command text for username or user ID
    const commandText = ctx.match || '';
    this.logger.debug('Parsing command text', { commandText });
    
    const { username, userId } = this.parseUserTarget(commandText.toString());

    if (userId) {
      this.logger.debug('Found user ID', { userId });
      return userId;
    }

    if (username) {
      this.logger.debug('Looking up username', { username });
      // Try to find user in database first
      const user = await this.userService.findByUsername(username);
      if (user?.id) {
        this.logger.debug('Found user in database', { userId: user.id });
        return user.id;
      }
      
      // If not in database, we can't get user ID from username alone
      this.logger.debug('Username not found in database', { username });
      return null;
    }

    return null;
  }

  protected formatDuration(minutes?: number): string {
    if (!minutes) return '永久';
    
    if (minutes < 60) {
      return `${minutes} 分钟`;
    } else if (minutes < 1440) {
      return `${Math.floor(minutes / 60)} 小时`;
    } else {
      return `${Math.floor(minutes / 1440)} 天`;
    }
  }

  protected parseDuration(text: string): number | undefined {
    const match = text.match(/^(\d+)([mhd])?$/i);
    if (!match) return undefined;

    const value = parseInt(match[1]);
    const unit = match[2]?.toLowerCase() || 'm';

    switch (unit) {
      case 'm': return value;
      case 'h': return value * 60;
      case 'd': return value * 1440;
      default: return value;
    }
  }
}