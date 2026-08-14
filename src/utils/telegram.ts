import { Bot } from 'grammy';
import { ChatPermissions } from 'grammy/types';
import { Logger } from './logger';
import { buildMention } from './markdown';

const logger = new Logger('TelegramUtils');

/**
 * Every permission set to true. Telegram documents this exact shape as the way
 * to *lift* a restriction: a partial set leaves the member in `restricted`
 * status with those permissions, while an all-true set returns them to plain
 * `member`, after which the group's own default permissions apply to them
 * again — which is what a verified user should end up with.
 */
const LIFT_ALL_RESTRICTIONS: ChatPermissions = {
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
  can_change_info: true,
  can_invite_users: true,
  can_pin_messages: true,
  can_manage_topics: true,
};

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
 * Telegram treats a ban whose `until_date` is under 30 seconds away (or over
 * 366 days) as permanent, so a temporary ban has to clear that floor with room
 * for clock skew.
 */
const MIN_TEMP_BAN_SECONDS = 35;

/**
 * How long a removed member is kept out before they may rejoin. The old
 * ban-then-immediately-unban sequence let a rejected account walk straight back
 * in, which for an automated account is not a deterrent at all — it just loops:
 * join, fail verification, get kicked, rejoin. A short cooling-off period
 * breaks that loop while staying trivially recoverable for a real person.
 */
const KICK_REJOIN_COOLDOWN_SECONDS = 60;

/**
 * Remove a user from a chat.
 *
 * The ban is the security-critical step and its failure propagates, so the
 * caller can retry and escalate. Everything after a successful ban is cleanup:
 * the member is already out of the group, so a failure there must not be
 * reported as a failed removal — doing so had the caller retry work that was
 * already done and announce an outcome that had in fact been achieved.
 *
 * Pass `rejoinCooldownSeconds = 0` for the classic kick (immediate rejoin).
 */
export async function kickUser(
  bot: Bot<any>,
  chatId: number,
  userId: number,
  rejoinCooldownSeconds: number = KICK_REJOIN_COOLDOWN_SECONDS
): Promise<void> {
  if (rejoinCooldownSeconds <= 0) {
    await bot.api.banChatMember(chatId, userId);
    try {
      await bot.api.unbanChatMember(chatId, userId);
    } catch (error) {
      logger.warn('Removed the member but could not lift the ban; they stay banned rather than kicked', {
        chatId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const untilDate =
    Math.floor(Date.now() / 1000) + Math.max(rejoinCooldownSeconds, MIN_TEMP_BAN_SECONDS);
  await bot.api.banChatMember(chatId, userId, { until_date: untilDate });
}

/**
 * Remove the verification restriction from a user.
 *
 * The previous implementation promoted and then demoted the member with an
 * all-false permission set, on the theory that this flips `restricted` back to
 * `member`. It does not — promoting a plain member with no permissions is a
 * no-op — and the `restrictChatMember` fallback only ran when the promote call
 * *threw*, which it never did. The result was that users who had just passed
 * verification stayed muted while the group was told they were welcome.
 *
 * Granting every permission through `restrictChatMember` is the documented way
 * to lift a restriction, so it is now the only path.
 *
 * Returns whether Telegram actually accepted the change. Callers must not
 * announce a successful verification, nor write a success audit entry, when
 * this returns false — the user is still muted and needs an admin.
 */
export async function unrestrictUser(bot: Bot<any>, chatId: number, userId: number): Promise<boolean> {
  try {
    await bot.api.restrictChatMember(chatId, userId, LIFT_ALL_RESTRICTIONS);
    return true;
  } catch (error) {
    logger.error('Failed to lift restrictions from user', {
      chatId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Format a clickable user mention for Telegram **HTML** mode.
 *
 * NOTE: callers must send with `parse_mode: 'HTML'`. We moved off legacy
 * Markdown because an unescaped nickname containing `_ * [ \`` made Telegram
 * return 400 and silently drop the whole notification.
 */
export function formatUserMention(
  user: { username?: string | null; firstName?: string | null; id?: string | number | null } | null,
  userId?: string
): string {
  return buildMention(user, userId);
}
