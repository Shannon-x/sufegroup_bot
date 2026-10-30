import { Context } from 'grammy';

/**
 * Telegram routes anonymous-admin messages through this special bot account
 * (first_name = "Group", username = "GroupAnonymousBot"); the real subject is
 * carried in `message.sender_chat`. See BaseCommand.isAdmin for the original
 * detection this consolidates.
 */
export const GROUP_ANONYMOUS_BOT_ID = 1087968824;

/**
 * True when the message speaks for the group itself rather than for one of its
 * members — something only the group's own administration can do:
 *  - an anonymous admin posting as this very group (GroupAnonymousBot with
 *    sender_chat set to this chat);
 *  - a post Telegram auto-forwarded from the group's linked channel
 *    (`is_automatic_forward`, set by Telegram and never by a client).
 *
 * Neither passes an admin lookup: getChatMember on the sending service accounts
 * (1087968824, 777000) answers "left", so moderation treated them as ordinary
 * members and deleted the owner's own posts. A member posting as *their own*
 * channel also carries sender_chat but is deliberately not covered — anyone who
 * owns a channel can wear that identity.
 */
export function speaksForGroup(ctx: Context): boolean {
  const message = ctx.message;
  if (!message?.sender_chat) return false;
  if (message.is_automatic_forward) return true;
  return ctx.from?.id === GROUP_ANONYMOUS_BOT_ID && message.sender_chat.id === ctx.chat?.id;
}

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
