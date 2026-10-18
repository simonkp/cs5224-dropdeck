import { describe, expect, it } from 'vitest';
import { analyticsCapabilities } from '../src/plans.js';
import { salesTotals, singaporeDay, summarizeSales, trackingCsv, trackingOf } from '../src/merchant-analytics.js';
import type { Order } from '../src/types.js';

const order=(patch:Partial<Order>={}):Order=>({tenantId:'t',dropId:'d',ref:'r',holdId:'h',variantId:'v',variantName:'Bread',qty:2,unitPriceCents:500,amountCents:1000,name:'Buyer',email:'buyer@example.com',status:'confirmed',createdAt:'2026-10-01T16:00:00Z',...patch});
describe('merchant analytics definitions',()=>{
  it('grants advanced access only to Growth when the preview switch is enabled',()=>{
    for(const tier of ['starter','event',undefined,'admin','GROWTH'])expect(analyticsCapabilities(tier).advancedPreview).toBe(false);
    expect(analyticsCapabilities('growth').advancedPreview).toBe(true);
    expect(analyticsCapabilities('growth',false).advancedPreview).toBe(false);
    expect(analyticsCapabilities('growth').quickSightConnected).toBe(false);
  });
  it('keeps paid no-shows distinct and does not invent legacy payment or fulfillment history',()=>{
    expect(trackingOf(order({status:'no-show'}))).toMatchObject({paymentStatus:'unknown',fulfillmentStatus:'unknown'});
    const o=order({status:'no-show',tracking:{paymentStatus:'paid',attendanceStatus:'no_show',fulfillmentMethod:'pickup',fulfillmentStatus:'not_started'}});
    expect(salesTotals([o])).toMatchObject({paidCents:1000,noShowUnits:2,fulfillmentOpen:1});
  });
  it('uses Singapore order cohorts and removes advanced payloads from basic reports',()=>{
    expect(singaporeDay('2026-10-01T16:00:00Z')).toBe('2026-10-02');
    const report=summarizeSales([order()],[],'2026-10-01','2026-10-02',false);
    expect(report.days.map(d=>d.orders)).toEqual([0,1]);
    expect(report).not.toHaveProperty('variants');expect(report).not.toHaveProperty('previous');expect(report).not.toHaveProperty('insights');
  });
  it('uses confirmation time when present and avoids growth percentages with an empty baseline',()=>{
    const r=summarizeSales([order({confirmedAt:'2026-10-03T00:00:00Z'})],[],'2026-10-03','2026-10-03',true);
    expect(r.totals.orders).toBe(1);expect(r.legacyDates).toBe(false);expect(r.previous?.changePercent).toBeNull();
  });
  it('exports only the worklist page and neutralizes tracking-reference formulas without buyer identity',()=>{
    const o=order();o.tracking={...trackingOf(o),trackingReference:'=HYPERLINK("x")'};
    const text=trackingCsv([o]);expect(text).not.toContain('buyer@example.com');expect(text).not.toContain('Buyer');expect(text).toContain(`"'=HYPERLINK(""x"")"`);expect(text.trim().split('\r\n')).toHaveLength(2);
  });
});
