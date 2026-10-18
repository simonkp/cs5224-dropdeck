import { beforeAll, describe, expect, it } from 'vitest';
import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { keys, type Drop, type Order } from '@dropdeck/shared';
import { ddb, table } from '@dropdeck/shared/ddb';
import { orderHistory, updateOrderTracking } from '@dropdeck/shared/order-tracking-store';
import { analyticsReport, exportAnalytics, inventorySnapshot, orderWorklist } from '../../../services/merchant-api/src/analytics.js';
import { createTable, enabled, http, liveDrop, parse, shardSold } from './harness.js';
import { handler as ticket } from '../../../services/ticket/src/handler.js';
import { handler as claim } from '../../../services/claim/src/handler.js';
import { handler as checkout } from '../../../services/checkout/src/handler.js';
import { overviewOrders } from '../../../services/merchant-api/src/repo.js';
import { orderCounts } from '../../../services/merchant-api/src/overview.js';
import { buildReport } from '../../../services/merchant-api/src/reports.js';

async function seed(status:Order['status']='confirmed',count=1){
  const drop=await liveDrop();
  const orders:Order[]=Array.from({length:count},(_,i)=>({tenantId:drop.tenantId,dropId:drop.dropId,ref:`ORDER${String(i).padStart(4,'0')}`,holdId:`h${i}`,variantId:'v1',variantName:'Loaf',qty:1,unitPriceCents:800,amountCents:800,name:'Buyer',email:'buyer@example.com',status,createdAt:new Date().toISOString()}));
  for(let i=0;i<orders.length;i+=25)await ddb.send(new BatchWriteCommand({RequestItems:{[table()]:orders.slice(i,i+25).map(o=>({PutRequest:{Item:{...keys.order(o.tenantId,o.dropId,o.ref),type:'Order',...o,ttl:Math.floor(Date.parse(drop.endAt)/1000)+180*86400}}}))}}));
  return {drop,order:orders[0]!};
}
const profile=(drop:Drop,tier:string)=>ddb.send(new PutCommand({TableName:table(),Item:{...keys.profile(drop.tenantId),tenantId:drop.tenantId,tier,name:'Shop',slug:'shop'}}));

