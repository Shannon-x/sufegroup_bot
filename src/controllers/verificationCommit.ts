import { Bot, GrammyError, HttpError } from 'grammy';
import { ChatPermissions } from 'grammy/types';
import { redisService } from '../services/RedisService';
import { sendTemporaryMessage } from '../utils/telegram';
import { Logger } from '../utils/logger';

/**
 * The commit half of a verification: lift the join restriction and record the
 * session as verified, as one step that can be undone.
 *
 * Doing the two in either order is unsafe on its own. Marking the session
 * verified first tells the user they may speak while they are still muted;
 * unrestricting first — the previous shape — leaves an account that never
 * verified permanently able to speak whenever the session write loses its race,
 * a window the account itself controls by choosing when to submit.
 */
const logger = new Logger('VerificationCommit');

/**
 * Every permission granted: the documented way to *lift* a restriction (an
 * all-true set returns the member to plain `member` status).
 *
 * Duplicated from utils/telegram rather than reused because that helper
 * collapses every failure into `false`, and telling a bot-permission problem
 * apart from a flood-wait — the difference between "alert the admins" and "ask
 * the user to retry" — needs the original error.
 */
const LIFT_ALL_RESTRICTIONS: ChatPermissions = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_change_info: true,
  can_invite_users: true,
  can_pin_messages: true,
  can_manage_topics: true,
};

/** The join-time mute, re-applied when a commit has to be rolled back. */
const MUTE_ALL_PERMISSIONS: ChatPermissions = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
};

/**
 * Why a restriction change failed.
 *
 * `permission`   — the bot lacks the rights; only an admin can fix it.
 * `not_applicable` — nothing to fix: the target is an admin/owner, or is no
 *                    longer in the chat.
 * `transient`    — flood wait, Telegram 5xx, network. Retrying works.
 * `unknown`      — unclassified; log it, do not accuse anyone.
 *
 * Only `permission` is worth telling a group about. Blaming admins for all four
 * turned a Telegram hiccup — reachable by any user, on demand — into a public
 * message that named the group's admins as misconfigured.
 */
export type RestrictionFailureKind = 'permission' | 'not_applicable' | 'transient' | 'unknown';

export type LiftRestrictionOutcome =
  | { ok: true }
  | { ok: false; kind: RestrictionFailureKind; detail: string };

export function classifyRestrictionError(error: unknown): RestrictionFailureKind {
  if (error instanceof HttpError) return 'transient';

  if (error instanceof GrammyError) {
    const code = error.error_code;
    if (code === 429 || code >= 500) return 'transient';

    const description = (error.description || '').toLowerCase();
    if (
      description.includes('not enough rights') ||
      description.includes('chat_admin_required') ||
      description.includes('need administrator') ||
      description.includes('have no rights') ||
      description.includes('bot is not a member') ||
      description.includes('bot was kicked')
    ) {
      return 'permission';
    }
    if (
      description.includes('user_admin_invalid') ||
      description.includes('an administrator of the chat') ||
      description.includes('participant_id_invalid') ||
      description.includes('user not found') ||
      description.includes('member not found') ||
      description.includes('chat not found') ||
      description.includes('user is not a member')
    ) {
      return 'not_applicable';
    }
    return 'unknown';
  }

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econn') ||
    message.includes('socket') ||
    message.includes('network') ||
    message.includes('fetch failed')
  ) {
    return 'transient';
  }
  return 'unknown';
}

/** Lift the join restriction, keeping enough of the error to act on it. */
async function liftRestriction(bot: Bot<any>, chatId: number, userId: number): Promise<LiftRestrictionOutcome> {
  try {
    await bot.api.restrictChatMember(chatId, userId, LIFT_ALL_RESTRICTIONS);
    return { ok: true };
  } catch (error) {
    const kind = classifyRestrictionError(error);
    const detail = error instanceof Error ? error.message : String(error);
    // Raw text stays in the server log; nothing downstream repeats it to a chat.
    logger.error('Failed to lift restrictions from user', { chatId, userId, kind, detail });
    return { ok: false, kind, detail };
  }
}

