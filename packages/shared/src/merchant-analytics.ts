import type { Drop, Order } from './types.js';

export type PaymentStatus = 'awaiting' | 'paid' | 'unknown';
export type FulfillmentStatus = 'not_started' | 'ready' | 'shipped' | 'collected' | 'delivered' | 'exception' | 'unknown';
export interface OrderTracking {
  paymentStatus: PaymentStatus;
  fulfillmentMethod: 'pickup' | 'shipping' | 'unassigned';
  fulfillmentStatus: FulfillmentStatus;
  attendanceStatus: 'normal' | 'no_show';
  paymentMethod?: string;
  paymentReference?: string;
  paymentRecordedAt?: string;
  fulfillBy?: string;
  carrier?: string;
  trackingReference?: string;
  dispatchedAt?: string;
  completedAt?: string;
  note?: string;
}
export function trackingOf(order: Pick<Order, 'status' | 'tracking'>): OrderTracking {
  return order.tracking ?? { paymentStatus: order.status === 'paid' ? 'paid' : order.status === 'confirmed' ? 'awaiting' : 'unknown', fulfillmentMethod: 'unassigned', fulfillmentStatus: 'unknown', attendanceStatus: order.status === 'no-show' ? 'no_show' : 'normal' };
}
export const singaporeDay = (at: string | number) => new Date(new Date(at).getTime() + 8 * 3600_000).toISOString().slice(0, 10);
/** A bounded worklist-page export, without buyer identity or free-text notes. */
export function trackingCsv(orders: Order[]) {
  const cell=(value:string|number)=>{const text=String(value);const safe=/^\s*[=+\-@]|^[\t\r\n]/.test(text)?`'${text}`:text;return /[",\r\n]/.test(safe)?`"${safe.replace(/"/g,'""')}"`:safe;};
  return [['ref','variant','qty','amount_sgd','payment_status','fulfillment_method','fulfillment_status','carrier','tracking_reference','fulfill_by'],...orders.map(o=>{const t=trackingOf(o);return [o.ref,o.variantName,o.qty,(o.amountCents/100).toFixed(2),t.paymentStatus,t.fulfillmentMethod,t.fulfillmentStatus,t.carrier??'',t.trackingReference??'',t.fulfillBy??''];})].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
export interface SalesTotals { orders: number; units: number; confirmedCents: number; paidCents: number; awaitingCents: number; unknownCents: number; noShowUnits: number; fulfillmentOpen: number; fulfillmentUnknown: number; overdue: number }
export const emptySales = (): SalesTotals => ({ orders: 0, units: 0, confirmedCents: 0, paidCents: 0, awaitingCents: 0, unknownCents: 0, noShowUnits: 0, fulfillmentOpen: 0, fulfillmentUnknown: 0, overdue: 0 });
export function salesTotals(orders: Order[], now = Date.now()): SalesTotals {
  const total = emptySales();
  for (const o of orders) {
    const t = trackingOf(o); const done = ['collected', 'delivered'].includes(t.fulfillmentStatus);
    total.orders++; total.units += o.qty; total.confirmedCents += o.amountCents;
    total[t.paymentStatus === 'paid' ? 'paidCents' : t.paymentStatus === 'awaiting' ? 'awaitingCents' : 'unknownCents'] += o.amountCents;
    if (t.attendanceStatus === 'no_show') total.noShowUnits += o.qty;
    if (t.fulfillmentStatus === 'unknown') total.fulfillmentUnknown++;
    else if (!done) total.fulfillmentOpen++;
    if (!done && t.fulfillBy && Date.parse(t.fulfillBy) < now) total.overdue++;
  }
  return total;
}
export function summarizeSales(orders: Order[], drops: Drop[], from: string, to: string, advanced: boolean, now = Date.now()) {
  const inRange = (o: Order) => { const day = singaporeDay(o.confirmedAt ?? o.createdAt); return day >= from && day <= to; };
  const selected = orders.filter(inRange); const totals = salesTotals(selected, now);
  const days: Array<{ day: string; orders: number; confirmedCents: number; paidCents: number }> = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += 86400000) {
    const day = new Date(at).toISOString().slice(0, 10); const t = salesTotals(selected.filter(o => singaporeDay(o.confirmedAt ?? o.createdAt) === day), now);
    days.push({ day, orders: t.orders, confirmedCents: t.confirmedCents, paidCents: t.paidCents });
  }
  if (!advanced) return { totals, days, legacyDates: selected.some(o => !o.confirmedAt) };
  const comparisons = drops.filter(d => d.state !== 'Draft').map(d => { const t = salesTotals(selected.filter(o => o.dropId === d.dropId), now); const stock = d.variants.reduce((n, v) => n + v.stock, 0); return { dropId: d.dropId, title: d.title, state: d.state, stock, ...t, sellThrough: stock ? t.units / stock : null }; });
  const variants = drops.flatMap(d => d.variants.map(v => { const t = salesTotals(selected.filter(o => o.dropId === d.dropId && o.variantId === v.id), now); return { dropId: d.dropId, variantId: v.id, name: v.name, dropTitle: d.title, stock: v.stock, ...t }; })).filter(v => v.orders).sort((a, b) => b.confirmedCents - a.confirmedCents);
  const span = days.length * 86400000; const previousFrom = new Date(Date.parse(`${from}T00:00:00Z`) - span).toISOString().slice(0, 10);
  const previous = orders.filter(o => { const day = singaporeDay(o.confirmedAt ?? o.createdAt); return day >= previousFrom && day < from; });
  const prev = salesTotals(previous, now);
  const insights = [totals.orders ? `${totals.orders} orders confirmed, with ${(totals.paidCents / Math.max(1, totals.confirmedCents) * 100).toFixed(0)}% of order value recorded paid.` : 'No orders in this period.'];
  if (variants[0]) insights.push(`${variants[0].name} (${variants[0].dropTitle}) has the highest confirmed order value in this selection.`);
  if (totals.overdue) insights.push(`${totals.overdue} orders have passed their merchant-set fulfillment due date.`);
  return { totals, days, legacyDates: selected.some(o => !o.confirmedAt), comparisons, variants, insights, previous: { from: previousFrom, to: new Date(Date.parse(`${from}T00:00:00Z`) - 86400000).toISOString().slice(0, 10), ...prev, changePercent: prev.confirmedCents ? (totals.confirmedCents - prev.confirmedCents) / prev.confirmedCents * 100 : null } };
}
