import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { randomInt } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  ApiError, emailHash, errorResult, isPlausibleEmail, json, keys, normaliseEmail, parseBody, verifyHold,
  type Drop, type Hold, type Order,
} from '@dropdeck/shared';
import { ddb, getDropCached, getHold, getProfile, isConditionFailure, releaseHold, strip, table } from '@dropdeck/shared/ddb';
import { ssmSecret } from '@dropdeck/shared/secrets';
import { checkCode, codeStatus, sendCode } from './otp.js';

/**
 * GET  /api/holds/{holdId}           resume a hold (or its confirmation) after a refresh
 * POST /api/holds/{holdId}/otp       { email } → 6-digit code by email (drops with verification 'email')
 * POST /api/holds/{holdId}/confirm   { name, email, code? } → order; payment is a PayNow handoff (decision 0004)
 *
 * The hold token travels as `Authorization: Bearer <token>`.
 */

const tokenKey = ssmSecret('TOKEN_KEY_PARAM');
const emailKey = ssmSecret('EMAIL_HASH_KEY_PARAM');

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** 8 characters from 31: about 8.5e11 values, so a same-drop collision is negligible; the put is conditional anyway. */
const newRef = () => Array.from({ length: 8 }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join('');

/** Orders (a buyer's name and email) are deleted this long after the drop ends (decision 0014, PDPA retention). */
export const ORDER_RETENTION_DAYS = 180;

/** Never overwrite another buyer's order: the ref must be new, or already belong to this hold (a retry). */
async function putOrder(order: Order, dropEndAt: string): Promise<void> {
  try {
    await ddb.send(new PutCommand({
      TableName: table(),
      Item: {
        ...keys.order(order.tenantId, order.dropId, order.ref), type: 'Order', ...order,
        ttl: Math.floor(Date.parse(dropEndAt) / 1000) + ORDER_RETENTION_DAYS * 86_400,
      },
      ConditionExpression: 'attribute_not_exists(PK) OR holdId = :h',
      ExpressionAttributeValues: { ':h': order.holdId },
    }));
  } catch (e) {
    if (isConditionFailure(e)) console.error(JSON.stringify({ level: 'error', msg: 'order ref collision', ref: order.ref, holdId: order.holdId }));
    throw e;
  }
}

async function confirmation(drop: Drop, order: Order) {
  const profile = await getProfile(drop.tenantId);
  return {
    state: 'confirmed' as const,
    orderRef: order.ref,
    dropTitle: drop.title,
    variantName: order.variantName,
    qty: order.qty,
    amountCents: order.amountCents,
    merchant: {
      name: profile?.name ?? 'The merchant', paynow: profile?.paynow, fulfilmentNote: profile?.fulfilmentNote,
      logoUrl: profile?.logoUrl, colour: profile?.colour, theme: profile?.theme,
    },
  };
}

function buildOrder(drop: Drop, hold: Hold, ref: string, name: string, email: string): Order {
  const variant = drop.variants.find((v) => v.id === hold.variantId);
  const unit = variant?.priceCents ?? 0;
  return {
    tenantId: drop.tenantId, dropId: drop.dropId, ref, holdId: hold.holdId, variantId: hold.variantId,
    variantName: variant?.name ?? hold.variantId, qty: hold.qty, unitPriceCents: unit, amountCents: unit * hold.qty,
    name, email, status: 'confirmed', createdAt: new Date(hold.createdAt).toISOString(),
  };
}

/** Writes the order if it is missing; a retried confirm after a crash rebuilds it from the confirmed hold. */
async function ensureOrder(drop: Drop, hold: Hold): Promise<Order> {
  const k = keys.order(drop.tenantId, drop.dropId, hold.orderRef!);
  const existing = strip<Order>((await ddb.send(new GetCommand({ TableName: table(), Key: k }))).Item);
  if (existing) return existing;
  const order = buildOrder(drop, hold, hold.orderRef!, hold.name ?? '', hold.email ?? '');
  await putOrder(order, drop.endAt);
  return order;
}

async function confirm(drop: Drop, hold: Hold, body: { name?: unknown; email?: unknown; code?: unknown }, now: number) {
  if (hold.state === 'confirmed') return confirmation(drop, await ensureOrder(drop, hold));
  // Closed still allows checkout: a buyer holding stock at endAt keeps the rest of their hold window.
  if (drop.state === 'Cancelled') throw new ApiError('INVALID_STATE', 'This drop was cancelled by the merchant');
  if (hold.state !== 'active' || hold.expiresAt <= now) throw new ApiError('HOLD_EXPIRED', 'Your hold has expired');
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!name) throw new ApiError('VALIDATION', 'Please enter your name');
  if (!isPlausibleEmail(email)) throw new ApiError('VALIDATION', 'Please enter a valid email');
  const key = await emailKey();
  // With verification on, the address must be the one the current code went to, and the code must still be
  // current when the hold flips (a resend in between changes the hash and fails the flip).
  const verifiedHash = drop.verification === 'email' ? await checkCode(drop, hold, email, body.code, key, now) : undefined;
  const limitKey = keys.buyerLimit(drop.tenantId, drop.dropId, emailHash(normaliseEmail(email), key));

  // One order per address per drop: a conditional put on its own item (a retry by the same hold passes).
  try {
    await ddb.send(new PutCommand({
      TableName: table(),
      Item: { ...limitKey, type: 'Limit', holdId: hold.holdId, ttl: Math.floor(Date.parse(drop.endAt) / 1000) + 30 * 86_400 },
      ConditionExpression: 'attribute_not_exists(PK) OR holdId = :h',
      ExpressionAttributeValues: { ':h': hold.holdId },
    }));
  } catch (e) {
    if (!isConditionFailure(e)) throw e;
    await releaseHold(hold);
    throw new ApiError('LIMIT_REACHED', 'This email already has an order for this drop');
  }

  const ref = newRef();
  try {
    await ddb.send(new UpdateCommand({
      TableName: table(),
      Key: keys.hold(drop.tenantId, drop.dropId, hold.holdId),
      UpdateExpression: 'SET #s = :confirmed, orderRef = :ref, #n = :name, email = :email REMOVE GSI1PK, GSI1SK',
      ConditionExpression: `#s = :active AND expiresAt > :now${verifiedHash ? ' AND otpHash = :otp' : ''}`,
      ExpressionAttributeNames: { '#s': 'state', '#n': 'name' },
      ExpressionAttributeValues: {
        ':confirmed': 'confirmed', ':active': 'active', ':ref': ref, ':name': name, ':email': email, ':now': now,
        ...(verifiedHash ? { ':otp': verifiedHash } : {}),
      },
    }));
  } catch (e) {
    if (!isConditionFailure(e)) throw e;
    // Expired or swept between the read and here: free the address for another try.
    await ddb.send(new DeleteCommand({
      TableName: table(), Key: limitKey, ConditionExpression: 'holdId = :h', ExpressionAttributeValues: { ':h': hold.holdId },
    })).catch(() => undefined);
    throw new ApiError('HOLD_EXPIRED', 'Your hold has expired');
  }
  const order = buildOrder(drop, hold, ref, name, email);
  await putOrder(order, drop.endAt);
  console.log(JSON.stringify({ metric: 'order', t: drop.tenantId, d: drop.dropId, ref, holdId: hold.holdId, qty: hold.qty, msFromHold: now - hold.createdAt }));
  return confirmation(drop, order);
}

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const holdId = event.pathParameters?.holdId;
    const token = (event.headers?.authorization ?? '').replace(/^Bearer\s+/i, '');
    const now = Date.now();
    const c = verifyHold(token, await tokenKey(), now);
    if (!holdId || c.h !== holdId) throw new ApiError('BAD_TOKEN', 'Token is for a different hold');
    const [drop, hold] = await Promise.all([getDropCached(c.t, c.d), getHold(c.t, c.d, c.h)]);
    if (!hold) throw new ApiError('HOLD_EXPIRED', 'This hold no longer exists');

    switch (event.routeKey) {
      case 'GET /api/holds/{holdId}': {
        if (hold.state === 'confirmed') return json(200, await confirmation(drop, await ensureOrder(drop, hold)));
        const active = hold.state === 'active' && hold.expiresAt > now && drop.state !== 'Cancelled';
        return json(200, {
          state: active ? 'active' : 'expired',
          expiresAt: new Date(hold.expiresAt).toISOString(),
          variantId: hold.variantId,
          qty: hold.qty,
          verification: drop.verification,
          codeSent: Boolean(hold.otpHash),
          code: active ? codeStatus(hold, now) : null,
        });
      }
      case 'POST /api/holds/{holdId}/otp': {
        const body = parseBody<{ email?: unknown }>(event.body, event.isBase64Encoded);
        return json(200, await sendCode(drop, hold, body.email, await emailKey(), now));
      }
      case 'POST /api/holds/{holdId}/confirm':
        return json(200, await confirm(drop, hold, parseBody(event.body, event.isBase64Encoded), now));
      default:
        throw new ApiError('NOT_FOUND', `No route ${event.routeKey}`);
    }
  } catch (err) {
    return errorResult(err);
  }
}
