import { Context } from 'grammy';

/**
 * Telegram routes anonymous-admin messages through this special bot account
 * (first_name = "Group", username = "GroupAnonymousBot"); the real subject is
 * carried in `message.sender_chat`. See BaseCommand.isAdmin for the original
 * detection this consolidates.
 */
export const GROUP_ANONYMOUS_BOT_ID = 1087968824;

/**
 * True when the message was NOT sent by an ordinary member acting as
 * themselves: anonymous admins (GroupAnonymousBot) or posts made on behalf of
 * a channel/group (sender_chat present).
 */
export function isAnonymousSender(ctx: Context): boolean {
  if (ctx.from?.id === GROUP_ANONYMOUS_BOT_ID) return true;
  const message = ctx.message as { sender_chat?: unknown } | undefined;
  if (message && message.sender_chat) return true;
  return false;
}

/**
 * Guard for systems that should only ever attribute activity to a real human
 * member (XP/levels, name persistence, level-up broadcasts). Rejects missing
 * senders, bots, anonymous admins and channel/group identity posts so a fake
 * "Group" account can never accrue XP or get announced as levelling up.
 */
export function isRealHumanSender(ctx: Context): boolean {
  const from = ctx.from;
  if (!from || !from.id) return false;
  if (from.is_bot) return false;
  if (isAnonymousSender(ctx)) return false;
  return true;
}