/** Re-apply the join-time mute after a commit failed. */
async function restoreRestriction(bot: Bot<any>, chatId: number, userId: number): Promise<boolean> {
  try {
    await bot.api.restrictChatMember(chatId, userId, MUTE_ALL_PERMISSIONS);
    return true;
  } catch (error) {
    logger.error('Rollback failed: user is unrestricted with an unverified session', {
      chatId,
      userId,
      kind: classifyRestrictionError(error),
      detail: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export type VerificationCommitResult =
  | { status: 'committed' }
  /**
   * The challenge was passed and the session is recorded as verified, but the
   * mute could not be lifted. The member stays silent until an admin fixes the
   * bot's permissions — recoverable, and strictly better than the alternative:
   * refusing to commit left a verified human sitting in a `pending` session
   * that the timeout scheduler then removed from the group.
   */
  | { status: 'committed_still_muted'; kind: RestrictionFailureKind }
  | { status: 'unrestrict_failed'; kind: RestrictionFailureKind }
  | { status: 'commit_lost'; rolledBack: boolean };

/**
 * Unrestrict, then record the verification — and put the mute back if the
 * record does not stick.
 *
 * `commit` is the conditional UPDATE that flips the session to `verified`. It
 * returns false when the session is no longer `pending` or has expired in the
 * meantime, and that window is not theoretical: the caller's up-front expiry
 * check happens seconds earlier (siteverify round trip, lock, Telegram call),
 * and the account being policed picks the submission time. Without the rollback
 * below, losing that race is exactly how an account that never verified ends up
 * unmuted forever — the session stays `pending`, so the success path never
 * runs, and nothing else re-mutes until the scheduler's timeout policy fires.
 */
export async function unrestrictThenCommit(params: {
  bot: Bot<any>;
  chatId: number;
  userId: number;
  commit: () => Promise<boolean>;
}): Promise<VerificationCommitResult> {
  const { bot, chatId, userId, commit } = params;

  const lifted = await liftRestriction(bot, chatId, userId);
  if (!lifted.ok) {
    // Record the verification anyway. The person in front of the challenge
    // solved it; failing to unmute them is our problem, not theirs, and
    // leaving the session `pending` handed them to the timeout scheduler,
    // which removed them from the group for a permission fault on our side.
    // Committing keeps them muted but safe, and the caller reports the truth.
    let recorded = false;
    try {
      recorded = await commit();
    } catch (error) {
      logger.error('Verification commit threw after the restriction could not be lifted', {
        chatId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!recorded) return { status: 'unrestrict_failed', kind: lifted.kind };
    return { status: 'committed_still_muted', kind: lifted.kind };
  }

  let committed = false;
  try {
    committed = await commit();
  } catch (error) {
    // A throwing commit is the same situation as a false one: the user is
    // unrestricted and the session is not verified.
    logger.error('Verification commit threw after the restriction was lifted', {
      chatId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    committed = false;
  }

  if (committed) return { status: 'committed' };

  const rolledBack = await restoreRestriction(bot, chatId, userId);
  logger.warn('Verification commit lost; restriction rollback attempted', { chatId, userId, rolledBack });
  return { status: 'commit_lost', rolledBack };
}

// ── Single-flight commit lock ──

/** Window in which a session's verification commit is single-flighted. */
export const VERIFY_COMMIT_LOCK_SECONDS = 20;

/**
 * Do not release a lock we may no longer hold. Without an atomic
 * compare-and-delete (which would have to live in RedisService), the honest
 * guard is time: if we are close enough to the TTL that the key could already
 * have expired and been re-taken by another submission, we let it expire rather
 * than delete a stranger's lock.
 */
const LOCK_RELEASE_SAFETY_MS = 5000;

export interface CommitLock {
  key: string;
  ttlSeconds: number;
  acquiredAt: number;
}

export type CommitLockResult =
  | { state: 'acquired'; lock: CommitLock }
  | { state: 'busy' }
  | { state: 'unavailable' };

/**
 * Take the commit lock, or say why not.
 *
 * Strict rather than fail-open: this lock is the only thing stopping two
 * concurrent submissions from each unrestricting, each committing and each
 * announcing. `acquireLock` answers "acquired" when Redis is unreachable, i.e.
 * it drops the guarantee during precisely the incident in which requests pile
 * up. `unavailable` is surfaced to the user as "try again shortly" — no side
 * effect is performed unguarded.
 */
export async function acquireCommitLock(key: string, ttlSeconds: number): Promise<CommitLockResult> {
  try {
    const acquired = await redisService.acquireLockStrict(key, ttlSeconds);
    if (!acquired) return { state: 'busy' };
    return { state: 'acquired', lock: { key, ttlSeconds, acquiredAt: Date.now() } };
  } catch (error) {
    logger.error('Commit lock backend unavailable, refusing to commit unguarded', { key, error });
    return { state: 'unavailable' };
  }
}

export async function releaseCommitLock(lock: CommitLock): Promise<void> {
  const heldMs = Date.now() - lock.acquiredAt;
  if (heldMs >= lock.ttlSeconds * 1000 - LOCK_RELEASE_SAFETY_MS) {
    logger.debug('Held the commit lock too long to release it safely; letting it expire', { key: lock.key });
    return;
  }
  try {
    await redisService.delete(lock.key);
  } catch (error) {
    // Losing the release just means the next attempt waits out the TTL.
    logger.debug('Could not release commit lock', { key: lock.key, error });
  }
}

// ── "Could not unrestrict" alerting ──

/** Cooldown between alerts about the same user. */
const UNRESTRICT_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
/** Ceiling on alerts per group, whatever the number of distinct users. */
const UNRESTRICT_ALERT_GROUP_WINDOW_MS = 60 * 60 * 1000;
const UNRESTRICT_ALERT_GROUP_MAX = 3;
/** The alert removes itself; admins keep the audit log entry. */
const UNRESTRICT_ALERT_TTL_MS = 5 * 60 * 1000;

const alertedUsers = new Map<string, number>();
const alertedGroups = new Map<string, number[]>();

function pruneAlertState(now: number): void {
  for (const [key, at] of alertedUsers) {
    if (now - at >= UNRESTRICT_ALERT_COOLDOWN_MS) alertedUsers.delete(key);
  }
  for (const [groupId, times] of alertedGroups) {
    const kept = times.filter((t) => now - t < UNRESTRICT_ALERT_GROUP_WINDOW_MS);
    if (kept.length === 0) alertedGroups.delete(groupId);
    else alertedGroups.set(groupId, kept);
  }
}

/**
 * May we post a "the bot could not unrestrict this user" notice?
 *
 * This path is reachable on demand by any user who can start a verification, so
 * the throttle is the only thing between it and a group-spam primitive. It is
 * process-local first — a Redis outage must not turn the throttle off, which is
 * what building it on the fail-open lock did — and additionally deduplicated
 * across processes through Redis when Redis is healthy. The per-group ceiling
 * covers the case the per-user cooldown misses: many different accounts each
 * triggering their own "first" alert.
 */
export async function shouldAlertUnrestrictFailure(groupId: string, userId: string): Promise<boolean> {
  const now = Date.now();
  pruneAlertState(now);

  const userKey = `${groupId}:${userId}`;
  const lastForUser = alertedUsers.get(userKey);
  if (lastForUser !== undefined && now - lastForUser < UNRESTRICT_ALERT_COOLDOWN_MS) return false;

  const groupTimes = alertedGroups.get(groupId) ?? [];
  if (groupTimes.length >= UNRESTRICT_ALERT_GROUP_MAX) return false;

  // Cross-process dedup, best effort: if Redis cannot answer we still have the
  // local budgets above, so the worst case is one alert per process per window.
  try {
    const first = await redisService.acquireLockStrict(
      `unrestrict-alert:${groupId}:${userId}`,
      Math.ceil(UNRESTRICT_ALERT_COOLDOWN_MS / 1000),
    );
    if (!first) {
      alertedUsers.set(userKey, now);
      return false;
    }
  } catch (error) {
    logger.debug('Alert dedup backend unavailable, falling back to the in-process budget', error);
  }

  alertedUsers.set(userKey, now);
  alertedGroups.set(groupId, [...groupTimes, now]);
  return true;
}

/**
 * Tell the group that a verified member is still muted because the bot lacks
 * the rights to free them. Auto-deletes: the durable record is the audit log,
 * whereas a permanent message is what made this worth triggering on purpose.
 */
export async function announceUnrestrictFailure(
  bot: Bot<any>,
  chatId: number,
  mention: string,
): Promise<void> {
  try {
    await sendTemporaryMessage(
      bot,
      chatId,
      `⚠️ ${mention} 已通过人机验证，但机器人无法解除其发言限制（通常是缺少「封禁用户」权限）。请管理员检查机器人权限并手动解除限制。`,
      { parse_mode: 'HTML' },
      UNRESTRICT_ALERT_TTL_MS,
    );
  } catch (error) {
    logger.error('Failed to notify group about unrestrict failure', error);
  }
}

/** User-facing copy for a restriction that could not be lifted. */
export function unrestrictFailureMessage(kind: RestrictionFailureKind): string {
  switch (kind) {
    case 'permission':
      return '人机验证已通过，但机器人无法解除您的发言限制（通常是权限不足）。已通知群管理员，请稍后重试。';
    case 'transient':
      return '人机验证已通过，但 Telegram 暂时无法完成操作。请稍等片刻后重试。';
    default:
      return '人机验证已通过，但未能解除您的发言限制。请稍后重试或联系群管理员。';
  }
}

/**
 * Everything both verification endpoints do when the commit did not go through:
 * audit it, decide whether the group should hear about it, and hand back the
 * response to send. Kept in one place so the two endpoints cannot drift into
 * different disclosure rules again.
 *
 * Audit details are deliberately generic — /audit prints them into a group
 * chat, so the raw Telegram error text stays in the server log only.
 */
export async function handleFailedCommit(params: {
  bot: Bot<any>;
  chatId: number;
  groupId: string;
  userId: string;
  result: Exclude<VerificationCommitResult, { status: 'committed' }>;
  source: string;
  audit: (entry: { action: 'unrestrict_failed' | 'restriction_failed'; details: string }) => Promise<void>;
  mention: () => Promise<string>;
}): Promise<{ statusCode: number; message: string }> {
  const { bot, chatId, groupId, userId, result, source, audit, mention } = params;

  if (result.status === 'unrestrict_failed') {
    await audit({
      action: 'unrestrict_failed',
      details: `Captcha passed but restriction could not be lifted (${source}); reason=${result.kind}`,
    });

    // Only a rights problem is actionable by an admin, and only then is a public
    // notice justified.
    if (result.kind === 'permission' && (await shouldAlertUnrestrictFailure(groupId, userId))) {
      await announceUnrestrictFailure(bot, chatId, await mention());
    }

    return {
      statusCode: result.kind === 'transient' ? 503 : 500,
      message: unrestrictFailureMessage(result.kind),
    };
  }

  if (result.status === 'committed_still_muted') {
    await audit({
      action: 'unrestrict_failed',
      details: `Verification recorded but the restriction could not be lifted (${source}); reason=${result.kind}`,
    });

    if (result.kind === 'permission' && (await shouldAlertUnrestrictFailure(groupId, userId))) {
      await announceUnrestrictFailure(bot, chatId, await mention());
    }

    // 200, not an error: the verification counted and the member will not be
    // removed. Say plainly that speaking is still blocked so they wait for an
    // admin rather than retrying a challenge they already passed.
    return {
      statusCode: 200,
      message: '✅ 验证已通过，但机器人暂时无法解除您的发言限制，请等待管理员处理（您不会被移出群组）。',
    };
  }

  if (!result.rolledBack) {
    // The user is speaking with an unverified session and we could not undo it.
    // The scheduler's mute policy is the backstop; this entry is how an operator
    // finds out before then.
    await audit({
      action: 'restriction_failed',
      details: `Verification commit failed and the mute could not be re-applied (${source})`,
    });
  }

  return {
    statusCode: 409,
    message: '验证未能完成（会话可能已过期或已被处理），请返回群组重新获取验证链接后重试。',
  };
}
