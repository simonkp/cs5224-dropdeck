import type { Context } from 'aws-lambda';
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  admissionStartsAt, admittedCount, dropAdmissionRate, entryOpensAt, FREEZE_DELAY_MS, keys, OPEN_LEAD_MS, toPublicShop,
  toPublicFeatured, usageMonth, watermark, type Drop, type Order, type PublicState,
} from '@dropdeck/shared';
import { ddb, getDrop, getProfile, isConditionFailure, listDrops, listFeatured, syncFeatured, table } from '@dropdeck/shared/ddb';
import { activeHoldCount, closeDrop, soldOutFlags, sweepExpired, unitsSold, voidActiveHolds } from './ops.js';
import { writeFeaturedJson, writeShopJson, writeState } from './publish.js';
import { deleteTickSchedule, upsertTickSchedule } from './schedule.js';

/**
 * Invoked by EventBridge Scheduler.
 *   { action: 'open', tenantId, dropId }  one-off at the entry-window start: Scheduled → Live, arm the ticks
 *   { action: 'tick', tenantId, dropId }  every minute while Live; loops for ~55 s, one tick every 2.5 s
 *
 * Stateless and safe to run twice: the watermark is a function of time and the frozen early-group size,
 * and every write that is not a function of time is conditional (decision 0003).
 *
 * Each tick: sweep expired holds back to stock, publish the watermark and sold-out flags, and close the drop at
 * endAt or once every variant is gone with no hold left open (at most one hold window after the last sale).
 * A drop that is no longer Live is finished: holds voided if it was cancelled, the terminal state.json
 * republished, the tick schedule deleted.
 */
interface ControllerEvent {
  action: 'open' | 'tick';
  tenantId: string;
  dropId: string;
}

const TICK_MS = 2500;
const RUN_MS = 55_000;

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ level: 'info', msg, ...extra }));

/**
 * Best effort: a failed shop page refresh must never stop a drop opening or closing. `changed` is the drop just moved,
 * laid over the list because the query can still return its previous state for a moment.
 */
async function refreshShop(t: string, changed: Drop): Promise<void> {
  try {
    const profile = await getProfile(t);
    if (!profile?.slugClaimed) return;
    const drops = (await listDrops(t)).map((x) => (x.dropId === changed.dropId ? changed : x));
    await writeShopJson(profile.slug, toPublicShop(profile, drops));
    if (profile.listed) {
      await syncFeatured(profile, [changed]);
      await writeFeaturedJson(toPublicFeatured(await listFeatured()));
    }
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'shop.json refresh failed', t, err: String(e) }));
  }
}

async function open(t: string, d: string, controllerArn: string): Promise<boolean> {
  let drop = await getDrop(t, d);
  if (drop.state === 'Scheduled') {
    try {
      await ddb.send(new UpdateCommand({
        TableName: table(),
        Key: keys.drop(t, d),
        UpdateExpression: 'SET #s = :live, version = version + :one, updatedAt = :now',
        ConditionExpression: '#s = :scheduled',
        ExpressionAttributeNames: { '#s': 'state' },
        ExpressionAttributeValues: { ':live': 'Live', ':scheduled': 'Scheduled', ':one': 1, ':now': new Date().toISOString() },
      }));
      drop = { ...drop, state: 'Live' };
      // Scheduler lag is an evaluation number: how late the open fired against when it was scheduled.
      const scheduledFor = entryOpensAt(drop).getTime() - OPEN_LEAD_MS;
      log('opened', { t, d, lagMs: Date.now() - scheduledFor, msBeforeEntry: entryOpensAt(drop).getTime() - Date.now() });
      await refreshShop(t, drop);
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
      drop = await getDrop(t, d); // another invocation won, or the merchant cancelled
    }
  }
  if (drop.state !== 'Live') {
    log('open skipped', { t, d, state: drop.state });
    return false;
  }
  await upsertTickSchedule(drop, controllerArn);
  return true;
}

