import { expect, it } from 'vitest';
import { orderCounts, overviewIds } from '../src/overview.js';
import { trackingOf } from '@dropdeck/shared/merchant-analytics';
it('bounds and deduplicates requested overview reads', () => {
  expect(overviewIds(undefined)).toEqual([]);
  expect(overviewIds('a,a,,b')).toEqual(['a','b']);
  expect(overviewIds(Array.from({ length: 100 }, (_,i) => String(i)).join(','))).toHaveLength(20);
});
it('keeps unpaid confirmed orders separate from paid and no-show orders', () => {
  expect(orderCounts([{ status: 'confirmed', qty: 2 }, { status: 'paid', qty: 1 }, { status: 'no-show', qty: 3 }])).toEqual({ orders: 3, paidOrders: 1, awaitingOrders: 1, ordered: 6 });
});
it('counts paid no-shows as paid and keeps unknown payments out of awaiting totals', () => {
  const tracking=trackingOf({status:'confirmed'});
  expect(orderCounts([{status:'no-show',qty:2,tracking:{...tracking,paymentStatus:'paid',attendanceStatus:'no_show'}},{status:'confirmed',qty:1,tracking:{...tracking,paymentStatus:'unknown'}},{status:'confirmed',qty:3}])).toEqual({orders:3,paidOrders:1,awaitingOrders:1,ordered:6});
});
