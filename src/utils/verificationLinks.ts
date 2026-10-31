import { InlineKeyboard } from 'grammy';
import { config } from '../config/config';

/**
 * Entry points for a pending join verification, as posted in the group.
 *
 * The primary button is a Mini App direct link (t.me/<bot>/<app>?startapp=…),
 * which only the official Telegram apps can open. Third-party clients such as
 * Telegram X answer "this link type is not supported", so a newcomer on one of
 * them had no way in at all and was removed when the session expired. The
 * fallback row is the plain bot deep link (t.me/<bot>?start=verify_…), which
 * every client supports; PrivateChatHandler then also offers the browser page.
 *
 * Both links carry only the session id, and their landing points (the private
 * /start handler and the Mini App /api/miniapp/verify* endpoints) reject a
 * caller who is not the session owner, so they are safe to post publicly.
 * Never put VerificationService.generateVerificationUrl()'s bearer URL here.
 */

export interface VerificationLinkConfig {
  username?: string;
  miniAppShortName?: string;
  webhookDomain?: string;
}

export const VERIFY_BUTTON_TEXT = '🔐 点击验证';
export const VERIFY_FALLBACK_BUTTON_TEXT = '📱 打不开？点这里验证';

/** Mini App direct link, or null when the Mini App is not configured. */
export function miniAppVerificationLink(
  sessionId: string,
  bot: VerificationLinkConfig = config.bot
): string | null {
  if (!bot.username || !bot.miniAppShortName || !bot.webhookDomain) return null;
  return `https://t.me/${bot.username}/${bot.miniAppShortName}?startapp=verify_${sessionId}`;
}

/** Bot private-chat deep link; works in every Telegram client. */
export function botStartVerificationLink(
  sessionId: string,
  bot: VerificationLinkConfig = config.bot
): string | null {
  if (!bot.username) return null;
  return `https://t.me/${bot.username}?start=verify_${sessionId}`;
}

/**
 * Keyboard for the group-facing verification prompt: the Mini App button when
 * configured, plus the private-chat fallback underneath it. Returns null when
 * no link can be built (BOT_USERNAME missing).
 */
export function buildGroupVerificationKeyboard(
  sessionId: string,
  bot: VerificationLinkConfig = config.bot
): InlineKeyboard | null {
  const startLink = botStartVerificationLink(sessionId, bot);
  if (!startLink) return null;

  const miniAppLink = miniAppVerificationLink(sessionId, bot);
  if (!miniAppLink) {
    return new InlineKeyboard().url(VERIFY_BUTTON_TEXT, startLink);
  }

  return new InlineKeyboard()
    .url(VERIFY_BUTTON_TEXT, miniAppLink)
    .row()
    .url(VERIFY_FALLBACK_BUTTON_TEXT, startLink);
}
