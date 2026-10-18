import { describe, expect, it } from 'vitest';
import type { Drop, Order, OrderStatus } from '@dropdeck/shared';
import { buildReport, ordersCsv } from '../src/reports.js';

const drop = {
  dropId: 'd1', title: 'Sourdough', state: 'Closed', openAt: '2026-10-31T01:00:00.000Z', endAt: '2026-10-31T01:30:00.000Z',
  variants: [{ id: 'v1', name: 'Loaf', stock: 3, priceCents: 900 }, { id: 'v2', name: 'Rye', stock: 1, priceCents: 1100 }],
} as Drop;

const order = (ref: string, variantId: string, qty: number, status: OrderStatus, minute: number, name = 'Ann Lee'): Order => ({
  tenantId: 't', dropId: 'd1', ref, holdId: ref, variantId, variantName: variantId === 'v1' ? 'Loaf' : 'Rye', qty,
  unitPriceCents: variantId === 'v1' ? 900 : 1100, amountCents: qty * (variantId === 'v1' ? 900 : 1100),
  name, email: `${ref}@example.com`, status, createdAt: new Date(Date.parse(drop.openAt) + minute * 60_000).toISOString(),
});

describe('report', () => {
  const orders = [order('A', 'v1', 2, 'paid', 1), order('B', 'v2', 1, 'no-show', 2), order('C', 'v1', 1, 'confirmed', 4)];
  const r = buildReport(drop, orders, { earlyCount: 120, lateTickets: 40 });

  it('counts units and money by status from orders', () => {
    expect(r.units).toEqual({ ordered: 4, paid: 2, unpaid: 1, noShow: 1 });
    expect(r.revenueCents).toEqual({ ordered: 3800, paid: 1800, outstanding: 900 });
    expect(r.byVariant.map((v) => [v.id, v.ordered, v.paid])).toEqual([['v1', 3, 2], ['v2', 1, 0]]);
  });
  it('reports sell-through and time to sell out', () => {
    expect(r.sellThrough).toBe(1);
    expect(r.secondsToSellOut).toBe(240);
  });
  it('has no sell-out time when stock remains', () => {
    expect(buildReport(drop, orders.slice(0, 1), { earlyCount: 0, lateTickets: 0 }).soldOutAt).toBeNull();
  });
});

describe('orders CSV', () => {
  it('quotes commas and quotes, and defuses formulas in buyer-entered text', () => {
    const csv = ordersCsv([order('A', 'v1', 1, 'paid', 1, 'Lee, "Ann"'), order('B', 'v1', 1, 'paid', 2, '=HYPERLINK("x")')]);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('ref,name,email,variant,qty,unit_price_sgd,amount_sgd,status,ordered_at,payment_status,payment_method,payment_reference,fulfillment_method,fulfillment_status,carrier,tracking_reference,fulfill_by');
    expect(lines[1]).toContain('"Lee, ""Ann"""');
    expect(lines[2]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(lines[1]).toContain(',9.00,9.00,paid,');
  });
});
