import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient, UpdateScheduleCommand,
  type CreateScheduleCommandInput,
} from '@aws-sdk/client-scheduler';
import {
  entryOpensAt, OPEN_LEAD_MS, s3Keys, type Drop, type DropState, type MerchantProfile, type PublicDrop, type PublicState,
} from '@dropdeck/shared';
import { env } from './env.js';

const s3 = new S3Client({});
const scheduler = new SchedulerClient({});

export function toPublicDrop(drop: Drop, profile: MerchantProfile | undefined): PublicDrop {
  return {
    tenantId: drop.tenantId,
    dropId: drop.dropId,
    merchant: { name: profile?.name ?? 'DropDeck merchant', logoUrl: profile?.logoUrl, colour: profile?.colour },
    title: drop.title,
    description: drop.description,
    imageUrl: drop.imageUrl,
    variants: drop.variants.map(({ id, name, priceCents }) => ({ id, name, priceCents })),
    openAt: drop.openAt,
    endAt: drop.endAt,
    entryOpensAt: entryOpensAt(drop).toISOString(),
    perBuyerLimit: drop.perBuyerLimit,
    holdSec: drop.holdSec,
    admitWindowSec: drop.admitWindowSec,
    verification: drop.verification,
  };
}

export async function writeDropJson(drop: Drop, profile: MerchantProfile | undefined): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: env.bucket(),
    Key: s3Keys.dropJson(drop.tenantId, drop.dropId),
    Body: JSON.stringify(toPublicDrop(drop, profile)),
    ContentType: 'application/json',
    CacheControl: 'public, max-age=30',
  }));
}

export async function deleteDropJson(drop: Drop): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.bucket(), Key: s3Keys.dropJson(drop.tenantId, drop.dropId) }));
}

/** Pre-open (or terminal) state. Once Live, the controller owns state.json and rewrites it every tick. */
export function initialState(state: DropState, now = new Date()): PublicState {
  return { state, serverTime: now.toISOString(), rThreshold: 0, nWatermark: 0, earlyCount: null, soldOut: {} };
}

export async function writeStateJson(drop: Drop, state: DropState): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: env.bucket(),
    Key: s3Keys.stateJson(drop.tenantId, drop.dropId),
    Body: JSON.stringify(initialState(state)),
    ContentType: 'application/json',
    CacheControl: 'public, max-age=2',
  }));
}

export async function deleteStateJson(drop: Drop): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.bucket(), Key: s3Keys.stateJson(drop.tenantId, drop.dropId) }));
}

const scheduleName = (drop: Drop) => `open-${drop.dropId}`;

/**
 * One-off schedule OPEN_LEAD_MS (90 s) before the entry window; the controller moves the drop to Live.
 * Upserts, so a retried /schedule (or one after a failed rollback) does not trip on ConflictException.
 */
export async function createOpenSchedule(drop: Drop): Promise<void> {
  const at = new Date(entryOpensAt(drop).getTime() - OPEN_LEAD_MS).toISOString().slice(0, 19);
  const input: CreateScheduleCommandInput = {
    Name: scheduleName(drop),
    GroupName: env.scheduleGroup(),
    ScheduleExpression: `at(${at})`,
    ScheduleExpressionTimezone: 'UTC',
    FlexibleTimeWindow: { Mode: 'OFF' },
    ActionAfterCompletion: 'DELETE',
    Target: {
      Arn: env.controllerArn(),
      RoleArn: env.schedulerRoleArn(),
      Input: JSON.stringify({ action: 'open', tenantId: drop.tenantId, dropId: drop.dropId }),
    },
  };
  try {
    await scheduler.send(new CreateScheduleCommand(input));
  } catch (e) {
    if ((e as { name?: string }).name !== 'ConflictException') throw e;
    await scheduler.send(new UpdateScheduleCommand(input));
  }
}

export async function deleteOpenSchedule(drop: Drop): Promise<void> {
  try {
    await scheduler.send(new DeleteScheduleCommand({ Name: scheduleName(drop), GroupName: env.scheduleGroup() }));
  } catch (e) {
    if ((e as { name?: string }).name !== 'ResourceNotFoundException') throw e;
  }
}
