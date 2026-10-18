import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchWriteCommand, DeleteCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createTable, enabled, liveDrop } from './harness.js';
import { keys } from '@dropdeck/shared';

const probe=vi.hoisted(()=>({s3:vi.fn()}));
vi.mock('@aws-sdk/client-s3',()=>({GetObjectCommand:class{constructor(public input:unknown){}},S3Client:class{send=probe.s3;}}));
vi.mock('../../../services/controller/src/publish.js',()=>({writeState:vi.fn(),writeShopJson:vi.fn(),writeFeaturedJson:vi.fn()}));
vi.mock('../../../services/controller/src/schedule.js',()=>({upsertTickSchedule:vi.fn(),deleteTickSchedule:vi.fn()}));
const {tickOnce}=await import('../../../services/controller/src/handler.js');
const publish=vi.mocked(await import('../../../services/controller/src/publish.js'));
const {collect}=await import('../../../services/operations/src/handler.js');
const {healthOverview}=await import('../../../services/admin-api/src/operations.js');
const {ddb,getDrop,table}=await import('@dropdeck/shared/ddb');

describe.skipIf(!enabled)('operational lifecycle and alarm continuity',()=>{
  beforeEach(async()=>{
    const main=await createTable();const ops=await createTable();process.env.TABLE_NAME=main;process.env.OPS_TABLE_NAME=ops;process.env.STAGE='review';
    vi.clearAllMocks();probe.s3.mockRejectedValue({$metadata:{httpStatusCode:404}});
  });
  it('publishes the same revision as the database when a live drop closes normally',async()=>{
    const drop=await liveDrop({endAt:new Date(Date.now()-1000).toISOString()});
    await tickOnce(drop.tenantId,drop.dropId,Date.now());
    const stored=await getDrop(drop.tenantId,drop.dropId);expect(stored.state).toBe('Closed');
    expect(publish.writeState.mock.lastCall?.[2].sourceVersion).toBe(stored.version);
  });
  it('does not report intentional state removal on unscheduling as a critical publication incident',async()=>{
    const drop=await liveDrop({state:'Scheduled'});
    await ddb.send(new PutCommand({TableName:process.env.OPS_TABLE_NAME,Item:{PK:'REGISTRY',SK:`${drop.tenantId}/${drop.dropId}`,tenantId:drop.tenantId,dropId:drop.dropId,lifecycle:'Scheduled',ttl:Math.floor(Date.now()/1000)+86400}}));
    await ddb.send(new UpdateCommand({TableName:table(),Key:keys.drop(drop.tenantId,drop.dropId),UpdateExpression:'SET #s=:draft',ExpressionAttributeNames:{'#s':'state'},ExpressionAttributeValues:{':draft':'Draft'}}));
    expect((await collect()).failures).toBe(0);
    expect((await healthOverview()).rows).toEqual([]);expect(probe.s3).not.toHaveBeenCalled();
  });
  it('keeps a persistent incident visible across pages, then clears it after recovery', async () => {
    const drops = [];
    for (let i = 0; i < 21; i++) drops.push(await liveDrop({ tenantId: `alarm-${String(i).padStart(2, '0')}`, dropId: 'live' }));
    const start = Date.now();
    await ddb.send(new BatchWriteCommand({ RequestItems: { [process.env.OPS_TABLE_NAME!]: drops.map(d => ({ PutRequest: { Item: {
      PK: 'REGISTRY', SK: `${d.tenantId}/${d.dropId}`, tenantId: d.tenantId, dropId: d.dropId,
      ttl: Math.floor(start / 1000) + 86400,
    } } })) } }));
    probe.s3.mockResolvedValue({ LastModified: new Date(), Body: { transformToString: async () => JSON.stringify({ state: 'Live', sourceVersion: 1 }) } });
    const clock = vi.spyOn(Date, 'now');
    const metrics = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      for (let minute = 0; minute < 6; minute++) {
        const now = start + minute * 60_000;
        clock.mockReturnValue(now);
        await Promise.all(drops.map((d, i) => ddb.send(new UpdateCommand({
          TableName: process.env.OPS_TABLE_NAME, Key: { PK: 'REGISTRY', SK: `${d.tenantId}/${d.dropId}` },
          UpdateExpression: 'SET heartbeatAt=:at', ExpressionAttributeValues: { ':at': now - (i === 0 && minute < 4 ? 200_000 : 0) },
        }))));
        await collect();
      }
      const records = metrics.mock.calls.map(c => JSON.parse(String(c[0]))) as Array<{ AffectedDrops: number; UnresolvedIncidentPresent: number }>;
      expect(records.map(r => r.AffectedDrops)).toEqual([1, 0, 1, 0, 0, 0]);
      expect(records.map(r => r.UnresolvedIncidentPresent)).toEqual([1, 1, 1, 1, 0, 0]);
    } finally { clock.mockRestore(); metrics.mockRestore(); }
  });
  it('ignores expired incident evidence before asynchronous TTL removal', async () => {
    const expiry = Date.now() - 1000;
    await ddb.send(new PutCommand({ TableName: process.env.OPS_TABLE_NAME, Item: {
      PK: 'REGISTRY', SK: 'expired/drop', tenantId: 'expired', dropId: 'drop',
      GSI1PK: 'UNRESOLVED', GSI1SK: `${expiry}#expired/drop`, ttl: Math.floor(expiry / 1000),
    } }));
    expect(await collect()).toMatchObject({ failures: 0, unresolvedIncidentPresent: 0 });
  });
  it('does not count an intentionally deleted draft as an operational collection failure',async()=>{
    const drop=await liveDrop({state:'Draft'});
    await ddb.send(new PutCommand({TableName:process.env.OPS_TABLE_NAME,Item:{PK:'REGISTRY',SK:`${drop.tenantId}/${drop.dropId}`,tenantId:drop.tenantId,dropId:drop.dropId,lifecycle:'Scheduled',ttl:Math.floor(Date.now()/1000)+86400}}));
    await ddb.send(new DeleteCommand({TableName:table(),Key:keys.drop(drop.tenantId,drop.dropId)}));
    expect((await collect()).failures).toBe(0);
    expect((await healthOverview()).rows).toEqual([]);
    expect(probe.s3).not.toHaveBeenCalled();
  });
});
