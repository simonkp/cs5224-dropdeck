import { BatchGetCommand, QueryCommand, UpdateCommand, type BatchGetCommandOutput, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { keys, type Drop, type Hold } from '@dropdeck/shared';
import { ddb, isConditionFailure, releaseHold, strip, table } from '@dropdeck/shared/ddb';

/** Releases run in small parallel batches so a burst of expiries fits inside one 2.5 s tick. */
const RELEASE_BATCH = 25;

/** Active holds from the sparse GSI1 (only active holds carry GSI1 keys), optionally only those expired by `nowMs`. */
async function* activeHolds(drop: Drop, expiredBy?: number): AsyncGenerator<Hold[]> {
  let start: QueryCommandInput['ExclusiveStartKey'];
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: table(),
      IndexName: 'GSI1',
      KeyConditionExpression: expiredBy === undefined ? 'GSI1PK = :pk' : 'GSI1PK = :pk AND GSI1SK <= :now',
      ExpressionAttributeValues: {
        ':pk': keys.holdIndex(drop.tenantId, drop.dropId),
        ...(expiredBy === undefined ? {} : { ':now': new Date(expiredBy).toISOString() }),
      },
      ExclusiveStartKey: start,
      Limit: 200,
    }));
    yield (r.Items ?? []).map((i) => strip<Hold>(i)!);
    start = r.LastEvaluatedKey;
  } while (start);
}

async function releaseAll(drop: Drop, expiredBy?: number): Promise<number> {
  let released = 0;
  for await (const page of activeHolds(drop, expiredBy)) {
    for (let i = 0; i < page.length; i += RELEASE_BATCH) {
      const results = await Promise.all(page.slice(i, i + RELEASE_BATCH).map((h) => releaseHold(h, { expiredBy })));
      released += results.filter(Boolean).length;
    }
  }
  return released;
}

/**
 * Return the units of expired holds. GSI reads are eventually consistent and another controller may be sweeping
 * too, but each release is a conditional flip (active and expired), so a unit goes back exactly once.
 */
export const sweepExpired = (drop: Drop, nowMs: number) => releaseAll(drop, nowMs);

/** A cancelled drop: void every active hold so none can still be confirmed. */
export const voidActiveHolds = (drop: Drop) => releaseAll(drop);

export async function activeHoldCount(drop: Drop): Promise<number> {
  const r = await ddb.send(new QueryCommand({
    TableName: table(),
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': keys.holdIndex(drop.tenantId, drop.dropId) },
    Select: 'COUNT',
  }));
  return r.Count ?? 0;
}

/** Per-variant units sold (held or confirmed), summed over its shards. */
export async function unitsSold(drop: Drop): Promise<Record<string, number>> {
  const variantOf = new Map<string, string>();
  const wanted = drop.variants.flatMap((v) => Array.from({ length: drop.shardCount }, (_, s) => {
    const k = keys.stockShard(drop.tenantId, drop.dropId, v.id, s);
    variantOf.set(k.PK, v.id);
    return k;
  }));
  const sold: Record<string, number> = Object.fromEntries(drop.variants.map((v) => [v.id, 0]));
  for (let i = 0; i < wanted.length; i += 100) {
    let request: Record<string, { Keys: Record<string, unknown>[] }> | undefined = { [table()]: { Keys: wanted.slice(i, i + 100) } };
    for (let attempt = 0; request && attempt < 5; attempt++) {
      const r: BatchGetCommandOutput = await ddb.send(new BatchGetCommand({ RequestItems: request }));
      for (const item of r.Responses?.[table()] ?? []) {
        const variantId = variantOf.get(String(item.PK));
        if (variantId) sold[variantId] = (sold[variantId] ?? 0) + Number(item.sold ?? 0);
      }
      request = r.UnprocessedKeys && Object.keys(r.UnprocessedKeys).length ? (r.UnprocessedKeys as typeof request) : undefined;
      if (request) await new Promise((res) => setTimeout(res, 50 * 2 ** attempt));
    }
  }
  return sold;
}

export function soldOutFlags(drop: Drop, sold: Record<string, number>): Record<string, boolean> {
  return Object.fromEntries(drop.variants.map((v) => [v.id, (sold[v.id] ?? 0) >= v.stock]));
}

/** Live → Closed. Conditional, so overlapping controllers (or a merchant cancel) cannot both win. */
export async function closeDrop(drop: Drop, nowMs: number): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: table(),
      Key: keys.drop(drop.tenantId, drop.dropId),
      UpdateExpression: 'SET #s = :closed, version = version + :one, updatedAt = :now',
      ConditionExpression: '#s = :live',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: { ':closed': 'Closed', ':live': 'Live', ':one': 1, ':now': new Date(nowMs).toISOString() },
    }));
    return true;
  } catch (e) {
    if (isConditionFailure(e)) return false;
    throw e;
  }
}
