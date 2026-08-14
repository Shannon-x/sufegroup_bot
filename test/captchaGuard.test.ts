import { describe, it, expect } from 'vitest';
import { assessCaptchaResult } from '../src/controllers/captchaGuard';

/**
 * A failed captcha check has two very different meanings, and conflating them
 * had a real cost: attempts are capped, and exceeding the cap removes the user
 * from the group. Turnstile and hCaptcha both report "we could not answer" the
 * same way they report "this token is bad" — a `success: false` body — and the
 * service wrappers synthesise `internal-error` when siteverify is unreachable.
 * Counting those against the user meant an outage on the provider's side, or a
 * mistyped secret key in our own deployment, kicked legitimate members out.
 */

function assess(result: Record<string, unknown>) {
  return assessCaptchaResult({
    provider: 'turnstile',
    result: result as never,
    token: `tok-${Math.random()}`,
    sessionId: 'session-1',
    requireCdata: false,
  });
}

describe('captcha failure classification', () => {
  it.each([
    ['internal-error', 'siteverify unreachable'],
    ['bad-request', 'malformed request from us'],
    ['missing-input-secret', 'deployment missing its secret key'],
    ['invalid-input-secret', 'deployment has the wrong secret key'],
  ])('treats %s as infrastructure, not a user failure (%s)', async (code) => {
    const verdict = await assess({ success: false, 'error-codes': [code] });

    expect(verdict.ok).toBe(false);
    // `infrastructure` is what tells the caller to ask for a retry *without*
    // charging an attempt.
    expect(verdict).toMatchObject({ kind: 'infrastructure' });
  });

  it.each([
    ['invalid-input-response', 'token is not valid'],
    ['missing-input-response', 'no token supplied'],
    ['timeout-or-duplicate', 'token expired or already redeemed'],
  ])('treats %s as a genuine rejection (%s)', async (code) => {
    const verdict = await assess({ success: false, 'error-codes': [code] });

    expect(verdict).toMatchObject({ ok: false, kind: 'rejected' });
  });

  it('treats an unexplained failure as a rejection', async () => {
    // No error codes at all: nothing indicates our side is at fault, so the
    // conservative reading is that the submission was not trustworthy.
    const verdict = await assess({ success: false });

    expect(verdict).toMatchObject({ ok: false, kind: 'rejected' });
  });

  it('classifies as infrastructure when any code is infrastructural', async () => {
    const verdict = await assess({
      success: false,
      'error-codes': ['invalid-input-response', 'internal-error'],
    });

    expect(verdict).toMatchObject({ kind: 'infrastructure' });
  });

  it('accepts a successful verification', async () => {
    const verdict = await assess({ success: true, hostname: 'example.com' });

    expect(verdict.ok).toBe(true);
  });
});
