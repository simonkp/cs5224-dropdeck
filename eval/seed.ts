/**
 * Clear a stage and/or load it with demo data, instead of clicking through the console.
 *
 *   AWS_PROFILE=dropdeck-uni AWS_REGION=ap-southeast-1 pnpm seed -- --stage dev-simon --owner you@example.com --clear
 *
 *   --stage <name>     required, e.g. dev-simon
 *   --owner <email>    a console user (sign up at <site>/m/ first); the demo shop and drops become theirs.
 *                      Without it the data goes to a synthetic tenant that no console user can see.
 *   --clear            wipe the stage's table, the published d/ objects and the stage's schedules first
 *   --no-load          clear only
 *   --opens-in <min>   when the scheduled demo drop's queue opens (default 10, minimum 4)
 *   --force            allow --clear on a stage that is not dev-*
 *
 * Loads one shop with: a draft; a drop scheduled through the real merchant Lambda (so EventBridge opens it);
 * a Live drop with orders that the controller is started on; a closed drop with paid, unpaid and no-show
 * orders; and a cancelled drop. Buyer emails are @example.com.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteScheduleCommand, ListSchedulesCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { BatchWriteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  keys, s3Keys, shardCapacities, toPublicDrop, type Drop, type DropState, type MerchantProfile, type Order, type OrderStatus,
  type PublicState, type Variant,
} from '@dropdeck/shared';

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    stage: { type: 'string' },
    owner: { type: 'string' },
    clear: { type: 'boolean', default: false },
    'no-load': { type: 'boolean', default: false },
    'opens-in': { type: 'string', default: '10' },
    force: { type: 'boolean', default: false },
  },
});
const stage = args.stage;
if (!stage) throw new Error('--stage is required (e.g. dev-simon)');
if (args.clear && !stage.startsWith('dev') && !args.force) {
  throw new Error(`Refusing to clear "${stage}": only dev-* stages are cleared without --force`);
}
const opensInMin = Math.max(4, Number(args['opens-in']));

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});
const lambda = new LambdaClient({});
const scheduler = new SchedulerClient({});
const MIN = 60_000;

async function stack() {
  const cf = new CloudFormationClient({});
  const name = `DropDeck-${stage}`;
  const out = Object.fromEntries(((await cf.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0]?.Outputs ?? [])
    .map((o) => [o.OutputKey!, o.OutputValue!]));
  const resources: Array<{ ResourceType?: string; LogicalResourceId?: string; PhysicalResourceId?: string }> = [];
  let next: string | undefined;
  do {
    const r = await cf.send(new ListStackResourcesCommand({ StackName: name, NextToken: next }));
    resources.push(...(r.StackResourceSummaries ?? []));
    next = r.NextToken;
  } while (next);
  const fn = (prefix: string) => resources.find((r) => r.ResourceType === 'AWS::Lambda::Function' && r.LogicalResourceId?.startsWith(prefix))!.PhysicalResourceId!;
  return {
    site: out.SiteUrl!, table: out.TableName!, bucket: out.BucketName!, userPoolId: out.UserPoolId!,
    merchantFn: fn('MerchantApi'), controllerFn: fn('Controller'), group: `dropdeck-${stage}`,
  };
}
type Stack = Awaited<ReturnType<typeof stack>>;

// ---------------------------------------------------------------- clear

async function clear(st: Stack) {
  let deleted = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(new ScanCommand({ TableName: st.table, ProjectionExpression: 'PK, SK', ExclusiveStartKey: start }));
    const items = page.Items ?? [];
    for (let i = 0; i < items.length; i += 25) {
      let batch: Record<string, unknown>[] | undefined = items.slice(i, i + 25).map((k) => ({ DeleteRequest: { Key: { PK: k.PK, SK: k.SK } } }));
      for (let attempt = 0; batch?.length && attempt < 6; attempt++) {
        const r = await doc.send(new BatchWriteCommand({ RequestItems: { [st.table]: batch as never } }));
        batch = r.UnprocessedItems?.[st.table] as Record<string, unknown>[] | undefined;
        if (batch?.length) await new Promise((res) => setTimeout(res, 100 * 2 ** attempt));
      }
    }
    deleted += items.length;
    start = page.LastEvaluatedKey;
  } while (start);

  let objects = 0;
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: st.bucket, Prefix: 'd/', ContinuationToken: token }));
    const keysToDelete = (r.Contents ?? []).map((o) => ({ Key: o.Key! }));
    // Keep the page itself (d/index.html and the export's d/ files); only per-drop folders are data.
    const data = keysToDelete.filter((k) => /^d\/[^/]+\/[^/]+\/(drop|state)\.json$/.test(k.Key));
    if (data.length) await s3.send(new DeleteObjectsCommand({ Bucket: st.bucket, Delete: { Objects: data } }));
    objects += data.length;
    token = r.NextContinuationToken;
  } while (token);

  let schedules = 0;
  let next: string | undefined;
  do {
    const r = await scheduler.send(new ListSchedulesCommand({ GroupName: st.group, NextToken: next }));
    for (const s of r.Schedules ?? []) {
      await scheduler.send(new DeleteScheduleCommand({ Name: s.Name!, GroupName: st.group }));
      schedules++;
    }
    next = r.NextToken;
  } while (next);
  console.log(`cleared ${stage}: ${deleted} items, ${objects} published files, ${schedules} schedules`);
}

// ---------------------------------------------------------------- load

const REF = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ref = () => Array.from({ length: 8 }, () => REF[randomInt(REF.length)]).join('');
const id = () => randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').toLowerCase();
const BUYERS = [
  'Aisha Rahman', 'Benjamin Tan', 'Chloe Lim', 'Darren Ng', 'Elaine Goh', 'Farhan Ismail', 'Grace Chua', 'Hui Min Lee',
  'Imran Kumar', 'Jasmine Ong', 'Kelvin Teo', 'Li Wei', 'Mei Ling Koh', 'Nurul Aziz', 'Oliver Wong', 'Priya Nair',
  'Qi Hao Chen', 'Rachel Yeo', 'Siti Hassan', 'Terence Low', 'Uma Pillai', 'Vincent Sim', 'Wen Jun Ho', 'Xin Yi Tay',
];

async function put(st: Stack, item: Record<string, unknown>) {
  await doc.send(new PutCommand({ TableName: st.table, Item: item }));
}

async function publish(st: Stack, drop: Drop, profile: MerchantProfile, state?: DropState, soldOut: Record<string, boolean> = {}) {
  await s3.send(new PutObjectCommand({
    Bucket: st.bucket, Key: s3Keys.dropJson(drop.tenantId, drop.dropId), Body: JSON.stringify(toPublicDrop(drop, profile)),
    ContentType: 'application/json', CacheControl: 'public, max-age=30',
  }));
  if (!state) return;
  const s: PublicState = { state, serverTime: new Date().toISOString(), rThreshold: 0, nWatermark: 0, earlyCount: drop.earlyCount ?? null, soldOut };
  await s3.send(new PutObjectCommand({
    Bucket: st.bucket, Key: s3Keys.stateJson(drop.tenantId, drop.dropId), Body: JSON.stringify(s),
    ContentType: 'application/json', CacheControl: 'public, max-age=2',
  }));
}

function baseDrop(tenantId: string, over: Partial<Drop> & Pick<Drop, 'title' | 'variants' | 'openAt' | 'endAt' | 'state'>): Drop {
  const now = new Date().toISOString();
  return {
    tenantId, dropId: id(), description: '', entryWindowMin: 15, graceSec: 30, perBuyerLimit: 2, holdSec: 300,
    admitWindowSec: 120, ratePreset: 'normal', verification: 'off', shardCount: 4, createdAt: now, updatedAt: now, version: 2,
    ...over,
  };
}

/** Writes the drop with stock shards and orders whose units are drawn from those shards. */
async function dropWithOrders(st: Stack, drop: Drop, orders: Array<{ variant: Variant; qty: number; status: OrderStatus }>) {
  const caps = Object.fromEntries(drop.variants.map((v) => [v.id, shardCapacities(v.stock, drop.shardCount)]));
  const sold = Object.fromEntries(drop.variants.map((v) => [v.id, Array<number>(drop.shardCount).fill(0)]));
  const placed: Order[] = [];
  orders.forEach((o, i) => {
    const shard = sold[o.variant.id]!.findIndex((n, s) => n + o.qty <= caps[o.variant.id]![s]!);
    if (shard < 0) return; // more orders than stock: skip rather than oversell the demo
    sold[o.variant.id]![shard]! += o.qty;
    const name = BUYERS[i % BUYERS.length]!;
    placed.push({
      tenantId: drop.tenantId, dropId: drop.dropId, ref: ref(), holdId: `n${i}`, variantId: o.variant.id, variantName: o.variant.name,
      qty: o.qty, unitPriceCents: o.variant.priceCents, amountCents: o.variant.priceCents * o.qty,
      name, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`, status: o.status,
      createdAt: new Date(Date.parse(drop.openAt) + (i + 1) * 20_000).toISOString(),
    });
  });
  await put(st, { ...keys.drop(drop.tenantId, drop.dropId), type: 'Drop', ...drop });
  for (const v of drop.variants) {
    for (let s = 0; s < drop.shardCount; s++) {
      await put(st, { ...keys.stockShard(drop.tenantId, drop.dropId, v.id, s), type: 'Stock', capacity: caps[v.id]![s], sold: sold[v.id]![s] });
    }
  }
  for (const o of placed) await put(st, { ...keys.order(drop.tenantId, drop.dropId, o.ref), type: 'Order', ...o });
  const soldOut = Object.fromEntries(drop.variants.map((v) => [v.id, sold[v.id]!.reduce((a, b) => a + b, 0) >= v.stock]));
  return { orders: placed.length, soldOut };
}

const statusMix = (i: number, closed: boolean): OrderStatus => (!closed ? (i % 3 === 0 ? 'paid' : 'confirmed') : i % 7 === 6 ? 'no-show' : i % 5 === 4 ? 'confirmed' : 'paid');

async function merchantInvoke<T>(st: Stack, tenant: string, routeKey: string, body?: unknown, dropId?: string): Promise<T> {
  const event = {
    routeKey, pathParameters: dropId ? { dropId } : {}, body: body === undefined ? undefined : JSON.stringify(body), isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims: { sub: tenant }, scopes: [] } } },
  };
  const r = await lambda.send(new InvokeCommand({ FunctionName: st.merchantFn, Payload: Buffer.from(JSON.stringify(event)) }));
  const res = JSON.parse(Buffer.from(r.Payload!).toString()) as { statusCode: number; body: string };
  if (res.statusCode >= 300) throw new Error(`${routeKey} → ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body) as T;
}

async function load(st: Stack, tenant: string) {
  const now = Date.now();
  const profile: MerchantProfile = {
    tenantId: tenant, name: 'Tiong Bahru Sourdough Co.', slug: 'tb-sourdough', colour: '#b5651d', paynow: '+65 9123 4567',
    fulfilmentNote: 'Self-collect at 55 Tiong Bahru Rd, Saturday 2–5pm. Bring your order reference.', tier: 'starter',
  };
  await put(st, { ...keys.profile(tenant), type: 'Profile', ...profile });

  const loaf = (stock: number): Variant => ({ id: 'v1', name: 'Country loaf', stock, priceCents: 900 });
  const rye = (stock: number): Variant => ({ id: 'v2', name: 'Seeded rye', stock, priceCents: 1100 });
  const urls: string[] = [];

  // Draft
  const draft = baseDrop(tenant, {
    title: 'Christmas stollen (draft)', description: 'Butter stollen with marzipan; 30 only.', state: 'Draft', version: 1,
    variants: [{ id: 'v1', name: 'Stollen', stock: 30, priceCents: 2800 }],
    openAt: new Date(now + 7 * 24 * 60 * MIN).toISOString(), endAt: new Date(now + 7 * 24 * 60 * MIN + 60 * MIN).toISOString(),
  });
  await put(st, { ...keys.drop(tenant, draft.dropId), type: 'Drop', ...draft });

  // Scheduled, through the real API so EventBridge opens it
  const openAt = new Date(now + (opensInMin + 5) * MIN);
  const created = await merchantInvoke<Drop>(st, tenant, 'POST /m/drops', {
    title: 'Saturday sourdough', description: 'Naturally leavened, baked Saturday morning. Limit 2 per buyer.',
    variants: [{ name: 'Country loaf', stock: 40, priceCents: 900 }, { name: 'Seeded rye', stock: 20, priceCents: 1100 }],
    openAt: openAt.toISOString(), endAt: new Date(openAt.getTime() + 30 * MIN).toISOString(),
    entryWindowMin: 5, verification: 'off', holdSec: 300,
  });
  await merchantInvoke<Drop>(st, tenant, 'POST /m/drops/{dropId}/schedule', undefined, created.dropId);
  urls.push(`scheduled (queue opens in ${opensInMin} min): ${st.site}/d/${tenant}/${created.dropId}/`);

  // Live now, 14 orders in; the controller is started on it and keeps ticking every minute
  const live = baseDrop(tenant, {
    title: 'Midweek baguettes', description: 'Classic baguettes, 2 per buyer.', state: 'Live', version: 3,
    variants: [{ id: 'v1', name: 'Baguette', stock: 50, priceCents: 450 }, { id: 'v2', name: 'Demi-baguette', stock: 30, priceCents: 300 }],
    openAt: new Date(now - 3 * MIN).toISOString(), endAt: new Date(now + 45 * MIN).toISOString(), earlyCount: 40, ratePreset: 'fast',
  });
  const liveOrders = await dropWithOrders(st, live, Array.from({ length: 14 }, (_, i) => ({
    variant: live.variants[i % 3 === 2 ? 1 : 0]!, qty: 1 + (i % 2), status: statusMix(i, false),
  })));
  await put(st, { ...keys.ticketCounter(tenant, live.dropId), v: 60 });
  await publish(st, live, profile, 'Live', liveOrders.soldOut);
  await lambda.send(new InvokeCommand({
    FunctionName: st.controllerFn, InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ action: 'open', tenantId: tenant, dropId: live.dropId })),
  }));
  urls.push(`live (${liveOrders.orders} orders): ${st.site}/d/${tenant}/${live.dropId}/`);

  // Closed last Saturday, sold out, with paid / unpaid / no-show orders for reconciliation and export
  const lastSat = new Date(now - ((new Date(now).getDay() + 1) % 7 || 7) * 24 * 60 * MIN);
  lastSat.setUTCHours(1, 0, 0, 0);
  const closed = baseDrop(tenant, {
    title: 'Saturday sourdough (last week)', state: 'Closed', version: 4,
    variants: [loaf(24), rye(12)], openAt: lastSat.toISOString(), endAt: new Date(lastSat.getTime() + 30 * MIN).toISOString(), earlyCount: 210,
  });
  const closedOrders = await dropWithOrders(st, closed, Array.from({ length: 22 }, (_, i) => ({
    variant: closed.variants[i % 3 === 2 ? 1 : 0]!, qty: i % 4 === 0 ? 1 : 2, status: statusMix(i, true),
  })));
  await publish(st, closed, profile, 'Closed', closedOrders.soldOut);
  urls.push(`closed (${closedOrders.orders} orders): ${st.site}/d/${tenant}/${closed.dropId}/`);

  // Cancelled
  const cancelled = baseDrop(tenant, {
    title: 'Croissant Friday (oven repair)', state: 'Cancelled', version: 3,
    variants: [{ id: 'v1', name: 'Butter croissant', stock: 60, priceCents: 380 }],
    openAt: new Date(now - 2 * 24 * 60 * MIN).toISOString(), endAt: new Date(now - 2 * 24 * 60 * MIN + 30 * MIN).toISOString(),
  });
  await put(st, { ...keys.drop(tenant, cancelled.dropId), type: 'Drop', ...cancelled });
  await publish(st, cancelled, profile, 'Cancelled');
  urls.push(`cancelled: ${st.site}/d/${tenant}/${cancelled.dropId}/`);

  console.log(`loaded shop "${profile.name}" with 5 drops for tenant ${tenant}`);
  console.log(`console: ${st.site}/m/`);
  for (const u of urls) console.log(`  ${u}`);
}

async function ownerTenant(st: Stack): Promise<string> {
  if (!args.owner) {
    console.log('no --owner: loading into tenant "seed-demo" (pages work; no console user sees it)');
    return 'seed-demo';
  }
  const r = await new CognitoIdentityProviderClient({}).send(new ListUsersCommand({
    UserPoolId: st.userPoolId, Filter: `email = "${args.owner.replace(/"/g, '')}"`, Limit: 1,
  }));
  const sub = r.Users?.[0]?.Attributes?.find((a) => a.Name === 'sub')?.Value;
  if (!sub) throw new Error(`No console user with email ${args.owner} in ${stage}; sign up at ${st.site}/m/ first`);
  return sub;
}

const st = await stack();
if (args.clear) await clear(st);
if (!args['no-load']) await load(st, await ownerTenant(st));
