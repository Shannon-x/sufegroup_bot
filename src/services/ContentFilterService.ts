import type { MessageOrigin } from 'grammy/types';
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
  blockForwards: boolean;      // Block forwards from channels/groups/hidden senders
  blockBotMentions: boolean;   // Block any @mention of a bot other than this one
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
  // Off by default: members mention inline bots (@gif, @vote) in ordinary
  // chat. The lure shape — a bot mention carrying a tracking payload — is
  // caught regardless of this switch; this only makes *every* mention decisive.
  blockBotMentions: false,
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

/** Facts about a message that are not visible in its text. */
export interface AnalyzeContext {
  /** Bot usernames never counted as a lure — at minimum, this bot itself. */
  exemptBots?: string[];
  /** The message quotes a post from another chat (Telegram "external reply"). */
  crossChatQuote?: boolean;
}

// ── Built-in patterns (zero maintenance) ──

// URL patterns.
//
// Whitespace and quotes are not enough to end a URL in a Chinese group: text
// runs straight into the link on both sides ("看这里https://example.com吧",
// "https://example.com，请查收"). Swallowing the neighbouring characters made
// extractHostname() punycode them into a different host
// ("example.xn--com-s63e"), which voided the domain whitelist for the most
// common way a URL is written here — and, because SPAM_TLD_REGEX is anchored
// at "$", let real spam domains through as well. So CJK/kana/Hangul,
// full-width and typographic punctuation and astral characters (emoji) all
// terminate a URL.
const URL_STOP_CHARS =
  '\\s<>"\'' +
  '\\u1100-\\u11FF\\u2018-\\u201F\\u2026\\u3000-\\u303F\\u3040-\\u30FF' +
  '\\u3130-\\u318F\\u31F0-\\u31FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uA960-\\uA97F' +
  '\\uAC00-\\uD7FF\\uD800-\\uDFFF\\uF900-\\uFAFF\\uFE10-\\uFE4F\\uFF00-\\uFFEF';
const URL_REGEX = new RegExp(
  `https?://[^${URL_STOP_CHARS}]+|www\\.[^${URL_STOP_CHARS}]+`,
  'gi'
);

// Trailing punctuation is stripped from a match for two reasons: it closes the
// sentence far more often than it belongs to the link, and NFKC folds the
// full-width variants ("（" → "(") so the same link would otherwise look like
// two different ones in the literal and the normalised copy. Only the hostname
// and the number of links are derived from a match, so dropping trailing
// characters can never weaken a verdict.
const URL_TRAILING_PUNCT_REGEX = /[\p{P}\p{S}]+$/u;

// Telegram invite links
const TG_INVITE_REGEX = /(?:t\.me\/(?:joinchat\/|\+)[a-zA-Z0-9_-]+|t\.me\/[a-zA-Z][a-zA-Z0-9_]{3,}|telegram\.me\/[^\s]+)/gi;

// Telegram deep links. Clients render `tg://resolve?domain=…` / `tg://join?invite=…`
// as a tappable link, but they contain neither http(s) nor www, so the URL and
// invite regexes above never saw them — a free bypass for channel promotion.
const TG_DEEPLINK_REGEX = /tg:\/\/[a-z_]+(?:\?\S*)?/gi;
const TG_DEEPLINK_INVITE_REGEX = /tg:\/\/(?:join|resolve)\b/i;

