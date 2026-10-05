import type { Context } from 'aws-lambda';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  admissionStartsAt, admittedCount, dropAdmissionRate, FREEZE_DELAY_MS, keys, watermark, type Drop, type PublicState,
} from '@dropdeck/shared';
import { ddb, getDrop, isConditionFailure, table } from '@dropdeck/shared/ddb';
import { writeState } from './publish.js';
import { upsertTickSchedule } from './schedule.js';

/**
 * Invoked by EventBridge Scheduler.
 *   { action: 'open', tenantId, dropId }  one-off at the entry-window start: Scheduled → Live, arm the ticks
 *   { action: 'tick', tenantId, dropId }  every minute while Live; loops for ~55 s, one tick every 2.5 s
 *
 * Stateless and safe to run twice: the watermark is a function of time and the frozen early-group size,
 * and every write that is not a function of time is conditional (decision 0003).
 *
 * Phase 3 adds to each tick: sweep expired holds (conditional active → released), sold-out flags, closing
 * at endAt or one hold window after the last sell-out, and stopping on a Cancelled drop.
 */
interface ControllerEvent {
  action: 'open' | 'tick';
  tenantId: string;
  dropId: string;
}

const TICK_MS = 2500;
const RUN_MS = 55_000;

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ level: 'info', msg, ...extra }));

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

/** One tick. Returns the state it published (or would have), or null when the drop is no longer Live. */
export async function tickOnce(t: string, d: string, nowMs: number, last?: PublicState): Promise<PublicState | null> {
  const drop = await getDrop(t, d); // fresh each tick: state and earlyCount must be current
  if (drop.state !== 'Live') return null;
  const start = admissionStartsAt(drop);
  let early = drop.earlyCount;
  if (early === undefined && nowMs >= start + FREEZE_DELAY_MS) early = await freezeEarlyCount(drop);
  const wm = early === undefined
    ? { rThreshold: 0, nWatermark: 0 }
    : watermark(admittedCount(start, dropAdmissionRate(drop), nowMs), early);
  const state: PublicState = { state: 'Live', serverTime: new Date(nowMs).toISOString(), ...wm, earlyCount: early ?? null, soldOut: {} };
  // Publish only when something moved (the first tick of each invocation always publishes).
  const moved = !last || wm.rThreshold > last.rThreshold || wm.nWatermark > last.nWatermark || state.earlyCount !== last.earlyCount;
  if (moved) await writeState(t, d, state);
  return state;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function handler(event: ControllerEvent, context: Pick<Context, 'invokedFunctionArn' | 'getRemainingTimeInMillis'>) {
  const { tenantId: t, dropId: d } = event;
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
  return { ok: true, ticks, last };
}
