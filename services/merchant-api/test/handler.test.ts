import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Drop } from '@dropdeck/shared';

vi.mock('../src/repo.js', () => ({
  getDrop: vi.fn(), getProfile: vi.fn(), transition: vi.fn(), writeStockShards: vi.fn(), saveDrop: vi.fn(),
  listDrops: vi.fn(), saveProfile: vi.fn(), slugOwner: vi.fn(), bumpUploadQuota: vi.fn(), listUsage: vi.fn(),
}));
vi.mock('../src/publish.js', () => ({
  writeDropJson: vi.fn(), deleteDropJson: vi.fn(), writeStateJson: vi.fn(), deleteStateJson: vi.fn(),
  createOpenSchedule: vi.fn(), deleteOpenSchedule: vi.fn(),
  putImage: vi.fn(), writeShopJson: vi.fn(), deleteShopJson: vi.fn(), refreshShop: vi.fn(), republishBranding: vi.fn(),
}));

const repo = vi.mocked(await import('../src/repo.js'));
const pub = vi.mocked(await import('../src/publish.js'));
const { handler } = await import('../src/handler.js');

const inAnHour = (min = 0) => new Date(Date.now() + 60 * 60_000 + min * 60_000).toISOString();

const draft = (): Drop => ({
  tenantId: 'tenant-1', dropId: 'drop1', state: 'Draft', title: 'Sourdough', description: '',
  variants: [{ id: 'v1', name: 'Loaf', stock: 60, priceCents: 800 }],
  openAt: inAnHour(), endAt: inAnHour(30), entryWindowMin: 15, graceSec: 30, perBuyerLimit: 2, holdSec: 300,
  admitWindowSec: 120, ratePreset: 'normal', verification: 'email', shardCount: 4,
  createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z', version: 1,
});

const call = (routeKey: string, body?: unknown, pathParameters: Record<string, string> = { dropId: 'drop1' }) => handler({
  routeKey,
  pathParameters,
  body: body === undefined ? undefined : JSON.stringify(body),
  isBase64Encoded: false,
  requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-1' }, scopes: [] } } },
} as never);

const bodyOf = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;

beforeEach(() => {
  vi.resetAllMocks();
  repo.transition.mockImplementation(async (d, to) => ({ ...d, state: to, version: d.version + 1 }));
  repo.saveProfile.mockImplementation(async (p) => ({ ...p, slugClaimed: true }));
  repo.listDrops.mockResolvedValue([]);
  pub.writeShopJson.mockResolvedValue();
  pub.deleteShopJson.mockResolvedValue();
});

describe('POST /schedule', () => {
  it('flips the state first, then publishes drop.json, state.json and the open schedule', async () => {
    repo.getDrop.mockResolvedValue(draft());
    const r = await call('POST /m/drops/{dropId}/schedule');
    expect(r.statusCode).toBe(200);
    expect(repo.transition.mock.invocationCallOrder[0]).toBeLessThan(repo.writeStockShards.mock.invocationCallOrder[0]!);
    expect(pub.writeStateJson).toHaveBeenCalledWith(expect.objectContaining({ state: 'Scheduled' }), 'Scheduled');
    expect(pub.createOpenSchedule).toHaveBeenCalledOnce();
    expect(pub.refreshShop).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ state: 'Scheduled' }));
  });

  it('rolls back to Draft when a side effect fails', async () => {
    repo.getDrop.mockResolvedValue(draft());
    pub.createOpenSchedule.mockRejectedValue(new Error('scheduler down'));
    const r = await call('POST /m/drops/{dropId}/schedule');
    expect(r.statusCode).toBe(500);
    expect(pub.deleteOpenSchedule).toHaveBeenCalled();
    expect(pub.deleteDropJson).toHaveBeenCalled();
    expect(pub.deleteStateJson).toHaveBeenCalled();
    expect(repo.transition).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'Scheduled' }), 'Draft');
  });

  it('refuses a third drop in a month on the Starter plan, with PLAN_LIMIT', async () => {
    repo.getDrop.mockResolvedValue(draft());
    repo.listDrops.mockResolvedValue([{ ...draft(), dropId: 'a', state: 'Closed' }, { ...draft(), dropId: 'b', state: 'Scheduled' }]);
    const r = await call('POST /m/drops/{dropId}/schedule');
    expect(r.statusCode).toBe(402);
    expect(bodyOf(r).code).toBe('PLAN_LIMIT');
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('lets a Growth shop schedule as many drops as it likes', async () => {
    repo.getDrop.mockResolvedValue(draft());
    repo.getProfile.mockResolvedValue({ tenantId: 'tenant-1', name: 'x', slug: 'x-shop', tier: 'growth' });
    repo.listDrops.mockResolvedValue(['a', 'b', 'c'].map((id) => ({ ...draft(), dropId: id, state: 'Closed' as const })));
    expect((await call('POST /m/drops/{dropId}/schedule')).statusCode).toBe(200);
  });

  it('a request that loses the state flip touches nothing', async () => {
    repo.getDrop.mockResolvedValue(draft());
    repo.transition.mockRejectedValue(new ApiError('INVALID_STATE', 'Drop is no longer Draft'));
    const r = await call('POST /m/drops/{dropId}/schedule');
    expect(r.statusCode).toBe(409);
    expect(repo.writeStockShards).not.toHaveBeenCalled();
    expect(pub.createOpenSchedule).not.toHaveBeenCalled();
    expect(pub.deleteOpenSchedule).not.toHaveBeenCalled();
  });
});

