import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { keys, type Order } from '@dropdeck/shared';
import { ddb, table } from '@dropdeck/shared/ddb';
import { updateOrderTracking } from '@dropdeck/shared/order-tracking-store';
import { sendPaymentReminders, reminderHistory, attachReminders } from '../../../services/merchant-api/src/payment-reminders.js';
import { createTable, enabled, liveDrop } from './harness.js';

vi.mock('../../../services/merchant-api/src/reminder-mailer.js', () => ({ sendReminder: vi.fn() }));
const { sendReminder } = vi.mocked(await import('../../../services/merchant-api/src/reminder-mailer.js'));

async function seed(count = 1) {
  const drop = await liveDrop();
  await ddb.send(new PutCommand({ TableName: table(), Item: { ...keys.profile(drop.tenantId), name: 'Shop', paynow: 'UEN123', tier: 'starter', slug: 'shop' } }));
  const orders: Order[] = Array.from({ length: count }, (_, i) => ({ tenantId: drop.tenantId, dropId: drop.dropId, ref: `REMINDER${i}`, holdId: 'hold', variantId: 'v1', variantName: 'Country loaf', qty: 2, unitPriceCents: 800, amountCents: 1600, name: `Buyer ${i}`, email: `buyer${i}@example.com`, status: 'confirmed', createdAt: new Date().toISOString() }));
  for (const order of orders) await ddb.send(new PutCommand({ TableName: table(), Item: { ...keys.order(drop.tenantId, drop.dropId, order.ref), ...order, ttl: Math.floor(Date.parse(drop.endAt) / 1000) + 180 * 86400 } }));
  return { drop, orders, body: { dropId: drop.dropId, refs: orders.map(o => o.ref), requestId: 'reminder-request-1' } };
}

