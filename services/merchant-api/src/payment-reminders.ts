import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, strip, table } from '@dropdeck/shared/ddb';
import { ApiError, keys, type Drop, type MerchantProfile } from '@dropdeck/shared';
import { retainedOrder } from '@dropdeck/shared/order-tracking-store';
import { paymentReminderTemplate, reminderProblem, REMINDER_BATCH_LIMIT, REMINDER_COOLDOWN_MS, type PaymentReminder, type ReminderOrder, type ReminderResult, type ReminderStatus } from '@dropdeck/shared/payment-reminders';
import { sendReminder } from './reminder-mailer.js';
import { setTimeout as delay } from 'node:timers/promises';

const transientReasons = new Set(['TransactionConflict', 'ProvisionedThroughputExceeded', 'ThrottlingError']);
function transientCancellation(error: unknown): boolean {
  const e = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  const reasons = e.CancellationReasons;
  return e.name === 'TransactionCanceledException' && Boolean(reasons?.some(r => transientReasons.has(r.Code ?? '')) && reasons.every(r => r.Code === 'None' || transientReasons.has(r.Code ?? '')));
}
async function reserveReminder(command: TransactWriteCommand): Promise<void> {
  // A cancelled transaction has not reserved an attempt or consumed quota. Never retry the SES send itself.
  for (let attempt = 0; ; attempt++) {
    try { await ddb.send(command); return; }
    catch (e) {
      if (!transientCancellation(e) || attempt >= 3) throw e;
      await delay(25 * 2 ** attempt + Math.floor(Math.random() * 25));
    }
  }
}

export const remindersEnabled = () => process.env.MERCHANT_ANALYTICS_ENABLED === '1' && process.env.MAIL_MODE === 'ses' && Boolean(process.env.MAIL_FROM);
const latestKey = (t: string, d: string, ref: string) => ({ PK: `T#${t}`, SK: `PAYREM#${d}#${ref}` });
const auditKey = (t: string, d: string, ref: string, id: string) => ({ PK: `T#${t}`, SK: `PAYREM_AUDIT#${d}#${ref}#${id}` });
const summary = (row: Record<string, unknown>): PaymentReminder => ({ status: row.status as ReminderStatus, attemptedAt: String(row.attemptedAt), nextAllowedAt: Number(row.nextAllowedAt) });
function result(ref: string, status: ReminderResult['status']): ReminderResult {
  const messages = { accepted: 'Accepted by SES; inbox delivery is not confirmed.', failed: 'SES rejected this email. Check the sender, recipient and sending quota before retrying.', uncertain: 'Sending outcome is uncertain. Check SES before retrying; another reminder is blocked for 24 hours.', sending: 'Sending outcome is pending or uncertain. Another reminder is blocked for 24 hours.', skipped: 'Order is not eligible for a reminder.' };
  return { ref, status, message: messages[status] };
}

export async function attachReminders(t: string, d: string, orders: ReminderOrder[]): Promise<ReminderOrder[]> {
  if (!orders.length) return orders;
  const r = await ddb.send(new BatchGetCommand({ RequestItems: { [table()]: { Keys: orders.map(o => latestKey(t, d, o.ref)), ConsistentRead: true } } }));
  if (r.UnprocessedKeys?.[table()]?.Keys?.length) throw new ApiError('RATE_LIMITED', 'Reminder history could not load completely. Refresh orders before sending.', 5);
  const found = new Map((r.Responses?.[table()] ?? []).filter(r => Number(r.ttl) * 1000 > Date.now()).map(r => [String(r.ref), summary(r)]));
  return orders.map(o => ({ ...o, ...(found.has(o.ref) ? { paymentReminder: found.get(o.ref) } : {}) }));
}

export async function reminderHistory(t: string, d: string, ref: string) {
  const r = await ddb.send(new QueryCommand({ TableName: table(), KeyConditionExpression: 'PK=:p AND begins_with(SK,:s)', ExpressionAttributeValues: { ':p': `T#${t}`, ':s': `PAYREM_AUDIT#${d}#${ref}#` }, ConsistentRead: true, Limit: 100 }));
  return { rows: (r.Items ?? []).filter(r => Number(r.ttl) * 1000 > Date.now()).map(r => ({ ...summary(r), actor: r.actor })).sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt)), partial: Boolean(r.LastEvaluatedKey) };
}

