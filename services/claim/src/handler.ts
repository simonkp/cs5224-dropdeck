import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { randomInt, randomUUID } from 'node:crypto';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  admissionStartsAt, admittedAt, ApiError, checkAdmission, claimWindowStart, dropAdmissionRate, errorResult, FREEZE_DELAY_MS, json, keys,
  parseBody, shardCapacities, sign, ticketId, verifyTicket, type Drop, type Hold, type Variant,
} from '@dropdeck/shared';
import { ddb, getDropCached, getHold, isConditionFailure, returnUnits, table } from '@dropdeck/shared/ddb';
import { ssmSecret } from '@dropdeck/shared/secrets';
import { observeRequest } from '@dropdeck/shared/observability';

/**
 * POST /api/d/{tenantId}/{dropId}/claim   { ticket, variantId, qty? }
 *
 * 1. Admission is recomputed from the signed ticket, the drop config and the frozen early-group size.
 * 2. Reserve: one conditional UpdateItem on a stock shard. A refused shard does not mean sold out, so the
 *    remaining shards are tried before giving up (the exhaustion sweep).
 * 3. Hold: conditional put keyed by the ticket, so one ticket holds stock at most once.
 *
 * Reserve comes before the hold on purpose. A crash between the two leaks units (undersell); the other order
 * would leave an active hold with no units behind it, which the expiry sweep would "return" (oversell).
 */

const tokenKey = ssmSecret('TOKEN_KEY_PARAM');

/** Returns the shard that took the units, or undefined if no shard has `qty` left. */
async function reserve(drop: Drop, variant: Variant, qty: number): Promise<number | undefined> {
  const caps = shardCapacities(variant.stock, drop.shardCount);
  const first = randomInt(drop.shardCount);
  for (let i = 0; i < drop.shardCount; i++) {
    const shard = (first + i) % drop.shardCount;
    const max = caps[shard]! - qty;
    if (max < 0) continue;
    try {
      // Condition expressions cannot do arithmetic, so `sold + q <= capacity` is written as `sold <= capacity - q`.
      await ddb.send(new UpdateCommand({
        TableName: table(),
        Key: keys.stockShard(drop.tenantId, drop.dropId, variant.id, shard),
        UpdateExpression: 'SET sold = sold + :q',
        ConditionExpression: 'sold <= :max',
        ExpressionAttributeValues: { ':q': qty, ':max': max },
      }));
      return shard;
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
    }
  }
  return undefined;
}

function holdResponse(statusCode: number, hold: Hold, key: string) {
  const token = sign({ k: 'hold', t: hold.tenantId, d: hold.dropId, h: hold.holdId, iat: Date.now(), exp: hold.expiresAt + 60_000 }, key);
  return json(statusCode, { hold: token, holdId: hold.holdId, expiresAt: new Date(hold.expiresAt).toISOString(), variantId: hold.variantId, qty: hold.qty });
}

export const handler = (event: APIGatewayProxyEventV2) => observeRequest('claim', event, () => handle(event));
async function handle(event: APIGatewayProxyEventV2) {
  try {
    const t = event.pathParameters?.tenantId;
    const d = event.pathParameters?.dropId;
    if (!t || !d) throw new ApiError('NOT_FOUND', 'No such drop');
    const body = parseBody<{ ticket?: string; variantId?: string; qty?: number }>(event.body, event.isBase64Encoded);
    const now = Date.now();
    const key = await tokenKey();
    const ticket = verifyTicket(String(body.ticket ?? ''), key, now);
    if (ticket.t !== t || ticket.d !== d) throw new ApiError('BAD_TOKEN', 'Ticket is for a different drop');

    const drop = await getDropCached(t, d);
    if (drop.state !== 'Live') throw new ApiError('NOT_LIVE', 'This drop is not open');
    const variant = drop.variants.find((v) => v.id === body.variantId);
    if (!variant) throw new ApiError('VALIDATION', 'Unknown variant');
    const qty = body.qty ?? 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > drop.perBuyerLimit) {
      throw new ApiError('VALIDATION', `Quantity must be 1 to ${drop.perBuyerLimit}`);
    }

    // Admission: a pure function of the ticket, the drop and the frozen early-group size (decision 0003).
    const start = admissionStartsAt(drop);
    if (drop.earlyCount === undefined) {
      throw new ApiError('NOT_ADMITTED', 'The queue has not started moving yet', Math.max(1, Math.ceil((start + FREEZE_DELAY_MS - now) / 1000)));
    }
    const rate = dropAdmissionRate(drop);
    const at = claimWindowStart(admittedAt('r' in ticket ? { r: ticket.r } : { n: ticket.n }, start, rate, drop.earlyCount), ticket.iat);
    const admission = checkAdmission(at, drop.admitWindowSec, now);
    if (!admission.ok) {
      throw new ApiError(
        admission.reason,
        admission.reason === 'NOT_ADMITTED' ? 'Not your turn yet' : 'Your turn to claim has passed',
        admission.retryAfterSec,
      );
    }

    const shard = await reserve(drop, variant, qty);
    if (shard === undefined) {
      throw new ApiError('VARIANT_SOLD_OUT', qty > 1 ? `Fewer than ${qty} ${variant.name} left; try fewer` : `${variant.name} is sold out`);
    }

    const hold: Hold = {
      tenantId: t, dropId: d, holdId: ticketId(ticket), variantId: variant.id, qty, shard,
      state: 'active', createdAt: now, expiresAt: now + drop.holdSec * 1000,
    };
    // Tells our own write apart from a duplicate when an SDK retry of a write that did land hits the condition.
    const nonce = randomUUID();
    try {
      await ddb.send(new PutCommand({
        TableName: table(),
        Item: {
          ...keys.hold(t, d, hold.holdId), type: 'Hold', ...hold, nonce,
          GSI1PK: keys.holdIndex(t, d), GSI1SK: new Date(hold.expiresAt).toISOString(),
          ttl: Math.floor(hold.expiresAt / 1000) + 86_400,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
    } catch (e) {
      // Any other error is ambiguous (the write may have landed), so keep the units: undersell, never oversell.
      if (!isConditionFailure(e)) throw e;
      const existing = await getHold(t, d, hold.holdId);
      if ((existing as { nonce?: string } | undefined)?.nonce === nonce) return holdResponse(201, hold, key);
      // A duplicate claim for the same ticket: give back what this request reserved and return the first hold.
      await returnUnits(t, d, variant.id, shard, qty);
      if (existing?.state === 'active' && existing.expiresAt > now) return holdResponse(200, existing, key);
      if (existing?.state === 'confirmed') throw new ApiError('INVALID_STATE', 'This ticket already has an order');
      throw new ApiError('HOLD_EXPIRED', 'This ticket’s hold has expired');
    }

    console.log(JSON.stringify({ metric: 'claim', t, d, holdId: hold.holdId, variantId: variant.id, qty, shard, latencyFromAdmitMs: now - at }));
    return holdResponse(201, hold, key);
  } catch (err) {
    return errorResult(err);
  }
}
