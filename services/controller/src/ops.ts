import { QueryCommand, UpdateCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { keys, type Drop, type Hold } from '@dropdeck/shared';
import { ddb, isConditionFailure, releaseHold, strip, table } from '@dropdeck/shared/ddb';

export { activeHoldCount, unitsSold } from '@dropdeck/shared/ddb';

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
