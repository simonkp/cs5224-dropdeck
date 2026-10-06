import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keys, type Drop } from '@dropdeck/shared';
import { createTable, enabled, http, liveDrop, parse, type Res } from './harness.js';

vi.mock('../../../services/merchant-api/src/publish.js', () => ({
  writeDropJson: vi.fn(), deleteDropJson: vi.fn(), writeStateJson: vi.fn(), deleteStateJson: vi.fn(),
  createOpenSchedule: vi.fn(), deleteOpenSchedule: vi.fn(),
  putImage: vi.fn(), writeShopJson: vi.fn(), deleteShopJson: vi.fn(), refreshShop: vi.fn(), republishBranding: vi.fn(),
}));

const { handler: ticket } = await import('../../../services/ticket/src/handler.js');
const { handler: claim } = await import('../../../services/claim/src/handler.js');
const { handler: checkout } = await import('../../../services/checkout/src/handler.js');
const { handler: merchant } = await import('../../../services/merchant-api/src/handler.js');
const { clearDropCache, ddb, table } = await import('@dropdeck/shared/ddb');
const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');

async function hold(drop: Drop, qty = 1): Promise<Res> {
  const tk = parse(await ticket(http.ticket(drop)));
  const c = parse(await claim(http.claim(drop, tk.ticket, 'v1', qty)));
  expect(c.status).toBe(201);
  return c;
}
const otp = (h: Res, email: string) => checkout({
  routeKey: 'POST /api/holds/{holdId}/otp', pathParameters: { holdId: h.holdId },
  headers: { authorization: `Bearer ${h.hold}` }, body: JSON.stringify({ email }),
} as never).then(parse);
const confirm = (h: Res, body: Record<string, unknown>) => checkout(http.checkout('confirm', h.holdId, h.hold, body)).then(parse);

/** Lets a resend through by moving the last send back past the 30 s wait. */
const skipResendWait = (drop: Drop, holdId: string) => ddb.send(new UpdateCommand({
  TableName: table(), Key: keys.hold(drop.tenantId, drop.dropId, holdId),
  UpdateExpression: 'SET otpLastSentAt = :t', ExpressionAttributeValues: { ':t': Date.now() - 31_000 },
}));

