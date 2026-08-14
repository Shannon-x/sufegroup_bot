import crypto from 'crypto';
import { config } from '../config/config';
import { redisService } from '../services/RedisService';
import { Logger } from '../utils/logger';

/**
 * Shared captcha acceptance rules.
 *
 * Every endpoint that redeems a captcha hands out the same pass (a muted user
 * becomes able to speak, a gated conversation becomes deliverable), so they all
 * have to apply the same rules. They did not: the Mini App endpoint checked
 * hostname, freshness and single use while /api/verify and the Chatwoot gate
 * still trusted a bare `success`, which made them the cheap way in.
 */
const logger = new Logger('CaptchaGuard');

/** How long a solved captcha may sit before it is redeemed. */
const CAPTCHA_MAX_AGE_MS = 5 * 60 * 1000;
/** Tolerance for the provider's clock running ahead of ours. */
const CAPTCHA_CLOCK_SKEW_MS = 60 * 1000;
/** Lifetime of the "this captcha token was already redeemed" marker. */
const CAPTCHA_TOKEN_TTL_SECONDS = 900;
/** Throttle for the hostname-mismatch alarm, per observed hostname. */
const HOSTNAME_ALERT_COOLDOWN_MS = 60 * 1000;

/** Fields both Turnstile and hCaptcha return from siteverify. */
export interface CaptchaVerifyResult {
  success: boolean;
  'error-codes'?: string[];
  challenge_ts?: string;
  hostname?: string;
  cdata?: string;
}

export type CaptchaProvider = 'turnstile' | 'hcaptcha';

/**
 * `rejected` — this submission is not trustworthy; it is a real verification
 * failure and may be counted against the user.
 *
 * `infrastructure` — we could not *decide*. Nothing is proven about the user
 * either way, so the caller must ask for a retry without charging an attempt:
 * charged attempts end in a kick, and a Redis blip must not kick anybody.
 */
export type CaptchaAssessment =
  | { ok: true }
  | { ok: false; kind: 'rejected'; reason: string }
  | { ok: false; kind: 'infrastructure'; reason: string };

/**
 * Provider error codes that describe our side of the exchange, not the user's.
 *
 * `internal-error` is what TurnstileService/HCaptchaService return when the
 * siteverify call throws, and Cloudflare also emits it for its own faults. The
 * secret-key codes mean the deployment is misconfigured. None of them say
 * anything about whether a human solved the challenge.
 */
const CAPTCHA_INFRASTRUCTURE_CODES = new Set([
  'internal-error',
  'bad-request',
  'missing-input-secret',
  'invalid-input-secret',
  'not-using-dummy-secret',
]);

type HostnamePolicy = 'enforce' | 'report' | 'off';

/** Last time each unexpected hostname was reported, so the log can't be flooded. */
const hostnameAlertedAt = new Map<string, number>();

/**
 * How to treat a captcha solved on a hostname we did not expect.
 *
 * Default is `report`, deliberately. The allowlist is derived from
 * BOT_WEBHOOK_DOMAIN, which is *not* guaranteed to be the domain the widget
 * actually runs on (a proxy, a vanity domain, a staging host, a trailing-path
 * webhook base). Enforcing straight away turns one config typo into "no member
 * of any group can ever verify" — a self-inflicted outage with no signal
 * pointing at the cause. In `report` mode a mismatch is logged at error level
 * with both sides printed, so the value can be corrected before enforcement is
 * switched on with CAPTCHA_HOSTNAME_POLICY=enforce.
 *
 * The trade-off is explicit: while in report mode a token farmed on a cloned
 * page is not rejected *by this check*. The submission still has to survive
 * every other control — the token is single-use, bound to the session through
 * cData, fresh, and redeemable only by the initData-authenticated owner of a
 * pending session — so report mode is a downgrade of defence in depth, not an
 * open door.
 */
function hostnamePolicy(): HostnamePolicy {
  const raw = (process.env.CAPTCHA_HOSTNAME_POLICY || '').trim().toLowerCase();
  if (raw === 'enforce' || raw === 'report' || raw === 'off') return raw;
  return 'report';
}

/**
 * Hostnames the captcha widget may legitimately have run on: the public webhook
 * domain plus anything listed in CAPTCHA_ALLOWED_HOSTNAMES (comma separated),
 * which is how a deployment whose widget domain differs from its webhook domain
 * gets to enforce instead of staying in report mode forever.
 */
function allowedCaptchaHostnames(): Set<string> {
  const hosts = new Set<string>();

  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    try {
      const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
      if (url.hostname) hosts.add(url.hostname.toLowerCase());
    } catch {
      // Not parseable as a URL — ignore rather than reject everything.
    }
  };

  if (config.bot.webhookDomain) add(config.bot.webhookDomain);
  for (const entry of (process.env.CAPTCHA_ALLOWED_HOSTNAMES || '').split(',')) add(entry);

  return hosts;
}

