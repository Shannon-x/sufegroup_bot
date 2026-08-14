import { describe, it, expect } from 'vitest';
import {
  renderWelcomeTemplate,
  validateTelegramHtml,
  DEFAULT_WELCOME_TEMPLATE,
} from '../src/utils/welcomeTemplate';

/**
 * The welcome template is the newcomer's only route to verification, so a
 * template Telegram refuses to render does not merely look wrong — the message
 * never arrives, and the member sits muted until the timeout removes them.
 *
 * Two defects here were live at once: the join path and /reverify had separate
 * renderers that treated the same stored template differently, and the
 * validator's own error messages contained raw tag names, so telling an admin
 * "<a> only supports href=..." produced a reply Telegram rejected — the admin
 * saw nothing and could not learn what was wrong.
 */

describe('validateTelegramHtml', () => {
  it.each([
    ['纯文本没有标签', 'plain text'],
    ['<b>粗体</b> 和 <i>斜体</i>', 'supported formatting'],
    ['<a href="https://example.com">链接</a>', 'a link'],
    ['<a href="tg://user?id=1">提及</a>', 'a tg link'],
    ['<span class="tg-spoiler">剧透</span>', 'a spoiler'],
    ['转义正确的 &lt;b&gt; 与 &amp;', 'escaped entities'],
  ])('accepts %s (%s)', (template) => {
    expect(validateTelegramHtml(template)).toBeNull();
  });

  it('accepts the shipped default template', () => {
    expect(validateTelegramHtml(DEFAULT_WELCOME_TEMPLATE)).toBeNull();
  });

  it.each([
    ['未闭合 <b>粗体', 'unclosed tag'],
    ['<marquee>不支持</marquee>', 'unsupported tag'],
    ['<b>错配</i>', 'mismatched closing tag'],
    ['裸露的 < 号', 'bare angle bracket'],
    ['裸露的 & 符号', 'bare ampersand'],
    ['<a href="javascript:alert(1)">x</a>', 'disallowed href scheme'],
    ['<span class="other">x</span>', 'disallowed span class'],
  ])('rejects %s (%s)', (template) => {
    expect(validateTelegramHtml(template)).not.toBeNull();
  });

  // Self-referential on purpose: an error message is delivered to the admin
  // with parse_mode HTML, so it has to survive the very check it reports on.
  it.each([
    '未闭合 <b>粗体',
    '<marquee>不支持</marquee>',
    '<b>错配</i>',
    '裸露的 < 号',
    '裸露的 & 符号',
    '<a href="javascript:alert(1)">x</a>',
    '<span class="other">x</span>',
    '<code class="nope">x</code>',
    '<b style="color:red">x</b>',
  ])('produces an error message that is itself valid Telegram HTML: %s', (template) => {
    const error = validateTelegramHtml(template);
    expect(error).not.toBeNull();
    expect(validateTelegramHtml(error as string)).toBeNull();
  });
});

describe('renderWelcomeTemplate', () => {
  const values = { userName: 'Alice', groupName: '测试群', ttlMinutes: 10 };

  it('substitutes every placeholder', () => {
    const out = renderWelcomeTemplate(
      '{user_name} / {group_name} / {ttl} / {ttl_minutes}',
      values
    );
    expect(out).toBe('Alice / 测试群 / 600 / 10');
  });

  it('falls back to the default template when none is stored', () => {
    expect(renderWelcomeTemplate(undefined, values)).toContain('Alice');
    expect(renderWelcomeTemplate('   ', values)).toContain('Alice');
  });

  it('escapes substituted values, which are attacker-controlled', () => {
    const out = renderWelcomeTemplate('欢迎 {user_name}', {
      ...values,
      userName: '<a href="https://evil.example">click</a>',
    });
    expect(out).not.toContain('<a href');
    expect(out).toContain('&lt;a href');
  });

  it('preserves formatting an admin deliberately wrote', () => {
    const out = renderWelcomeTemplate('<b>欢迎</b> {user_name}', values);
    expect(out).toContain('<b>欢迎</b>');
  });

  it('escapes a template that would otherwise be rejected by Telegram', () => {
    // A legacy template stored before validation existed. Sending it as-is
    // would 400 the whole message; escaping keeps the verification link
    // deliverable, which matters more than the formatting.
    const invalid = 'a < b & c';
    const out = renderWelcomeTemplate(invalid, values);
    expect(validateTelegramHtml(out)).toBeNull();
  });

  it('reports why a template had to be escaped', () => {
    let reported: string | undefined;
    renderWelcomeTemplate('未闭合 <b>x', values, (error) => {
      reported = error;
    });
    expect(reported).toBeTruthy();
  });

  it('always yields something Telegram will accept', () => {
    for (const template of [
      undefined,
      '',
      '<b>ok</b>',
      'a < b',
      '<marquee>x</marquee>',
      '{user_name} & {group_name}',
    ]) {
      const out = renderWelcomeTemplate(template, values);
      expect(validateTelegramHtml(out), `template=${String(template)}`).toBeNull();
    }
  });
});
