import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ApiError, keys, type Drop, type DropState, type MerchantProfile, type Order, type OrderStatus, type Usage } from '@dropdeck/shared';
import { env } from './env.js';
import { shardCapacities } from './validate.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

const strip = <T>(item: Record<string, unknown> | undefined): T | undefined => {
  if (!item) return undefined;
  const { PK: _pk, SK: _sk, type: _type, ttl: _ttl, ...rest } = item;
  return rest as T;
};

const isConditionFailure = (e: unknown) => (e as { name?: string })?.name === 'ConditionalCheckFailedException';

export async function getProfile(t: string): Promise<MerchantProfile | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.profile(t) }));
  return strip<MerchantProfile>(r.Item);
}

/**
 * Save the profile and hold its slug in one transaction: claim SLUG#{new} (unless another tenant has it), write the
 * profile (only if nobody changed its slug since we read it), and free SLUG#{old} when the slug moved. Every save
 * re-claims the slug, which also backfills the SLUG# item for profiles saved before slugs were unique.
 */
export async function saveProfile(next: MerchantProfile, prev: MerchantProfile | undefined): Promise<MerchantProfile> {
  const t = next.tenantId;
  const saved: MerchantProfile = { ...next, slugClaimed: true };
  const moved = prev !== undefined && prev.slug !== next.slug;
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: env.table(),
            Item: { ...keys.slug(next.slug), type: 'Slug', tenantId: t },
            ConditionExpression: 'attribute_not_exists(PK) OR tenantId = :t',
            ExpressionAttributeValues: { ':t': t },
          },
        },
        {
          Put: {
            TableName: env.table(),
            Item: { ...keys.profile(t), type: 'Profile', ...saved },
            ...(prev
              ? { ConditionExpression: 'slug = :prev', ExpressionAttributeValues: { ':prev': prev.slug } }
              : { ConditionExpression: 'attribute_not_exists(PK)' }),
          },
        },
        // The registry operators list shops from (no table scan).
        { Put: { TableName: env.table(), Item: { ...keys.tenantEntry(t), type: 'Tenant', tenantId: t, name: next.name, slug: next.slug, updatedAt: new Date().toISOString() } } },
        ...(moved
          ? [{
            Delete: {
              TableName: env.table(),
              Key: keys.slug(prev.slug),
              ConditionExpression: 'attribute_not_exists(PK) OR tenantId = :t',
              ExpressionAttributeValues: { ':t': t },
            },
          }]
          : []),
      ],
    }));
  } catch (e) {
    const reasons = (e as { name?: string; CancellationReasons?: Array<{ Code?: string }> });
    if (reasons.name === 'TransactionCanceledException') {
      if (reasons.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') throw new ApiError('SLUG_TAKEN', 'That shop link is taken; try another');
      throw new ApiError('INVALID_STATE', 'Your shop profile changed since it was loaded; reload and try again');
    }
    throw e;
  }
  return saved;
}

/** The shop's metered months, newest first. */
export async function listUsage(t: string): Promise<Usage[]> {
  const k = keys.usagePrefix(t);
  const r = await ddb.send(new QueryCommand({
    TableName: env.table(),
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': k.PK, ':sk': k.SKPrefix },
    ScanIndexForward: false,
    Limit: 12,
  }));
  return (r.Items ?? []).map((i) => strip<Usage>(i)!);
}

/** Who holds a slug, if anyone. */
export async function slugOwner(slug: string): Promise<string | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.slug(slug) }));
  return r.Item?.tenantId as string | undefined;
}

export const UPLOADS_PER_DAY = 100;

/** Count one image upload against today's allowance; RATE_LIMITED once it is used up. */
export async function bumpUploadQuota(t: string, now = new Date()): Promise<void> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: env.table(),
      Key: keys.uploadQuota(t, now.toISOString().slice(0, 10)),
      UpdateExpression: 'ADD n :one SET #type = :type, #ttl = :ttl',
      ConditionExpression: 'attribute_not_exists(n) OR n < :max',
      ExpressionAttributeNames: { '#type': 'type', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':max': UPLOADS_PER_DAY, ':type': 'UploadQuota', ':ttl': Math.floor(now.getTime() / 1000) + 2 * 86400 },
    }));
  } catch (e) {
    if (isConditionFailure(e)) throw new ApiError('RATE_LIMITED', `Up to ${UPLOADS_PER_DAY} image uploads a day; try again tomorrow`, 3600);
    throw e;
  }
}

/** Shared with the controller, which rebuilds shop.json when a drop opens or closes. */
export { listDrops } from '@dropdeck/shared/ddb';

export async function getDrop(t: string, d: string): Promise<Drop> {
  const r = await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.drop(t, d) }));
  const drop = strip<Drop>(r.Item);
  if (!drop) throw new ApiError('NOT_FOUND', 'Drop not found');
  return drop;
}

