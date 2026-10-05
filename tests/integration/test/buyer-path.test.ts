import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keys, type Drop } from '@dropdeck/shared';
import { activeHolds, createTable, enabled, http, liveDrop, parse, shardSold } from './harness.js';

vi.mock('../../../services/controller/src/publish.js', () => ({ writeState: vi.fn() }));
vi.mock('../../../services/controller/src/schedule.js', () => ({ upsertTickSchedule: vi.fn(), deleteTickSchedule: vi.fn() }));

const { handler: ticket } = await import('../../../services/ticket/src/handler.js');
const { handler: claim } = await import('../../../services/claim/src/handler.js');
const { handler: checkout } = await import('../../../services/checkout/src/handler.js');
const controller = await import('../../../services/controller/src/handler.js');
const publish = vi.mocked(await import('../../../services/controller/src/publish.js'));
const schedule = vi.mocked(await import('../../../services/controller/src/schedule.js'));
const { clearDropCache, ddb, getDrop, getHold, releaseHold, table } = await import('@dropdeck/shared/ddb');
const { GetCommand, UpdateCommand } = await import('@aws-sdk/lib-dynamodb');

const lambdaContext = { invokedFunctionArn: 'arn:aws:lambda:local:0:function:controller', getRemainingTimeInMillis: () => 0 };

/** One buyer: take a ticket, then claim. Returns the claim response. */
async function buyer(drop: Drop, qty = 1) {
  const tk = parse(await ticket(http.ticket(drop)));
  expect(tk.status).toBe(201);
  return parse(await claim(http.claim(drop, tk.ticket as string, 'v1', qty)));
}

const sum = (xs: Array<{ sold: number }>) => xs.reduce((n, x) => n + x.sold, 0);