/** Sum the early-counter shards once and record it on the drop; the first writer wins, later ones adopt it. */
async function freezeEarlyCount(drop: Drop): Promise<number> {
  const r = await ddb.send(new QueryCommand({
    TableName: table(),
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': keys.earlyCounter(drop.tenantId, drop.dropId, 0).PK, ':sk': 'COUNTER#early#' },
    ConsistentRead: true,
  }));
  const early = (r.Items ?? []).reduce((n, i) => n + Number(i.v ?? 0), 0);
  try {
    await ddb.send(new UpdateCommand({
      TableName: table(),
      Key: keys.drop(drop.tenantId, drop.dropId),
      UpdateExpression: 'SET earlyCount = :e',
      ConditionExpression: 'attribute_not_exists(earlyCount)',
      ExpressionAttributeValues: { ':e': early },
    }));
    log('early group frozen', { t: drop.tenantId, d: drop.dropId, earlyCount: early });
    return early;
  } catch (e) {
    if (!isConditionFailure(e)) throw e;
    return (await getDrop(drop.tenantId, drop.dropId)).earlyCount ?? early;
  }
}

/** Everyone who took a ticket: the early group (frozen, or summed if the drop ended before the freeze) plus late tickets. */
async function sessionsOf(drop: Drop): Promise<number> {
  const late = await ddb.send(new GetCommand({ TableName: table(), Key: keys.ticketCounter(drop.tenantId, drop.dropId) }));
  let early = drop.earlyCount;
  if (early === undefined) {
    const r = await ddb.send(new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': keys.earlyCounter(drop.tenantId, drop.dropId, 0).PK, ':sk': 'COUNTER#early#' },
    }));
    early = (r.Items ?? []).reduce((n, i) => n + Number(i.v ?? 0), 0);
  }
  return early + Number(late.Item?.v ?? 0);
}

async function ordersOf(drop: Drop): Promise<Order[]> {
  const k = keys.orderPrefix(drop.tenantId, drop.dropId);
  const out: Order[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': k.PK, ':sk': k.SKPrefix },
      ExclusiveStartKey: start,
    }));
    out.push(...((r.Items ?? []) as Order[]));
    start = r.LastEvaluatedKey;
  } while (start);
  return out;
}

/**
 * Add a finished drop to its shop's monthly usage, exactly once: the drop's `meteredAt` is claimed in the same
 * transaction, and finish() runs on every tick that sees the drop over. Orders confirmed after this (a hold that
 * outlives the close) are not counted; that is a few units at most and only ever undercounts.
 * Not best effort: a failure throws, the tick schedule survives, and the next tick meters again.
 */
async function meter(drop: Drop): Promise<boolean> {
  if (drop.meteredAt) return false;
  const [sessions, orders] = await Promise.all([sessionsOf(drop), ordersOf(drop)]);
  const month = usageMonth(drop.openAt);
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: table(),
            Key: keys.drop(drop.tenantId, drop.dropId),
            UpdateExpression: 'SET meteredAt = :now',
            ConditionExpression: 'attribute_not_exists(meteredAt)',
            ExpressionAttributeValues: { ':now': new Date().toISOString() },
          },
        },
        {
          Update: {
            TableName: table(),
            Key: keys.usage(drop.tenantId, month),
            UpdateExpression: 'ADD drops :d, cancelled :c, sessions :s, orders :o, units :u, revenueCents :r SET #type = :type, tenantId = :t, #month = :m',
            ExpressionAttributeNames: { '#type': 'type', '#month': 'month' },
            ExpressionAttributeValues: {
              ':d': drop.state === 'Closed' ? 1 : 0, ':c': drop.state === 'Cancelled' ? 1 : 0, ':s': sessions,
              ':o': orders.length, ':u': orders.reduce((n, o) => n + o.qty, 0), ':r': orders.reduce((n, o) => n + o.amountCents, 0),
              ':type': 'Usage', ':t': drop.tenantId, ':m': month,
            },
          },
        },
      ],
    }));
  } catch (e) {
    const err = e as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
    if (err.name === 'TransactionCanceledException' && err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') return false;
    throw e;
  }
  log('drop metered', { t: drop.tenantId, d: drop.dropId, month, sessions, orders: orders.length });
  return true;
}

