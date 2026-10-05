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

describe('scheduling', () => {
  const drop = { ...validateDropInput(valid), entryWindowMin: 15, state: 'Draft' } as never;
  it('requires two minutes of lead time before the entry window', () => {
    expect(() => assertSchedulable(drop, new Date('2026-10-31T00:43:30Z'))).toThrow(/minutes/);
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
