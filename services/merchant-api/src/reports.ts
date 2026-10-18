import type { Drop, Order, OrderStatus } from '@dropdeck/shared';
import { orderMatchesStatus, trackingOf } from '@dropdeck/shared/merchant-analytics';

/**
 * Post-drop numbers for the merchant, counted from orders only. Stock counters are not used: holds still open when
 * a drop closes are never swept, so after close the counters overstate sales (docs/degradation.md).
 */
export function buildReport(drop: Drop, orders: Order[], queue: { earlyCount: number | null; lateTickets: number }) {
  const units = (pred: (o: Order) => boolean) => orders.filter(pred).reduce((n, o) => n + o.qty, 0);
  const cents = (pred: (o: Order) => boolean) => orders.filter(pred).reduce((n, o) => n + o.amountCents, 0);
  const is = (s: OrderStatus) => (o: Order) => orderMatchesStatus(o,s);
  const stock = drop.variants.reduce((n, v) => n + v.stock, 0);
  const ordered = units(() => true);
  const times = orders.map((o) => Date.parse(o.createdAt)).sort((a, b) => a - b);
  const soldOutAt = ordered >= stock && times.length ? new Date(times[times.length - 1]!).toISOString() : null;
  return {
    dropId: drop.dropId,
    title: drop.title,
    state: drop.state,
    openAt: drop.openAt,
    endAt: drop.endAt,
    stock,
    orders: orders.length,
    units: { ordered, paid: units(is('paid')), unpaid: units(is('confirmed')), noShow: units(is('no-show')) },
    revenueCents: { ordered: cents(() => true), paid: cents(is('paid')), outstanding: cents(is('confirmed')) },
    sellThrough: stock ? ordered / stock : 0,
    firstOrderAt: times.length ? new Date(times[0]!).toISOString() : null,
    soldOutAt,
    secondsToSellOut: soldOutAt ? Math.round((Date.parse(soldOutAt) - Date.parse(drop.openAt)) / 1000) : null,
    byVariant: drop.variants.map((v) => ({
      id: v.id, name: v.name, stock: v.stock, priceCents: v.priceCents,
      ordered: units((o) => o.variantId === v.id), paid: units((o) => o.variantId === v.id && is('paid')(o)),
    })),
    // Late tickets come from block allocation, so this overstates by up to one block per Lambda instance.
    queue: { joinedDraw: queue.earlyCount, lateTicketsAtMost: queue.lateTickets },
  };
}

const cell = (v: string | number) => {
  const s = String(v);
  // Quote when needed, and defuse spreadsheet formulas in buyer-entered text (CSV injection).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function ordersCsv(orders: Order[]): string {
  const header = ['ref', 'name', 'email', 'variant', 'qty', 'unit_price_sgd', 'amount_sgd', 'status', 'ordered_at', 'payment_status', 'payment_method', 'payment_reference', 'fulfillment_method', 'fulfillment_status', 'carrier', 'tracking_reference', 'fulfill_by'];
  const rows = orders.map((o) => { const t=trackingOf(o); return [o.ref, o.name, o.email, o.variantName, o.qty, (o.unitPriceCents / 100).toFixed(2), (o.amountCents / 100).toFixed(2), o.status, o.createdAt,t.paymentStatus,t.paymentMethod??'',t.paymentReference??'',t.fulfillmentMethod,t.fulfillmentStatus,t.carrier??'',t.trackingReference??'',t.fulfillBy??'']; });
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
