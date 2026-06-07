/**
 * HTML helpers for Telegram messages.
 *
 * We standardise outgoing messages on `parse_mode: 'HTML'` instead of the
 * legacy Markdown mode: HTML only needs three characters escaped (& < >) and
 * never fails on an unbalanced `_` / `*` / `[` the way legacy Markdown does
 * (an unescaped user nickname containing those characters made Telegram return
 * 400 "can't parse entities" and silently dropped the whole message).
 */

export interface MentionUser {
  id?: string | number | null;
  username?: string | null;
  // Accept both the DB entity shape (firstName/lastName) and the raw Telegram
  // user shape (first_name/last_name) so callers don't have to normalise.
  firstName?: string | null;
  first_name?: string | null;
  lastName?: string | null;
  last_name?: string | null;
}

/** Escape the three characters that are significant in Telegram HTML mode. */
export function escapeHtml(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build a human-readable display name (NOT HTML-escaped) from a user-like
 * object. Prefers "first last", then @username, then a short id-based
 * placeholder so we never surface a raw 10+ digit Telegram id.
 */
export function displayName(user: MentionUser | null | undefined, fallbackId?: string | number): string {
  if (user) {
    const fn = (user.firstName ?? user.first_name ?? '').toString().trim();
    const ln = (user.lastName ?? user.last_name ?? '').toString().trim();
    const full = [fn, ln].filter(Boolean).join(' ').trim();
    if (full) return full;
    if (user.username) return `@${user.username}`;
  }
  const id = user?.id ?? fallbackId;
  return id ? `用户${String(id).slice(-4)}` : '用户';
}

/**
 * Build a clickable HTML mention. Prefers @username (always tappable), else a
 * `tg://user?id=` text link, else an escaped plain name. The result is safe to
 * embed directly in a `parse_mode: 'HTML'` message.
 */
export function buildMention(user: MentionUser | null | undefined, fallbackId?: string | number): string {
  const id = user?.id ?? fallbackId;
  if (user?.username) {
    // Usernames are limited to [A-Za-z0-9_]; escaping is a harmless safety net.
    return `@${escapeHtml(user.username)}`;
  }
  const name = escapeHtml(displayName(user, fallbackId));
  if (id !== undefined && id !== null && id !== '') {
    return `<a href="tg://user?id=${id}">${name}</a>`;
  }
  return name;
}
