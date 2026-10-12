import { describe, expect, it } from 'vitest';
import type { Hold } from '@dropdeck/shared';
import { codeStatus } from '../src/otp.js';

describe('checkout resume metadata', () => {
  const hold = { expiresAt: 500000, otpHash: 'secret-hash', otpEmail: 'alice@example.com', otpLastSentAt: 100000, otpExpiresAt: 500000, otpSends: 2, otpAttempts: 1 } as Hold;
  it('restores remaining cooldown and limits without exposing email or OTP hash', () => {
    const r = codeStatus(hold, 110000);
    expect(r).toMatchObject({ resendAfterSec: 20, sendsLeft: 1, attemptsLeft: 4 });
    expect(JSON.stringify(r)).not.toContain('alice@');
    expect(JSON.stringify(r)).not.toContain('secret-hash');
  });
  it('clamps elapsed cooldown and exhausted limits', () => {
    expect(codeStatus({ ...hold, otpSends: 4, otpAttempts: 6 }, 200000)).toMatchObject({ resendAfterSec: 0, sendsLeft: 0, attemptsLeft: 0 });
  });
  it('masks even a one-character email local part', () => { expect(codeStatus({ ...hold, otpEmail: 'a@example.com' }, 100000)?.sentTo).toBe('a•••@example.com'); });
  it('returns no metadata before a code was sent', () => { expect(codeStatus({ expiresAt: 500000 } as Hold, 100000)).toBeNull(); });
});
