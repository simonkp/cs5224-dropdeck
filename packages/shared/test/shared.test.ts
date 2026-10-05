import { describe, expect, it } from 'vitest';
import {
  admissionRatePerMin, admittedAt, admittedCount, checkAdmission, watermark,
  normaliseEmail, emailHash, sign, verifyTicket, ticketId, canTransition, isLockedForEdit, ApiError,
} from '../src/index.js';

describe('email normalisation', () => {
  it('collapses Gmail dots, plus suffixes and case', () => {
    expect(normaliseEmail(' Jane.Doe+drop1@GoogleMail.com ')).toBe('janedoe@gmail.com');
  });
  it('keeps dots for other domains', () => {
    expect(normaliseEmail('jane.doe+x@nus.edu.sg')).toBe('jane.doe@nus.edu.sg');
  });
  it('hashes deterministically per key', () => {
    expect(emailHash('a@b.com', 'k1')).toBe(emailHash('a@b.com', 'k1'));
    expect(emailHash('a@b.com', 'k1')).not.toBe(emailHash('a@b.com', 'k2'));
  });
});

describe('signed tokens', () => {
  const key = 'test-key';
  it('round-trips a ticket', () => {
    const tok = sign({ k: 'ticket', t: 't1', d: 'd1', n: 42, iat: 1 }, key);
    const c = verifyTicket(tok, key);
    expect(ticketId(c)).toBe('n42');
  });
  it('rejects a forged number', () => {
    const tok = sign({ k: 'ticket', t: 't1', d: 'd1', n: 4000, iat: 1 }, key);
    const [, mac] = tok.split('.');
    const forged = `${Buffer.from(JSON.stringify({ k: 'ticket', t: 't1', d: 'd1', n: 0, iat: 1 })).toString('base64url')}.${mac}`;
    expect(() => verifyTicket(forged, key)).toThrow(ApiError);
  });
  it('rejects a hold token used as a ticket', () => {
    const tok = sign({ k: 'hold', t: 't1', d: 'd1', h: 'n1', iat: 1 }, key);
    expect(() => verifyTicket(tok, key)).toThrow(/ticket/);
  });
});

describe('admission', () => {
  const start = Date.parse('2026-10-30T09:00:30Z');
  it('derives the rate from stock, hold window and preset', () => {
    expect(admissionRatePerMin('normal', 200, 300)).toBe(80);
    expect(admissionRatePerMin('fast', 200, 300, 50)).toBe(50);
  });
  it('admits the early group before late tickets', () => {
    expect(watermark(50, 100)).toEqual({ rThreshold: 0.5, nWatermark: 0 });
    expect(watermark(130, 100)).toEqual({ rThreshold: 1, nWatermark: 30 });
    expect(watermark(10, 0)).toEqual({ rThreshold: 1, nWatermark: 10 });
  });
  it('is monotonic in time', () => {
    let prev = -1;
    for (let s = 0; s < 600; s += 7) {
      const a = admittedCount(start, 80, start + s * 1000);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });
  it('agrees between the watermark and the per-ticket admission time', () => {
    const rate = 80, early = 400;
    const r = 0.37;
    const at = admittedAt({ r }, start, rate, early);
    const { rThreshold } = watermark(admittedCount(start, rate, at), early);
    expect(r).toBeLessThanOrEqual(rThreshold + 1e-9);
    const n = 25;
    const atN = admittedAt({ n }, start, rate, early);
    expect(watermark(admittedCount(start, rate, atN), early).nWatermark).toBeGreaterThanOrEqual(n);
  });
  it('enforces the admission window', () => {
    expect(checkAdmission(1000, 60, 500)).toMatchObject({ ok: false, reason: 'NOT_ADMITTED' });
    expect(checkAdmission(1000, 60, 30_000)).toEqual({ ok: true });
    expect(checkAdmission(1000, 60, 62_000)).toMatchObject({ ok: false, reason: 'ADMISSION_EXPIRED' });
  });
});

describe('lifecycle', () => {
  it('allows only the documented transitions', () => {
    expect(canTransition('Draft', 'Scheduled')).toBe(true);
    expect(canTransition('Draft', 'Live')).toBe(false);
    expect(canTransition('Closed', 'Live')).toBe(false);
  });
  it('locks edits when the entry window opens', () => {
    const drop = { state: 'Scheduled' as const, openAt: '2026-10-30T09:00:00Z', entryWindowMin: 15 };
    expect(isLockedForEdit(drop, new Date('2026-10-30T08:44:00Z'))).toBe(false);
    expect(isLockedForEdit(drop, new Date('2026-10-30T08:45:00Z'))).toBe(true);
  });
});
