import { describe, expect, it } from 'vitest';
import { ApiError } from '@dropdeck/shared';
import { assertSchedulable, shardCapacities, validateDropInput } from '../src/validate.js';

const valid = {
  title: 'Saturday sourdough',
  variants: [{ name: 'Country loaf', stock: 60, priceCents: 800 }],
  openAt: '2026-10-31T01:00:00Z',
  endAt: '2026-10-31T01:30:00Z',
};

describe('drop validation', () => {
  it('accepts a minimal drop and assigns variant ids', () => {
    const out = validateDropInput(valid);
    expect(out.variants?.[0]?.id).toBe('v1');
  });
  it.each([false, true])('accepts a five-day duration (partial: %s)', (partial) => {
    const dates = { openAt: '2026-10-31T01:00:00.000Z', endAt: '2026-11-05T01:00:00.000Z' };
    expect(validateDropInput(partial ? dates : { ...valid, ...dates }, partial)).toMatchObject(dates);
  });
  it('rejects an end before the open', () => {
    expect(() => validateDropInput({ ...valid, endAt: '2026-10-31T00:00:00Z' })).toThrow(ApiError);
  });
  it('rejects fractional stock', () => {
    expect(() => validateDropInput({ ...valid, variants: [{ name: 'x', stock: 1.5, priceCents: 1 }] })).toThrow(/stock/);
  });
  it('validates only present fields on PATCH', () => {
    expect(validateDropInput({ title: 'New name' }, true)).toEqual({ title: 'New name' });
  });
});

describe('drop image', () => {
  const own = '/b/tenant-1/0123456789abcdef0123456789abcdef.webp';
  it('accepts an image the tenant uploaded, a legacy https link, and clearing it', () => {
    expect(validateDropInput({ imageUrl: own }, true, 'tenant-1').imageUrl).toBe(own);
    expect(validateDropInput({ imageUrl: 'https://cdn.example/loaf.jpg' }, true, 'tenant-1').imageUrl).toBe('https://cdn.example/loaf.jpg');
    const cleared = validateDropInput({ imageUrl: null }, true, 'tenant-1');
    expect('imageUrl' in cleared && cleared.imageUrl === undefined).toBe(true);
  });
  it('refuses http, javascript and another tenant\'s upload', () => {
    for (const imageUrl of ['http://cdn.example/a.jpg', 'javascript:alert(1)', '/b/tenant-2/0123456789abcdef0123456789abcdef.png']) {
      expect(() => validateDropInput({ imageUrl }, true, 'tenant-1'), imageUrl).toThrow(ApiError);
    }
  });
});

describe('scheduling', () => {
  const drop = { ...validateDropInput(valid), entryWindowMin: 15, state: 'Draft' } as never;
  it('requires three minutes of lead time before the entry window', () => {
    expect(() => assertSchedulable(drop, new Date('2026-10-31T00:42:30Z'))).toThrow(/minutes/);
    expect(() => assertSchedulable(drop, new Date('2026-10-31T00:40:00Z'))).not.toThrow();
  });
});

describe('shard capacities', () => {
  it('splits stock without losing units', () => {
    const caps = shardCapacities(61, 4);
    expect(caps).toEqual([16, 15, 15, 15]);
    expect(caps.reduce((a, b) => a + b, 0)).toBe(61);
  });
});
