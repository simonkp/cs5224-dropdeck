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
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteScheduleCommand, ListSchedulesCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { BatchWriteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { listFeatured, syncFeatured } from '@dropdeck/shared/ddb';
import {
  keys, s3Keys, shardCapacities, toPublicDrop, toPublicFeatured, toPublicShop, type Drop, type DropState, type MerchantProfile, type Order, type OrderStatus,
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
  // Keep the pages themselves (d/index.html, s/index.html and the export's files); only the services' files are data:
  // per-drop JSON, per-shop JSON and uploaded images.
  const dataFiles: Array<[string, RegExp]> = [
    ['d/', /^d\/[^/]+\/[^/]+\/(drop|state)\.json$/],
    ['s/', /^s\/[^/]+\/shop\.json$/],
    ['p/', /^p\/featured\.json$/],
    ['b/', /^b\/[^/]+\/[^/]+$/],
  ];
  for (const [prefix, isData] of dataFiles) {
    let token: string | undefined;
    do {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: st.bucket, Prefix: prefix, ContinuationToken: token }));
      const data = (r.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((k) => isData.test(k.Key));
      if (data.length) await s3.send(new DeleteObjectsCommand({ Bucket: st.bucket, Delete: { Objects: data } }));
      objects += data.length;
      token = r.NextContinuationToken;
    } while (token);
  }

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

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets/seed');

