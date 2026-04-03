import { Bot } from 'grammy';
import { Logger } from './logger';

const logger = new Logger('TelegramUtils');

/**
 * Send a temporary message that auto-deletes after a specified delay.
 */
export async function sendTemporaryMessage(
  bot: Bot<any>,
  chatId: number,
  text: string,
  options?: any,
  deleteAfterMs: number = 30000
): Promise<number> {
  const msg = await bot.api.sendMessage(chatId, text, options);

  setTimeout(async () => {
    try {
      await bot.api.deleteMessage(chatId, msg.message_id);
    } catch (error) {
      logger.debug('Could not delete temporary message', { chatId, messageId: msg.message_id });
    }
  }, deleteAfterMs);

  return msg.message_id;
}

/**
 * Kick a user by banning and immediately unbanning (allows rejoin).
 */
export async function kickUser(bot: Bot<any>, chatId: number, userId: number): Promise<void> {
  await bot.api.banChatMember(chatId, userId);
  await bot.api.unbanChatMember(chatId, userId);
}

/**
 * Remove all restrictions from a user (promote/demote method with fallback).
 */
export async function unrestrictUser(bot: Bot<any>, chatId: number, userId: number): Promise<void> {
  try {
    const noPerms = {
      can_manage_chat: false,
      can_post_messages: false,
      can_edit_messages: false,
      can_delete_messages: false,
      can_manage_video_chats: false,
      can_restrict_members: false,
      can_promote_members: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false,
    };
    // Promote then demote to change status from 'restricted' to 'member'
    await bot.api.promoteChatMember(chatId, userId, noPerms);
    await bot.api.promoteChatMember(chatId, userId, noPerms);
  } catch {
    // Fallback: grant all send permissions via restrictChatMember
    await bot.api.restrictChatMember(chatId, userId, {
      can_send_messages: true,
      can_send_audios: true,
      can_send_documents: true,
      can_send_photos: true,
      can_send_videos: true,
      can_send_video_notes: true,
      can_send_voice_notes: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true,
      can_change_info: false,
      can_invite_users: true,
      can_pin_messages: false,
    });
  }
}

/**
 * Format a user mention string for Markdown.
 */
export function formatUserMention(user: { username?: string; firstName?: string; id?: string } | null, userId?: string): string {
  if (!user) {
    return `[用户](tg://user?id=${userId})`;
  }
  return user.username
    ? `@${user.username}`
    : `[${user.firstName || '用户'}](tg://user?id=${user.id || userId})`;
}
