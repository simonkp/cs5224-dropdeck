import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keys, usageMonth, type Drop, type PublicState } from '@dropdeck/shared';
import { activeHolds, createTable, enabled, http, liveDrop, parse, shardSold, type Res } from './harness.js';

vi.mock('../../../services/controller/src/publish.js', () => ({ writeState: vi.fn(), writeShopJson: vi.fn(), writeFeaturedJson: vi.fn() }));
vi.mock('../../../services/controller/src/schedule.js', () => ({ upsertTickSchedule: vi.fn(), deleteTickSchedule: vi.fn() }));

const { handler: ticket } = await import('../../../services/ticket/src/handler.js');
const { handler: claim } = await import('../../../services/claim/src/handler.js');
const { handler: checkout } = await import('../../../services/checkout/src/handler.js');
const { tickOnce } = await import('../../../services/controller/src/handler.js');
const publish = vi.mocked(await import('../../../services/controller/src/publish.js'));
const schedule = vi.mocked(await import('../../../services/controller/src/schedule.js'));
const { clearDropCache, ddb, getDrop, getHold, releaseHold, table } = await import('@dropdeck/shared/ddb');
const { GetCommand, UpdateCommand } = await import('@aws-sdk/lib-dynamodb');

const sum = (xs: Array<{ sold: number }>) => xs.reduce((n, x) => n + x.sold, 0);
const lastState = (): PublicState => publish.writeState.mock.lastCall![2];

async function hold(drop: Drop, qty = 1) {
  const tk = parse(await ticket(http.ticket(drop)));
  const c = parse(await claim(http.claim(drop, tk.ticket, 'v1', qty)));
  expect(c.status).toBe(201);
  return c;
}

/** Make a hold look expired, as the clock would: both its expiry and its GSI1 sort key. */
async function expire(drop: Drop, holdId: string, msAgo = 1000) {
  const at = Date.now() - msAgo;
  await ddb.send(new UpdateCommand({
    TableName: table(), Key: keys.hold(drop.tenantId, drop.dropId, holdId),
    UpdateExpression: 'SET expiresAt = :at, GSI1SK = :iso',
    ExpressionAttributeValues: { ':at': at, ':iso': new Date(at).toISOString() },
  }));
}

const setState = (drop: Drop, state: string) => ddb.send(new UpdateCommand({
  TableName: table(), Key: keys.drop(drop.tenantId, drop.dropId),
  UpdateExpression: 'SET #s = :s', ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':s': state },
}));

const confirm = (h: Res, email: string) =>
  checkout(http.checkout('confirm', h.holdId, h.hold, { name: 'Buyer', email })).then(parse);