const asMerchant = (tenant: string, routeKey: string, dropId?: string, body?: unknown, ref?: string) => merchant({
  routeKey, pathParameters: { ...(dropId ? { dropId } : {}), ...(ref ? { ref } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body), isBase64Encoded: false,
  requestContext: { authorizer: { jwt: { claims: { sub: tenant }, scopes: [] } } },
} as never);

describe.skipIf(!enabled)('phase 4 against DynamoDB Local', () => {
  beforeAll(createTable);
  beforeEach(() => clearDropCache());

  describe('email code at checkout (log mode)', () => {
    it('confirms with the code sent to the address', async () => {
      const drop = await liveDrop({ verification: 'email' });
      const h = await hold(drop);
      expect((await confirm(h, { name: 'Ann', email: 'ann@example.com' })).code).toBe('OTP_INVALID'); // no code yet
      const sent = await otp(h, 'Ann@Example.com');
      expect(sent.sentTo).toBe('A•••n@Example.com');
      expect(sent.devCode).toMatch(/^\d{6}$/);
      const ok = await confirm(h, { name: 'Ann', email: 'ann@example.com', code: sent.devCode });
      expect(ok.status).toBe(200);
      expect(ok.orderRef).toBeTruthy();
    });

    it('rejects a different address than the one the code went to', async () => {
      const drop = await liveDrop({ verification: 'email' });
      const h = await hold(drop);
      const sent = await otp(h, 'bo@example.com');
      const r = await confirm(h, { name: 'Bo', email: 'someone.else@example.com', code: sent.devCode });
      expect(r.code).toBe('OTP_INVALID');
    });

    it('locks the hold after five wrong codes', async () => {
      const drop = await liveDrop({ verification: 'email' });
      const h = await hold(drop);
      const sent = await otp(h, 'cy@example.com');
      const wrong = sent.devCode === '000000' ? '111111' : '000000';
      const results = [];
      for (let i = 0; i < 6; i++) results.push((await confirm(h, { name: 'Cy', email: 'cy@example.com', code: wrong })).code);
      expect(results.slice(0, 4).every((c) => c === 'OTP_INVALID')).toBe(true);
      expect(results.slice(4)).toEqual(['OTP_LOCKED', 'OTP_LOCKED']);
      expect((await confirm(h, { name: 'Cy', email: 'cy@example.com', code: sent.devCode })).code).toBe('OTP_LOCKED');
    });

    it('throttles resends and caps them at three', async () => {
      const drop = await liveDrop({ verification: 'email' });
      const h = await hold(drop);
      expect((await otp(h, 'di@example.com')).status).toBe(200);
      const tooSoon = await otp(h, 'di@example.com');
      expect(tooSoon.code).toBe('RATE_LIMITED');
      expect(tooSoon.retryAfter).toBeGreaterThan(20);
      for (let i = 0; i < 2; i++) {
        await skipResendWait(drop, h.holdId);
        expect((await otp(h, 'di@example.com')).status).toBe(200);
      }
      await skipResendWait(drop, h.holdId);
      expect((await otp(h, 'di@example.com')).code).toBe('OTP_LOCKED');
    });

    it('a code replaced by a resend no longer confirms', async () => {
      const drop = await liveDrop({ verification: 'email' });
      const h = await hold(drop);
      const first = await otp(h, 'ed@example.com');
      await skipResendWait(drop, h.holdId);
      const second = await otp(h, 'ed@example.com');
      if (first.devCode !== second.devCode) {
        expect((await confirm(h, { name: 'Ed', email: 'ed@example.com', code: first.devCode })).code).toBe('OTP_INVALID');
      }
      expect((await confirm(h, { name: 'Ed', email: 'ed@example.com', code: second.devCode })).status).toBe(200);
    });

    it('refuses to send a code to an address that already ordered', async () => {
      const drop = await liveDrop({ verification: 'email' });
      const a = await hold(drop);
      const sent = await otp(a, 'fay@example.com');
      await confirm(a, { name: 'Fay', email: 'fay@example.com', code: sent.devCode });
      const b = await hold(drop);
      expect((await otp(b, 'FAY@example.com')).code).toBe('LIMIT_REACHED');
      expect((await otp(b, 'fay+again@example.com')).code).toBe('LIMIT_REACHED'); // +suffix is stripped
      expect((await otp(b, 'f.a.y@example.com')).status).toBe(200); // dots only collapse for Gmail
    });
  });

  describe('merchant orders, reconciliation, export and report', () => {
    it('lists orders, marks them paid or no-show, exports CSV and reports from orders', async () => {
      const drop = await liveDrop({ variants: [{ id: 'v1', name: 'Loaf', stock: 3, priceCents: 900 }], shardCount: 1 });
      const refs: string[] = [];
      for (const who of ['ann', 'bo', 'cy']) {
        const h = await hold(drop);
        refs.push((await confirm(h, { name: who, email: `${who}@example.com` })).orderRef);
      }
      const t = drop.tenantId;
      const list = JSON.parse((await asMerchant(t, 'GET /m/drops/{dropId}/orders', drop.dropId)).body) as Array<{ ref: string; status: string }>;
      expect(list.map((o) => o.ref).sort()).toEqual([...refs].sort());

      expect((await asMerchant(t, 'PATCH /m/orders/{ref}', undefined, { dropId: drop.dropId, status: 'paid' }, refs[0])).statusCode).toBe(200);
      expect((await asMerchant(t, 'PATCH /m/orders/{ref}', undefined, { dropId: drop.dropId, status: 'no-show' }, refs[1])).statusCode).toBe(200);
      expect((await asMerchant(t, 'PATCH /m/orders/{ref}', undefined, { dropId: drop.dropId, status: 'refunded' }, refs[2])).statusCode).toBe(400);

      const csv = await asMerchant(t, 'GET /m/drops/{dropId}/export.csv', drop.dropId);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.body.trim().split('\r\n')).toHaveLength(4);

      const report = JSON.parse((await asMerchant(t, 'GET /m/drops/{dropId}/report', drop.dropId)).body);
      expect(report.units).toEqual({ ordered: 3, paid: 1, unpaid: 1, noShow: 1 });
      expect(report.revenueCents.paid).toBe(900);

      const live = JSON.parse((await asMerchant(t, 'GET /m/drops/{dropId}/live', drop.dropId)).body);
      expect(live.variants[0]).toMatchObject({ stock: 3, out: 3 });
      expect(live.orders).toBe(3);
      expect(live.activeHolds).toBe(0);
    });

    it('another merchant cannot read or change these orders', async () => {
      const drop = await liveDrop();
      const h = await hold(drop);
      const ref = (await confirm(h, { name: 'Gus', email: 'gus@example.com' })).orderRef;
      expect((await asMerchant('someone-else', 'GET /m/drops/{dropId}/orders', drop.dropId)).statusCode).toBe(404);
      expect((await asMerchant('someone-else', 'PATCH /m/orders/{ref}', undefined, { dropId: drop.dropId, status: 'paid' }, ref)).statusCode).toBe(404);
    });
  });
});