/**
 * Wind down a Closed or Cancelled drop. Idempotent, so every controller that notices runs it. Republishing the
 * terminal state.json here is what settles a merchant cancel racing a tick: the tick read Live, the merchant wrote
 * Cancelled, the tick's Live write landed last; the next tick sees Cancelled and puts the right file back.
 */
async function finish(drop: Drop, nowMs: number, soldOut?: Record<string, boolean>): Promise<void> {
  if (drop.state === 'Cancelled') {
    const voided = await voidActiveHolds(drop);
    if (voided) log('holds voided on cancel', { t: drop.tenantId, d: drop.dropId, voided });
  }
  await writeState(drop.tenantId, drop.dropId, {
    state: drop.state, serverTime: new Date(nowMs).toISOString(), rThreshold: 0, nWatermark: 0,
    earlyCount: drop.earlyCount ?? null, soldOut: soldOut ?? soldOutFlags(drop, await unitsSold(drop)),
  });
  await meter(drop);
  await refreshShop(drop.tenantId, drop);
  await deleteTickSchedule(drop);
}

/** One tick. Returns the state it published (or would have), or null when the drop is no longer Live. */
export async function tickOnce(t: string, d: string, nowMs: number, last?: PublicState): Promise<PublicState | null> {
  const drop = await getDrop(t, d); // fresh each tick: state and earlyCount must be current
  if (drop.state === 'Closed' || drop.state === 'Cancelled') {
    await finish(drop, nowMs);
    return null;
  }
  if (drop.state !== 'Live') return null;

  const released = await sweepExpired(drop, nowMs);
  if (released) log('expired holds released', { t, d, released });
  const soldOut = soldOutFlags(drop, await unitsSold(drop));
  const allGone = drop.variants.every((v) => soldOut[v.id]);
  if (nowMs >= Date.parse(drop.endAt) || (allGone && (await activeHoldCount(drop)) === 0)) {
    const closed = await closeDrop(drop, nowMs);
    if (closed) log('drop closed', { t, d, reason: allGone ? 'sold out' : 'ended' });
    // Re-read: if a cancel won the race, finish the drop as Cancelled.
    await finish(closed ? { ...drop, state: 'Closed' } : await getDrop(t, d), nowMs, soldOut);
    return null;
  }

  const start = admissionStartsAt(drop);
  let early = drop.earlyCount;
  if (early === undefined && nowMs >= start + FREEZE_DELAY_MS) early = await freezeEarlyCount(drop);
  const wm = early === undefined
    ? { rThreshold: 0, nWatermark: 0 }
    : watermark(admittedCount(start, dropAdmissionRate(drop), nowMs), early);
  const state: PublicState = { state: 'Live', serverTime: new Date(nowMs).toISOString(), ...wm, earlyCount: early ?? null, soldOut };
  // Publish only when something changed (the first tick of each invocation always publishes).
  const moved = !last || wm.rThreshold > last.rThreshold || wm.nWatermark > last.nWatermark
    || state.earlyCount !== last.earlyCount || JSON.stringify(soldOut) !== JSON.stringify(last.soldOut);
  if (moved) await writeState(t, d, state);
  return state;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function handler(event: ControllerEvent, context: Pick<Context, 'invokedFunctionArn' | 'getRemainingTimeInMillis'>) {
  const { tenantId: t, dropId: d } = event;
  log('controller invoked', { action: event.action, t, d });
  const deadline = Date.now() + Math.min(RUN_MS, context.getRemainingTimeInMillis() - 10_000);
  if (event.action === 'open' && !(await open(t, d, context.invokedFunctionArn))) return { ok: true, live: false };

  let last: PublicState | undefined;
  let ticks = 0;
  for (;;) {
    try {
      const state = await tickOnce(t, d, Date.now(), last);
      if (!state) break;
      last = state;
      ticks++;
    } catch (e) {
      // Self-healing: the next tick (or the next minute's invocation) recomputes everything from time.
      console.error(JSON.stringify({ level: 'error', msg: 'tick failed', t, d, err: String(e) }));
    }
    if (Date.now() + TICK_MS > deadline) break;
    await sleep(TICK_MS);
  }
  log('controller done', { action: event.action, t, d, ticks, state: last?.state ?? 'stopped' });
  return { ok: true, ticks, last };
}
