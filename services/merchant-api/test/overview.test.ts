import { expect, it } from 'vitest';
import { orderCounts, overviewIds } from '../src/overview.js';
it('bounds and deduplicates requested overview reads', () => {
  expect(overviewIds(undefined)).toEqual([]);
  expect(overviewIds('a,a,,b')).toEqual(['a','b']);
  expect(overviewIds(Array.from({ length: 100 }, (_,i) => String(i)).join(','))).toHaveLength(20);
});
it('keeps unpaid confirmed orders separate from paid and no-show orders', () => {
  expect(orderCounts([{ status: 'confirmed', qty: 2 }, { status: 'paid', qty: 1 }, { status: 'no-show', qty: 3 }])).toEqual({ orders: 3, paidOrders: 1, awaitingOrders: 1, ordered: 6 });
});
