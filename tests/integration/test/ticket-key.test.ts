import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { keys, type Drop } from '@dropdeck/shared';
import { createTable, enabled, http, liveDrop, parse } from './harness.js';

const { handler: ticket } = await import('../../../services/ticket/src/handler.js');
const { ddb, table } = await import('@dropdeck/shared/ddb');
const { GetCommand } = await import('@aws-sdk/lib-dynamodb');

const keyParam = process.env.TOKEN_KEY_PARAM;

async function counter(key: Record<string, string>): Promise<number> {
  const r = await ddb.send(new GetCommand({ TableName: table(), Key: key, ConsistentRead: true }));
  return Number(r.Item?.v ?? 0);
}
const earlyCount = async (drop: Drop) => {
  let n = 0;
  for (let shard = 0; shard < 8; shard++) n += await counter(keys.earlyCounter(drop.tenantId, drop.dropId, shard));
  return n;
};

// Under a crowd the key lookup is refused (SSM ThrottlingException). A refused join must leave no trace in the
// counters, or it becomes an entry in the draw that nobody holds.
describe.skipIf(!enabled)('ticket when the signing key cannot be loaded', () => {
  beforeAll(createTable);
  afterEach(() => { process.env.TOKEN_KEY_PARAM = keyParam; });

  // One test: the handler caches the key once loaded, so every failing call must come before the first success.
  it('a join that fails on the key leaves the draw and the late numbers untouched', async () => {
    const early = await liveDrop({ startedMinAgo: -10 / 60, earlyCount: undefined });
    const late = await liveDrop();
    delete process.env.TOKEN_KEY_PARAM;
    expect(parse(await ticket(http.ticket(early))).status).toBe(500);
    expect(parse(await ticket(http.ticket(late))).status).toBe(500);
    expect(await earlyCount(early)).toBe(0);
    expect(await counter(keys.ticketCounter(late.tenantId, late.dropId))).toBe(0);

    process.env.TOKEN_KEY_PARAM = keyParam;
    expect(parse(await ticket(http.ticket(early))).status).toBe(201);
    expect(await earlyCount(early)).toBe(1);
  });
});