describe.skipIf(!enabled)('payment reminders', () => {
  beforeAll(async () => { await createTable(); });
  beforeEach(() => { vi.resetAllMocks(); sendReminder.mockResolvedValue('ses-message-id'); process.env.MERCHANT_ANALYTICS_ENABLED = '1'; process.env.MAIL_MODE = 'ses'; process.env.MAIL_FROM = 'codes@example.com'; });

  it('personalizes separate emails, records audits, and safely replays a request', async () => {
    const { drop, orders, body } = await seed(2);
    const first = await sendPaymentReminders(drop.tenantId, body);
    expect(first.results.map(r => r.status)).toEqual(['accepted', 'accepted']);
    expect(sendReminder).toHaveBeenCalledTimes(2);
    expect(sendReminder).toHaveBeenCalledWith('buyer0@example.com', expect.objectContaining({ subject: expect.stringContaining('REMINDER0'), text: expect.stringContaining('Amount due: SGD 16.00') }));
    expect(sendReminder.mock.calls.find(call => call[0] === 'buyer0@example.com')![1].text).not.toContain('Buyer 1');
    await sendPaymentReminders(drop.tenantId, body);
    expect(sendReminder).toHaveBeenCalledTimes(2);
    expect((await reminderHistory(drop.tenantId, drop.dropId, orders[0]!.ref)).rows).toHaveLength(1);
    expect((await attachReminders(drop.tenantId, drop.dropId, orders))[0]?.paymentReminder?.status).toBe('accepted');
    expect((await sendPaymentReminders(drop.tenantId, { ...body, requestId: 'new-reminder-request' })).results.every(r => r.status === 'skipped')).toBe(true);
  });

  it('allows only one sender during concurrent requests', async () => {
    const { drop, body } = await seed();
    await Promise.all([sendPaymentReminders(drop.tenantId, body), sendPaymentReminders(drop.tenantId, { ...body, requestId: 'concurrent-reminder' })]);
    expect(sendReminder).toHaveBeenCalledOnce();
  });

  it('skips orders marked paid or no-show after the list was loaded', async () => {
    const { drop, orders, body } = await seed(2);
    await updateOrderTracking(drop.tenantId, drop.dropId, orders[0]!.ref, { requestId: 'payment-recorded-1', expectedVersion: 0, patch: { paymentStatus: 'paid' } });
    await updateOrderTracking(drop.tenantId, drop.dropId, orders[1]!.ref, { requestId: 'attendance-recorded', expectedVersion: 0, patch: { attendanceStatus: 'no_show' } });
    expect((await sendPaymentReminders(drop.tenantId, body)).results.every(r => r.status === 'skipped')).toBe(true);
    expect(sendReminder).not.toHaveBeenCalled();
  });

  it('rejects conflicting payment changes between the read and reservation', async () => {
    const { drop, orders, body } = await seed();
    const originalSend = ddb.send.bind(ddb);
    let changed = false;
    const spy = vi.spyOn(ddb, 'send').mockImplementation((async (command: { constructor: { name: string } }) => {
      if (!changed && command.constructor.name === 'TransactWriteCommand') {
        changed = true;
        await originalSend(new UpdateCommand({ TableName: table(), Key: keys.order(drop.tenantId, drop.dropId, orders[0]!.ref), UpdateExpression: 'SET #v=:v, #s=:s', ExpressionAttributeNames: { '#v': 'version', '#s': 'status' }, ExpressionAttributeValues: { ':v': 1, ':s': 'paid' } }));
      }
      return originalSend(command as never);
    }) as never);
    try { expect((await sendPaymentReminders(drop.tenantId, body)).results[0]?.status).toBe('skipped'); }
    finally { spy.mockRestore(); }
    expect(sendReminder).not.toHaveBeenCalled();
  });

  it('protects tenant boundaries, logical expiry and cancelled drops', async () => {
    const { drop, orders, body } = await seed(2);
    await expect(sendPaymentReminders('other-tenant', body)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await ddb.send(new UpdateCommand({ TableName: table(), Key: keys.order(drop.tenantId, drop.dropId, orders[0]!.ref), UpdateExpression: 'SET #ttl=:ttl', ExpressionAttributeNames: { '#ttl': 'ttl' }, ExpressionAttributeValues: { ':ttl': 1 } }));
    const expired = await sendPaymentReminders(drop.tenantId, { ...body, refs: [orders[0]!.ref] }); expect(expired.results[0]?.status).toBe('skipped');
    await ddb.send(new UpdateCommand({ TableName: table(), Key: keys.drop(drop.tenantId, drop.dropId), UpdateExpression: 'SET #s=:s', ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':s': 'Cancelled' } }));
    expect((await sendPaymentReminders(drop.tenantId, body)).results.every(r => r.status === 'skipped')).toBe(true);
    expect(sendReminder).not.toHaveBeenCalled();
  });

  it('reports mixed results and locks uncertain outcomes without SDK/application retries', async () => {
    const { drop, body } = await seed(3);
    sendReminder.mockImplementation(async to => { if (to === 'buyer1@example.com') throw { $metadata: { httpStatusCode: 400 } }; if (to === 'buyer2@example.com') throw new Error('timeout'); return 'ses-id'; });
    const sent = await sendPaymentReminders(drop.tenantId, body);
    expect(sent.results.map(r => r.status)).toEqual(['accepted', 'failed', 'uncertain']);
    await sendPaymentReminders(drop.tenantId, { ...body, requestId: 'retry-after-timeout' });
    expect(sendReminder).toHaveBeenCalledTimes(3);
    expect((await reminderHistory(drop.tenantId, drop.dropId, 'REMINDER2')).rows[0]?.status).toBe('uncertain');
  });

  it('keeps a conservative lock if SES accepts but saving its result fails', async () => {
    const { drop, body } = await seed();
    sendReminder.mockImplementationOnce(async () => { await ddb.send(new UpdateCommand({ TableName: table(), Key: { PK: `T#${drop.tenantId}`, SK: `PAYREM_AUDIT#${drop.dropId}#REMINDER0#${body.requestId}` }, UpdateExpression: 'SET requestId=:id', ExpressionAttributeValues: { ':id': 'changed-for-test' } })); return 'ses-id'; });
    expect((await sendPaymentReminders(drop.tenantId, body)).results[0]?.status).toBe('uncertain');
    await sendPaymentReminders(drop.tenantId, { ...body, requestId: 'receipt-failure-retry' });
    expect(sendReminder).toHaveBeenCalledOnce();
  });

  it('bounds batches, disables log-mode sends, requires instructions and enforces the daily quota', async () => {
    const { drop, body } = await seed();
    await expect(sendPaymentReminders(drop.tenantId, { ...body, refs: Array.from({ length: 11 }, (_, i) => `ORDER${i}`) })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(sendPaymentReminders(drop.tenantId, { ...body, refs: ['REMINDER0', 'REMINDER0'] })).rejects.toMatchObject({ code: 'VALIDATION' });
    process.env.MAIL_MODE = 'log'; await expect(sendPaymentReminders(drop.tenantId, body)).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' }); process.env.MAIL_MODE = 'ses';
    await ddb.send(new PutCommand({ TableName: table(), Item: { ...keys.profile(drop.tenantId), name: 'Shop' } }));
    await expect(sendPaymentReminders(drop.tenantId, body)).rejects.toMatchObject({ code: 'VALIDATION' });
    await ddb.send(new PutCommand({ TableName: table(), Item: { ...keys.profile(drop.tenantId), name: 'Shop', paynow: 'UEN123' } }));
    await ddb.send(new PutCommand({ TableName: table(), Item: { PK: `T#${drop.tenantId}`, SK: `PAYREM_QUOTA#${new Date().toISOString().slice(0, 10)}`, n: 100 } }));
    expect((await sendPaymentReminders(drop.tenantId, body)).results[0]?.status).toBe('skipped');
    expect(sendReminder).not.toHaveBeenCalled();
    const lock = await ddb.send(new GetCommand({ TableName: table(), Key: { PK: `T#${drop.tenantId}`, SK: `PAYREM#${drop.dropId}#REMINDER0` } })); expect(lock.Item).toBeUndefined();
  });
});
