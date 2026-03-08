import { Logger } from '../utils/logger';
import { redisService } from './RedisService';

// ── Flood control config ──
export interface FloodConfig {
  enabled: boolean;
  maxMessages: number;    // Max messages allowed in the window
  windowSeconds: number;  // Sliding window size in seconds
  action: 'warn' | 'mute' | 'ban'; // Action on flood
  muteDuration: number;   // Mute duration in minutes
  deleteExcess: boolean;  // Delete messages that exceed the limit
}

export const DEFAULT_FLOOD_CONFIG: FloodConfig = {
  enabled: false,
  maxMessages: 10,
  windowSeconds: 10,
  action: 'mute',
  muteDuration: 5,
  deleteExcess: true,
};

// ── Filter config stored in GroupSettings.customSettings.filter ──
export interface FilterConfig {
  enabled: boolean;
  blockUrls: boolean;          // Block all URLs (except whitelisted)
  blockInviteLinks: boolean;   // Block t.me/+xxx, t.me/joinchat, etc.
  blockPhoneNumbers: boolean;  // Block phone numbers
  blockForwards: boolean;      // Block forwarded messages from channels
  newUserLinkDelay: number;    // Minutes after join before user can post links (0 = off)
  customKeywords: string[];    // Admin-added keywords
  whitelistUrls: string[];     // Allowed URL domains
  action: 'warn' | 'mute' | 'ban'; // Action on violation
  muteDuration: number;        // Mute duration in minutes
  maxWarnings: number;         // Warnings before escalation to mute
  flood: FloodConfig;          // Flood control settings
}

export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  enabled: false,
  blockUrls: true,
  blockInviteLinks: true,
  blockPhoneNumbers: true,
  blockForwards: false,
  newUserLinkDelay: 5,
  customKeywords: [],
  whitelistUrls: [],
  action: 'warn',
  muteDuration: 60,
  maxWarnings: 3,
  flood: { ...DEFAULT_FLOOD_CONFIG },
};

export interface FilterResult {
  blocked: boolean;
  reasons: string[];
  score: number; // 0-100, higher = more spammy
}

// ── Built-in patterns (zero maintenance) ──