function reportHostnameMismatch(actual: string, allowed: Set<string>, policy: HostnamePolicy): void {
  const now = Date.now();
  const last = hostnameAlertedAt.get(actual) ?? 0;
  if (now - last < HOSTNAME_ALERT_COOLDOWN_MS) return;
  hostnameAlertedAt.set(actual, now);

  // Keep the map from growing under a spray of forged hostnames.
  if (hostnameAlertedAt.size > 100) {
    for (const [host, at] of hostnameAlertedAt) {
      if (now - at >= HOSTNAME_ALERT_COOLDOWN_MS) hostnameAlertedAt.delete(host);
    }
  }

  logger.error('Captcha solved on an unexpected hostname', {
    actual,
    allowed: [...allowed],
    policy,
    // Spelled out because this is the exact symptom of a misconfigured
    // BOT_WEBHOOK_DOMAIN, and in `enforce` mode it means nobody can verify.
    hint: 'Set CAPTCHA_ALLOWED_HOSTNAMES if this hostname is legitimate',
  });
}

/**
 * Decide whether a siteverify response really vouches for *this* submission.
 *
 * `success` alone only says "some human solved a challenge for our sitekey": it
 * does not say where the widget ran, when it was solved, or who it was solved
 * for. A token farmed on a cloned page, or solved once and fanned out across
 * sessions, passes that check untouched.
 *
 * `requireCdata` is true wherever our own widget code sets cData (the Mini App
 * pages). The legacy /verify page renders Turnstile implicitly from a template
 * that cannot pass cData, so it can only tolerate a missing binding — see the
 * call site.
 */
export async function assessCaptchaResult(params: {
  provider: CaptchaProvider;
  result: CaptchaVerifyResult;
  token: string;
  sessionId: string;
  requireCdata: boolean;
}): Promise<CaptchaAssessment> {
  const { provider, result, token, sessionId, requireCdata } = params;

  if (!result.success) {
    // A failed verification is not automatically the user's fault. The provider
    // services synthesise `internal-error` when siteverify itself is
    // unreachable, and the secret-key codes mean *we* are misconfigured — in
    // both cases nothing has been proven about the person on the other end.
    // Charging those to the user was fatal rather than annoying: attempts are
    // capped, and passing the cap kicks them out of the group.
    const codes = result['error-codes'] ?? [];
    const infrastructural = codes.some(code => CAPTCHA_INFRASTRUCTURE_CODES.has(code));
    if (infrastructural) {
      logger.error('Captcha provider could not be consulted', { provider, codes });
      return { ok: false, kind: 'infrastructure', reason: `provider-unavailable:${codes.join(',')}` };
    }
    return { ok: false, kind: 'rejected', reason: 'provider-rejected' };
  }

  const allowed = allowedCaptchaHostnames();
  const policy = hostnamePolicy();
  if (policy !== 'off' && allowed.size > 0 && result.hostname) {
    const actual = result.hostname.toLowerCase();
    if (!allowed.has(actual)) {
      reportHostnameMismatch(actual, allowed, policy);
      if (policy === 'enforce') {
        return { ok: false, kind: 'rejected', reason: `hostname-mismatch:${actual}` };
      }
    }
  }

  if (result.challenge_ts) {
    const solvedAt = Date.parse(result.challenge_ts);
    if (Number.isNaN(solvedAt)) return { ok: false, kind: 'rejected', reason: 'bad-challenge-ts' };
    const ageMs = Date.now() - solvedAt;
    if (ageMs > CAPTCHA_MAX_AGE_MS || ageMs < -CAPTCHA_CLOCK_SKEW_MS) {
      return { ok: false, kind: 'rejected', reason: `stale-challenge:${Math.round(ageMs / 1000)}s` };
    }
  }

  // Turnstile echoes back the cData the widget was rendered with, which we set
  // to the session id. Tolerating a *missing* cdata made the binding opt-in for
  // the attacker — the widget runs on the client, so anyone rendering it
  // without cData simply skipped the check. Where our own code always sets it,
  // absence is now a rejection.
  if (provider === 'turnstile') {
    const cdata = result.cdata;
    if (cdata) {
      if (cdata !== sessionId) return { ok: false, kind: 'rejected', reason: 'cdata-mismatch' };
    } else if (requireCdata) {
      return { ok: false, kind: 'rejected', reason: 'cdata-missing' };
    }
  }
  // hCaptcha has no free-tier equivalent of cData (rqdata is Enterprise only),
  // so cross-session relay there is held off by the single-use marker below
  // plus the initData-authenticated session ownership check at the call site.

  // Single-use marker: whichever submission redeems the token first owns it, so
  // one solved challenge cannot be spread over several sessions or users.
  // Strict on purpose — the fail-open lock returned "first use" for *every*
  // submission while Redis was down, i.e. it stopped being a replay guard
  // exactly when an attacker would want it to.
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  try {
    const firstUse = await redisService.acquireLockStrict(
      `captcha-used:${provider}:${digest}`,
      CAPTCHA_TOKEN_TTL_SECONDS,
    );
    if (!firstUse) return { ok: false, kind: 'rejected', reason: 'token-replayed' };
  } catch (error) {
    logger.error('Captcha replay guard unavailable, refusing to redeem token', error);
    return { ok: false, kind: 'infrastructure', reason: 'replay-guard-unavailable' };
  }

  return { ok: true };
}