export async function createDrop(drop: Drop): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: env.table(),
    Item: { ...keys.drop(drop.tenantId, drop.dropId), type: 'Drop', ...drop },
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
}

/** Optimistic update: fails if someone else changed the drop since `expectedVersion`. */
export async function saveDrop(drop: Drop, expectedVersion: number): Promise<Drop> {
  const next = { ...drop, version: expectedVersion + 1, updatedAt: new Date().toISOString() };
  try {
    await ddb.send(new PutCommand({
      TableName: env.table(),
      Item: { ...keys.drop(drop.tenantId, drop.dropId), type: 'Drop', ...next },
      ConditionExpression: 'version = :v',
      ExpressionAttributeValues: { ':v': expectedVersion },
    }));
  } catch (e) {
    if (isConditionFailure(e)) throw new ApiError('INVALID_STATE', 'Drop changed since it was read; reload and retry');
    throw e;
  }
  return next;
}

export async function transition(drop: Drop, to: DropState): Promise<Drop> {
  try {
    const r = await ddb.send(new UpdateCommand({
      TableName: env.table(),
      Key: keys.drop(drop.tenantId, drop.dropId),
      UpdateExpression: 'SET #s = :to, version = version + :one, updatedAt = :now',
      ConditionExpression: '#s = :from',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: { ':to': to, ':from': drop.state, ':one': 1, ':now': new Date().toISOString() },
      ReturnValues: 'ALL_NEW',
    }));
    return strip<Drop>(r.Attributes)!;
  } catch (e) {
    if (isConditionFailure(e)) throw new ApiError('INVALID_STATE', `Drop is no longer ${drop.state}`);
    throw e;
  }
}

export async function deleteDraft(t: string, d: string): Promise<void> {
  try {
    await ddb.send(new DeleteCommand({
      TableName: env.table(),
      Key: keys.drop(t, d),
      ConditionExpression: '#s = :draft',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: { ':draft': 'Draft' },
    }));
  } catch (e) {
    if (isConditionFailure(e)) throw new ApiError('INVALID_STATE', 'Only drafts can be deleted');
    throw e;
  }
}

/** (Re)create stock shards for every variant. Safe to repeat before the drop opens. */
export async function writeStockShards(drop: Drop): Promise<void> {
  const items = drop.variants.flatMap((v) =>
    shardCapacities(v.stock, drop.shardCount).map((capacity, shard) => ({
      PutRequest: { Item: { ...keys.stockShard(drop.tenantId, drop.dropId, v.id, shard), type: 'Stock', capacity, sold: 0 } },
    })),
  );
  for (let i = 0; i < items.length; i += 25) {
    let batch: Record<string, unknown>[] | undefined = items.slice(i, i + 25);
    for (let attempt = 0; batch && batch.length && attempt < 5; attempt++) {
      const r = await ddb.send(new BatchWriteCommand({ RequestItems: { [env.table()]: batch as never } }));
      batch = r.UnprocessedItems?.[env.table()] as Record<string, unknown>[] | undefined;
      if (batch?.length) await new Promise((res) => setTimeout(res, 50 * 2 ** attempt));
    }
    if (batch?.length) throw new Error('Could not write all stock shards');
  }
}

export async function listOrders(t: string, d: string): Promise<Order[]> {
  const k = keys.orderPrefix(t, d);
  const out: Order[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: env.table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': k.PK, ':sk': k.SKPrefix },
      ExclusiveStartKey: start,
    }));
    out.push(...(r.Items ?? []).map((i) => strip<Order>(i)!));
    start = r.LastEvaluatedKey;
  } while (start);
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Merchant reconciliation: confirmed (awaiting payment), paid, or no-show. */
export async function setOrderStatus(t: string, d: string, ref: string, status: OrderStatus): Promise<Order> {
  try {
    const r = await ddb.send(new UpdateCommand({
      TableName: env.table(),
      Key: keys.order(t, d, ref),
      UpdateExpression: 'SET #s = :s, statusUpdatedAt = :now',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status, ':now': new Date().toISOString() },
      ReturnValues: 'ALL_NEW',
    }));
    return strip<Order>(r.Attributes)!;
  } catch (e) {
    if (isConditionFailure(e)) throw new ApiError('NOT_FOUND', 'Order not found');
    throw e;
  }
}

/** Queue size: the frozen early group, and the late ticket counter (block-allocated, so an upper bound). */
export async function queueCounts(drop: Drop): Promise<{ earlyCount: number | null; lateTickets: number }> {
  const r = await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.ticketCounter(drop.tenantId, drop.dropId) }));
  return { earlyCount: drop.earlyCount ?? null, lateTickets: Number(r.Item?.v ?? 0) };
}
