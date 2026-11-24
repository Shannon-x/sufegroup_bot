import { config } from '../config/config';
import { Logger } from '../utils/logger';
import { redisService } from './RedisService';

/** Answer of the panel's check endpoint. */
export type GateStatus = 'member' | 'banned' | 'unbound';

/** Answer of the panel's bind endpoint. */
export type BindStatus = GateStatus | 'bound' | 'invalid_link' | 'account_taken';

const CHECK_STATUSES: readonly string[] = ['member', 'banned', 'unbound'];
const BIND_STATUSES: readonly string[] = [...CHECK_STATUSES, 'bound', 'invalid_link', 'account_taken'];

/**
 * Bounded so a slow panel cannot stall a join. Joins that go through the gate
 * are join *requests*, which simply stay pending on a timeout, so there is no
 * security pressure to answer quickly — only a user-experience one.
 */
const REQUEST_TIMEOUT_MS = 4000;

/**
 * A verdict is cached briefly so a burst of joins (or a user tapping "check
 * again") does not hammer the panel. "unbound" is cached the shortest: it is
 * the state a user is actively trying to leave.
 */
const CACHE_SECONDS: Record<GateStatus, number> = {
  member: 10 * 60,
  banned: 10 * 60,
  unbound: 30,
};

/**
 * Client for the Xboard panel's group-gate API.
 *
 * The gate admits only Telegram accounts bound to a registered, non-banned
 * panel account — paying or not. Every method returns `null` when the panel
 * could not be asked (not configured, network error, bad answer); callers must
 * treat `null` as "unknown", never as a verdict either way.
 */
export class XboardGateService {
  private logger = new Logger('XboardGateService');

  /** The deployment has both the panel URL and the shared secret. */
  isConfigured(): boolean {
    return Boolean(config.xboardGate.apiUrl && config.xboardGate.secret);
  }

  /** The gate applies to this group: configured, and switched on by its admins. */
  isEnabledFor(settings: { customSettings?: Record<string, any> | null } | null | undefined): boolean {
    return this.isConfigured() && settings?.customSettings?.xboardGate === true;
  }

  async check(telegramId: number | string, opts: { fresh?: boolean } = {}): Promise<GateStatus | null> {
    const id = String(telegramId);
    const cacheKey = `xbgate:status:${id}`;

    if (!opts.fresh) {
      try {
        const cached = await redisService.get(cacheKey);
        if (cached && CHECK_STATUSES.includes(cached)) return cached as GateStatus;
      } catch {
        // A cache miss by another name.
      }
    }

    const status = await this.call('check', { telegram_id: Number(id) }, CHECK_STATUSES);
    if (status) await this.remember(id, status as GateStatus);
    return status as GateStatus | null;
  }

  async bind(telegramId: number | string, subscribeUrl: string): Promise<BindStatus | null> {
    const id = String(telegramId);
    const status = (await this.call(
      'bind',
      { telegram_id: Number(id), subscribe_url: subscribeUrl },
      BIND_STATUSES
    )) as BindStatus | null;

    // Keep the check cache in step with what bind just learned.
    if (status === 'bound' || status === 'member') await this.remember(id, 'member');
    else if (status === 'banned') await this.remember(id, 'banned');
    return status;
  }

  private async remember(id: string, status: GateStatus): Promise<void> {
    try {
      await redisService.set(`xbgate:status:${id}`, status, CACHE_SECONDS[status]);
    } catch {
      // Uncached only means the next lookup asks the panel again.
    }
  }

  private async call(op: 'check' | 'bind', body: Record<string, unknown>, valid: readonly string[]): Promise<string | null> {
    if (!this.isConfigured()) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${config.xboardGate.apiUrl}/api/v1/guest/telegram/gate/${op}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Gate-Secret': config.xboardGate.secret,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        // 401 = secrets differ, 404 = the panel has the gate switched off.
        this.logger.warn('Xboard gate returned an HTTP error', { op, status: response.status });
        return null;
      }
      const json = (await response.json()) as { data?: { status?: unknown } };
      const status = json?.data?.status;
      if (typeof status !== 'string' || !valid.includes(status)) {
        this.logger.warn('Xboard gate returned an unexpected answer', { op });
        return null;
      }
      return status;
    } catch (error) {
      this.logger.warn('Xboard gate request failed', {
        op,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Pulls the first http(s) URL out of a message. */
export function extractUrl(text: string | undefined | null): string | null {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0] : null;
}
