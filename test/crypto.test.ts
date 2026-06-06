import { describe, it, expect } from 'vitest';
import { CryptoUtils } from '../src/utils/crypto';

describe('CryptoUtils.verifyHmac (constant-time + length guard)', () => {
  it('accepts a valid signature', () => {
    const sig = CryptoUtils.generateHmac('hello');
    expect(CryptoUtils.verifyHmac('hello', sig)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const sig = CryptoUtils.generateHmac('hello');
    const tampered = sig.slice(0, -1) + (sig.slice(-1) === 'a' ? 'b' : 'a');
    expect(CryptoUtils.verifyHmac('hello', tampered)).toBe(false);
  });

  it('rejects a signature for different data', () => {
    const sig = CryptoUtils.generateHmac('hello');
    expect(CryptoUtils.verifyHmac('world', sig)).toBe(false);
  });

  it('rejects a wrong-length signature without throwing', () => {
    // timingSafeEqual would throw on mismatched lengths — the guard must catch it.
    expect(() => CryptoUtils.verifyHmac('hello', 'short')).not.toThrow();
    expect(CryptoUtils.verifyHmac('hello', 'short')).toBe(false);
    expect(CryptoUtils.verifyHmac('hello', '')).toBe(false);
  });
});

describe('CryptoUtils verification token round-trip', () => {
  it('round-trips a valid token', () => {
    const token = CryptoUtils.generateVerificationToken('u1', 'g1', 's1');
    expect(CryptoUtils.verifyVerificationToken(token)).toEqual({
      userId: 'u1', groupId: 'g1', sessionId: 's1',
    });
  });

  it('rejects a token whose signature was tampered', () => {
    const token = CryptoUtils.generateVerificationToken('u1', 'g1', 's1');
    const [data] = token.split('.');
    expect(CryptoUtils.verifyVerificationToken(data + '.deadbeef')).toBeNull();
  });

  it('rejects a token whose payload was tampered (signature mismatch)', () => {
    const token = CryptoUtils.generateVerificationToken('u1', 'g1', 's1');
    const [, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ userId: 'attacker', groupId: 'g1', sessionId: 's1', exp: 9999999999 })).toString('base64url');
    expect(CryptoUtils.verifyVerificationToken(forged + '.' + sig)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(CryptoUtils.verifyVerificationToken('garbage')).toBeNull();
    expect(CryptoUtils.verifyVerificationToken('')).toBeNull();
  });
});
