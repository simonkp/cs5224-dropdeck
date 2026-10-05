import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { entryOpensAt, s3Keys, type Drop, type MerchantProfile, type PublicDrop } from '@dropdeck/shared';
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

const scheduleName = (drop: Drop) => `open-${drop.dropId}`;

/** One-off schedule at the entry-window start; the controller moves the drop to Live. */
export async function createOpenSchedule(drop: Drop): Promise<void> {
  const at = entryOpensAt(drop).toISOString().slice(0, 19);
  await scheduler.send(new CreateScheduleCommand({
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
  }));
}

export async function deleteOpenSchedule(drop: Drop): Promise<void> {
  try {
    await scheduler.send(new DeleteScheduleCommand({ Name: scheduleName(drop), GroupName: env.scheduleGroup() }));
  } catch (e) {
    if ((e as { name?: string }).name !== 'ResourceNotFoundException') throw e;
  }
}
