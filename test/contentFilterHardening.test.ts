import { describe, it, expect } from 'vitest';
import { ContentFilterService, HIGH_CONFIDENCE_SPAM_LABELS } from '../src/services/ContentFilterService';

/**
 * Regression matrix for the content filter.
 *
 * Every case here comes from a defect that actually shipped, and each one sits
 * on one side of the same trade-off: the filter has to stop deliberately
 * obfuscated spam without deleting ordinary conversation. Both directions have
 * been broken at different points — first the filter was too permissive (a
 * whitelisted substring anywhere in a URL bought a full exemption), then the
 * hardening overshot and started deleting GitHub links and order numbers.
 *
 * These assertions were previously verified only by throwaway scripts, so the
 * suite stayed green while the behaviour regressed. They live here now.
 */

const svc = new ContentFilterService();

function config(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    blockUrls: true,
    blockInviteLinks: true,
    blockPhoneNumbers: true,
    blockForwards: false,
    customKeywords: [],
    whitelistUrls: ['example.com'],
    newUserLinkDelay: 0,
    flood: { enabled: false },
    ...overrides,
  } as any;
}

function verdict(text: string, overrides?: Record<string, unknown>) {
  return svc.analyzeText(text, config(overrides));
}

describe('URL whitelisting', () => {
  it.each([
    ['https://example.com/path', 'plain ASCII'],
    ['https://example.com/ｐａｔｈ', 'full-width characters in the path'],
    ['看这里https://example.com吧', 'CJK text immediately around the URL'],
    ['https://example.com，请查收', 'CJK punctuation immediately after'],
    ['https://docs.example.com/guide', 'subdomain of a whitelisted host'],
  ])('exempts a whitelisted link: %s (%s)', (text) => {
    expect(verdict(text).blocked).toBe(false);
  });

  // The full-width case is subtle: URL matching stops at a full-width character
  // while NFKC folds it back to ASCII, so one link produced a short literal and
  // a longer normalised twin. Pairing them by whole string left the twin
  // unmatched, and an unmatched candidate was reported as an impostor — the
  // filter deleted the group's own trusted links.
  it('does not accuse a whitelisted link of impersonating itself', () => {
    expect(verdict('https://example.com/ｐａｔｈ').reasons).not.toContain('仿冒白名单域名');
  });

  it.each([
    ['https://evil.com/?ref=example.com', 'whitelisted domain in the query string'],
    ['https://example.com.attacker.com/x', 'whitelisted domain as a subdomain label'],
    ['https://nottrusted-example.com/x', 'whitelisted domain as a substring'],
  ])('does not exempt a link that merely contains the domain: %s (%s)', (text) => {
    expect(verdict(text).blocked).toBe(true);
  });

  it('flags a homoglyph look-alike of a whitelisted domain', () => {
    // Third character is Cyrillic U+0430. It renders as example.com but resolves
    // to xn--exmple-4nf.com, an entirely different host the attacker controls.
    const result = verdict('https://exаmple.com/free-money');
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain('仿冒白名单域名');
  });

  it('still detects a spam TLD when CJK text follows the link', () => {
    expect(verdict('快看https://free-money.top吧').reasons).toContain('可疑域名');
  });
});

describe('phone number detection', () => {
  it.each([
    ['联系我 13812345678', 'mainland mobile'],
    ['打 +86 138 1234 5678', 'country code with spaces'],
    ['电话 138-1234-5678', 'hyphen separated'],
    ['call +1 (415) 555-0132', 'US format with parentheses'],
    ['座机 010-12345678', 'area code and landline'],
  ])('blocks a real number: %s (%s)', (text) => {
    expect(verdict(text).blocked).toBe(true);
  });

  // A space-separated 3-3-4 run has exactly the shape of three ordinary
  // numbers, so matching it deleted price lists, scores and build numbers.
  it.each([
    ['价格 100 200 3000', 'price list'],
    ['成绩 800 900 1000', 'scores'],
    ['预算 5000 3000 2000', 'budget figures'],
    ['订单号 20240115001 已发货', 'order number'],
    ['版本 1.2.3 构建号 20240115', 'version and build number'],
    ['参考 RFC 12345678', 'document reference'],
    ['服务器 192.168.100.200 重启了', 'IP address'],
    ['会议在 2024-01-15 10:30 开始', 'date and time'],
  ])('leaves ordinary numbers alone: %s (%s)', (text) => {
    expect(verdict(text).blocked).toBe(false);
  });
});

