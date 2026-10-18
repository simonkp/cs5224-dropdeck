import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
const mock=vi.hoisted(()=>({send:vi.fn()}));
vi.mock('@dropdeck/shared/ddb',()=>({ddb:{send:mock.send},table:()=> 'application',getDrop:vi.fn()}));
import { ingest } from '../src/handler.js';
import { observation } from '../src/events.js';
beforeEach(()=>{mock.send.mockReset();process.env.OPS_TABLE_NAME='operations';});
describe('bounded batch aggregation',()=>{
  it('atomically deduplicates a retry and never writes to application inventory',async()=>{
    mock.send.mockResolvedValue({});const o=observation({_ops:true,kind:'request',tenantId:'t',dropId:'d',at:Date.now(),Service:'claim',status:201,LatencyMs:40},'request-1')!;
    await ingest([o],'logs');const command=mock.send.mock.calls[0]![0] as TransactWriteCommand;
    expect(command).toBeInstanceOf(TransactWriteCommand);
    const writes=command.input.TransactItems!;expect(writes).toHaveLength(3);
    expect(writes[0]?.Put?.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(writes.every(w=>(w.Put??w.Update)?.TableName==='operations')).toBe(true);
    mock.send.mockRejectedValueOnce({CancellationReasons:[{Code:'ConditionalCheckFailed'}]});await expect(ingest([o],'logs')).resolves.toBeUndefined();
  });
  it('does not hide ingestion failures as successful telemetry',async()=>{
    mock.send.mockRejectedValue(new Error('DynamoDB unavailable'));
    const o=observation({_ops:true,kind:'request',tenantId:'t',dropId:'d',at:Date.now(),Service:'ticket',status:201},'id')!;
    await expect(ingest([o],'logs')).rejects.toThrow('DynamoDB unavailable');
  });
  it('keeps only the newest heartbeat field in a batch and conditions against older log deliveries',async()=>{
    mock.send.mockResolvedValue({});const at=Math.floor(Date.now()/60000)*60000+10000;const make=(time:number)=>observation({_ops:true,kind:'heartbeat',tenantId:'t',dropId:'d',at:time},String(time))!;
    await ingest([make(at-1000),make(at)],'logs');expect(mock.send).toHaveBeenCalledTimes(1);
    const input=mock.send.mock.calls[0]![0].input;expect(input.ExpressionAttributeValues[':value']).toBe(at);expect(input.ConditionExpression).toContain('#clock < :at');
  });
});
