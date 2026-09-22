import { config } from '../config/config';
import { Logger } from '../utils/logger';
import { redisService } from './RedisService';

const CAS_ENDPOINT = 'https://api.cas.chat/check';

/**
 * Bounded so a slow third party cannot stall the join path. The lookup runs
 * alongside the join-time restriction rather than before it, so the member is
 * already muted while we wait; this only bounds how long they stay unjudged.
 */
const CAS_TIMEOUT_MS = 2500;

/** A listed account stays listed; a clean one is re-checked more often. */
const CAS_BANNED_CACHE_SECONDS = 24 * 60 * 60;
const CAS_CLEAN_CACHE_SECONDS = 60 * 60;

/**
 * Lookups against Combot Anti-Spam (https://cas.chat), a blocklist of accounts
 * reported for spam across many Telegram groups.
 *
 * This exists because a captcha only proves that *somebody* solved a challenge
 * at join time. Spam operations buy that cheaply — captcha-solving services,
 * click farms, or accounts that verify once and wait days before posting — so
 * accounts already caught spamming elsewhere pass verification like anyone
 * else. Their history is the one thing they cannot solve their way past.
 *
 * Every failure mode answers "not listed". A blocklist outage must not stop
 * anyone joining: the member still goes through normal verification, and the
 * content filter still judges what they post.
 */
export class CasService {
  private logger = new Logger('CasService');

  async isBanned(userId: string | number): Promise<boolean> {
    if (!config.cas.enabled) return false;

    const id = String(userId);
    const cacheKey = `cas:${id}`;

    try {
      const cached = await redisService.get(cacheKey);
      if (cached !== null) return cached === '1';
    } catch {
      // Cache miss by another name.
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CAS_TIMEOUT_MS);

    try {
      const response = await fetch(`${CAS_ENDPOINT}?user_id=${encodeURIComponent(id)}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.warn('CAS lookup returned an HTTP error, treating as not listed', {
          status: response.status,
        });
        return false;
      }

      // Listed:     {"ok":true,"result":{...}}
      // Not listed: {"ok":false,"description":"Record not found."}
      const body = (await response.json()) as { ok?: boolean; result?: unknown };
      const banned = body?.ok === true && body.result != null;

      try {
        await redisService.set(
          cacheKey,
          banned ? '1' : '0',
          banned ? CAS_BANNED_CACHE_SECONDS : CAS_CLEAN_CACHE_SECONDS
        );
      } catch {
        // Uncached just means the next lookup pays for another request.
      }

      return banned;
    } catch (error) {
      this.logger.warn('CAS lookup failed, treating as not listed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