describe.skipIf(!enabled)('buyer path against DynamoDB Local', () => {
  beforeAll(createTable);
  beforeEach(() => clearDropCache());

  describe('oversell: N concurrent claimants against M units', () => {
    it.each([
      { n: 120, m: 20 },
      { n: 10, m: 20 },
      { n: 200, m: 7 },
    ])('sells exactly min($n, $m) with no double allocation', async ({ n, m }) => {
      // fast preset, 1-minute holds: 4m admitted per minute, so all n are admitted inside the 10-minute window.
      const drop = await liveDrop({ variants: [{ id: 'v1', name: 'Loaf', stock: m, priceCents: 800 }], holdSec: 60, startedMinAgo: 9 });
      const results = await Promise.all(Array.from({ length: n }, () => buyer(drop)));
      const won = results.filter((r) => r.status === 201);
      const refused = results.filter((r) => r.status !== 201);
      expect(won).toHaveLength(Math.min(n, m));
      expect(refused.every((r) => r.code === 'VARIANT_SOLD_OUT')).toBe(true);
      const shards = await shardSold(drop);
      expect(sum(shards)).toBe(Math.min(n, m));
      for (const s of shards) expect(s.sold).toBeLessThanOrEqual(s.capacity);
      expect(new Set(won.map((r) => r.holdId)).size).toBe(won.length);
      expect(await activeHolds(drop)).toBe(won.length);
    });
  });

  it('sweeps the other shards before reporting sold out (one unit per shard)', async () => {
    const drop = await liveDrop({ variants: [{ id: 'v1', name: 'Loaf', stock: 4, priceCents: 800 }], shardCount: 4 });
    for (let i = 0; i < 4; i++) expect((await buyer(drop)).status).toBe(201);
    expect((await buyer(drop)).code).toBe('VARIANT_SOLD_OUT');
    expect(sum(await shardSold(drop))).toBe(4);
  });

  it('a retried claim for the same ticket holds stock once', async () => {
    const drop = await liveDrop();
    const tk = parse(await ticket(http.ticket(drop)));
    const [a, b] = await Promise.all([claim(http.claim(drop, tk.ticket as string)), claim(http.claim(drop, tk.ticket as string))]).then((rs) => rs.map(parse));
    expect([a!.holdId, b!.holdId]).toEqual([a!.holdId, a!.holdId]);
    expect(sum(await shardSold(drop))).toBe(1);
  });

  it('refuses a ticket for another drop and a forged one', async () => {
    const drop = await liveDrop();
    const other = await liveDrop();
    const tk = parse(await ticket(http.ticket(other)));
    expect(parse(await claim(http.claim(drop, tk.ticket as string))).code).toBe('BAD_TOKEN');
    const [body] = (tk.ticket as string).split('.');
    expect(parse(await claim(http.claim(other, `${body}.forged`))).code).toBe('BAD_TOKEN');
  });

  describe('admission (decision 0003)', () => {
    it('early tickets wait for the freeze, then enter by the r threshold', async () => {
      // Admission starts 10 s from now, so these tickets join the random draw.
      const drop = await liveDrop({ startedMinAgo: -10 / 60, earlyCount: undefined, ratePreset: 'gentle', holdSec: 120, admitWindowSec: 600 });
      const tickets = await Promise.all(Array.from({ length: 30 }, () => ticket(http.ticket(drop)).then(parse)));
      expect(tickets.every((t) => typeof t.r === 'number')).toBe(true);

      const early = parse(await claim(http.claim(drop, tickets[0]!.ticket as string)));
      expect(early.code).toBe('NOT_ADMITTED');
      expect(early.retryAfter).toBeGreaterThan(0);

      // The controller freezes E once admission has started; a second controller adopts the same E.
      const start = Date.parse(drop.openAt) + drop.graceSec * 1000;
      await controller.tickOnce(drop.tenantId, drop.dropId, start + 2500);
      await controller.tickOnce(drop.tenantId, drop.dropId, start + 2600);
      expect((await getDrop(drop.tenantId, drop.dropId)).earlyCount).toBe(30);

      // gentle: 20 units per 2 min → 10/min, so 30 early buyers take 3 minutes; the watermark moves with time.
      const at90s = await controller.tickOnce(drop.tenantId, drop.dropId, start + 90_000);
      expect(at90s!.rThreshold).toBeCloseTo(0.5, 1);
      expect(at90s!.nWatermark).toBe(0);
      expect(publish.writeState).toHaveBeenCalled();
    });

    it('a late ticket is not admitted before its turn', async () => {
      const drop = await liveDrop({ startedMinAgo: 0, ratePreset: 'gentle', holdSec: 900 }); // 20 units / 15 min
      for (let i = 0; i < 3; i++) await ticket(http.ticket(drop));
      // The block for this instance was reserved by the first ticket; take one far enough back in the queue.
      let last: Record<string, unknown> = {};
      for (let i = 0; i < 5; i++) last = parse(await ticket(http.ticket(drop)));
      const r = parse(await claim(http.claim(drop, last.ticket as string)));
      expect(r.code).toBe('NOT_ADMITTED');
    });
  });

  describe('checkout with verification off', () => {
    async function heldBy(drop: Drop, qty = 1) {
      const c = await buyer(drop, qty);
      expect(c.status).toBe(201);
      return c;
    }

    it('confirms once per email, and a second hold for the same address is released', async () => {
      const drop = await liveDrop();
      const a = await heldBy(drop);
      const b = await heldBy(drop, 2);
      const ok = parse(await checkout(http.checkout('confirm', a.holdId, a.hold, { name: 'Ann', email: 'Ann.Lee+drop@gmail.com' })));
      expect(ok.status).toBe(200);
      expect(ok.orderRef).toMatch(/^[A-Z2-9]{8}$/);
      expect(ok.amountCents).toBe(800);

      const dup = parse(await checkout(http.checkout('confirm', b.holdId, b.hold, { name: 'Ann', email: 'annlee@gmail.com' })));
      expect(dup.code).toBe('LIMIT_REACHED');
      expect(sum(await shardSold(drop))).toBe(1); // b's two units went back
      expect(await activeHolds(drop)).toBe(0);
    });

    it('a retried confirm returns the same order', async () => {
      const drop = await liveDrop();
      const a = await heldBy(drop);
      const body = { name: 'Bo', email: 'bo@example.com' };
      const first = parse(await checkout(http.checkout('confirm', a.holdId, a.hold, body)));
      const again = parse(await checkout(http.checkout('confirm', a.holdId, a.hold, body)));
      expect(again.orderRef).toBe(first.orderRef);
      const resumed = parse(await checkout(http.checkout('GET', a.holdId, a.hold)));
      expect(resumed.state).toBe('confirmed');
      const order = await ddb.send(new GetCommand({ TableName: table(), Key: keys.order(drop.tenantId, drop.dropId, first.orderRef as string) }));
      expect(order.Item?.email).toBe('bo@example.com');
    });

    it('an expired hold cannot be confirmed', async () => {
      const drop = await liveDrop();
      const a = await heldBy(drop);
      await ddb.send(new UpdateCommand({
        TableName: table(), Key: keys.hold(drop.tenantId, drop.dropId, a.holdId),
        UpdateExpression: 'SET expiresAt = :past', ExpressionAttributeValues: { ':past': Date.now() - 1000 },
      }));
      const r = parse(await checkout(http.checkout('confirm', a.holdId, a.hold, { name: 'Cy', email: 'cy@example.com' })));
      expect(r.code).toBe('HOLD_EXPIRED');
    });
  });

  it('concurrent releases of one hold return its units exactly once', async () => {
    const drop = await liveDrop();
    const c = await buyer(drop, 2);
    const hold = (await getHold(drop.tenantId, drop.dropId, c.holdId))!;
    const results = await Promise.all(Array.from({ length: 5 }, () => releaseHold(hold)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(sum(await shardSold(drop))).toBe(0);
  });

  it('controller open moves Scheduled to Live once and arms the tick schedule', async () => {
    const drop = await liveDrop({ state: 'Scheduled', earlyCount: undefined, startedMinAgo: -15 });
    const results = await Promise.all([1, 2].map(() => controller.handler({ action: 'open', tenantId: drop.tenantId, dropId: drop.dropId }, lambdaContext)));
    expect(results.every((r) => r.ok)).toBe(true);
    const after = await getDrop(drop.tenantId, drop.dropId);
    expect(after.state).toBe('Live');
    expect(after.version).toBe(2);
    expect(schedule.upsertTickSchedule).toHaveBeenCalled();
  });
});