/** Small synchronous batches keep this manual action bounded without a new queue or mail campaign service. */
export async function sendPaymentReminders(t: string, body: Record<string, unknown>) {
  if (!body || typeof body.dropId !== 'string' || !Array.isArray(body.refs) || !body.refs.length || body.refs.length > REMINDER_BATCH_LIMIT || body.refs.some(r => typeof r !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(r)) || new Set(body.refs).size !== body.refs.length || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(body.requestId)) throw new ApiError('VALIDATION', `Choose 1–${REMINDER_BATCH_LIMIT} unique orders and provide a request ID and drop ID`);
  if (!remindersEnabled()) throw new ApiError('NOT_IMPLEMENTED', 'Payment reminder email requires a configured SES sender in this stage');
  const d = body.dropId, id = body.requestId, refs = body.refs as string[];
  const [dr, pr] = await Promise.all([
    ddb.send(new GetCommand({ TableName: table(), Key: keys.drop(t, d), ConsistentRead: true })),
    ddb.send(new GetCommand({ TableName: table(), Key: keys.profile(t), ConsistentRead: true })),
  ]);
  const drop = strip<Drop>(dr.Item), profile = strip<MerchantProfile>(pr.Item);
  if (!drop) throw new ApiError('NOT_FOUND', 'Drop not found');
  if (!profile?.paynow?.trim()) throw new ApiError('VALIDATION', 'Add your shop’s PayNow payment instructions before sending reminders');
  const sendOne = async (ref: string): Promise<ReminderResult> => {
    try {
      const receiptKey = auditKey(t, d, ref, id), lockKey = latestKey(t, d, ref);
      const receipt = await ddb.send(new GetCommand({ TableName: table(), Key: receiptKey, ConsistentRead: true }));
      if (receipt.Item && Number(receipt.Item.ttl) * 1000 > Date.now()) return result(ref, receipt.Item.status as ReminderStatus);
      const { order, ttl } = await retainedOrder(t, d, ref);
      const problem = reminderProblem(order, drop);
      if (problem) return { ref, status: 'skipped', message: problem };
      const now = Date.now(), attemptedAt = new Date(now).toISOString(), nextAllowedAt = now + REMINDER_COOLDOWN_MS;
      const attempt = { type: 'PaymentReminder', ref, requestId: id, actor: t, status: 'sending', attemptedAt, nextAllowedAt, ttl };
      try {
        await reserveReminder(new TransactWriteCommand({ TransactItems: [
          { ConditionCheck: { TableName: table(), Key: keys.order(t, d, ref), ConditionExpression: `attribute_exists(PK) AND ${order.version === undefined ? 'attribute_not_exists(#v)' : '#v=:v'}`, ExpressionAttributeNames: { '#v': 'version' }, ...(order.version === undefined ? {} : { ExpressionAttributeValues: { ':v': order.version } }) } },
          { ConditionCheck: { TableName: table(), Key: keys.drop(t, d), ConditionExpression: '#v=:v AND (#s=:live OR #s=:closed)', ExpressionAttributeNames: { '#v': 'version', '#s': 'state' }, ExpressionAttributeValues: { ':v': drop.version, ':live': 'Live', ':closed': 'Closed' } } },
          { Put: { TableName: table(), Item: { ...lockKey, ...attempt }, ConditionExpression: 'attribute_not_exists(PK) OR nextAllowedAt<=:now', ExpressionAttributeValues: { ':now': now } } },
          { Put: { TableName: table(), Item: { ...receiptKey, ...attempt }, ConditionExpression: 'attribute_not_exists(PK)' } },
          { Update: { TableName: table(), Key: { PK: `T#${t}`, SK: `PAYREM_QUOTA#${attemptedAt.slice(0, 10)}` }, UpdateExpression: 'SET #ttl=:ttl ADD n :one', ConditionExpression: 'attribute_not_exists(n) OR n<:max', ExpressionAttributeNames: { '#ttl': 'ttl' }, ExpressionAttributeValues: { ':one': 1, ':max': 100, ':ttl': Math.floor(now / 1000) + 2 * 86400 } } },
        ] }));
      } catch (e) {
        if ((e as { name?: string }).name !== 'TransactionCanceledException') throw e;
        const replay = await ddb.send(new GetCommand({ TableName: table(), Key: receiptKey, ConsistentRead: true }));
        if (replay.Item) return result(ref, replay.Item.status as ReminderStatus);
        if (transientCancellation(e)) return { ref, status: 'failed', message: 'Temporary database contention prevented reserving this reminder. No email was sent; refresh and try again.' };
        const reasons = (e as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
        if (reasons?.some(r => r.Code === 'ConditionalCheckFailed')) return { ref, status: 'skipped', message: 'Order changed, a reminder was recently attempted, or the shop reached its 100-attempt daily limit. Refresh before retrying.' };
        throw e;
      }
      let status: ReminderStatus = 'accepted', messageId: string | undefined;
      try { messageId = await sendReminder(order.email, paymentReminderTemplate(profile, drop, order)); }
      catch (e) {
        const http = Number((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode);
        status = http >= 400 && http < 500 && http !== 408 ? 'failed' : 'uncertain';
      }
      const completed = { ...attempt, status, ...(messageId ? { messageId } : {}), nextAllowedAt: status === 'failed' ? Date.now() + 60_000 : nextAllowedAt };
      try {
        await ddb.send(new TransactWriteCommand({ TransactItems: [lockKey, receiptKey].map(Key => ({ Put: { TableName: table(), Item: { ...Key, ...completed }, ConditionExpression: 'requestId=:id', ExpressionAttributeValues: { ':id': id } } })) }));
      } catch {
        // The sending receipt remains a conservative lock. Never re-send after an ambiguous write failure.
        console.error(JSON.stringify({ event: 'paymentReminderReceiptFailed', tenantId: t, dropId: d, ref }));
        return result(ref, 'uncertain');
      }
      console.info(JSON.stringify({ event: 'paymentReminder', tenantId: t, dropId: d, ref, status }));
      return result(ref, status);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NOT_FOUND') return { ref, status: 'skipped', message: 'Order not found or outside its retention period.' };
      // Earlier writes may already have reserved the attempt; a new request must go through the cooldown.
      console.error(JSON.stringify({ event: 'paymentReminderError', tenantId: t, dropId: d, ref }));
      return result(ref, 'uncertain');
    }
  };
  const results: ReminderResult[] = [];
  // Two at a time, at most ten. Failures are returned per order rather than hiding partial success.
  for (let i = 0; i < refs.length; i += 2) results.push(...await Promise.all(refs.slice(i, i + 2).map(sendOne)));
  return { mode: 'ses' as const, results };
}