/** Stores a sample picture the way POST /m/uploads does (content-hashed key under b/{tenant}/) and returns its path. */
async function uploadImage(st: Stack, tenant: string, file: string): Promise<string> {
  const bytes = readFileSync(path.join(ASSETS, file));
  const ext = file.endsWith('.png') ? 'png' : 'jpg';
  const key = s3Keys.image(tenant, createHash('sha256').update(bytes).digest('hex').slice(0, 32), ext);
  await s3.send(new PutObjectCommand({
    Bucket: st.bucket, Key: key, Body: bytes, ContentType: ext === 'png' ? 'image/png' : 'image/jpeg',
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return `/${key}`;
}

/** A profile plus the SLUG# item that holds its shop link, as PUT /m/profile would leave them. */
async function putProfile(st: Stack, profile: MerchantProfile) {
  await put(st, { ...keys.slug(profile.slug), type: 'Slug', tenantId: profile.tenantId });
  await put(st, { ...keys.profile(profile.tenantId), type: 'Profile', ...profile, slugClaimed: true });
  await put(st, { ...keys.tenantEntry(profile.tenantId), type: 'Tenant', tenantId: profile.tenantId, name: profile.name, slug: profile.slug, updatedAt: new Date().toISOString() });
}

async function writeShop(st: Stack, profile: MerchantProfile, drops: Drop[]) {
  await s3.send(new PutObjectCommand({
    Bucket: st.bucket, Key: s3Keys.shopJson(profile.slug), ContentType: 'application/json', CacheControl: 'public, max-age=30',
    Body: JSON.stringify(toPublicShop({ ...profile, slugClaimed: true }, drops)),
  }));
}

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
    admitWindowSec: 120, ratePreset: 'normal', verification: 'email', shardCount: 4, createdAt: now, updatedAt: now, version: 2,
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
  const img = (file: string) => uploadImage(st, tenant, file);
  const profile: MerchantProfile = {
    tenantId: tenant, name: 'Tiong Bahru Sourdough Co.', slug: 'tb-sourdough', colour: '#b5651d', theme: 'auto',
    tagline: 'Baked Saturday mornings. Self-collect in Tiong Bahru.', paynow: '+65 9123 4567',
    logoUrl: await img('tb-logo.png'), coverUrl: await img('tb-cover.jpg'),
    fulfilmentNote: 'Self-collect at 55 Tiong Bahru Rd, Saturday 2–5pm. Bring your order reference.', tier: 'growth',
    slugClaimed: true, listed: true,
  };
  await putProfile(st, profile);

  const loaf = (stock: number): Variant => ({ id: 'v1', name: 'Country loaf', stock, priceCents: 900 });
  const rye = (stock: number): Variant => ({ id: 'v2', name: 'Seeded rye', stock, priceCents: 1100 });

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
    imageUrl: await img('tb-sourdough.jpg'),
    variants: [{ name: 'Country loaf', stock: 40, priceCents: 900 }, { name: 'Seeded rye', stock: 20, priceCents: 1100 }],
    openAt: openAt.toISOString(), endAt: new Date(openAt.getTime() + 30 * MIN).toISOString(),
    entryWindowMin: 5, verification: 'email', holdSec: 300,
  });
  const scheduled = await merchantInvoke<Drop>(st, tenant, 'POST /m/drops/{dropId}/schedule', undefined, created.dropId);

  // Live now, 14 orders in; the controller is started on it and keeps ticking every minute
  const live = baseDrop(tenant, {
    title: 'Midweek baguettes', description: 'Classic baguettes, 2 per buyer.', state: 'Live', version: 3,
    imageUrl: await img('tb-baguettes.jpg'),
    variants: [{ id: 'v1', name: 'Baguette', stock: 50, priceCents: 450 }, { id: 'v2', name: 'Demi-baguette', stock: 30, priceCents: 300 }],
    openAt: new Date(now - 3 * MIN).toISOString(), endAt: new Date(now + 45 * MIN).toISOString(), earlyCount: 40, ratePreset: 'fast', verification: 'email',
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

  // Closed last Saturday, sold out, with paid / unpaid / no-show orders for reconciliation and export
  const lastSat = new Date(now - ((new Date(now).getDay() + 1) % 7 || 7) * 24 * 60 * MIN);
  lastSat.setUTCHours(1, 0, 0, 0);
  const closed = baseDrop(tenant, {
    title: 'Saturday sourdough (last week)', state: 'Closed', version: 4, imageUrl: await img('tb-baguettes-paper.jpg'),
    variants: [loaf(24), rye(12)], openAt: lastSat.toISOString(), endAt: new Date(lastSat.getTime() + 30 * MIN).toISOString(), earlyCount: 210,
  });
  const closedOrders = await dropWithOrders(st, closed, Array.from({ length: 22 }, (_, i) => ({
    variant: closed.variants[i % 3 === 2 ? 1 : 0]!, qty: i % 4 === 0 ? 1 : 2, status: statusMix(i, true),
  })));
  await publish(st, closed, profile, 'Closed', closedOrders.soldOut);

  // Cancelled
  const cancelled = baseDrop(tenant, {
    title: 'Croissant Friday (oven repair)', state: 'Cancelled', version: 3, imageUrl: await img('tb-croissants.jpg'),
    variants: [{ id: 'v1', name: 'Butter croissant', stock: 60, priceCents: 380 }],
    openAt: new Date(now - 2 * 24 * 60 * MIN).toISOString(), endAt: new Date(now - 2 * 24 * 60 * MIN + 30 * MIN).toISOString(),
  });
  await put(st, { ...keys.drop(tenant, cancelled.dropId), type: 'Drop', ...cancelled });
  await publish(st, cancelled, profile, 'Cancelled');

  // The API wrote shop.json when the Scheduled drop was made; the seeded Live and Closed drops came in behind its back.
  await writeShop(st, profile, [draft, scheduled, live, closed, cancelled]);

  // Two more shops, public pages only (no console user owns them), to show other brands and themes side by side.
  const showcase: string[] = [];
  for (const shop of SHOWCASE) showcase.push(...(await loadShowcase(st, shop)));

  // The demo shops opted in to DropDeck's homepage: list their drops there.
  await syncFeatured(profile, [draft, scheduled, live, closed, cancelled]);
  await s3.send(new PutObjectCommand({
    Bucket: st.bucket, Key: s3Keys.featuredJson(), ContentType: 'application/json', CacheControl: 'public, max-age=60',
    Body: JSON.stringify(toPublicFeatured(await listFeatured())),
  }));

  const line = (label: string, url: string) => console.log(`  ${label.padEnd(30)} ${url}`);
  console.log(`\nDemo links for ${stage} (these stay the same across reseeds)\n`);
  console.log('DropDeck');
  line(`merchant console${args.owner ? ` (sign in as ${args.owner})` : ''}`, `${st.site}/m/`);
  line('operators (ops page)', `${st.site}/ops/`);
  line('DropDeck homepage', `${st.site}/`);
  console.log('\nShop pages (each lists its drops: live, coming up, past)');
  line(`${profile.name} (${profile.theme}, your shop)`, `${st.site}/s/${profile.slug}/`);
  for (const s of showcase.filter((x) => x.startsWith('shop|'))) line(s.split('|')[1]!, s.split('|')[2]!);
  console.log(`\nOn ${profile.name}'s page, "${live.title}" is live now and "${scheduled.title}" opens its queue ${opensInMin} min from now (--opens-in to change).`);
  console.log(`Email codes show on screen while the stage is in log mode. The ops page needs an operator: pnpm ops -- ${stage} make-operator <email>`);
}

interface Showcase {
  tenant: string;
  tier: MerchantProfile['tier'];
  profile: Omit<MerchantProfile, 'tenantId' | 'tier' | 'logoUrl' | 'coverUrl'>;
  logo: string;
  cover: string;
  next: { title: string; description: string; image: string; variants: Array<{ name: string; stock: number; priceCents: number }>; inDays: number };
  past: { title: string; image: string; variant: Variant; daysAgo: number };
}

const SHOWCASE: Showcase[] = [
  {
    tenant: 'seed-kopi-lab',
    tier: 'growth',
    profile: {
      name: 'Kopi Lab', slug: 'kopi-lab', colour: '#0f766e', theme: 'dark', tagline: 'Small-batch roasts from Joo Chiat.',
      paynow: '+65 8123 4567', fulfilmentNote: 'Collect at 212 Joo Chiat Rd, Thursday 8am to 6pm.',
    },
    logo: 'kopi-logo.png', cover: 'kopi-cover.jpg',
    next: {
      title: 'Geisha micro-lot', description: 'Only 60 bags of this Panama Geisha. 200 g, whole bean, roasted Thursday.', image: 'kopi-beans.jpg',
      variants: [{ name: 'Whole bean 200 g', stock: 40, priceCents: 3800 }, { name: 'Filter grind 200 g', stock: 20, priceCents: 3800 }], inDays: 2,
    },
    past: { title: 'Holiday blend', image: 'kopi-latte.jpg', variant: { id: 'v1', name: 'Holiday blend 250 g', stock: 80, priceCents: 2400 }, daysAgo: 9 },
  },
  {
    tenant: 'seed-hue-ceramics',
    tier: 'starter',
    profile: {
      name: 'Hue Ceramics', slug: 'hue-ceramics', colour: '#f2c94c', theme: 'light', tagline: 'Wheel-thrown in Jalan Besar.',
      paynow: '201912345A', fulfilmentNote: 'Delivered within 7 days, or collect from the studio on Saturdays.',
    },
    logo: 'hue-logo.png', cover: 'hue-cover.jpg',
    next: {
      title: 'Speckled mug restock', description: 'Forty mugs from the last firing, each one a little different. 350 ml, dishwasher safe.', image: 'hue-mug.jpg',
      variants: [{ name: 'Oat speckle', stock: 20, priceCents: 4200 }, { name: 'Ink speckle', stock: 20, priceCents: 4200 }], inDays: 3,
    },
    past: { title: 'Bud vase trio', image: 'hue-cover.jpg', variant: { id: 'v1', name: 'Set of three', stock: 25, priceCents: 6800 }, daysAgo: 14 },
  },
];

/** Returns `shop|label|url` lines for the summary. */
async function loadShowcase(st: Stack, shop: Showcase): Promise<string[]> {
  const t = shop.tenant;
  const profile: MerchantProfile = {
    ...shop.profile, tenantId: t, tier: shop.tier, slugClaimed: true, listed: true,
    logoUrl: await uploadImage(st, t, shop.logo), coverUrl: await uploadImage(st, t, shop.cover),
  };
  await putProfile(st, profile);

  const openAt = new Date(Date.now() + shop.next.inDays * 24 * 60 * MIN);
  openAt.setUTCHours(2, 0, 0, 0); // 10:00 in Singapore
  const created = await merchantInvoke<Drop>(st, t, 'POST /m/drops', {
    title: shop.next.title, description: shop.next.description, imageUrl: await uploadImage(st, t, shop.next.image),
    variants: shop.next.variants, openAt: openAt.toISOString(), endAt: new Date(openAt.getTime() + 60 * MIN).toISOString(),
    verification: 'email',
  });
  const scheduled = await merchantInvoke<Drop>(st, t, 'POST /m/drops/{dropId}/schedule', undefined, created.dropId);

  const pastOpen = new Date(Date.now() - shop.past.daysAgo * 24 * 60 * MIN);
  pastOpen.setUTCHours(2, 0, 0, 0);
  const past = baseDrop(t, {
    title: shop.past.title, state: 'Closed', version: 4, imageUrl: await uploadImage(st, t, shop.past.image), variants: [shop.past.variant],
    openAt: pastOpen.toISOString(), endAt: new Date(pastOpen.getTime() + 60 * MIN).toISOString(), earlyCount: 120,
  });
  const pastOrders = await dropWithOrders(st, past, Array.from({ length: 12 }, (_, i) => ({ variant: shop.past.variant, qty: 2, status: statusMix(i, true) })));
  await publish(st, past, profile, 'Closed', pastOrders.soldOut);

  await writeShop(st, profile, [scheduled, past]);
  await syncFeatured(profile, [scheduled, past]);
  return [
    `shop|${profile.name} (${profile.theme})|${st.site}/s/${profile.slug}/`,
  ];
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
process.env.TABLE_NAME = st.table; // for the shared table helpers (homepage list)
if (args.clear) await clear(st);
if (!args['no-load']) await load(st, await ownerTenant(st));