// Phone numbers — deliberately narrow, because blockPhoneNumbers defaults to
// true and a match deletes the message outright. The previous pattern accepted
// any run of 8+ digits, so "订单号 20240115001 已发货", "构建号 20240115",
// "价格是 12345678 元" and "参考 RFC 12345678" were all deleted as contact
// details. Only shapes a reader would recognise as a phone number qualify: an
// explicit country code, a mainland mobile number, or digits grouped by
// separators. A bare digit run is never one of them — it stays a job for the
// heuristic patterns, which need corroborating wording before they block.
const PHONE_REGEX = new RegExp(
  [
    // +86 138 1234 5678 / +1 (415) 555-0132. The "+" must not follow a digit,
    // otherwise arithmetic ("1000+2000000") reads as a country code.
    '(?<!\\d)\\+\\d{1,3}[\\s.-]?(?:\\(\\d{1,4}\\)[\\s.-]?)?\\d{2,4}(?:[\\s.-]?\\d{2,4}){1,3}',
    // 13812345678 — mainland mobile, fixed length, must not sit inside a longer run
    '(?<!\\d)1[3-9]\\d{9}(?!\\d)',
    // 138-1234-5678 / 415.555.0132. Separators must be punctuation, and the
    // same punctuation twice (backreference). A space-separated 3-3-4 run is
    // indistinguishable from three ordinary numbers in a row — "价格 100 200
    // 3000" and "成绩 800 900 1000" have exactly the shape of "415 555 0132" —
    // so matching it deleted normal messages. A bare space-separated number
    // with no country code is not worth that cost: the mainland, the "+CC" and
    // the punctuated forms are all still covered by the other alternatives.
    '(?<!\\d)\\d{3}([.-])\\d{3,4}\\1\\d{4}(?!\\d)',
    // 010-12345678 — area code plus landline. Hyphen only, because a space here
    // would match two unrelated numbers written next to each other.
    '(?<!\\d)\\d{3,4}-\\d{7,8}(?!\\d)',
  ].join('|'),
  'g'
);

// Bot usernames. Telegram requires every bot username to end in "bot" and to
// be 5–32 characters long, so the suffix identifies a bot mention from the text
// alone, with no API call.
const BOT_MENTION_REGEX = /@([A-Za-z][A-Za-z0-9_]{1,28}bot)\b/gi;

// An opaque tracking payload after a bot mention: "campaign_001", or a long
// token mixing letters and digits ("g1790033580614cfd80825"). This is how a
// phishing bot attributes which spam run delivered a victim. Real people do
// not type these; they paste them from a campaign script.
const TRACKING_TOKEN_REGEX = /(?:^|[\s:：=])(?:campaign[_-]?\d+|(?=[a-z0-9_-]*\d)(?=[a-z0-9_-]*[a-z])[a-z0-9_-]{14,})(?=$|\s)/i;

// E.164 allows at most 15 digits; below 8 nothing is dialable either.
const PHONE_MIN_DIGITS = 8;
const PHONE_MAX_DIGITS = 15;

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
  // Get-rich-quick recruitment. This vocabulary was a blind spot: an ad bot
  // posting a wall of buttons promising an income scored zero, because none of
  // the patterns above cover "no capital required" / "get rich" phrasing and
  // the post carries no keyword any other rule looks for. Deliberate
  // misspellings are common here ("项木" for 项目), so the patterns key on the
  // parts of the phrase the author cannot afford to disguise.
  {
    pattern: /[0０零无]本金|免费入[金场]|躺[着平]赚|包[教赚]包会|带你[飞致]富|财富[入密]口|致富之路|翻身.{0,4}找我|带你提(迈巴赫|保时捷|兰博基尼|豪车)/i,
    weight: 30,
    label: '诈骗',
  },
  // Income claims. Deliberately lighter: a number of this shape can occur in
  // ordinary conversation, so it raises suspicion rather than deciding on its
  // own. The negative lookahead keeps counts and measurements out.
  {
    pattern: /一天[^，。！？\n]{0,6}[\d几两三四五六七八九十百]+[万千](?![次步个米字条行人])|[日月]入[^，。\n]{0,4}[\d几]*[万千]/i,
    weight: 25,
    label: '诈骗',
  },
  // Repetitive emojis (common spam style)
  { pattern: /(.)\1{7,}|([🔥💰🎁🎉💎🚀✅].*){5,}/u, weight: 15, label: '刷屏' },
];

/**
 * Reasons specific enough to act on *without* knowing the group's settings.
 *
 * The heavier patterns name an unambiguous category — gambling, fraud, adult
 * content, contact-farming. The lighter ones ("推广", "频道推广", "刷屏") describe a
 * tone that ordinary messages share: "欢迎大家加入我们的讨论组，了解更多详情" scores 35 on
 * them alone, above the normal block threshold, while a real gambling ad scores
 * 40. The two ranges overlap, so no score cut-off separates them — the category
 * does. Derived from the weights rather than listed by hand so it cannot drift
 * as patterns are added.
 */