describe('admin switches are decisive', () => {
  it('blocks a single link when the admin enabled blockUrls', () => {
    // The original scoring gave one URL 25 points against a threshold of 30, so
    // turning the switch on did nothing for the case it exists to cover.
    expect(verdict('https://spam-site.biz/promo').blocked).toBe(true);
  });

  it('leaves links alone when the admin did not enable blockUrls', () => {
    expect(verdict('https://spam-site.biz/promo', { blockUrls: false }).blocked).toBe(false);
  });

  it('blocks private invite links when enabled', () => {
    expect(verdict('进群 https://t.me/joinchat/AAAAAEabcdef').blocked).toBe(true);
  });
});

describe('unicode normalisation', () => {
  it('sees through zero-width characters used to split a keyword', () => {
    expect(verdict('ht​tps://spam-site.biz/x', { blockUrls: true }).blocked).toBe(true);
  });

  // ZWJ glues emoji sequences together. Stripping it split one family emoji
  // into several code points, which then tripped the repetition heuristics and
  // added score to perfectly ordinary messages.
  it('does not shred emoji sequences', () => {
    expect(verdict('👨‍👩‍👧 大家好，一起吃饭 🏳️‍🌈').blocked).toBe(false);
  });
});

/**
 * Degraded mode runs when the bot cannot read a group's settings at all. Its
 * verdicts therefore cannot be tuned or switched off by the admins they affect,
 * so it may only act on categories that are unambiguous on their own.
 *
 * Scores alone cannot draw that line: an innocent welcome message reaches 35 on
 * generic promotion patterns while a real gambling ad reaches 40. The overlap is
 * why this is decided by label, and why an earlier attempt at a score cut-off
 * deleted ordinary messages across every group during a Redis outage.
 */
describe('degraded mode signal selection', () => {
  const degraded = config({
    blockUrls: false,
    blockInviteLinks: false,
    blockPhoneNumbers: false,
    whitelistUrls: [],
  });

  const decisiveReasons = (text: string) =>
    svc.analyzeText(text, degraded).reasons.filter(r => HIGH_CONFIDENCE_SPAM_LABELS.has(r));

  it.each([
    '欢迎大家加入我们的讨论组，了解更多详情',
    '关注我们的频道获取更多信息',
    '有问题欢迎加群讨论，详情看置顶',
    '大家看看这个文档 https://github.com/foo/bar',
    '会议链接 https://zoom.us/j/123',
  ])('leaves ordinary conversation alone: %s', (text) => {
    expect(decisiveReasons(text)).toHaveLength(0);
  });

  it.each([
    '澳门赌场上线啦 百家乐 免费开户 快来加入',
    '刷单兼职日入过千 加微信 免费教学 名额有限',
    '免费领取 限时优惠 立即注册 加V信 内部渠道',
  ])('still acts on unambiguous spam: %s', (text) => {
    expect(decisiveReasons(text).length).toBeGreaterThan(0);
  });

  it('treats only the specific categories as decisive', () => {
    // Guards the derivation: if a light "tone" pattern is ever given a heavy
    // weight, it would silently start firing in degraded mode.
    expect([...HIGH_CONFIDENCE_SPAM_LABELS].sort()).not.toContain('推广');
    expect([...HIGH_CONFIDENCE_SPAM_LABELS].sort()).not.toContain('频道推广');
    expect([...HIGH_CONFIDENCE_SPAM_LABELS]).toContain('赌博');
    expect([...HIGH_CONFIDENCE_SPAM_LABELS]).toContain('诈骗');
  });
});