describe('PATCH a scheduled drop', () => {
  beforeEach(() => repo.getDrop.mockResolvedValue({ ...draft(), state: 'Scheduled' }));

  it('rejects changes to times or stock', async () => {
    const r = await call('PATCH /m/drops/{dropId}', { openAt: inAnHour(10) });
    expect(r.statusCode).toBe(409);
    expect(bodyOf(r).code).toBe('LOCKED_FOR_EDIT');
    expect(repo.saveDrop).not.toHaveBeenCalled();
  });

  it('allows text edits and republishes drop.json', async () => {
    repo.saveDrop.mockImplementation(async (d) => d);
    const r = await call('PATCH /m/drops/{dropId}', { title: 'Weekend sourdough' });
    expect(r.statusCode).toBe(200);
    expect(pub.writeDropJson).toHaveBeenCalled();
  });

  it('rejects an end time moved before the open', async () => {
    const r = await call('PATCH /m/drops/{dropId}', { endAt: inAnHour(-5) });
    expect(r.statusCode).toBe(400);
  });
});

describe('POST /cancel', () => {
  it('publishes a Cancelled state and keeps drop.json', async () => {
    repo.getDrop.mockResolvedValue({ ...draft(), state: 'Scheduled' });
    const r = await call('POST /m/drops/{dropId}/cancel');
    expect(r.statusCode).toBe(200);
    expect(pub.writeStateJson).toHaveBeenCalledWith(expect.objectContaining({ state: 'Cancelled' }), 'Cancelled');
    expect(pub.deleteDropJson).not.toHaveBeenCalled();
    expect(pub.refreshShop).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ state: 'Cancelled' }));
  });
});

const IMG = '/b/tenant-1/0123456789abcdef0123456789abcdef.png';
const profile = () => ({
  tenantId: 'tenant-1', name: 'Tiong Bahru Sourdough', slug: 'tb-sourdough', colour: '#b5651d', paynow: '+65 9123 4567',
  tier: 'starter' as const, slugClaimed: true,
});

