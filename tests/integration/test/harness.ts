import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { keys, shardCapacities, type Drop } from '@dropdeck/shared';

export const enabled = Boolean(process.env.DYNAMODB_LOCAL);

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

/** Same shape as the CDK table: PK/SK plus the sparse GSI1. */
export async function createTable(): Promise<string> {
  const name = `it-${randomUUID().slice(0, 8)}`;
  await doc.send(new CreateTableCommand({
    TableName: name,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: ['PK', 'SK', 'GSI1PK', 'GSI1SK'].map((n) => ({ AttributeName: n, AttributeType: 'S' })),
    KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    GlobalSecondaryIndexes: [{
      IndexName: 'GSI1',
      KeySchema: [{ AttributeName: 'GSI1PK', KeyType: 'HASH' }, { AttributeName: 'GSI1SK', KeyType: 'RANGE' }],
      Projection: { ProjectionType: 'ALL' },
    }],
  }));
  process.env.TABLE_NAME = name;
  return name;
}

const min = 60_000;

/**
 * A Live drop whose admission started `startedMinAgo` minutes ago, with a frozen (empty) early group, so late
 * ticket n is admitted at start + n / rate and every ticket inside the window can claim straight away.
 */
export async function liveDrop(over: Partial<Drop> & { startedMinAgo?: number } = {}): Promise<Drop> {
  const { startedMinAgo = 8, ...rest } = over;
  const graceSec = 30;
  const openAt = new Date(Date.now() - startedMinAgo * min - graceSec * 1000).toISOString();
  const drop: Drop = {
    tenantId: `t-${randomUUID().slice(0, 6)}`,
    dropId: `d-${randomUUID().slice(0, 6)}`,
    state: 'Live',
    title: 'Integration drop',
    description: '',
    variants: [{ id: 'v1', name: 'Loaf', stock: 20, priceCents: 800 }],
    openAt,
    endAt: new Date(Date.parse(openAt) + 60 * min).toISOString(),
    entryWindowMin: 15,
    graceSec,
    perBuyerLimit: 2,
    holdSec: 300,
    admitWindowSec: 600,
    ratePreset: 'fast',
    verification: 'off',
    shardCount: 4,
    earlyCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    ...rest,
  };
  await doc.send(new PutCommand({ TableName: process.env.TABLE_NAME, Item: { ...keys.drop(drop.tenantId, drop.dropId), type: 'Drop', ...drop } }));
  const shards = drop.variants.flatMap((v) => shardCapacities(v.stock, drop.shardCount).map((capacity, shard) => ({
    PutRequest: { Item: { ...keys.stockShard(drop.tenantId, drop.dropId, v.id, shard), type: 'Stock', capacity, sold: 0 } },
  })));
  for (let i = 0; i < shards.length; i += 25) {
    await doc.send(new BatchWriteCommand({ RequestItems: { [process.env.TABLE_NAME!]: shards.slice(i, i + 25) } }));
  }
  return drop;
}

export async function shardSold(drop: Drop, variantId = 'v1'): Promise<Array<{ sold: number; capacity: number }>> {
  const r = await doc.send(new ScanCommand({
    TableName: process.env.TABLE_NAME,
    FilterExpression: 'begins_with(PK, :p)',
    ExpressionAttributeValues: { ':p': `S#${drop.tenantId}#${drop.dropId}#${variantId}#` },
    ConsistentRead: true,
  }));
  return (r.Items ?? []).map((i) => ({ sold: Number(i.sold), capacity: Number(i.capacity) }));
}

export async function activeHolds(drop: Drop): Promise<number> {
  const r = await doc.send(new QueryCommand({
    TableName: process.env.TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': keys.holdIndex(drop.tenantId, drop.dropId) },
  }));
  return r.Count ?? 0;
}

export const http = {
  ticket: (drop: Drop) => ({ pathParameters: { tenantId: drop.tenantId, dropId: drop.dropId } }) as never,
  claim: (drop: Drop, ticket: string, variantId = 'v1', qty = 1) =>
    ({ pathParameters: { tenantId: drop.tenantId, dropId: drop.dropId }, body: JSON.stringify({ ticket, variantId, qty }) }) as never,
  checkout: (route: 'GET' | 'confirm', holdId: string, token: string, body?: unknown) => ({
    routeKey: route === 'GET' ? 'GET /api/holds/{holdId}' : 'POST /api/holds/{holdId}/confirm',
    pathParameters: { holdId },
    headers: { authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as never,
};

// Response bodies are loosely typed on purpose: tests assert on whichever fields the route returns.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Res = { status: number } & Record<string, any>;
export const parse = (r: { statusCode: number; body: string }): Res => ({ status: r.statusCode, ...(JSON.parse(r.body) as object) });
