import { escapeHtml } from './markdown';

/**
 * Welcome-template validation and rendering, shared by every path that sends
 * one.
 *
 * This lives here rather than on BaseCommand because the join path
 * (MembershipHandler) is not a command and cannot inherit from it. Two separate
 * implementations had already drifted apart: one validated the template and
 * sent valid markup through, the other escaped unconditionally — so the same
 * stored template rendered as bold text via /reverify and as literal `<b>` tags
 * when a member actually joined.
 */

const TELEGRAM_HTML_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'span', 'tg-spoiler', 'a', 'code', 'pre', 'blockquote',
]);

/** `&` that does not open one of the entities Telegram understands. */
const BARE_AMPERSAND = /&(?!(?:amp|lt|gt|quot|#\d{1,6}|#x[0-9a-fA-F]{1,6});)/;

export const DEFAULT_WELCOME_TEMPLATE =
  `新成员【{user_name}】 你好！\n` +
  `小菲欢迎您加入{group_name}\n` +
  `您当前需要完成验证才能解除限制，验证有效时间不超过{ttl} 秒。\n` +
  `过期会被踢出或封禁，请尽快。`;

/**
 * Error messages are themselves delivered with parse_mode HTML, so every tag
 * name mentioned in one has to be escaped. Interpolating a bare `<a>` produced
 * a reply Telegram rejected with a 400 — the admin saw nothing at all and had
 * no way to learn what was wrong with their template.
 */
function tag(name: string): string {
  return `&lt;${escapeHtml(name)}&gt;`;
}

function validateTagAttributes(name: string, attrs: string): string | null {
  if (name === 'a') {
    const href = /^href="(https?:\/\/|tg:\/\/)[^"<>]*"$/.test(attrs);
    return href ? null : `❌ ${tag('a')} 标签只支持 href="http(s)://..." 或 href="tg://..."`;
  }
  if (name === 'span') {
    return attrs === 'class="tg-spoiler"' ? null : `❌ ${tag('span')} 标签只支持 class="tg-spoiler"`;
  }
  if (name === 'code' || name === 'pre') {
    return /^class="language-[A-Za-z0-9+#._-]+"$/.test(attrs)
      ? null
      : `❌ ${tag('code')}/${tag('pre')} 只支持 class="language-xxx"`;
  }
  return `❌ 标签 ${tag(name)} 不支持属性`;
}

/**
 * Check a template against the subset of HTML Telegram accepts.
 *
 * Returns an admin-facing error message (already safe to send with parse_mode
 * HTML), or null when the template is fine.
 */
export function validateTelegramHtml(text: string): string | null {
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)>/g;
  const stack: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  const checkText = (chunk: string): string | null => {
    if (chunk.includes('<') || chunk.includes('>')) {
      return '❌ 模板里的 &lt; 和 &gt; 必须写成 &amp;lt; 和 &amp;gt;，否则 Telegram 会拒发整条消息';
    }
    if (BARE_AMPERSAND.test(chunk)) {
      return '❌ 模板里的 &amp; 必须写成 &amp;amp;，否则 Telegram 会拒发整条消息';
    }
    return null;
  };

  while ((match = tagPattern.exec(text)) !== null) {
    const textError = checkText(text.slice(cursor, match.index));
    if (textError) return textError;
    cursor = match.index + match[0].length;

    const name = match[1].toLowerCase();
    if (!TELEGRAM_HTML_TAGS.has(name)) {
      return `❌ Telegram 不支持标签 ${tag(name)}，可用: ${[...TELEGRAM_HTML_TAGS].map(tag).join(' ')}`;
    }

    if (match[0].startsWith('</')) {
      if (stack.pop() !== name) return `❌ HTML 标签闭合不匹配: &lt;/${escapeHtml(name)}&gt;`;
    } else {
      // Only <a href> and <span class> carry attributes; anything else with
      // attributes is rejected rather than guessed at.
      const attrs = match[2].trim();
      if (attrs) {
        const attrError = validateTagAttributes(name, attrs);
        if (attrError) return attrError;
      }
      stack.push(name);
    }
  }

  const tailError = checkText(text.slice(cursor));
  if (tailError) return tailError;
  if (stack.length > 0) return `❌ HTML 标签未闭合: ${tag(stack[stack.length - 1])}`;

  return null;
}

export interface WelcomeTemplateValues {
  userName: string;
  groupName: string;
  ttlMinutes: number;
}

/**
 * Fill a group's welcome template for a parse_mode HTML message.
 *
 * Substituted values are always escaped — a display name is attacker-supplied.
 * The template body itself is sent as-is when it is valid Telegram markup, so
 * an admin who wrote `<b>` gets bold text; a template that predates validation
 * (or was stored through another path) is escaped wholesale instead, because a
 * single stray `<` would otherwise take the whole message down with a 400 and
 * leave the new member muted with no way to verify.
 *
 * `{ttl}` is seconds and `{ttl_minutes}` is minutes, matching the shipped
 * default copy.
 */
export function renderWelcomeTemplate(
  template: string | undefined,
  values: WelcomeTemplateValues,
  onInvalid?: (error: string) => void
): string {
  let body = template && template.trim() ? template : DEFAULT_WELCOME_TEMPLATE;

  const error = validateTelegramHtml(body);
  if (error) {
    onInvalid?.(error);
    body = escapeHtml(body);
  }

  return body
    .replace(/\{user_name\}/g, escapeHtml(values.userName))
    .replace(/\{group_name\}/g, escapeHtml(values.groupName))
    .replace(/\{ttl\}/g, String(values.ttlMinutes * 60))
    .replace(/\{ttl_minutes\}/g, String(values.ttlMinutes));
}
