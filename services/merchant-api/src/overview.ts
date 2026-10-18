import type { Drop, Order } from '@dropdeck/shared';
import { orderMatchesStatus } from '@dropdeck/shared/merchant-analytics';

/** Select at most 20 requested drops. Authentication supplies the tenant before any reads. */
export function overviewIds(raw: string | undefined): string[] {
  return [...new Set((raw ?? '').split(',').filter(Boolean))].slice(0, 20);
}
export function orderCounts(rows: Array<Pick<Order, 'status' | 'qty' | 'tracking'>>) {
  return { orders: rows.length, paidOrders: rows.filter(o => orderMatchesStatus(o,'paid')).length, awaitingOrders: rows.filter(o => orderMatchesStatus(o,'confirmed')).length, ordered: rows.reduce((n,o) => n+o.qty,0) };
}
export function stockTotal(drop: Drop) { return drop.variants.reduce((n,v) => n+v.stock,0); }
