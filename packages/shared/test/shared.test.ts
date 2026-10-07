import { describe, expect, it } from 'vitest';
import {
  admissionRatePerMin, admittedAt, admittedCount, checkAdmission, watermark,
  normaliseEmail, emailHash, sign, verifyHold, verifyTicket, ticketId, canTransition, isLockedForEdit, ApiError,
  dropAdmissionRate, claimWindowStart, toPublicShop, toPublicDrop, slugProblem, uploadPathRe, planProblem, invoicePreview, usageMonth,
  type Drop, type MerchantProfile,
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
  it('rejects an expired token', () => {
    const tok = sign({ k: 'hold', t: 't1', d: 'd1', h: 'n1', iat: 1, exp: 1000 }, key);
    expect(verifyHold(tok, key, 999).h).toBe('n1');
    expect(() => verifyHold(tok, key, 1001)).toThrow(/expired/);
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
    expect(dropAdmissionRate({ ratePreset: 'normal', holdSec: 300, variants: [{ id: 'a', name: 'a', stock: 150, priceCents: 1 }, { id: 'b', name: 'b', stock: 50, priceCents: 1 }] })).toBe(80);
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
  it('starts a late arrival’s window when the ticket was issued', () => {
    expect(claimWindowStart(1000, 50_000)).toBe(50_000);
    expect(claimWindowStart(80_000, 50_000)).toBe(80_000);
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

describe('public shop page', () => {
  const now = new Date('2026-12-10T00:00:00Z');
  const profile: MerchantProfile = { tenantId: 't1', name: 'TB', slug: 'tb', tier: 'starter', paynow: '+65 9', slugClaimed: true };
  const drop = (dropId: string, state: Drop['state'], openAt: string, endAt = openAt): Drop => ({
    tenantId: 't1', dropId, state, title: dropId, description: '', openAt, endAt,
    variants: [{ id: 'v1', name: 'a', stock: 1, priceCents: 900 }, { id: 'v2', name: 'b', stock: 1, priceCents: 450 }],
    entryWindowMin: 15, graceSec: 30, perBuyerLimit: 2, holdSec: 300, admitWindowSec: 120, ratePreset: 'normal',
    verification: 'email', shardCount: 1, createdAt: '', updatedAt: '', version: 1,
  });

  it('lists live, then upcoming soonest first, then recent past newest first; never drafts or cancelled', () => {
    const shop = toPublicShop(profile, [
      drop('later', 'Scheduled', '2026-12-20T02:00:00Z'), drop('draft', 'Draft', '2026-12-12T02:00:00Z'),
      drop('old', 'Closed', '2026-10-01T02:00:00Z'), drop('lastweek', 'Closed', '2026-12-03T02:00:00Z'),
      drop('soon', 'Scheduled', '2026-12-13T02:00:00Z'), drop('now', 'Live', '2026-12-09T23:50:00Z'),
      drop('gone', 'Cancelled', '2026-12-11T02:00:00Z'), drop('recent', 'Closed', '2026-12-08T02:00:00Z'),
    ], now);
    expect(shop.drops.map((d) => d.dropId)).toEqual(['now', 'soon', 'later', 'recent', 'lastweek']);
    expect(shop.drops[0]).toMatchObject({ url: '/d/t1/now/', fromPriceCents: 450, state: 'Live' });
  });

  it('never publishes the PayNow number, and exposes the slug only once it is claimed', () => {
    expect(JSON.stringify(toPublicShop(profile, [], now))).not.toContain('+65');
    expect(toPublicDrop(drop('x', 'Scheduled', '2026-12-13T02:00:00Z'), { ...profile, slugClaimed: undefined }).merchant.slug).toBeUndefined();
    expect(toPublicDrop(drop('x', 'Scheduled', '2026-12-13T02:00:00Z'), profile).merchant).toMatchObject({ slug: 'tb', theme: 'auto' });
  });
});

describe('branding rules', () => {
  it('accepts plain shop links and refuses odd or reserved ones', () => {
    expect(slugProblem('tb-sourdough')).toBeNull();
    for (const bad of ['ab', '-tb', 'tb-', 'TB', 'tb.json', 'a'.repeat(41), 'admin']) expect(slugProblem(bad), bad).not.toBeNull();
  });
  it('matches only the tenant\'s own uploads', () => {
    const re = uploadPathRe('t.1');
    expect(re.test('/b/t.1/0123456789abcdef0123456789abcdef.png')).toBe(true);
    expect(re.test('/b/tx1/0123456789abcdef0123456789abcdef.png')).toBe(false);
    expect(re.test('/b/t.1/0123456789abcdef0123456789abcdef.svg')).toBe(false);
  });
});

describe('plans', () => {
  const mk = (dropId: string, state: Drop['state'], openAt: string, stock = 50, meteredAt?: string): Drop => ({
    tenantId: 't1', dropId, state, title: dropId, description: '', openAt, endAt: openAt, meteredAt,
    variants: [{ id: 'v1', name: 'a', stock, priceCents: 900 }],
    entryWindowMin: 15, graceSec: 30, perBuyerLimit: 2, holdSec: 300, admitWindowSec: 120, ratePreset: 'normal',
    verification: 'email', shardCount: 1, createdAt: '', updatedAt: '', version: 1,
  });
  const oct = '2026-10-10T02:00:00Z';

  it('counts the billing month in Singapore time', () => {
    expect(usageMonth('2026-10-31T17:00:00Z')).toBe('2026-11'); // 1 am on 1 Nov in Singapore
    expect(usageMonth('2026-10-31T15:00:00Z')).toBe('2026-10');
  });

  it('Starter: two drops and 200 units a month; drafts and never-opened cancellations do not count', () => {
    const cand = mk('new', 'Draft', oct);
    expect(planProblem('starter', [mk('a', 'Closed', oct), mk('b', 'Draft', oct), mk('c', 'Cancelled', oct)], cand)).toBeNull();
    expect(planProblem('starter', [mk('a', 'Closed', oct), mk('b', 'Scheduled', oct)], cand)).toMatch(/2 drops a month/);
    expect(planProblem('starter', [mk('a', 'Closed', oct), mk('c', 'Cancelled', oct, 50, oct)], cand)).toMatch(/2 drops/);
    expect(planProblem('starter', [mk('a', 'Closed', oct, 180)], cand)).toMatch(/200 units/);
    expect(planProblem('starter', [mk('a', 'Closed', '2026-09-10T02:00:00Z'), mk('b', 'Closed', '2026-09-11T02:00:00Z')], cand)).toBeNull();
    expect(planProblem('growth', [mk('a', 'Closed', oct, 5000), mk('b', 'Live', oct)], cand)).toBeNull();
  });

  it('previews a month\'s bill from metered usage', () => {
    expect(invoicePreview('starter', undefined).totalSgd).toBe(29);
    expect(invoicePreview('growth', { drops: 3, cancelled: 0, sessions: 7200 })).toMatchObject({ totalSgd: 79 + 3 * 5 });
    expect(invoicePreview('growth', { drops: 3, cancelled: 0, sessions: 4000 }).totalSgd).toBe(79);
    expect(invoicePreview('event', { drops: 2, cancelled: 1, sessions: 9000 }).totalSgd).toBe(57);
  });
});
