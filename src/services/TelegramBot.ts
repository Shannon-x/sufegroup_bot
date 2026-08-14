import { Bot, Context, SessionFlavor, session } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { InlineKeyboard } from 'grammy';
import { config } from '../config/config';
import { Logger } from '../utils/logger';
import { UserService } from '../services/UserService';
import { GroupService } from '../services/GroupService';
import { VerificationService } from '../services/VerificationService';
import { AuditService } from '../services/AuditService';
import {
  ContentFilterService,
  FilterConfig,
  DEFAULT_FILTER_CONFIG,
  DEFAULT_FLOOD_CONFIG,
  normalizeForMatching,
  HIGH_CONFIDENCE_SPAM_LABELS,
} from '../services/ContentFilterService';
import type { GroupSettings } from '../entities/GroupSettings';
import { LevelService } from '../services/LevelService';
import { redisService } from '../services/RedisService';
import { CommandHandler } from '../commands/CommandHandler';
import { sendTemporaryMessage } from '../utils/telegram';
import { buildMention, displayName, escapeHtml } from '../utils/markdown';
import { isRealHumanSender } from '../utils/sender';
import { FloodControlHandler } from '../handlers/FloodControlHandler';
import { ContentFilterHandler } from '../handlers/ContentFilterHandler';
import { MembershipHandler } from '../handlers/MembershipHandler';
import { PrivateChatHandler } from '../handlers/PrivateChatHandler';

export interface SessionData {
  step?: string;
  data?: any;
}

export type MyContext = Context & SessionFlavor<SessionData>;

// Max age for debounce entries before cleanup (5 minutes)
const DEBOUNCE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const DEBOUNCE_MAX_AGE_MS = 2 * 60 * 1000;

/**
 * Update types the bot subscribes to.
 *
 * Telegram's default is "every type except chat_member, message_reaction and
 * message_reaction_count", and passing an explicit list *replaces* that default
 * instead of adding to it. The first version of this constant existed to add
 * chat_member — without it a polling deployment never saw a single join event
 * and the entire verification flow was a silent no-op — but by naming six types
 * it also unsubscribed from everything it forgot, most visibly channel_post,
 * which grammy's `bot.command()` matches as well (`Context.has.command` reads
 * `ctx.message ?? ctx.channelPost`).
 *
 * So the list is the default set *plus* chat_member: nothing the bot uses today,
 * or grows a handler for tomorrow, can silently go missing. The two reaction
 * updates stay out — no handler reads them and they are by far the chattiest
 * updates Telegram sends.
 */
const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
  'inline_query',
  'chosen_inline_result',
  'callback_query',
  'shipping_query',
  'pre_checkout_query',
  'purchased_paid_media',
  'poll',
  'poll_answer',
  'my_chat_member',
  'chat_member',
  'chat_join_request',
  'chat_boost',
  'removed_chat_boost',
] as const;

/** Throttle for the degraded-mode notice, so an outage cannot spam a group. */
const DEGRADED_NOTICE_INTERVAL_MS = 60 * 1000;
/** Throttle for the degradation log, so an outage cannot spam the log either. */
const DEGRADED_LOG_INTERVAL_MS = 60 * 1000;

/**
 * Private-invite links: the one link shape that is unambiguous without any
 * per-group configuration. Deliberately narrower than the filter's own invite
 * pattern, which also matches every `t.me/<username>` mention — pointing at a
 * public channel is ordinary conversation and must not be deleted on a guess.
 */
const DEGRADED_INVITE_REGEX =
  /(?:t|telegram)\.me\/(?:joinchat\/|\+)[a-zA-Z0-9_-]+|tg:\/\/join\b/i;

/**
 * What degraded mode may judge on its own.
 *
 * Every switch analyzeText treats as a *decisive* rule is off here. blockUrls,
 * blockInviteLinks, blockPhoneNumbers and customKeywords are per-group
 * decisions, and this config is only ever reached when the group's own
 * decisions could not be read — inheriting them from DEFAULT_FILTER_CONFIG made
 * an outage stricter than any real group: `https://github.com/foo/bar`,
 * `www.python.org` and a zoom invite were all deleted as "links", any 8-digit
 * number as a "phone number", and the emptied whitelist left nothing to soften
 * it. What remains is the built-in scam/ad heuristics, which are additive and
 * only block once several independent signals agree.
 */
