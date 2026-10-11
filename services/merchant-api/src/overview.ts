import type { Drop } from '@dropdeck/shared';

/** Select at most 20 requested drops. Authentication supplies the tenant before any reads. */
export function overviewIds(raw: string | undefined): string[] {
  return [...new Set((raw ?? '').split(',').filter(Boolean))].slice(0, 20);
}
export function orderCounts(rows: Array<{ status: string; qty: number }>) {
  return { orders: rows.length, paidOrders: rows.filter(o => o.status === 'paid').length, awaitingOrders: rows.filter(o => o.status === 'confirmed').length, ordered: rows.reduce((n,o) => n+o.qty,0) };
}
export function stockTotal(drop: Drop) { return drop.variants.reduce((n,v) => n+v.stock,0); }