describe('PUT /m/profile', () => {
  it('merges: fields left out keep their value, null clears one, and the tier is not the merchant\'s to set', async () => {
    repo.getProfile.mockResolvedValue({ ...profile(), logoUrl: IMG });
    const r = await call('PUT /m/profile', { colour: '#0F766E', logoUrl: null, tier: 'event' });
    expect(r.statusCode).toBe(200);
    const saved = repo.saveProfile.mock.calls[0]![0];
    expect(saved).toMatchObject({ name: 'Tiong Bahru Sourdough', paynow: '+65 9123 4567', colour: '#0f766e', tier: 'starter' });
    expect(saved).not.toHaveProperty('logoUrl');
  });

  it('rejects colours, themes, taglines and images that do not fit the rules', async () => {
    repo.getProfile.mockResolvedValue(profile());
    for (const body of [
      { colour: 'red' }, { colour: '#fff' }, { theme: 'neon' }, { tagline: 'x'.repeat(141) },
      { logoUrl: 'https://evil.example/logo.png' }, { logoUrl: '/b/tenant-2/0123456789abcdef0123456789abcdef.png' },
      { slug: 'Has Spaces' }, { slug: 'admin' },
    ]) {
      const r = await call('PUT /m/profile', body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(repo.saveProfile).not.toHaveBeenCalled();
  });

  it('republishes published drop pages and the shop page with the new branding', async () => {
    repo.getProfile.mockResolvedValue(profile());
    const drops = [{ ...draft(), state: 'Scheduled' as const }];
    repo.listDrops.mockResolvedValue(drops);
    await call('PUT /m/profile', { colour: '#e11d48' });
    expect(pub.republishBranding).toHaveBeenCalledWith(expect.objectContaining({ colour: '#e11d48' }), drops);
    expect(pub.writeShopJson).toHaveBeenCalledWith(expect.objectContaining({ colour: '#e11d48' }), drops);
    expect(pub.deleteShopJson).not.toHaveBeenCalled();
  });

  it('takes the old shop page down when the slug moves', async () => {
    repo.getProfile.mockResolvedValue(profile());
    await call('PUT /m/profile', { slug: 'tiong-bahru' });
    expect(repo.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ slug: 'tiong-bahru' }), expect.objectContaining({ slug: 'tb-sourdough' }));
    expect(pub.deleteShopJson).toHaveBeenCalledWith('tb-sourdough');
  });

  it('reports a taken slug as 409 SLUG_TAKEN', async () => {
    repo.getProfile.mockResolvedValue(profile());
    repo.saveProfile.mockRejectedValue(new ApiError('SLUG_TAKEN', 'That shop link is taken; try another'));
    const r = await call('PUT /m/profile', { slug: 'popular' });
    expect(r.statusCode).toBe(409);
    expect(bodyOf(r).code).toBe('SLUG_TAKEN');
  });

  it('creates a first profile with defaults', async () => {
    repo.getProfile.mockResolvedValue(undefined);
    await call('PUT /m/profile', { name: 'Kopi Lab' });
    expect(repo.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ name: 'Kopi Lab', slug: 'tenant-1', theme: 'auto', tier: 'starter' }), undefined);
  });
});

describe('GET /m/slugs/{slug}', () => {
  it('is available when free or already yours, not when someone else holds it', async () => {
    repo.slugOwner.mockResolvedValueOnce(undefined).mockResolvedValueOnce('tenant-1').mockResolvedValueOnce('tenant-2');
    const ask = async (slug: string) => bodyOf(await call('GET /m/slugs/{slug}', undefined, { slug })).available;
    expect(await ask('free-one')).toBe(true);
    expect(await ask('mine')).toBe(true);
    expect(await ask('theirs')).toBe(false);
    expect(await ask('no')).toBe(false); // too short, never looked up
    expect(repo.slugOwner).toHaveBeenCalledTimes(3);
  });
});

describe('POST /m/uploads', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);

  it('stores a PNG under a content hash and returns its path', async () => {
    pub.putImage.mockImplementation(async (t, img) => `/b/${t}/${img.hash}.${img.ext}`);
    const r = await call('POST /m/uploads', { image: `data:image/png;base64,${png.toString('base64')}` });
    expect(r.statusCode).toBe(201);
    expect(bodyOf(r).path).toMatch(/^\/b\/tenant-1\/[a-f0-9]{32}\.png$/);
    expect(repo.bumpUploadQuota).toHaveBeenCalledWith('tenant-1');
  });

  it('refuses SVG and anything that is not PNG, JPEG or WebP, before touching the quota', async () => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(80)}<script>alert(1)</script></svg>`);
    const r = await call('POST /m/uploads', { image: svg.toString('base64') });
    expect(r.statusCode).toBe(400);
    expect(repo.bumpUploadQuota).not.toHaveBeenCalled();
    expect(pub.putImage).not.toHaveBeenCalled();
  });
});