const DEGRADED_FILTER_CONFIG: FilterConfig = {
  ...DEFAULT_FILTER_CONFIG,
  enabled: true,
  blockUrls: false,
  blockInviteLinks: false,
  blockPhoneNumbers: false,
  blockForwards: false,
  newUserLinkDelay: 0,
  customKeywords: [],
  whitelistUrls: [],
  flood: { ...DEFAULT_FLOOD_CONFIG },
};

export class TelegramBot {
  private bot: Bot<MyContext>;
  private logger: Logger;
  private userService: UserService;
  private groupService: GroupService;
  private verificationService: VerificationService;
  private auditService: AuditService;
  private contentFilterService: ContentFilterService;
  private levelService: LevelService;
  private commandHandler: CommandHandler;
  private lastChatMemberUpdate: Map<string, number> = new Map();
  private debounceCleanupTimer: NodeJS.Timeout | null = null;

  // ── Degraded-mode state (only written while a dependency is down) ──
  /** `chatId` → last time the group was told moderation is degraded. */
  private lastDegradedNotice: Map<string, number> = new Map();
  /** `chatId` → last time the degradation itself was logged for this group. */
  private lastDegradedLog: Map<string, number> = new Map();
  /**
   * `chatId` → whether the group had content filtering switched on, as of the
   * last time its settings could actually be read. Deliberately not expired: it
   * is one small boolean per active group and its whole purpose is to survive an
   * outage. A group absent from this map has never been observed, so degraded
   * mode has no mandate over it at all — see moderateDegraded.
   */
  private lastKnownFilterEnabled: Map<string, boolean> = new Map();

  // Extracted handlers
  private floodControlHandler: FloodControlHandler;
  private contentFilterHandler: ContentFilterHandler;
  private membershipHandler: MembershipHandler;
  private privateChatHandler: PrivateChatHandler;

  constructor() {
    this.logger = new Logger('TelegramBot');
    this.bot = new Bot<MyContext>(config.bot.token);

    // Auto-retry on 429 (Too Many Requests) from Telegram API
    this.bot.api.config.use(autoRetry({
      maxRetryAttempts: 3,
      maxDelaySeconds: 5,
    }));

    // Initialize services
    this.userService = new UserService();
    this.groupService = new GroupService();
    this.verificationService = new VerificationService();
    this.auditService = new AuditService();
    this.contentFilterService = new ContentFilterService();
    this.levelService = new LevelService();

    // Initialize handlers
    this.floodControlHandler = new FloodControlHandler(
      this.bot, this.contentFilterService, this.auditService
    );
    this.contentFilterHandler = new ContentFilterHandler(
      this.bot, this.contentFilterService, this.auditService
    );
    this.membershipHandler = new MembershipHandler(
      this.bot, this.userService, this.groupService,
      this.verificationService, this.auditService, this.contentFilterService,
      this.levelService
    );
    this.privateChatHandler = new PrivateChatHandler(
      this.verificationService, this.groupService
    );

    // Setup session
    this.bot.use(session({
      initial: (): SessionData => ({})
    }));

    // Initialize command handler
    this.commandHandler = new CommandHandler(
      this.bot,
      this.userService,
      this.groupService,
      this.verificationService,
      this.auditService
    );

    this.setupHandlers();
    this.startDebounceCleanup();
  }

