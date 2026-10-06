import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { keys } from '@dropdeck/shared';
import { createTable, enabled, parse } from './harness.js';

vi.mock('../../../services/merchant-api/src/publish.js', () => ({
  writeDropJson: vi.fn(), deleteDropJson: vi.fn(), writeStateJson: vi.fn(), deleteStateJson: vi.fn(),
  createOpenSchedule: vi.fn(), deleteOpenSchedule: vi.fn(),
  putImage: vi.fn(), writeShopJson: vi.fn(async () => {}), deleteShopJson: vi.fn(async () => {}), refreshShop: vi.fn(),
  republishBranding: vi.fn(),
}));

const { handler: merchant } = await import('../../../services/merchant-api/src/handler.js');
const repo = await import('../../../services/merchant-api/src/repo.js');
const { ddb, table } = await import('@dropdeck/shared/ddb');
const { GetCommand, PutCommand } = await import('@aws-sdk/lib-dynamodb');

const tenant = () => `t-${randomUUID().slice(0, 8)}`;
const slug = (base: string) => `${base}-${randomUUID().slice(0, 6)}`;
const as = (t: string, routeKey: string, body?: unknown) => merchant({
  routeKey, pathParameters: {}, body: body === undefined ? undefined : JSON.stringify(body), isBase64Encoded: false,
  requestContext: { authorizer: { jwt: { claims: { sub: t }, scopes: [] } } },
} as never).then(parse);
const slugItem = (s: string) => ddb.send(new GetCommand({ TableName: table(), Key: keys.slug(s) })).then((r) => r.Item);

describe.skipIf(!enabled)('shop links against DynamoDB Local', () => {
  beforeAll(createTable);

  it('lets one shop hold a link; a second shop asking for it gets SLUG_TAKEN', async () => {
    const s = slug('bakery');
    const [a, b] = [tenant(), tenant()];
    expect((await as(a, 'PUT /m/profile', { name: 'A', slug: s })).status).toBe(200);
    const r = await as(b, 'PUT /m/profile', { name: 'B', slug: s });
    expect(r).toMatchObject({ status: 409, code: 'SLUG_TAKEN' });
    expect((await slugItem(s))?.tenantId).toBe(a);
    // B's profile was not written either: the transaction is all or nothing.
    expect((await as(b, 'GET /m/profile')).status).toBe(200);
    expect((await ddb.send(new GetCommand({ TableName: table(), Key: keys.profile(b) }))).Item).toBeUndefined();
  });

  it('frees the old link when a shop moves, so another shop can take it', async () => {
    const [s1, s2] = [slug('old'), slug('new')];
    const [a, b] = [tenant(), tenant()];
    await as(a, 'PUT /m/profile', { name: 'A', slug: s1 });
    expect((await as(a, 'PUT /m/profile', { slug: s2 })).status).toBe(200);
    expect(await slugItem(s1)).toBeUndefined();
    expect((await as(b, 'PUT /m/profile', { name: 'B', slug: s1 })).status).toBe(200);
  });

  it('claims the link of a profile saved before links were unique, on its next save', async () => {
    const t = tenant();
    const s = slug('legacy');
    await ddb.send(new PutCommand({ TableName: table(), Item: { ...keys.profile(t), type: 'Profile', tenantId: t, name: 'Old', slug: s, tier: 'starter' } }));
    const r = await as(t, 'PUT /m/profile', { tagline: 'Since 2019' });
    expect(r).toMatchObject({ status: 200, slug: s, slugClaimed: true, tagline: 'Since 2019', name: 'Old' });
    expect((await slugItem(s))?.tenantId).toBe(t);
  });

  it('refuses a save based on a stale read of the link, so two racing moves cannot strand a SLUG# item', async () => {
    const t = tenant();
    await as(t, 'PUT /m/profile', { name: 'A', slug: slug('start') });
    const read = (await repo.getProfile(t))!; // both racers read this
    const [left, right] = [slug('left'), slug('right')];
    await repo.saveProfile({ ...read, slug: left }, read);
    await expect(repo.saveProfile({ ...read, slug: right }, read)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await slugItem(right)).toBeUndefined();
    expect((await slugItem(left))?.tenantId).toBe(t);
  });

  it('caps uploads per day', async () => {
    const t = tenant();
    const day = new Date().toISOString().slice(0, 10);
    await ddb.send(new PutCommand({ TableName: table(), Item: { ...keys.uploadQuota(t, day), n: 100 } }));
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
    expect(await as(t, 'POST /m/uploads', { image: png.toString('base64') })).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
  });
});
