import { createHash } from 'node:crypto';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, table, strip } from './ddb.js';
import { keys } from './keys.js';
import { ApiError } from './errors.js';
import { trackingOf, type OrderTracking } from './merchant-analytics.js';
import type { Order } from './types.js';

const fields = ['paymentStatus', 'fulfillmentMethod', 'fulfillmentStatus', 'attendanceStatus', 'paymentMethod', 'paymentReference', 'fulfillBy', 'carrier', 'trackingReference', 'note'] as const;
const enums: Record<string, string[]> = { paymentStatus: ['awaiting','paid','unknown'], fulfillmentMethod: ['pickup','shipping','unassigned'], fulfillmentStatus: ['not_started','ready','shipped','collected','delivered','exception','unknown'], attendanceStatus: ['normal','no_show'] };
function validatePatch(patch: Record<string, unknown>, current: OrderTracking, now: string, reason: string): OrderTracking {
  if (!Object.keys(patch).length || Object.keys(patch).some(k => !(fields as readonly string[]).includes(k))) throw new ApiError('VALIDATION', 'Provide only supported tracking fields');
  const next = { ...current };
  for (const key of fields) if (Object.hasOwn(patch, key)) {
    const value = patch[key];
    if (enums[key]) { if (typeof value !== 'string' || !enums[key]!.includes(value)) throw new ApiError('VALIDATION', `Invalid ${key}`); }
    else if (value !== null && (typeof value !== 'string' || value.length > (key === 'note' ? 500 : 120))) throw new ApiError('VALIDATION', `Invalid ${key}`);
    if (value === null) delete next[key]; else (next as unknown as Record<string, unknown>)[key] = typeof value === 'string' ? value.trim() : value;
  }
  if (next.fulfillBy && (!Number.isFinite(Date.parse(next.fulfillBy)) || !/T/.test(next.fulfillBy))) throw new ApiError('VALIDATION', 'Fulfillment due date must be an ISO timestamp');
  const state = next.fulfillmentStatus;
  if (next.fulfillmentMethod === 'unassigned' && !['unknown','not_started'].includes(state)) throw new ApiError('VALIDATION', 'Select pickup or shipping first');
  if (next.fulfillmentMethod === 'pickup' && ['shipped','delivered'].includes(state)) throw new ApiError('VALIDATION', 'Pickup orders cannot be shipped or delivered');
  if (next.fulfillmentMethod === 'shipping' && ['collected'].includes(state)) throw new ApiError('VALIDATION', 'Shipping orders cannot be collected');
  if (['shipped','delivered'].includes(state) && (!next.carrier || !next.trackingReference)) throw new ApiError('VALIDATION', 'Shipping requires a carrier and tracking reference');
  if ((current.paymentStatus === 'paid' && next.paymentStatus !== 'paid') || (['collected','delivered'].includes(current.fulfillmentStatus) && state !== current.fulfillmentStatus)) {
    if (!reason) throw new ApiError('VALIDATION', 'A reason is required to reverse payment or completed fulfillment');
  }
  if (['shipped','collected','delivered'].includes(state) && state !== current.fulfillmentStatus && next.paymentStatus !== 'paid' && !reason) throw new ApiError('VALIDATION', 'Record payment first, or provide an unpaid-fulfillment override reason');
  if (next.paymentStatus !== current.paymentStatus) { if (next.paymentStatus === 'paid') next.paymentRecordedAt = now; else delete next.paymentRecordedAt; }
  if (state !== current.fulfillmentStatus) {
    if (state === 'shipped') next.dispatchedAt = now;
    if (['collected','delivered'].includes(state)) next.completedAt = now; else delete next.completedAt;
  }
  return next;
}
export async function retainedOrder(t: string, d: string, ref: string): Promise<{ order: Order; raw: Record<string, unknown>; ttl: number }> {
  const r = await ddb.send(new GetCommand({ TableName: table(), Key: keys.order(t,d,ref), ConsistentRead: true }));
  if (!r.Item) throw new ApiError('NOT_FOUND', 'Order not found');
  let ttl = Number(r.Item.ttl);
  if (!Number.isFinite(ttl)) {
    const drop = await ddb.send(new GetCommand({ TableName: table(), Key: keys.drop(t,d), ConsistentRead: true }));
    ttl = Math.floor(Date.parse(String(drop.Item?.endAt)) / 1000) + 180 * 86400;
  }
  if (!Number.isFinite(ttl) || ttl * 1000 <= Date.now()) throw new ApiError('NOT_FOUND', 'Order is outside its retention period');
  return { order: strip<Order>(r.Item)!, raw: r.Item, ttl };
}
export async function updateOrderTracking(t: string, d: string, ref: string, body: Record<string, unknown>) {
  if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0 || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(body.requestId)) throw new ApiError('VALIDATION', 'A request ID and expected version are required');
  if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) throw new ApiError('VALIDATION', 'Tracking patch is required');
  if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 300)) throw new ApiError('VALIDATION', 'Reason must be at most 300 characters');
  const reason = String(body.reason ?? '').trim(); const patch = body.patch as Record<string, unknown>;
  const canonical = Object.fromEntries(Object.entries(patch).sort(([a],[b])=>a.localeCompare(b)));
  const hash = createHash('sha256').update(JSON.stringify({ version: body.expectedVersion, patch: canonical, reason })).digest('hex');
  const auditKey = { PK: `T#${t}`, SK: `TRACK#${d}#${ref}#${body.requestId}` };
  const [source, receipt] = await Promise.all([retainedOrder(t,d,ref), ddb.send(new GetCommand({ TableName: table(), Key: auditKey, ConsistentRead: true }))]);
  if (receipt.Item) {
    if (receipt.Item.hash !== hash) throw new ApiError('INVALID_STATE', 'Request ID was already used for another action');
    return source.order;
  }
  const { order, raw, ttl } = source; const version = order.version ?? 0;
  if (version !== body.expectedVersion) throw new ApiError('INVALID_STATE', 'Order changed. Refresh before saving again.');
  const now = new Date().toISOString(); const before = trackingOf(order); const after = validatePatch(patch, before, now, reason);
  const status = after.attendanceStatus === 'no_show' ? 'no-show' : after.paymentStatus === 'paid' ? 'paid' : 'confirmed';
  const next: Order = { ...order, status, tracking: after, version: version + 1 };
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: table(), Item: { ...raw, ...next, updatedAt: now, ttl }, ConditionExpression: `attribute_exists(PK) AND ${order.version === undefined ? 'attribute_not_exists(#v)' : '#v = :v'}`, ExpressionAttributeNames: { '#v': 'version' }, ...(order.version === undefined ? {} : { ExpressionAttributeValues: { ':v': version } }) } },
      { Put: { TableName: table(), Item: { ...auditKey, type: 'OrderTrackingAudit', at: now, actor: t, before, after, reason, version: version + 1, hash, ttl }, ConditionExpression: 'attribute_not_exists(PK)' } },
    ] }));
  } catch (e) {
    if ((e as { name?: string }).name !== 'TransactionCanceledException') throw e;
    const replay = await ddb.send(new GetCommand({ TableName: table(), Key: auditKey, ConsistentRead: true }));
    if (replay.Item?.hash === hash) return (await retainedOrder(t,d,ref)).order;
    throw new ApiError('INVALID_STATE', 'Order changed. Refresh before saving again.');
  }
  return next;
}
export async function orderHistory(t: string, d: string, ref: string) {
  await retainedOrder(t,d,ref);
  const r = await ddb.send(new QueryCommand({ TableName: table(), KeyConditionExpression: 'PK = :p AND begins_with(SK,:s)', ExpressionAttributeValues: { ':p': `T#${t}`, ':s': `TRACK#${d}#${ref}#` }, Limit: 100, ConsistentRead: true }));
  // IDs provide idempotency, not chronological sort. Mark a bounded history rather than claiming completeness.
  return { rows: (r.Items ?? []).filter(i => Number(i.ttl)*1000 > Date.now()).map(i => ({ at:i.at, actor:i.actor, before:i.before, after:i.after, reason:i.reason, version:i.version })).sort((a,b)=>Number(b.version)-Number(a.version)), partial: Boolean(r.LastEvaluatedKey) };
}