  private startDebounceCleanup() {
    this.debounceCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, timestamp] of this.lastChatMemberUpdate.entries()) {
        if (now - timestamp > DEBOUNCE_MAX_AGE_MS) {
          this.lastChatMemberUpdate.delete(key);
        }
      }

      // The degraded-mode throttles are small and short-lived by design, but
      // they must not keep growing after the outage that filled them is over.
      // (lastKnownFilterEnabled is deliberately excluded — see its declaration.)
      for (const [key, noticedAt] of this.lastDegradedNotice.entries()) {
        if (now - noticedAt > DEGRADED_NOTICE_INTERVAL_MS) {
          this.lastDegradedNotice.delete(key);
        }
      }
      for (const [key, loggedAt] of this.lastDegradedLog.entries()) {
        if (now - loggedAt > DEGRADED_LOG_INTERVAL_MS) {
          this.lastDegradedLog.delete(key);
        }
      }
    }, DEBOUNCE_CLEANUP_INTERVAL_MS);
  }

  private setupHandlers() {
    // Handle new chat members
    this.bot.on('chat_member', async (ctx) => {
      try {
        await this.membershipHandler.handleChatMemberUpdate(ctx, this.lastChatMemberUpdate);
      } catch (error) {
        this.logger.error('Error handling chat member update', error);
      }
    });

    // Handle message from new chat members (fallback)
    this.bot.on('message:new_chat_members', async (ctx) => {
      try {
        await this.membershipHandler.handleNewChatMembers(ctx);
      } catch (error) {
        this.logger.error('Error handling new chat members', error);
      }
    });

    // Handle bot being added to groups
    this.bot.on('my_chat_member', async (ctx) => {
      try {
        await this.membershipHandler.handleBotStatusUpdate(ctx);
      } catch (error) {
        this.logger.error('Error handling bot status update', error);
      }
    });

    // Flood control + content filter for group messages.
    //
    // Registered BEFORE every handler that consumes a message (commands, the
    // reply-keyboard button). grammy stops the chain at the first handler that
    // does not call next(), so a message routed to a command never reached the
    // pipeline — and on top of that any text starting with '/' was explicitly
    // waved through. Between the two, prefixing an ad with "/start " bought
    // complete immunity from anti-flood and content filtering. Everything that
    // enters a group is now checked first and only then dispatched.
    this.bot.on('message', async (ctx, next) => {
      if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
        // A rejection here must never eat the update. Awaiting the pipeline
        // straight into `if (blocked) return` meant any throw skipped next(),
        // so the message vanished for every handler behind this one — commands
        // included — instead of merely going unmoderated. Failures are handled
        // inside moderateGroupMessage; this catch is the last resort.
        let blocked = false;
        try {
          blocked = await this.moderateGroupMessage(ctx, 'new');
        } catch (error) {
          this.logger.error('Moderation pipeline threw, delivering message unmoderated', error);
        }
        if (blocked) return;
      } else if (ctx.chat?.type === 'private' && ctx.from?.id) {
        await this.ensurePrivateKeyboard(ctx);
      }
      await next();
    });

    // Edits run through the content filter too: posting something harmless and
    // editing it into an ad afterwards was a permanent free pass, because an
    // `edited_message` update never touched the filters. They stop there — see
    // moderateGroupMessage for why an edit earns no XP and does not count
    // towards the flood window.
    this.bot.on('edited_message', async (ctx, next) => {
      if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
        let blocked = false;
        try {
          blocked = await this.moderateGroupMessage(this.asEditedMessageView(ctx), 'edit');
        } catch (error) {
          this.logger.error('Edit moderation threw, delivering edit unmoderated', error);
        }
        if (blocked) return;
      }
      await next();
    });

    // Handle "添加到群聊" reply-keyboard button tap (private chat only)
    this.bot.hears('➕ 添加到群聊', async (ctx) => {
      if (ctx.chat?.type !== 'private') return;
      try {
        const botUsername = config.bot.username || 'bot';
        const addToGroupUrl = `https://t.me/${botUsername}?startgroup=true`;
        await ctx.reply(
          '点击下方按钮将我添加到你的群组，添加后请将我设置为管理员（需要删除消息、封禁用户权限）。',
          { reply_markup: new InlineKeyboard().url('➕ 添加到群聊', addToGroupUrl) }
        );
      } catch (error) {
        this.logger.error('Error handling add-to-group button', error);
      }
    });

    // Commands. The per-command rate limiter lives inside setup(), so anything
    // registered after this line is covered by it.
    this.commandHandler.setup();

    // /start used to be registered before the command middleware and was the
    // one command nobody could rate limit — it is now behind it like the rest.
    this.bot.command('start', async (ctx) => {
      try {
        await this.privateChatHandler.handleStartCommand(ctx);
      } catch (error) {
        this.logger.error('Error handling start command', error);
      }
    });

    // Error handler
    this.bot.catch((err) => {
      this.logger.error('Bot error', err);
    });
  }

  /**
   * Flood control, content filtering and XP for a single group message.
   * Returns true when the message was blocked, in which case the update must
   * not reach any further handler.
   *
   * `source` separates a freshly posted message from an edit of one that was
   * already processed. An edit is re-filtered, because its text changed, but it
   * is never re-counted: Telegram emits `edited_message` for *automatic* edits
   * as well — live location sharing rewrites the same message for the entire
   * duration of the share — so feeding edits into the flood window muted people
   * for standing still, and re-awarding XP would make "edit your own message"
   * the cheapest farm there is.
   */
  private async moderateGroupMessage(ctx: MyContext, source: 'new' | 'edit'): Promise<boolean> {
    const chatId = ctx.chat!.id.toString();
    const userId = ctx.from?.id;

    // Settings are fetched on their own because they alone decide whether the
    // degraded path is even legitimate. getSettings treats Redis as a pure
    // cache and falls back to Postgres, so a throw here means no configuration
    // source answered at all — the only state in which guessing is defensible.
    let settings: GroupSettings | null;
    try {
      settings = await this.groupService.getSettings(chatId);
    } catch (error) {
      return this.moderateDegraded(ctx, error);
    }

    try {
      const isAdmin = userId
        ? await this.groupService.isAdminCached(Number(chatId), userId, ctx.api)
        : false;

      // Remember whether this group asked for content filtering, so that a
      // later outage can honour that answer instead of guessing at it.
      if (settings) {
        const filterConfig = this.contentFilterService.getFilterConfig(settings.customSettings);
        this.lastKnownFilterEnabled.set(chatId, filterConfig.enabled);
      }

      // 1. Flood control (runs on ALL messages, even non-text) — new posts only.
      if (source === 'new') {
        const flooded = await this.floodControlHandler.handle(ctx, settings, isAdmin);
        if (flooded) return true;
      }

      // 2. Content filter (spam/ads/keywords)
      const filtered = await this.contentFilterHandler.handle(ctx, settings, isAdmin);
      if (filtered) return true;

      // 3. Award XP — only for real human members, and never for a command.
      //    Bots, anonymous admins (GroupAnonymousBot, first_name "Group") and
      //    channel/group identity posts must never accrue XP or be announced as
      //    levelling up, otherwise they create ghost profiles and broadcast
      //    "Group". Commands are instructions to the bot rather than
      //    conversation, and the old '/'-prefix shortcut used to keep them out
      //    of XP as a side effect of skipping the whole pipeline; removing that
      //    shortcut (rightly — "/start <ad>" must not buy immunity) turned
      //    `/rank` spam into a level farm, so the exclusion is made explicit
      //    here, at the XP step only.
      if (source === 'new' && !this.isCommandMessage(ctx) && isRealHumanSender(ctx)) {
        try {
          // Persist/refresh the sender's name. The XP path is the only place
          // an already-present member is observed, and it never wrote the
          // users table before — so leaderboards/broadcasts could not resolve
          // a real name and fell back to the raw numeric id. Fire-and-forget.
          this.userService.findOrCreate(ctx.from!).catch(() => {});

          const customTitles = settings?.customSettings?.customTitles || null;
          const result = await this.levelService.awardMessageXP(
            userId!.toString(),
            chatId,
            customTitles
          );
          if (result?.leveledUp) {
            await this.announceLevelUp(ctx, result);
          }
        } catch (error) {
          // XP tracking failure should not block messages
          this.logger.debug('XP tracking failed', error);
        }
      }

      return false;
    } catch (error) {
      // Handlers below this point swallow their own dependency failures, so an
      // exception escaping here is unexpected. Fall back to the same narrow
      // checks rather than to "deliver anyway".
      return this.moderateDegraded(ctx, error);
    }
  }

  /**
   * Is this message an instruction to the bot rather than conversation?
   *
   * Asked by the XP step only. The filters above deliberately treat a command
   * like any other text: waving '/'-prefixed text through was how "/start" plus
   * an ad bought complete immunity from filtering.
   */
  private isCommandMessage(ctx: MyContext): boolean {
    const message = ctx.message;
    if (!message) return false;

    const text = message.text ?? message.caption ?? '';
    if (!text.startsWith('/')) return false;

    // Telegram marks a real command with a bot_command entity at offset 0; the
    // literal prefix test covers the messages that carry no entities at all.
    const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
    return (
      entities.some((entity) => entity.type === 'bot_command' && entity.offset === 0) ||
      /^\/[a-zA-Z0-9_]/.test(text)
    );
  }

  /**
   * Moderation fallback for when the group's configuration could not be read.
   *
   * The original code logged the exception and let the message through, so an
   * outage switched moderation off entirely — exactly the window an automated
   * account needs. The first correction went too far the other way: it ran
   * DEFAULT_FILTER_CONFIG, whose blockUrls / blockInviteLinks /
   * blockPhoneNumbers switches analyzeText treats as *decisive*, against every
   * group including those that had never turned filtering on. During a Redis
   * blip a link to github.com, a zoom invite or an order number was deleted from
   * groups that had asked for none of it. Deleting a member's message is the
   * most visible thing this bot does; doing it on a guess is worse than doing
   * nothing, and it also trains admins to remove the bot.
   *
   * The mandate here is therefore deliberately small:
   *  - only groups positively observed with content filtering switched on are
   *    policed. For an unknown group — never seen, or seen only after a restart
   *    — we do not even know whether filtering was wanted, so the outage is
   *    recorded and nothing else happens;
   *  - only signals that are unambiguous *without* per-group state are acted on:
   *    a private invite link, and the built-in scam/ad heuristics, which are
   *    additive and need several agreeing signals to reach their threshold.
   *    "Contains a URL" and "contains an 8-digit number" are not such signals.
   *
   * Flood control needs no stand-in: ContentFilterService.checkFlood already
   * falls back to an in-process window when Redis is down, and a *guessed* rate
   * limit would be precisely the kind of generic signal this must not act on.
   */
  private async moderateDegraded(ctx: MyContext, error: unknown): Promise<boolean> {
    const chatId = ctx.chat!.id.toString();
    const userId = ctx.from?.id;

    this.logDegradation(chatId, userId, error);

    if (!userId) return false;
    if (this.lastKnownFilterEnabled.get(chatId) !== true) return false;

    const reasons = this.degradedReasons(ctx);
    if (reasons.length === 0) return false;

    // Admins are exempt from the normal pipeline and must stay exempt here. The
    // cached lookup went down with the pipeline, but Telegram itself is
    // evidently reachable — we just received this update — so ask it directly.
    // Only messages that already tripped a signal pay for this extra call.
    if (await this.isChatAdmin(ctx, userId)) return false;

    let deleted = true;
    try {
      await ctx.deleteMessage();
    } catch (deleteError) {
      deleted = false;
      this.logger.warn('Degraded moderation could not delete message', deleteError);
    }

    await this.auditService
      .log({
        groupId: chatId,
        userId: userId.toString(),
        // Everywhere else 'moderation_failed' means "the disposal we attempted
        // did not happen" — it is what operators grep for to find a bot that
        // lost its permissions. A degraded deletion that *worked* is a filtered
        // message like any other and must not drown that signal out.
        action: deleted ? 'message_filtered' : 'moderation_failed',
        details: deleted
          ? `Degraded moderation deleted a message: ${reasons.join(', ')}`
          : `Degraded moderation could not delete a message: ${reasons.join(', ')}`,
        metadata: { reasons, degraded: true, messageDeleted: deleted },
      })
      .catch((auditError) => this.logger.debug('Degraded audit log failed', auditError));

    this.logger.warn('Degraded moderation blocked a message', { chatId, userId, reasons, deleted });

    await this.postDegradedNotice(ctx, chatId);
    return true;
  }

  /**
   * The only content signals degraded mode may act on. Wrapped so a failure
   * inside the analyzer cannot escape into the middleware chain and take the
   * whole update with it.
   */
  private degradedReasons(ctx: MyContext): string[] {
    const text = ctx.message?.text || ctx.message?.caption || '';
    if (!text) return [];

    try {
      // Normalised exactly as the filter does, so zero-width and homoglyph
      // obfuscation cannot walk an invite link past this check.
      if (DEGRADED_INVITE_REGEX.test(normalizeForMatching(text))) return ['邀请链接'];

      const analysis = this.contentFilterService.analyzeText(text, DEGRADED_FILTER_CONFIG);
      // Judge by category, not by score. Degraded verdicts are made without the
      // group's configuration and cannot be tuned or switched off by the admins
      // they affect, so they must only fire on unambiguous categories. Measured
      // scores overlap: an innocent "欢迎大家加入我们的讨论组，了解更多详情" reaches 35 on
      // generic promotion patterns while a real gambling ad reaches 40 — no
      // threshold separates those, but the label does.
      return analysis.reasons.filter(reason => HIGH_CONFIDENCE_SPAM_LABELS.has(reason));
    } catch (analysisError) {
      this.logger.warn('Degraded content analysis failed, leaving message alone', analysisError);
      return [];
    }
  }

  /**
   * Record that moderation is running degraded, at most once a minute per group.
   * An outage on a busy group would otherwise write one error line per message
   * and bury the report of the outage itself.
   */
  private logDegradation(chatId: string, userId: number | undefined, error: unknown) {
    const now = Date.now();
    const last = this.lastDegradedLog.get(chatId) ?? 0;
    if (now - last < DEGRADED_LOG_INTERVAL_MS) return;
    this.lastDegradedLog.set(chatId, now);

    this.logger.error('Moderation pipeline failed, falling back to degraded checks', {
      chatId,
      userId,
      // Tells an operator straight away whether this group is being policed at
      // all during the outage, or only observed.
      filteringKnownEnabled: this.lastKnownFilterEnabled.get(chatId) ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /** Live admin lookup for degraded mode; unknown counts as a normal member. */
  private async isChatAdmin(ctx: MyContext, userId: number): Promise<boolean> {
    try {
      const member = await ctx.api.getChatMember(ctx.chat!.id, userId);
      return member.status === 'administrator' || member.status === 'creator';
    } catch (error) {
      // Being wrong here costs an admin a single message during an outage;
      // guessing the other way would hand a spammer a free pass.
      this.logger.debug('Degraded admin check failed, treating as member', error);
      return false;
    }
  }

  /**
   * Tell the group at most once a minute that moderation is running degraded,
   * so a deleted message is not a silent mystery for as long as the outage lasts.
   */
  private async postDegradedNotice(ctx: MyContext, chatId: string) {
    const now = Date.now();
    const last = this.lastDegradedNotice.get(chatId) ?? 0;
    if (now - last < DEGRADED_NOTICE_INTERVAL_MS) return;
    this.lastDegradedNotice.set(chatId, now);

    try {
      await sendTemporaryMessage(
        this.bot,
        ctx.chat!.id,
        '⚠️ 依赖服务暂时不可用，机器人已切换为保守模式，暂时只拦截高置信度的垃圾内容。',
        {},
        30000
      );
    } catch (error) {
      this.logger.debug('Could not post degraded-mode notice', error);
    }
  }

  /**
   * Present an `edited_message` update as if it carried a fresh message.
   *
   * The filter handlers read `ctx.message`, which Telegram leaves unset on an
   * edit, so without this they would see empty text and wave every edit
   * through. The view shadows that single accessor and is discarded after the
   * pipeline, leaving the real context — and any later middleware — untouched.
   */
  private asEditedMessageView(ctx: MyContext): MyContext {
    const edited = ctx.editedMessage;
    if (!edited) return ctx;

    const view = Object.create(ctx) as MyContext;
    Object.defineProperty(view, 'message', { value: edited, configurable: true });
    return view;
  }

  /**
   * Private chat: ensure the persistent keyboard is visible. Commands are
   * skipped — /start sends the keyboard itself, and doing both looks broken.
   */
  private async ensurePrivateKeyboard(ctx: MyContext) {
    if (ctx.message?.text?.startsWith('/')) return;

    const cacheKey = `kb_shown:${ctx.from!.id}`;
    try {
      const already = await redisService.get(cacheKey);
      if (!already) {
        await redisService.set(cacheKey, '1', 86400 * 30); // 30 days
        await this.privateChatHandler.sendWelcomeKeyboard(ctx);
      }
    } catch {
      // Non-critical: keyboard display failure should not break other handling
    }
  }

  /**
   * Announce a level-up. Renders a clickable HTML mention (so the member is
   * pinged and can be tapped), replies to the triggering message, escapes all
   * user-controlled text, throttles per group to avoid floods, and on any send
   * failure logs + retries once as plain text instead of swallowing the error.
   */
  private async announceLevelUp(
    ctx: MyContext,
    result: { newLevel: number; title: string }
  ) {
    const chatId = ctx.chat!.id;

    // Throttle: at most a few level-up messages per group per window so a burst
    // of simultaneous level-ups can't flood the chat. XP is still awarded.
    if (!(await this.canBroadcastLevelUp(chatId.toString()))) return;

    const mention = buildMention(ctx.from!);
    const text =
      `🎉 恭喜 ${mention} 升级到 <b>Lv.${result.newLevel}</b>！\n` +
      `称号: ${escapeHtml(result.title)}`;
    const replyToMessageId = ctx.message?.message_id;

    try {
      await sendTemporaryMessage(
        this.bot,
        chatId,
        text,
        {
          parse_mode: 'HTML',
          ...(replyToMessageId
            ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }
            : {}),
        },
        30000
      );
    } catch (error) {
      // Should be rare now that we use HTML + escaping, but never swallow it.
      this.logger.warn('Level-up broadcast failed, retrying as plain text', error);
      try {
        const plain = `🎉 恭喜 ${displayName(ctx.from!)} 升级到 Lv.${result.newLevel}！称号: ${result.title}`;
        await sendTemporaryMessage(this.bot, chatId, plain, {}, 30000);
      } catch (retryError) {
        this.logger.warn('Level-up plain-text fallback also failed', retryError);
      }
    }
  }

  /** Best-effort per-group throttle for level-up broadcasts (fail-open). */
  private async canBroadcastLevelUp(chatId: string): Promise<boolean> {
    try {
      const count = await redisService.increment(`lvlup_rate:${chatId}`, 10);
      return count <= 3; // ≤ 3 broadcasts per 10s window per group
    } catch {
      return true;
    }
  }

  private async setBotCommands() {
    try {
      const privateCommands = [
        { command: 'start', description: '开始使用机器人' },
        { command: 'help', description: '显示帮助信息' },
      ];

      const groupCommands = [
        { command: 'help', description: '显示帮助信息' },
        { command: 'settings', description: '管理群组设置（管理员）' },
        { command: 'admin', description: '管理面板（管理员）' },
        { command: 'filter', description: '内容过滤管理（管理员）' },
        { command: 'stats', description: '查看群组统计' },
        { command: 'kick', description: '踢出用户（管理员）' },
        { command: 'ban', description: '封禁用户（管理员）' },
        { command: 'unban', description: '解封用户（管理员）' },
        { command: 'mute', description: '禁言用户（管理员）' },
        { command: 'unmute', description: '解除禁言（管理员）' },
        { command: 'checkin', description: '每日签到' },
        { command: 'profile', description: '查看个人资料' },
        { command: 'rank', description: '活跃排行榜' },
        { command: 'lottery', description: '抽奖系统' },
      ];

      await this.bot.api.setMyCommands(privateCommands, {
        scope: { type: 'all_private_chats' }
      });

      await this.bot.api.setMyCommands(groupCommands, {
        scope: { type: 'all_group_chats' }
      });

      await this.bot.api.setMyCommands(groupCommands, {
        scope: { type: 'all_chat_administrators' }
      });

      await this.bot.api.setMyCommands([
        { command: 'start', description: '开始使用机器人' },
        { command: 'help', description: '显示帮助信息' },
      ]);

      // Set persistent Mini App menu button for all private chats
      if (config.bot.webhookDomain) {
        await this.bot.api.setChatMenuButton({
          menu_button: {
            type: 'web_app',
            text: '📱 管理面板',
            web_app: { url: `${config.bot.webhookDomain}/mini-app` },
          } as any,
        });
      }

      this.logger.info('Bot commands updated successfully');
    } catch (error) {
      this.logger.error('Error setting bot commands', error);
    }
  }

  async start() {
    await this.bot.init();
    await this.setBotCommands();

    if (config.bot.webhookDomain) {
      const webhookUrl = `${config.bot.webhookDomain}/telegram-webhook`;
      await this.bot.api.setWebhook(webhookUrl, {
        secret_token: config.bot.webhookSecret,
        allowed_updates: ALLOWED_UPDATES,
      });
      this.logger.info(`Webhook set to: ${webhookUrl}`);
    } else {
      this.bot.start({
        // Long polling defaults to Telegram's standard update set, which leaves
        // out chat_member — without this the bot never saw anyone join and
        // verification did nothing at all in every non-webhook deployment.
        allowed_updates: ALLOWED_UPDATES,
        onStart: () => this.logger.info('Bot started in polling mode'),
      });
    }
  }

  async stop() {
    if (this.debounceCleanupTimer) {
      clearInterval(this.debounceCleanupTimer);
      this.debounceCleanupTimer = null;
    }
    await this.bot.stop();
    this.logger.info('Bot stopped');
  }

  getBot() {
    return this.bot;
  }
}
