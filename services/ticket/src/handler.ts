import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { admissionStartsAt, ApiError, errorResult, json, keys, sign, type TicketClaims } from '@dropdeck/shared';
import { ddb, getDropCached, table } from '@dropdeck/shared/ddb';
import { ssmSecret } from '@dropdeck/shared/secrets';

/**
 * POST /api/d/{tenantId}/{dropId}/ticket
 *
 * Before admission start (openAt + graceSec) a buyer joins the random draw: r ~ U[0,1), one ADD to a random
 * early-counter shard. After it, buyers get sequential numbers from this instance's block, reserved with one
 * ADD per block, so the counter item sees one write per BLOCK_SIZE tickets. Tickets are signed, not stored
 * (decision 0006): the claim recomputes admission from the token alone.
 */

const tokenKey = ssmSecret('TOKEN_KEY_PARAM');
const BLOCK_SIZE = Number(process.env.BLOCK_SIZE ?? 10);
const EARLY_SHARDS = 8;
/** Identifies this instance in the fairness logs (numbers interleave across instances by up to one block). */
const instance = randomUUID().slice(0, 8);
const blocks = new Map<string, { next: number; end: number; refill?: Promise<void> }>();

/** Uniform r in [0,1) from 48 bits of the CSPRNG. */
const drawR = () => randomBytes(6).readUIntBE(0, 6) / 2 ** 48;

async function reserveBlock(t: string, d: string): Promise<number> {
  const r = await ddb.send(new UpdateCommand({
    TableName: table(),
    Key: keys.ticketCounter(t, d),
    UpdateExpression: 'ADD v :b',
    ExpressionAttributeValues: { ':b': BLOCK_SIZE },
    ReturnValues: 'UPDATED_NEW',
  }));
  return Number(r.Attributes?.v);
}

/**
 * Concurrent callers on one instance share a single refill; otherwise each would reserve (and waste) a block,
 * inflating numbers and pushing buyers back in the queue.
 */
async function nextLateNumber(t: string, d: string): Promise<{ n: number; block: number }> {
  const k = `${t}#${d}`;
  let b = blocks.get(k);
  if (!b) blocks.set(k, (b = { next: 0, end: 0 }));
  while (b.next >= b.end) {
    const block = b;
    block.refill ??= reserveBlock(t, d)
      .then((v) => { block.next = v - BLOCK_SIZE; block.end = v; })
      .finally(() => { block.refill = undefined; });
    await block.refill;
  }
  return { n: b.next++, block: b.end - BLOCK_SIZE };
}

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const t = event.pathParameters?.tenantId;
    const d = event.pathParameters?.dropId;
    if (!t || !d) throw new ApiError('NOT_FOUND', 'No such drop');
    const now = Date.now();
    const drop = await getDropCached(t, d);
    if (drop.state !== 'Live') {
      throw new ApiError('NOT_LIVE', drop.state === 'Scheduled' ? 'The queue has not opened yet' : 'This drop is not open');
    }
    if (now > Date.parse(drop.endAt)) throw new ApiError('NOT_LIVE', 'This drop has ended');

    const start = admissionStartsAt(drop);
    const exp = Date.parse(drop.endAt) + drop.holdSec * 1000;
    let claims: TicketClaims;
    let block: number | undefined;
    if (now < start) {
      claims = { k: 'ticket', t, d, r: drawR(), iat: now, exp };
      await ddb.send(new UpdateCommand({
        TableName: table(),
        Key: keys.earlyCounter(t, d, randomInt(EARLY_SHARDS)),
        UpdateExpression: 'ADD v :one',
        ExpressionAttributeValues: { ':one': 1 },
      }));
    } else {
      const late = await nextLateNumber(t, d);
      block = late.block;
      claims = { k: 'ticket', t, d, n: late.n, iat: now, exp };
    }
    const position = 'r' in claims ? { r: claims.r } : { n: claims.n };

    // One structured line per ticket: the fairness experiment compares arrival order with admission order.
    console.log(JSON.stringify({ metric: 'ticket', t, d, arrival: now, ...position, block, instance }));
    return json(201, { ticket: sign(claims, await tokenKey()), ...position, admissionStartsAt: new Date(start).toISOString() });
  } catch (err) {
    return errorResult(err);
  }
}