export const HIGH_CONFIDENCE_SPAM_LABELS: ReadonlySet<string> = new Set(
  SPAM_PATTERNS.filter(p => p.weight >= 30).map(p => p.label)
);

// Known spam TLDs. Matched against the parsed hostname only — matching the raw
// URL made any path or query containing ".top" (e.g. /docs.top-tips) look like
// a spam domain.
const SPAM_TLD_REGEX = /\.(xyz|top|club|wang|icu|buzz|surf|monster|rest|cfd|sbs)$/i;

// ── Normalisation ──

// Zero-width, bidi and soft-hyphen characters: invisible in every client, yet
// they split a domain in half ("ht" + U+200B + "tps") and defeat every literal
// pattern above.
//
// U+200D ZERO WIDTH JOINER is deliberately *not* in the set: it is the glue of
// emoji ZWJ sequences (family and flag emoji). Stripping it exploded a single
// family emoji into several consecutive ones, which then tripped the
// "repetitive emoji" spam pattern and added 15 points to an ordinary message.
const INVISIBLE_CHARS_REGEX = /[\u00AD\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

// NFKC folds full-width and compatibility forms (ｈｔｔｐｓ → https) but leaves
// homoglyphs alone: Cyrillic "а" and Latin "a" remain different code points, so
// a single look-alike letter still dodges keyword lists and link patterns. Fold
// only the letters that are pixel-identical in common fonts; anything broader
// would start mangling legitimate Russian/Greek text.
const HOMOGLYPH_MAP: Record<string, string> = {
  'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p',
  'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P',
  'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M',
  'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X', 'ο': 'o', 'ρ': 'p',
  'α': 'a', 'ν': 'v',
};
const HOMOGLYPH_REGEX = new RegExp(`[${Object.keys(HOMOGLYPH_MAP).join('')}]`, 'g');

/**
 * Canonical form used for *matching only* (never for display or storage).
 * Everything the filter compares against must go through this, otherwise the
 * same ad passes simply by being typed in full-width characters or with a
 * zero-width space in the middle of the domain.
 */
export function normalizeForMatching(input: string): string {
  return input
    .normalize('NFKC')
    .replace(INVISIBLE_CHARS_REGEX, '')
    .replace(HOMOGLYPH_REGEX, (ch) => HOMOGLYPH_MAP[ch] ?? ch);
}

// ── Scoring ──

// Heuristic signals accumulate towards this threshold, so several weak hints
// (promotion wording + repeated emojis + …) can still add up to a block.
const BLOCK_SCORE_THRESHOLD = 30;

// Upper bound the admin UI accepts for newUserLinkDelay (24h). The join
// timestamp must outlive the longest window a group can configure, plus a
// margin — with the old fixed 1h TTL every configuration above 60 minutes
// silently stopped being enforced after the first hour.
const MAX_JOIN_DELAY_MINUTES = 1440;
const JOIN_TIME_TTL_MARGIN_SECONDS = 3600;

// Housekeeping interval for the in-process flood fallback below.
const LOCAL_FLOOD_SWEEP_INTERVAL_MS = 60_000;

export class ContentFilterService {
  private logger: Logger;
  // Fallback sliding windows used only while the Redis counter is unusable.
  // Each entry carries the window it was measured with — see checkFloodLocally.
  private localFloodWindows: Map<string, { windowMs: number; stamps: number[] }> = new Map();
  private lastLocalFloodSweep = 0;

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
   *
   * Two kinds of signal are combined:
   *  - **Explicit rules** (custom keywords, blockUrls, blockInviteLinks,
   *    blockPhoneNumbers). These are switches an admin deliberately turned on,
   *    so a single match blocks the message outright. They used to be scored
   *    like hints — one advertising link was worth 25 and a phone number 15
   *    against a threshold of 30, which meant "block all URLs" did not actually
   *    block a URL. Anything that only *sometimes* enforces a switch the admin
   *    flipped is worse than not having the switch. That only holds while each
   *    rule fires on an unambiguous signal, which is why PHONE_REGEX no longer
   *    accepts a bare run of digits: a decisive rule with a loose pattern
   *    deletes ordinary chat.
   *  - **Heuristic patterns** (built-in ad/scam wording, spam TLDs). Still
   *    additive, so several weak hints together clear BLOCK_SCORE_THRESHOLD.
   */
  analyzeText(text: string, filterConfig: FilterConfig, context: AnalyzeContext = {}): FilterResult {
    const reasons: string[] = [];
    let score = 0;
    // Set by explicit rules only — see the doc comment above.
    let ruleViolated = false;

    if (!text || !filterConfig.enabled) {
      return { blocked: false, reasons: [], score: 0 };
    }

    // Everything below matches against the normalised copy so full-width,
    // zero-width and homoglyph obfuscation cannot walk past the patterns. The
    // one thing it must never decide is an *exemption* — see the URL check.
    const normalized = normalizeForMatching(text);

    // 1. Custom keywords (highest priority)
    if (filterConfig.customKeywords.length > 0) {
      const lowerText = normalized.toLowerCase();
      for (const keyword of filterConfig.customKeywords) {
        const needle = normalizeForMatching(keyword).toLowerCase();
        if (needle && lowerText.includes(needle)) {
          reasons.push(`自定义关键词: ${keyword}`);
          score += 50;
          ruleViolated = true;
        }
      }
    }

    // 2. URL check
    if (filterConfig.blockUrls) {
      const links = this.collectLinkCandidates(text, normalized);
      if (links.length > 0) {
        // The whitelist is applied to the link *as it was typed*, never to the
        // folded copy: `https://exаmple.com` (Cyrillic а) folds to a
        // whitelisted "example.com" while the client opens the attacker's
        // xn--exmple-4nf.com. Homoglyph folding may only make matching
        // stricter — it must never hand out an exemption.
        const nonWhitelisted = links.filter(
          link => !(link.literal !== null && this.isUrlWhitelisted(link.literal, filterConfig.whitelistUrls))
        );
        if (nonWhitelisted.length > 0) {
          reasons.push(`链接: ${nonWhitelisted.length}个`);
          // One link already violates the rule; extra links only raise severity.
          score += BLOCK_SCORE_THRESHOLD + (nonWhitelisted.length - 1) * 5;
          ruleViolated = true;

          // A host that is not whitelisted but folds onto one that is, is a
          // deliberate look-alike of a domain this group trusts — the exact
          // case that used to buy a full exemption now costs extra points.
          //
          // The hostnames must genuinely differ. Folding also normalises
          // characters outside the domain, so requiring a real host-level
          // difference is what separates "attacker swapped a Cyrillic а into
          // the domain" from "author typed a full-width character in the path".
          const impostors = nonWhitelisted.filter(link => {
            if (!this.isUrlWhitelisted(link.normalized, filterConfig.whitelistUrls)) return false;
            if (link.literal === null) return true;
            return this.extractHostname(link.literal) !== this.extractHostname(link.normalized);
          });
          if (impostors.length > 0) {
            reasons.push('仿冒白名单域名');
            score += 30 * impostors.length;
          }

          // Extra score for spammy TLDs — hostname only, never path/query.
          const suspicious = nonWhitelisted.filter(link => {
            const host = this.extractHostname(link.literal ?? link.normalized);
            return host !== null && SPAM_TLD_REGEX.test(host);
          });
          if (suspicious.length > 0) {
            reasons.push('可疑域名');
            score += 15 * suspicious.length;
          }
        }
      }
    }

    // 3. Invite links
    if (filterConfig.blockInviteLinks) {
      const invites = normalized.match(TG_INVITE_REGEX) || [];
      const deepLinkInvite = TG_DEEPLINK_INVITE_REGEX.test(normalized);
      if (invites.length > 0 || deepLinkInvite) {
        reasons.push(`邀请链接: ${invites.length + (deepLinkInvite ? 1 : 0)}个`);
        score += 40;
        ruleViolated = true;
      }
    }

    // 4. Phone numbers
    if (filterConfig.blockPhoneNumbers) {
      const phones = normalized.match(PHONE_REGEX) || [];
      // Keep only dialable lengths: shorter is not a number anyone can call,
      // longer is an identifier that merely happens to carry separators.
      const realPhones = phones.filter(p => {
        const digits = p.replace(/\D/g, '').length;
        return digits >= PHONE_MIN_DIGITS && digits <= PHONE_MAX_DIGITS;
      });
      if (realPhones.length > 0) {
        reasons.push(`手机号: ${realPhones.length}个`);
        score += 30;
        ruleViolated = true;
      }
    }

    // 5. Built-in spam patterns (heuristics — additive, not decisive)
    for (const { pattern, weight, label } of SPAM_PATTERNS) {
      if (pattern.test(normalized)) {
        reasons.push(label);
        score += weight;
      }
    }

    // 6. Phishing-bot lures.
    //
    // An account posts "@somebot campaign_001 g17900…" — no link, no phone
    // number, nothing any rule above looks at, so it scored zero. The mention
    // routes members to a bot that runs the actual scam, and the token tells
    // the operator which spam run brought the victim in. A bot mention on its
    // own is ordinary (people invoke inline bots); a bot mention *carrying a
    // tracking payload* is not.
    const lures = this.findBotLures(normalized, context.exemptBots);
    if (lures.mentions.length > 0) {
      if (filterConfig.blockBotMentions) {
        reasons.push(`机器人链接: ${lures.mentions.length}个`);
        score += BLOCK_SCORE_THRESHOLD;
        ruleViolated = true;
      }
      if (lures.withTracking) {
        reasons.push('钓鱼机器人');
        score += 35;
      }
    }

    // 7. Quoting a post from another chat. A legitimate feature, so it only
    // adds weight — but it is how the lure above borrows credibility, by
    // quoting (or faking) an official announcement channel above the payload.
    if (context.crossChatQuote) {
      reasons.push('跨群引用');
      score += 15;
    }

    // Clamp score
    score = Math.min(score, 100);

    return {
      blocked: ruleViolated || score >= BLOCK_SCORE_THRESHOLD,
      reasons,
      score,
    };
  }

  /**
   * Cheap "does this contain a link at all" probe for the new-user link delay.
   * Runs on the normalised text and covers tg:// deep links, so the delay sees
   * the same links the analyzer does.
   */
  containsLinkSignal(text: string, exemptBots?: string[]): boolean {
    if (!text) return false;
    const normalized = normalizeForMatching(text);
    return (
      normalized.match(URL_REGEX) !== null ||
      normalized.match(TG_INVITE_REGEX) !== null ||
      normalized.match(TG_DEEPLINK_REGEX) !== null ||
      // A bot mention is a link in every sense that matters: one tap opens a
      // chat with it. Leaving it out let a brand-new account send members to a
      // phishing bot straight through the new-user link delay.
      this.findBotLures(normalized, exemptBots).mentions.length > 0
    );
  }

  /**
   * Bot mentions in already-normalised text, and whether any of them is
   * followed on the same line by a tracking payload.
   */
  private findBotLures(
    normalized: string,
    exemptBots: string[] = []
  ): { mentions: string[]; withTracking: boolean } {
    const exempt = new Set(exemptBots.filter(Boolean).map(name => name.replace(/^@/, '').toLowerCase()));
    const mentions: string[] = [];
    let withTracking = false;

    for (const match of normalized.matchAll(BOT_MENTION_REGEX)) {
      const username = match[1].toLowerCase();
      if (exempt.has(username)) continue;
      mentions.push(username);

      const start = (match.index ?? 0) + match[0].length;
      const lineEnd = normalized.indexOf('\n', start);
      const rest = normalized.slice(start, lineEnd === -1 ? undefined : lineEnd);
      if (TRACKING_TOKEN_REGEX.test(rest)) withTracking = true;
    }

    return { mentions, withTracking };
  }

  /**
   * Every link in a message, in both the form the client resolves and the form
   * the patterns match.
   *
   * `literal` is the substring exactly as it was typed and is the *only* thing
   * the whitelist is ever allowed to see. `normalized` is the folded copy, which
   * is what catches full-width or zero-width-split links; a candidate that only
   * exists in that copy has no literal form the whitelist could vouch for, so it
   * carries `literal: null` and can never be exempted.
   */
  private collectLinkCandidates(
    text: string,
    normalized: string
  ): Array<{ literal: string | null; normalized: string }> {
    const candidates: Array<{ literal: string | null; normalized: string }> = [];
    // Occurrence counter, not a set: two links that fold to the same string are
    // still two links, and consuming them one by one keeps a legitimate URL from
    // vouching for an identical-looking homoglyph twin in the same message.
    //
    // Keyed on the folded *hostname*, not the whole folded URL. URL_STOP_CHARS
    // ends a raw match at a full-width character while NFKC folds that same
    // character back into ASCII, so one link could yield a truncated literal
    // ("https://example.com/") and a longer normalised twin
    // ("https://example.com/path"). Pairing on the whole string left the twin
    // unmatched, and an unmatched candidate is treated as folded-only — which
    // reported a genuinely whitelisted link as an impostor. Only the hostname
    // ever decides a verdict, so it is the right identity for pairing.
    const accountedFor = new Map<string, number>();
    const identity = (url: string): string => this.extractHostname(url) ?? url;

    for (const literal of this.matchLinks(text)) {
      const folded = normalizeForMatching(literal);
      const key = identity(folded);
      accountedFor.set(key, (accountedFor.get(key) ?? 0) + 1);
      candidates.push({ literal, normalized: folded });
    }

    for (const link of this.matchLinks(normalized)) {
      const key = identity(link);
      const pending = accountedFor.get(key) ?? 0;
      if (pending > 0) {
        accountedFor.set(key, pending - 1); // Same link, already held in literal form.
        continue;
      }
      candidates.push({ literal: null, normalized: link });
    }

    return candidates;
  }

  /** Raw link substrings of one string, with the sentence punctuation trimmed off. */
  private matchLinks(source: string): string[] {
    return [
      ...(source.match(URL_REGEX) || []),
      ...(source.match(TG_DEEPLINK_REGEX) || []),
    ].map(url => url.replace(URL_TRAILING_PUNCT_REGEX, ''));
  }

  /**
   * Reason label for blocking a forwarded message, or null to allow it.
   *
   * Only channel forwards used to be caught, which left the two origins spam
   * actually prefers — another group, and a sender who hid their account —
   * completely unfiltered. Forwards from a named user stay allowed: the origin
   * is attributable and the text still goes through analyzeText().
   */
  forwardBlockReason(origin: MessageOrigin | undefined): string | null {
    switch (origin?.type) {
      case 'channel':
        return '频道转发';
      case 'chat':
        return '群组转发';
      case 'hidden_user':
        return '匿名转发';
      default:
        return null;
    }
  }

  /**
   * Real hostname of a matched URL, lower-cased and punycoded, or null when the
   * URL cannot be parsed or is not http(s). Callers treat null as untrusted.
   */
  private extractHostname(url: string): string | null {
    try {
      // URL_REGEX also matches scheme-less "www.foo.com". The scheme test needs
      // the "//" — without it "example.com:8080" read as the scheme
      // "example.com:", so every whitelist entry or link carrying a port was
      // parsed as a non-http URL and silently treated as untrusted.
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
      const parsed = new URL(withScheme);
      // A domain whitelist can only vouch for web links; tg:// and friends
      // carry no comparable authority.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
      return host || null;
    } catch {
      return null;
    }
  }

  /** Reduce an admin-typed whitelist entry ("*.a.com", "https://a.com/x") to a bare host. */
  private normalizeWhitelistDomain(entry: string): string | null {
    const trimmed = entry.trim().toLowerCase().replace(/^\*\./, '');
    if (!trimmed) return null;
    // Parsed the same way as the URL under test, so IDN entries end up in the
    // same punycode form and compare equal.
    return this.extractHostname(trimmed);
  }

  /**
   * Check if a URL is in the whitelist.
   *
   * Matching is done on the parsed hostname, exact or as a true subdomain.
   * The previous substring test let both `https://evil.com/?ref=trusted.example`
   * (whitelisted domain in the query string) and `trusted.example.attacker.com`
   * (whitelisted domain as a prefix label) skip the filter entirely.
   */
  private isUrlWhitelisted(url: string, whitelist: string[]): boolean {
    if (whitelist.length === 0) return false;
    const host = this.extractHostname(url);
    if (!host) return false; // Unparseable or non-http: cannot be vouched for.
    return whitelist.some(entry => {
      const domain = this.normalizeWhitelistDomain(entry);
      if (!domain) return false;
      // `.` guard keeps 'nottrusted.example' from matching 'trusted.example'.
      return host === domain || host.endsWith(`.${domain}`);
    });
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
  // 'delete' was declared but never returned, which left the handler carrying a
  // branch that could not run and a label nothing ever displayed. Deleting the
  // offending message happens unconditionally; this decides what happens to the
  // sender on top of that.
  determineAction(violationCount: number, config: FilterConfig): 'warn' | 'mute' | 'ban' {
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
   * Remember when a user joined, for the new-user link delay.
   *
   * TTL follows the delay that has to be enforced instead of a fixed hour.
   * Callers that do not know the group's configured delay yet (the join handler
   * runs before the filter config is read) get the maximum supported window, so
   * no configuration can outlive its own evidence.
   */
  async recordUserJoinTime(groupId: string, userId: string, delayMinutes?: number): Promise<void> {
    const key = `jointime:${groupId}:${userId}`;
    const minutes = Math.min(
      delayMinutes && delayMinutes > 0 ? delayMinutes : MAX_JOIN_DELAY_MINUTES,
      MAX_JOIN_DELAY_MINUTES
    );
    await redisService.set(key, Date.now().toString(), minutes * 60 + JOIN_TIME_TTL_MARGIN_SECONDS);
  }

  /**
   * Is the sender still inside the "no links from newcomers" window?
   *
   * Only a recorded join time can answer this. It is written by the join guard
   * (recordUserJoinTime) with a TTL that outlives the longest configurable
   * delay, so a member with no record either joined long enough ago that the key
   * expired, joined before the bot did, or lost the record to a Redis wipe. Two
   * of those three are established members, and the third is indistinguishable
   * from them here — so no record means "not new".
   *
   * The previous version failed closed instead and used the UserGroupProfile row
   * as the durable "we already know this member" marker. That row is not written
   * on join: LevelService creates it from the XP path, and a message this filter
   * blocks never reaches the XP path. A member wrongly judged new therefore had
   * their message deleted, which prevented the very row that would have cleared
   * them — a self-sustaining warn → mute → ban loop that no amount of normal
   * behaviour could break out of. Deleting a newcomer's link is recoverable;
   * banning an established member over a missing cache entry is not.
   *
   * Nothing else is relaxed by this: newcomers still face blockUrls,
   * blockInviteLinks and the full heuristic pattern set on the same message.
   */
  async isNewUser(groupId: string, userId: string, delayMinutes: number): Promise<boolean> {
    if (delayMinutes <= 0) return false;
    const windowMs = delayMinutes * 60 * 1000;
    const key = `jointime:${groupId}:${userId}`;

    try {
      const joinTime = await redisService.get(key);
      if (joinTime) {
        const recordedAt = Number.parseInt(joinTime, 10);
        if (Number.isFinite(recordedAt)) {
          const age = Date.now() - recordedAt;
          // A timestamp in the future — clock skew between the instance that
          // wrote it and this one, or a corrupted value — produces a negative
          // age, which would satisfy `age < windowMs` for as long as the key
          // lives and hold an established member in the new-user delay
          // indefinitely. Treat anything not in the past as "not new".
          if (age < 0) {
            this.logger.warn('Join timestamp is in the future, ignoring the new-user delay', {
              groupId,
              userId,
              recordedAt,
            });
            return false;
          }
          return age < windowMs;
        }
      }
    } catch (error) {
      // A lookup failure is not evidence about the sender either way, and this
      // check runs on ordinary chat that merely contains a link.
      this.logger.warn('Join-time lookup failed, not applying the new-user link delay', error);
    }

    return false;
  }

  // ── Flood control (Redis sliding window) ──

  /**
   * Record a message and check if the user is flooding.
   * Uses a Redis sorted set with timestamps as scores for precise sliding window.
   * Returns { flooding, messageCount } where flooding = true if limit exceeded.
   *
   * A Redis failure used to throw out of here, which the message pipeline caught
   * and treated as "not flooding" — the rate limit disappeared exactly when the
   * infrastructure was already under stress. We degrade to a per-process window
   * instead: less accurate (each replica counts on its own, so the effective
   * limit is per replica) but still a limit.
   */
  async checkFlood(
    groupId: string,
    userId: string,
    config: FloodConfig
  ): Promise<{ flooding: boolean; messageCount: number }> {
    const key = `flood:${groupId}:${userId}`;
    // Housekeeping runs on every call, not only while Redis is down: the
    // fallback windows built during an outage were otherwise never collected
    // again once Redis came back.
    this.sweepLocalFloodWindows(Date.now());

    try {
      const { allowed, remaining } = await redisService.getRateLimitInfo(
        key,
        config.windowSeconds * 1000,
        config.maxMessages
      );
      const messageCount = config.maxMessages - remaining;

      // The count comes from a ZCARD issued *after* this message's own ZADD, so
      // a working counter can never report fewer than one. Zero means the
      // pipeline came back with per-command errors — a read-only replica, OOM,
      // or a WRONGTYPE key. ioredis resolves those instead of rejecting, and
      // they surface as count 0, i.e. a silent "nobody is flooding" for the
      // whole group. Catching the rejection alone was not enough.
      if (config.maxMessages > 0 && messageCount <= 0) {
        this.logger.warn('Redis flood counter returned an impossible count, using in-process window', {
          key,
          messageCount,
        });
        return this.checkFloodLocally(key, config);
      }

      return { flooding: !allowed, messageCount };
    } catch (error) {
      this.logger.warn('Redis flood counter unavailable, using in-process window', error);
      return this.checkFloodLocally(key, config);
    }
  }

  /** In-process sliding window used only while the Redis counter is unavailable. */
  private checkFloodLocally(
    key: string,
    config: FloodConfig
  ): { flooding: boolean; messageCount: number } {
    const now = Date.now();
    const windowMs = config.windowSeconds * 1000;

    const stamps = (this.localFloodWindows.get(key)?.stamps || []).filter(t => now - t < windowMs);
    stamps.push(now);
    // Cap the buffer: past the limit the exact count no longer changes the
    // verdict, and an aggressive flooder should not be able to grow it freely.
    const cap = config.maxMessages + 1;
    if (stamps.length > cap) stamps.splice(0, stamps.length - cap);
    // The window length is stored per key. The sweep used to apply whichever
    // group called it last, so a group with a 10-second window evicted the still
    // live timestamps of a group with a 300-second one.
    this.localFloodWindows.set(key, { windowMs, stamps });

    return { flooding: stamps.length > config.maxMessages, messageCount: stamps.length };
  }

  /** Drop windows that can no longer hold a live timestamp, bounding the map. */
  private sweepLocalFloodWindows(now: number): void {
    if (now - this.lastLocalFloodSweep < LOCAL_FLOOD_SWEEP_INTERVAL_MS) return;
    this.lastLocalFloodSweep = now;
    for (const [key, window] of this.localFloodWindows) {
      const newest = window.stamps[window.stamps.length - 1];
      if (newest === undefined || now - newest >= window.windowMs) {
        this.localFloodWindows.delete(key);
      }
    }
  }
}