describe.skipIf(!enabled)('merchant analytics and order tracking',()=>{
  beforeAll(async()=>{await createTable();process.env.MERCHANT_ANALYTICS_ENABLED='1';process.env.GROWTH_ANALYTICS_PREVIEW_ENABLED='1';});
  it('keeps projected overview counts consistent with paid no-shows and omits private tracking fields',async()=>{
    const {drop,order}=await seed('paid',2);
    const paid=await updateOrderTracking(drop.tenantId,drop.dropId,order.ref,{expectedVersion:0,requestId:'paid-no-show-review',patch:{attendanceStatus:'no_show',note:'Private merchant note'}});
    const unknown=await updateOrderTracking(drop.tenantId,drop.dropId,'ORDER0001',{expectedVersion:0,requestId:'unknown-payment-review',reason:'Payment reconciliation pending',patch:{paymentStatus:'unknown'}});
    const page=await overviewOrders(drop.tenantId,drop.dropId);
    expect(orderCounts(page.rows)).toMatchObject({paidOrders:1,awaitingOrders:0,orders:2});
    expect(JSON.stringify(page.rows)).not.toMatch(/Private merchant note|buyer@example.com|"note"|"email"|"name"/);
    const report=buildReport(drop,[paid,unknown],{earlyCount:0,lateTickets:0});
    expect(report.units.paid).toBe(1);expect(report.byVariant[0]?.paid).toBe(report.units.paid);
  });
  it('enforces persisted tiers, blocks spoofing and removes premium access immediately on downgrade',async()=>{
    const {drop}=await seed();const t=drop.tenantId;
    for(const tier of ['starter','event']){
      await profile(drop,tier);const basic=await analyticsReport(t,{dropId:drop.dropId});expect('totals'in basic&&basic.totals.orders).toBe(1);expect(basic).not.toHaveProperty('variants');
      await expect(analyticsReport(t,{advanced:'1',tier:'growth'})).rejects.toMatchObject({code:'PLAN_LIMIT'});
      await expect(exportAnalytics(t,{advanced:'0'})).rejects.toMatchObject({code:'PLAN_LIMIT'});
    }
    await profile(drop,'growth');expect(await analyticsReport(t,{advanced:'1'})).toHaveProperty('insights');
    await profile(drop,'starter');await expect(analyticsReport(t,{advanced:'1'})).rejects.toMatchObject({code:'PLAN_LIMIT'});
    await expect(analyticsReport(t,{from:'2026-02-30'})).rejects.toMatchObject({code:'VALIDATION'});
  });
  it('atomically audits idempotent updates, rejects conflicting writes, and leaves stock unchanged',async()=>{
    const {drop,order}=await seed();const before=await shardSold(drop);
    const body={expectedVersion:0,requestId:'payment-request-1',patch:{paymentStatus:'paid',paymentMethod:'PayNow'}};
    const updated=await updateOrderTracking(drop.tenantId,drop.dropId,order.ref,body);expect(updated.version).toBe(1);
    await updateOrderTracking(drop.tenantId,drop.dropId,order.ref,body);
    const history=await orderHistory(drop.tenantId,drop.dropId,order.ref);expect(history.rows).toHaveLength(1);
    await expect(updateOrderTracking(drop.tenantId,drop.dropId,order.ref,{...body,patch:{paymentStatus:'awaiting'}})).rejects.toMatchObject({code:'INVALID_STATE'});
    const concurrent=await Promise.allSettled(['concurrent-1','concurrent-2'].map(requestId=>updateOrderTracking(drop.tenantId,drop.dropId,order.ref,{expectedVersion:1,requestId,patch:{fulfillmentMethod:'pickup',fulfillmentStatus:'ready'}})));
    expect(concurrent.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await shardSold(drop)).toEqual(before);
  });
  it('requires reversal/override reasons and validates pickup/shipping transitions',async()=>{
    const {drop,order}=await seed('paid');const t=drop.tenantId,d=drop.dropId;
    await expect(updateOrderTracking(t,d,order.ref,{expectedVersion:0,requestId:'reverse-no-reason',patch:{paymentStatus:'awaiting'}})).rejects.toMatchObject({code:'VALIDATION'});
    await expect(updateOrderTracking(t,d,order.ref,{expectedVersion:0,requestId:'wrong-pickup-state',patch:{fulfillmentMethod:'pickup',fulfillmentStatus:'shipped'}})).rejects.toMatchObject({code:'VALIDATION'});
    const shipped=await updateOrderTracking(t,d,order.ref,{expectedVersion:0,requestId:'dispatch-order-1',patch:{fulfillmentMethod:'shipping',fulfillmentStatus:'shipped',carrier:'SingPost',trackingReference:'TRACK123'}});
    expect(shipped.tracking?.dispatchedAt).toBeTruthy();
    const done=await updateOrderTracking(t,d,order.ref,{expectedVersion:1,requestId:'deliver-order-1',patch:{fulfillmentStatus:'delivered'}});expect(done.tracking?.completedAt).toBeTruthy();
    await expect(updateOrderTracking(t,d,order.ref,{expectedVersion:2,requestId:'undo-delivery-1',patch:{fulfillmentStatus:'not_started'}})).rejects.toMatchObject({code:'VALIDATION'});
  });
  it('protects tenant boundaries, logical retention and cursor ownership',async()=>{
    const {drop,order}=await seed();await expect(updateOrderTracking('another-tenant',drop.dropId,order.ref,{expectedVersion:0,requestId:'tenant-spoof-1',patch:{paymentStatus:'paid'}})).rejects.toMatchObject({code:'NOT_FOUND'});
    const cursor=Buffer.from(JSON.stringify({PK:'T#other',SK:`ORDER#${drop.dropId}#a`})).toString('base64url');
    await expect(orderWorklist(drop.tenantId,{dropId:drop.dropId,cursor})).rejects.toMatchObject({code:'VALIDATION'});
    await ddb.send(new PutCommand({TableName:table(),Item:{...keys.order(drop.tenantId,drop.dropId,order.ref),...order,ttl:1}}));
    expect((await orderWorklist(drop.tenantId,{dropId:drop.dropId})).rows).toHaveLength(0);
    await expect(orderHistory(drop.tenantId,drop.dropId,order.ref)).rejects.toMatchObject({code:'NOT_FOUND'});
  });
  it('marks missing stock shards as unknown rather than inventing available inventory',async()=>{
    const drop=await liveDrop();const clean=await inventorySnapshot(drop.tenantId,drop.dropId);expect(clean.partial).toBe(false);expect(clean.variants[0]?.available).toBe(20);
    await ddb.send(new DeleteCommand({TableName:table(),Key:keys.stockShard(drop.tenantId,drop.dropId,'v1',0)}));
    const partial=await inventorySnapshot(drop.tenantId,drop.dropId);expect(partial.partial).toBe(true);expect(partial.variants[0]?.available).toBeNull();
    await expect(inventorySnapshot('another-tenant',drop.dropId)).rejects.toMatchObject({code:'NOT_FOUND'});
  });
  it('marks bounded reports partial, pages worklists, and refuses incomplete exports',async()=>{
    const {drop}=await seed('paid',501);await profile(drop,'growth');
    const r=await analyticsReport(drop.tenantId,{dropId:drop.dropId,advanced:'1'});expect('scope'in r&&r.scope.partial).toBe(true);expect('totals'in r&&r.totals.orders).toBe(500);
    const first=await orderWorklist(drop.tenantId,{dropId:drop.dropId});expect(first.rows).toHaveLength(50);expect(first.nextCursor).toBeTruthy();
    const second=await orderWorklist(drop.tenantId,{dropId:drop.dropId,cursor:first.nextCursor});expect(second.rows[0]?.ref).not.toBe(first.rows[0]?.ref);
    await expect(exportAnalytics(drop.tenantId,{dropId:drop.dropId})).rejects.toMatchObject({code:'VALIDATION'});
  });
  it('limits advanced exports and excludes buyer identity from sales summaries',async()=>{
    const {drop}=await seed();await profile(drop,'growth');
    const text=await exportAnalytics(drop.tenantId,{dropId:drop.dropId});expect(text).toContain('confirmed_sgd');expect(text).not.toContain('buyer@example.com');
    await exportAnalytics(drop.tenantId,{dropId:drop.dropId});await expect(exportAnalytics(drop.tenantId,{dropId:drop.dropId})).rejects.toMatchObject({code:'RATE_LIMITED'});
  });
  it('preserves tracking when checkout confirmation is retried after a merchant action',async()=>{
    const drop=await liveDrop();const tk=parse(await ticket(http.ticket(drop)));const held=parse(await claim(http.claim(drop,tk.ticket,'v1',1)));
    const result=parse(await checkout(http.checkout('confirm',held.holdId,held.hold,{name:'Buyer',email:'b@example.com'})));expect(result.status).toBe(200);
    await updateOrderTracking(drop.tenantId,drop.dropId,result.orderRef,{expectedVersion:1,requestId:'paid-after-checkout',patch:{paymentStatus:'paid',fulfillmentMethod:'pickup',fulfillmentStatus:'collected'}});
    await checkout(http.checkout('confirm',held.holdId,held.hold,{name:'Buyer',email:'b@example.com'}));
    const row=await ddb.send(new GetCommand({TableName:table(),Key:keys.order(drop.tenantId,drop.dropId,result.orderRef)}));expect(row.Item?.tracking).toMatchObject({paymentStatus:'paid',fulfillmentStatus:'collected'});expect(row.Item?.version).toBe(2);
  });
});