describe.skipIf(!enabled)('controller tick against DynamoDB Local', () => {
  beforeAll(createTable);
  beforeEach(() => {
    clearDropCache();
    vi.clearAllMocks();
  });

  // DynamoDB Local serialises requests, so these ticks barely overlap; the race itself is proven by the direct
  // concurrent releaseHold test in buyer-path.test.ts and the stale-read test below.
  it('repeated controller ticks return an expired hold’s units once and leave live holds alone', async () => {
    const drop = await liveDrop();
    const stale = await hold(drop, 2);
    const fresh = await hold(drop, 1);
    await expire(drop, stale.holdId);
    await Promise.all(Array.from({ length: 4 }, () => tickOnce(drop.tenantId, drop.dropId, Date.now())));
    expect(sum(await shardSold(drop))).toBe(1);
    expect((await getHold(drop.tenantId, drop.dropId, stale.holdId))!.state).toBe('released');
    expect((await getHold(drop.tenantId, drop.dropId, fresh.holdId))!.state).toBe('active');
  });

  it('a sweep acting on a stale index read cannot release a hold that has not expired', async () => {
    const drop = await liveDrop();
    const h = await hold(drop);
    const item = (await getHold(drop.tenantId, drop.dropId, h.holdId))!;
    expect(await releaseHold(item, { expiredBy: Date.now() })).toBe(false);
    expect(sum(await shardSold(drop))).toBe(1);
    expect(await releaseHold(item, { expiredBy: item.expiresAt })).toBe(true);
    expect(sum(await shardSold(drop))).toBe(0);
  });

  it('never sweeps a confirmed hold, even one past its expiry', async () => {
    const drop = await liveDrop();
    const h = await hold(drop);
    expect((await confirm(h, 'kept@example.com')).status).toBe(200);
    await expire(drop, h.holdId); // the GSI keys are gone once confirmed; this only moves expiresAt
    await tickOnce(drop.tenantId, drop.dropId, Date.now());
    expect(sum(await shardSold(drop))).toBe(1);
    expect((await getHold(drop.tenantId, drop.dropId, h.holdId))!.state).toBe('confirmed');
  });

  it('publishes sold-out flags, and clears them when an expired hold brings stock back', async () => {
    const drop = await liveDrop({ variants: [{ id: 'v1', name: 'Loaf', stock: 2, priceCents: 800 }], shardCount: 2 });
    const a = await hold(drop);
    await hold(drop);
    const soldOut = await tickOnce(drop.tenantId, drop.dropId, Date.now());
    expect(soldOut!.state).toBe('Live'); // holds are still open, so not closed yet
    expect(soldOut!.soldOut).toEqual({ v1: true });

    await expire(drop, a.holdId);
    const back = await tickOnce(drop.tenantId, drop.dropId, Date.now(), soldOut!);
    expect(back!.soldOut).toEqual({ v1: false });
    expect(lastState().soldOut).toEqual({ v1: false });
  });

  it('closes once everything is sold and confirmed', async () => {
    const drop = await liveDrop({ variants: [{ id: 'v1', name: 'Loaf', stock: 2, priceCents: 800 }], shardCount: 2 });
    await confirm(await hold(drop), 'one@example.com');
    await confirm(await hold(drop), 'two@example.com');
    expect(await tickOnce(drop.tenantId, drop.dropId, Date.now())).toBeNull();
    expect((await getDrop(drop.tenantId, drop.dropId)).state).toBe('Closed');
    expect(lastState()).toMatchObject({ state: 'Closed', soldOut: { v1: true } });
    expect(schedule.deleteTickSchedule).toHaveBeenCalled();
  });

  it('adds a finished drop to the shop\'s monthly usage exactly once, however many ticks see it closed', async () => {
    const drop = await liveDrop({ variants: [{ id: 'v1', name: 'Loaf', stock: 3, priceCents: 800 }], shardCount: 1 });
    await confirm(await hold(drop, 2), 'one@example.com');
    await confirm(await hold(drop), 'two@example.com');
    expect(await tickOnce(drop.tenantId, drop.dropId, Date.now())).toBeNull();
    await tickOnce(drop.tenantId, drop.dropId, Date.now()); // later ticks finish the drop again
    await tickOnce(drop.tenantId, drop.dropId, Date.now());
    const month = usageMonth(drop.openAt);
    const u = (await ddb.send(new GetCommand({ TableName: table(), Key: keys.usage(drop.tenantId, month) }))).Item;
    expect(u).toMatchObject({ drops: 1, cancelled: 0, orders: 2, units: 3, revenueCents: 2400, month });
    expect(u!.sessions).toBeGreaterThanOrEqual(2);
    expect((await getDrop(drop.tenantId, drop.dropId)).meteredAt).toBeTruthy();
  });

  it('closes at endAt, and a buyer still holding stock can finish checking out', async () => {
    // Real time, not a faked clock: at endAt the sweep must still leave a hold that has minutes to run.
    const drop = await liveDrop({ endAt: new Date(Date.now() + 1500).toISOString() });
    const h = await hold(drop);
    await new Promise((r) => setTimeout(r, 1600));
    await tickOnce(drop.tenantId, drop.dropId, Date.now());
    expect((await getDrop(drop.tenantId, drop.dropId)).state).toBe('Closed');
    clearDropCache();
    expect((await confirm(h, 'late@example.com')).status).toBe(200);
  });

  it('a cancel voids open holds, republishes Cancelled over a racing Live write, and blocks checkout', async () => {
    const drop = await liveDrop();
    const h = await hold(drop, 2);
    await setState(drop, 'Cancelled'); // the merchant cancels; suppose a tick's Live state.json landed after
    expect(await tickOnce(drop.tenantId, drop.dropId, Date.now())).toBeNull();
    expect(lastState().state).toBe('Cancelled');
    expect(schedule.deleteTickSchedule).toHaveBeenCalled();
    expect(await activeHolds(drop)).toBe(0);
    expect(sum(await shardSold(drop))).toBe(0);
    clearDropCache();
    const r = await confirm(h, 'gone@example.com');
    expect(r.code).toBe('INVALID_STATE');
  });

  it('a cancel that beats the close is finished as Cancelled', async () => {
    const drop = await liveDrop();
    await setState(drop, 'Cancelled');
    await tickOnce(drop.tenantId, drop.dropId, Date.parse(drop.endAt) + 1);
    expect((await getDrop(drop.tenantId, drop.dropId)).state).toBe('Cancelled');
    expect(lastState().state).toBe('Cancelled');
  });
});
