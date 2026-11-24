import { createHmac } from 'crypto';
import { config } from '../config/config';
import { Logger } from '../utils/logger';
import { redisService } from './RedisService';

/** Answer of the panel's check endpoint. */
export type GateStatus = 'member' | 'banned' | 'unbound';

/** Answer of the panel's bind endpoint. */
export type BindStatus = GateStatus | 'bound' | 'invalid_link' | 'account_taken';

export type GateVerificationOutcome =
  | { ok: true }
  | { ok: false; httpStatus: number; message: string; needsBind?: boolean };

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

  /**
   * Whether the verification page must ask this member for a subscription
   * link. Only a confirmed binding answers "no"; an unreachable panel still
   * shows the field, and the submit endpoint makes the final call.
   */
  async requiresBinding(
    settings: { customSettings?: Record<string, any> | null } | null | undefined,
    telegramId: number | string
  ): Promise<boolean> {
    if (!this.isEnabledFor(settings)) return false;
    return (await this.check(telegramId)) !== 'member';
  }

  /**
   * The gate's half of a captcha submission, run after the captcha passed and
   * before the member is unmuted. Binds the subscription link when one is
   * needed. A failure here never charges a verification attempt — it says
   * nothing about whether a human solved the challenge.
   */
  async resolveAtVerification(
    settings: { customSettings?: Record<string, any> | null } | null | undefined,
    telegramId: number | string,
    subscribeUrl?: string | null
  ): Promise<GateVerificationOutcome> {
    if (!this.isEnabledFor(settings)) return { ok: true };
    const panel = config.xboardGate.panelName;
    const unreachable: GateVerificationOutcome = {
      ok: false,
      httpStatus: 503,
      message: `暂时无法连接${panel}，请稍后重试`,
    };

    const current = await this.check(telegramId, { fresh: true });
    if (current === 'member') return { ok: true };
    if (current === 'banned') return { ok: false, httpStatus: 403, message: `你的${panel}账号已被停用，无法入群` };
    if (current === null) return unreachable;

    const url = subscribeUrl?.trim();
    if (!url) {
      return { ok: false, httpStatus: 400, needsBind: true, message: `本群仅限${panel}用户，请填写你的订阅链接` };
    }

    switch (await this.bind(telegramId, url)) {
      case 'bound':
      case 'member':
        return { ok: true };
      case 'banned':
        return { ok: false, httpStatus: 403, message: `这个${panel}账号已被停用，无法入群` };
      case 'account_taken':
        return {
          ok: false,
          httpStatus: 409,
          needsBind: true,
          message: `这个${panel}账号已经绑定了另一个 Telegram 账号，请用那个账号入群，或联系客服换绑`,
        };
      case 'invalid_link':
      case 'unbound':
        return {
          ok: false,
          httpStatus: 400,
          needsBind: true,
          message: `没认出这个订阅链接，请到${panel}重新复制完整的订阅链接`,
        };
      default:
        return unreachable;
    }
  }

  /**
   * A link to the panel's one-click binding page for this Telegram account, or
   * null when the deployment cannot offer one (gate not configured, or no
   * https panel address to send the member to).
   *
   * The panel signs the member in (or already has them signed in), shows the
   * Telegram account from the ticket and binds it on "confirm". The ticket
   * proves only which Telegram account wants binding; which panel account it
   * lands on is decided by whoever is signed in on the panel.
   */
  bindLink(user: TicketUser, now: number = Date.now()): string | null {
    const panelUrl = config.xboardGate.panelUrl.replace(/\/+$/, '');
    if (!this.isConfigured() || !/^https:\/\//i.test(panelUrl)) return null;
    return `${panelUrl}/tg-bind/${signBindTicket(user, config.xboardGate.secret, now)}`;
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

export interface TicketUser {
  id: number | string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
}

/** Long enough to sign in on the panel, short enough that a leaked link soon dies. */
export const BIND_TICKET_TTL_SECONDS = 15 * 60;

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Signs a one-click binding ticket in the format the panel's
 * GateBindTicket::parse expects:
 *   base64url(JSON payload) "." base64url(HMAC-SHA256(secret, "xbgate-bind:" + payload segment))
 * Single use is enforced by the panel.
 */
export function signBindTicket(user: TicketUser, secret: string, now: number = Date.now()): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim().slice(0, 64);
  const username = user.username && /^[A-Za-z0-9_]{1,32}$/.test(user.username) ? user.username : null;
  const bot = config.bot.username && /^[A-Za-z0-9_]{1,32}$/.test(config.bot.username) ? config.bot.username : null;
  const payload = {
    v: 1,
    tg: Number(user.id),
    n: name,
    u: username,
    b: bot,
    exp: Math.floor(now / 1000) + BIND_TICKET_TTL_SECONDS,
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update('xbgate-bind:' + payloadB64).digest());
  return `${payloadB64}.${sig}`;
}

/** Pulls the first http(s) URL out of a message. */
export function extractUrl(text: string | undefined | null): string | null {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0] : null;
}
