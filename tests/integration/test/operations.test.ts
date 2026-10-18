import { beforeAll, describe, expect, it, vi } from 'vitest';
import { BatchWriteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createTable, enabled, http, liveDrop, parse, shardSold } from './harness.js';

vi.mock('@aws-sdk/client-s3',()=>({
  GetObjectCommand:class { constructor(public input:unknown){} },
  S3Client:class {async send(){return {LastModified:new Date(),Body:{transformToString:async()=>JSON.stringify({state:'Live',sourceVersion:1})}};}},
}));
const {ingest,collect}=await import('../../../services/operations/src/handler.js');
const {observation}=await import('../../../services/operations/src/events.js');
const {analytics,dropTelemetry,healthOverview}=await import('../../../services/admin-api/src/operations.js');
const {handler:admin}=await import('../../../services/admin-api/src/handler.js');
const {handler:ticket}=await import('../../../services/ticket/src/handler.js');
const {handler:claim}=await import('../../../services/claim/src/handler.js');
const {ddb,table}=await import('@dropdeck/shared/ddb');

describe.skipIf(!enabled)('operations against DynamoDB Local',()=>{
  beforeAll(async()=>{const main=await createTable();const ops=await createTable();process.env.TABLE_NAME=main;process.env.OPS_TABLE_NAME=ops;});
  it('deduplicates real transactional metric updates and collects health without changing stock',async()=>{
    const drop=await liveDrop();const tk=parse(await ticket(http.ticket(drop)));const held=parse(await claim(http.claim(drop,tk.ticket,'v1',2)));
    expect(held.status).toBe(201);const before=await shardSold(drop);const now=Date.now();
    const events=[
      observation({_ops:true,kind:'heartbeat',tenantId:drop.tenantId,dropId:drop.dropId,at:now,title:drop.title,lifecycle:'Live',sourceVersion:1},'heartbeat')!,
      observation({_ops:true,kind:'request',tenantId:drop.tenantId,dropId:drop.dropId,at:now,Service:'ticket',status:201,LatencyMs:25},'ticket')!,
    ];
    await ingest(events,'integration');await ingest(events,'integration');
    const telemetry=await dropTelemetry(drop.tenantId,drop.dropId,'1h');expect(telemetry.totals.ticketsIssued).toBe(1);
    expect(await collect()).toMatchObject({failures:0,sampled:1});
    const overview=await healthOverview();expect(overview.rows[0]?.inventory).toMatchObject({counterUnits:2,activeUnits:2,orderUnits:0,partial:false});
    expect(await shardSold(drop)).toEqual(before);
    const hold=await ddb.send(new GetCommand({TableName:table(),Key:{PK:`H#${drop.tenantId}#${drop.dropId}#${held.holdId}`,SK:'HOLD'}}));expect(hold.Item?.state).toBe('active');
  });
  it('skips overlapping collection while a live lease owns the cursor',async()=>{
    await ddb.send(new PutCommand({TableName:process.env.OPS_TABLE_NAME,Item:{PK:'META',SK:'COLLECTOR',leaseOwner:'another-run',leaseUntil:Date.now()+90_000}}));
    expect(await collect()).toMatchObject({sampled:0,skipped:true});
  });
  it('keeps analytics page-scoped across real DynamoDB pagination',async()=>{
    const rows=Array.from({length:26},(_,i)=>{const t=`analytics-${String(i).padStart(2,'0')}`;return [
      {PK:'TENANTS',SK:`T#${t}`,tenantId:t}, {PK:`T#${t}`,SK:'PROFILE',tenantId:t,name:t,tier:'growth'},
      {PK:`T#${t}`,SK:'USAGE#2026-10',month:'2026-10',sessions:i+1,drops:1,cancelled:0,orders:1,revenueCents:800},
    ];}).flat();
    for(let i=0;i<rows.length;i+=25)await ddb.send(new BatchWriteCommand({RequestItems:{[table()]:rows.slice(i,i+25).map(Item=>({PutRequest:{Item}}))}}));
    const first=await analytics('2026-10');expect(first.scope).toBe('page');expect(first.shops).toBe(25);expect(first.partial).toBe(false);expect(first.trend.at(-1)?.sessions).toBe(325);expect(first.nextCursor).toBeTruthy();
    const next=await analytics('2026-10',first.nextCursor);expect(next.shops).toBe(1);expect(next.trend.at(-1)?.sessions).toBe(26);expect(next.nextCursor).toBeUndefined();
    const changed=await admin({routeKey:'PATCH /admin/tenants/{tenantId}',pathParameters:{tenantId:'analytics-00'},body:JSON.stringify({tier:'event'}),requestContext:{authorizer:{jwt:{claims:{sub:'operator','cognito:groups':['operators']}}}}} as never);
    expect(changed.statusCode).toBe(200);
    const refreshed=await analytics('2026-10');
    expect(refreshed.planMix.find(p=>p.tier==='event')?.shops).toBe(1);
    expect(refreshed.merchants.find(m=>m.tenantId==='analytics-00')).toMatchObject({tier:'event',previewSgd:19});
  });
});
