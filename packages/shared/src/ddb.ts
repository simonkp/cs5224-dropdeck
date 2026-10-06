import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand, type BatchGetCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { ApiError } from './errors.js';
import { keys } from './keys.js';
import type { Drop, Hold, MerchantProfile } from './types.js';

/**
 * Table access shared by the buyer-path services (ticket, claim, checkout, controller).
 * Exported from `@dropdeck/shared/ddb`, not the index, so the web bundle never pulls in the SDK.
 */

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

export function table(): string {
  const name = process.env.TABLE_NAME;
  if (!name) throw new Error('Missing env TABLE_NAME');
  return name;
}

export const isConditionFailure = (e: unknown) => (e as { name?: string })?.name === 'ConditionalCheckFailedException';

/** Drop the PK/SK/type/GSI attributes that only exist for the table's sake. */
export function strip<T>(item: Record<string, unknown> | undefined): T | undefined {
  if (!item) return undefined;
  const { PK: _pk, SK: _sk, type: _type, GSI1PK: _g1, GSI1SK: _g2, ttl: _ttl, ...rest } = item;
  return rest as T;
}

export async function getDrop(t: string, d: string): Promise<Drop> {
  const r = await ddb.send(new GetCommand({ TableName: table(), Key: keys.drop(t, d) }));
  const drop = strip<Drop>(r.Item);
  if (!drop) throw new ApiError('NOT_FOUND', 'Drop not found');
  return drop;
}

const dropCache = new Map<string, { at: number; drop: Promise<Drop> }>();

/**
 * Per-instance cache: at the opening second every ticket and claim would otherwise read the same drop item.
 * A few seconds of staleness is fine; the frozen earlyCount and the Live/Closed state are the only fields
 * that change while buyers are active, and both are re-checked by conditional writes where it matters.
 */
export function getDropCached(t: string, d: string, ttlMs = 3000, nowMs = Date.now()): Promise<Drop> {
  const key = `${t}#${d}`;
  const hit = dropCache.get(key);
  if (hit && nowMs - hit.at < ttlMs) return hit.drop;
  const drop = getDrop(t, d);
  dropCache.set(key, { at: nowMs, drop });
  drop.catch(() => dropCache.delete(key));
  return drop;
}

export function clearDropCache(): void {
  dropCache.clear();
}

/** Every drop of a tenant, newest first (paginated, so a long history is never cut short). */
export async function listDrops(t: string): Promise<Drop[]> {
  const k = keys.dropPrefix(t);
  const out: Drop[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': k.PK, ':sk': k.SKPrefix },
      ExclusiveStartKey: start,
    }));
    out.push(...(r.Items ?? []).map((i) => strip<Drop>(i)!));
    start = r.LastEvaluatedKey;
  } while (start);
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getProfile(t: string): Promise<MerchantProfile | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: table(), Key: keys.profile(t) }));
  return strip<MerchantProfile>(r.Item);
}

export async function getHold(t: string, d: string, holdId: string): Promise<Hold | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: table(), Key: keys.hold(t, d, holdId), ConsistentRead: true }));
  return strip<Hold>(r.Item);
}

/** Give units back to a stock shard. Only ever called after the caller won a conditional state flip. */
export async function returnUnits(t: string, d: string, variantId: string, shard: number, qty: number): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: table(),
    Key: keys.stockShard(t, d, variantId, shard),
    UpdateExpression: 'SET sold = sold - :q',
    ExpressionAttributeValues: { ':q': qty },
  }));
}

/**
 * Release an active hold and return its units. The flip active → released is conditional, so when two
 * sweepers (or a sweeper and a checkout) race, exactly one returns the units: no double release, no oversell.
 * `expiredBy` (epoch ms) additionally requires the hold to have expired by then: the sweep passes it, so it can
 * never take a hold from a buyer who is still inside their window. Returns false if the condition failed.
 */
export async function releaseHold(
  hold: Pick<Hold, 'tenantId' | 'dropId' | 'holdId' | 'variantId' | 'shard' | 'qty'>,
  opts: { expiredBy?: number } = {},
): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: table(),
      Key: keys.hold(hold.tenantId, hold.dropId, hold.holdId),
      UpdateExpression: 'SET #s = :released REMOVE GSI1PK, GSI1SK',
      ConditionExpression: opts.expiredBy === undefined ? '#s = :active' : '#s = :active AND expiresAt <= :now',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: {
        ':released': 'released', ':active': 'active',
        ...(opts.expiredBy === undefined ? {} : { ':now': opts.expiredBy }),
      },
    }));
  } catch (e) {
    if (isConditionFailure(e)) return false;
    throw e;
  }
  // A crash here leaks the units (undersell), never oversells.
  await returnUnits(hold.tenantId, hold.dropId, hold.variantId, hold.shard, hold.qty);
  return true;
}

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

/**
 * Per-variant units out (held or confirmed), summed over its shards. Live view only: after close, unswept holds
 * keep counting, so reports must count ORDER# items instead.
 */
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
