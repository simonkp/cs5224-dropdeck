import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Drop } from '@dropdeck/shared';

vi.mock('../src/repo.js', () => ({
  getDrop: vi.fn(), getProfile: vi.fn(), transition: vi.fn(), writeStockShards: vi.fn(), saveDrop: vi.fn(),
}));
vi.mock('../src/publish.js', () => ({
  writeDropJson: vi.fn(), deleteDropJson: vi.fn(), writeStateJson: vi.fn(), deleteStateJson: vi.fn(),
  createOpenSchedule: vi.fn(), deleteOpenSchedule: vi.fn(),
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

const call = (routeKey: string, body?: unknown) => handler({
  routeKey,
  pathParameters: { dropId: 'drop1' },
  body: body === undefined ? undefined : JSON.stringify(body),
  isBase64Encoded: false,
  requestContext: { authorizer: { jwt: { claims: { sub: 'tenant-1' }, scopes: [] } } },
} as never);

const bodyOf = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;

beforeEach(() => {
  vi.resetAllMocks();
  repo.transition.mockImplementation(async (d, to) => ({ ...d, state: to, version: d.version + 1 }));
});

describe('POST /schedule', () => {
  it('flips the state first, then publishes drop.json, state.json and the open schedule', async () => {
    repo.getDrop.mockResolvedValue(draft());
    const r = await call('POST /m/drops/{dropId}/schedule');
    expect(r.statusCode).toBe(200);
    expect(repo.transition.mock.invocationCallOrder[0]).toBeLessThan(repo.writeStockShards.mock.invocationCallOrder[0]!);
    expect(pub.writeStateJson).toHaveBeenCalledWith(expect.objectContaining({ state: 'Scheduled' }), 'Scheduled');
    expect(pub.createOpenSchedule).toHaveBeenCalledOnce();
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
  });
});