// URL patterns
// eslint-disable-next-line no-useless-escape
const URL_REGEX = /https?:\/\/[^\s<>\"']+|www\.[^\s<>\"']+/gi;

// Telegram invite links
const TG_INVITE_REGEX = /(?:t\.me\/(?:joinchat\/|\+)[a-zA-Z0-9_-]+|t\.me\/[a-zA-Z][a-zA-Z0-9_]{3,}|telegram\.me\/[^\s]+)/gi;

// Phone numbers (international formats)
const PHONE_REGEX = /(?:\+?\d{1,4}[\s-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,5}/g;

// Common Chinese spam / ad patterns
const SPAM_PATTERNS: Array<{ pattern: RegExp; weight: number; label: string }> = [
  // Gambling
  { pattern: /赌[博场注]|菠菜|百家乐|棋牌|彩票|六合彩|时时彩|北京赛车|幸运飞艇|AG[真平]|澳门[赌新银威]|皇冠体育/i, weight: 40, label: '赌博' },
  // Porn / adult
  { pattern: /[约色情黄]色|裸聊|援交|包夜|一夜[情晴]|成人[视直]|AV[女资]|私密视频/i, weight: 40, label: '色情' },
  // Fraud / scam
  { pattern: /刷单|兼职日[赚结]|[日月]入[过万千]|[在线日]赚\d|免费领|薅羊毛|零撸|空投.*领取/i, weight: 35, label: '诈骗' },
  // Crypto scam
  { pattern: /搬砖套利|跑[分量]|[USDT出入金].*[日稳赚]|合约[带跟]单|私募[额度]|百倍币|暴涨.*入场/i, weight: 30, label: '币圈诈骗' },
  // Contact solicitation
  // eslint-disable-next-line no-misleading-character-class
  { pattern: /[加➕]我?[微➕薇V][信❤️xX]|[微➕薇V][信❤️xX]号?[:：]?\s*[a-zA-Z0-9_]+/i, weight: 30, label: '引流' },
  { pattern: /[加联]系?[QqＱ扣][QqＱ扣号][:：]?\s*\d+/i, weight: 30, label: '引流' },
  { pattern: /[私聊]我|咨询.*[客服详情]|详[聊询]|了解[更详]多/i, weight: 15, label: '推广' },
  // Channel promotion
  { pattern: /[关注进加入].*[频道群组channel]|频道.*[推荐福利资源]/i, weight: 20, label: '频道推广' },
  // Medicine / health scam
  { pattern: /[壮阳减肥丰胸].*[产品药丸胶囊]|祖传秘方|包治百病/i, weight: 30, label: '虚假广告' },
  // Repetitive emojis (common spam style)
  { pattern: /(.)\1{7,}|([🔥💰🎁🎉💎🚀✅].*){5,}/u, weight: 15, label: '刷屏' },
];

// Known spam TLD patterns
const SPAM_URL_PATTERNS = /\.(xyz|top|club|wang|icu|buzz|surf|monster|rest|cfd|sbs)\b/i;

export class ContentFilterService {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('ContentFilter');
  }

  /**
   * Get filter config from GroupSettings, merging with defaults.
   */
  getFilterConfig(customSettings: Record<string, any> | null | undefined): FilterConfig {
    if (!customSettings?.filter) {
      return { ...DEFAULT_FILTER_CONFIG, flood: { ...DEFAULT_FLOOD_CONFIG } };
    }
    const config = { ...DEFAULT_FILTER_CONFIG, ...customSettings.filter };
    config.flood = { ...DEFAULT_FLOOD_CONFIG, ...(customSettings.filter.flood || {}) };
    return config;
  }

  /**
   * Analyze a text message for spam/ad content.
   */
  analyzeText(text: string, filterConfig: FilterConfig): FilterResult {
    const reasons: string[] = [];
    let score = 0;

    if (!text || !filterConfig.enabled) {
      return { blocked: false, reasons: [], score: 0 };
    }

    // 1. Custom keywords (highest priority)
    if (filterConfig.customKeywords.length > 0) {
      const lowerText = text.toLowerCase();
      for (const keyword of filterConfig.customKeywords) {
        if (lowerText.includes(keyword.toLowerCase())) {
          reasons.push(`自定义关键词: ${keyword}`);
          score += 50;
        }
      }
    }

    // 2. URL check
    if (filterConfig.blockUrls) {
      const urls = text.match(URL_REGEX) || [];
      if (urls.length > 0) {
        const nonWhitelisted = urls.filter(url => !this.isUrlWhitelisted(url, filterConfig.whitelistUrls));
        if (nonWhitelisted.length > 0) {
          reasons.push(`链接: ${nonWhitelisted.length}个`);
          score += 20 + nonWhitelisted.length * 5;

          // Extra score for spammy TLDs
          for (const url of nonWhitelisted) {
            if (SPAM_URL_PATTERNS.test(url)) {
              score += 15;
              reasons.push('可疑域名');
            }
          }
        }
      }
    }

    // 3. Invite links
    if (filterConfig.blockInviteLinks) {
      const invites = text.match(TG_INVITE_REGEX) || [];
      if (invites.length > 0) {
        reasons.push(`邀请链接: ${invites.length}个`);
        score += 35;
      }
    }

    // 4. Phone numbers
    if (filterConfig.blockPhoneNumbers) {
      const phones = text.match(PHONE_REGEX) || [];
      // Filter out short matches (dates, version numbers etc.)
      const realPhones = phones.filter(p => p.replace(/[\s\-().+]/g, '').length >= 8);
      if (realPhones.length > 0) {
        reasons.push(`手机号: ${realPhones.length}个`);
        score += 15;
      }
    }

    // 5. Built-in spam patterns
    for (const { pattern, weight, label } of SPAM_PATTERNS) {
      if (pattern.test(text)) {
        reasons.push(label);
        score += weight;
      }
    }

    // Clamp score
    score = Math.min(score, 100);

    // Block if score >= 30 (at least one significant signal)
    return {
      blocked: score >= 30,
      reasons,
      score,
    };
  }

  /**
   * Check if a message is forwarded from a channel (potential spam).
   */
  isSpamForward(forwardFromChat: any): boolean {
    // Forwarded from a channel (not group)
    return forwardFromChat?.type === 'channel';
  }

  /**
   * Check if a URL is in the whitelist.
   */
  private isUrlWhitelisted(url: string, whitelist: string[]): boolean {
    if (whitelist.length === 0) return false;
    const lower = url.toLowerCase();
    return whitelist.some(domain => lower.includes(domain.toLowerCase()));
  }

  // ── Violation tracking (Redis) ──

  /**
   * Increment violation count for a user in a group.
   * Returns the new count.
   */
  async addViolation(groupId: string, userId: string): Promise<number> {
    const key = `violations:${groupId}:${userId}`;
    // 24-hour sliding window
    return redisService.increment(key, 86400);
  }

  /**
   * Get current violation count.
   */
  async getViolationCount(groupId: string, userId: string): Promise<number> {
    const key = `violations:${groupId}:${userId}`;
    const val = await redisService.get(key);
    return val ? parseInt(val, 10) : 0;
  }

  /**
   * Reset violations for a user in a group.
   */
  async resetViolations(groupId: string, userId: string): Promise<void> {
    const key = `violations:${groupId}:${userId}`;
    await redisService.delete(key);
  }

  /**
   * Determine action based on violation count and config.
   * Escalation: warn → mute → ban
   */
  determineAction(violationCount: number, config: FilterConfig): 'delete' | 'warn' | 'mute' | 'ban' {
    if (config.action === 'ban') return 'ban';
    if (config.action === 'mute') {
      // Even in mute mode, escalate to ban after 2x maxWarnings
      if (violationCount >= config.maxWarnings * 2) return 'ban';
      return 'mute';
    }
    // warn mode: escalate
    if (violationCount >= config.maxWarnings * 2) return 'ban';
    if (violationCount >= config.maxWarnings) return 'mute';
    return 'warn';
  }

  /**
   * Check if a user joined recently (within N minutes).
   * Uses Redis to track join time.
   */
  async recordUserJoinTime(groupId: string, userId: string): Promise<void> {
    const key = `jointime:${groupId}:${userId}`;
    await redisService.set(key, Date.now().toString(), 3600); // Keep for 1 hour
  }

  async isNewUser(groupId: string, userId: string, delayMinutes: number): Promise<boolean> {
    if (delayMinutes <= 0) return false;
    const key = `jointime:${groupId}:${userId}`;
    const joinTime = await redisService.get(key);
    if (!joinTime) return false; // Unknown join time, don't restrict
    const elapsed = Date.now() - parseInt(joinTime, 10);
    return elapsed < delayMinutes * 60 * 1000;
  }

  // ── Flood control (Redis sliding window) ──

  /**
   * Record a message and check if the user is flooding.
   * Uses a Redis sorted set with timestamps as scores for precise sliding window.
   * Returns { flooding, messageCount } where flooding = true if limit exceeded.
   */
  async checkFlood(
    groupId: string,
    userId: string,
    config: FloodConfig
  ): Promise<{ flooding: boolean; messageCount: number }> {
    const key = `flood:${groupId}:${userId}`;
    const { allowed, remaining } = await redisService.getRateLimitInfo(
      key,
      config.windowSeconds * 1000,
      config.maxMessages
    );

    return {
      flooding: !allowed,
      messageCount: config.maxMessages - remaining,
    };
  }
}
