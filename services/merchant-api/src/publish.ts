import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient, UpdateScheduleCommand,
  type CreateScheduleCommandInput,
} from '@aws-sdk/client-scheduler';
import {
  entryOpensAt, OPEN_LEAD_MS, s3Keys, toPublicDrop, toPublicFeatured, toPublicShop, type Drop, type DropState,
  type MerchantProfile, type PublicState,
} from '@dropdeck/shared';
import { listFeatured, syncFeatured } from '@dropdeck/shared/ddb';
import { env } from './env.js';
import type { DecodedImage } from './images.js';
import * as repo from './repo.js';

const s3 = new S3Client({});
const scheduler = new SchedulerClient({});

/** Moved to the shared package so the seed script writes exactly what the API writes. */
export { toPublicDrop } from '@dropdeck/shared';

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

/** Uploaded images are content-addressed and never overwritten with different bytes, so they cache for a year. */
export async function putImage(t: string, img: DecodedImage): Promise<string> {
  const key = s3Keys.image(t, img.hash, img.ext);
  await s3.send(new PutObjectCommand({
    Bucket: env.bucket(),
    Key: key,
    Body: img.bytes,
    ContentType: img.contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return `/${key}`;
}

export async function writeShopJson(profile: MerchantProfile, drops: Drop[]): Promise<void> {
  if (!profile.slugClaimed) return;
  await s3.send(new PutObjectCommand({
    Bucket: env.bucket(),
    Key: s3Keys.shopJson(profile.slug),
    Body: JSON.stringify(toPublicShop(profile, drops)),
    ContentType: 'application/json',
    CacheControl: 'public, max-age=30',
  }));
}

export async function deleteShopJson(slug: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.bucket(), Key: s3Keys.shopJson(slug) }));
}

const warn = (msg: string, err: unknown, extra: Record<string, unknown> = {}) =>
  console.error(JSON.stringify({ level: 'error', msg, err: String(err), ...extra }));

/**
 * Rebuild the shop page after a drop changes. Best effort: the drop change has already happened, and the next change
 * (or the controller opening or closing the drop) writes the file again. `changed` is laid over the listed drops,
 * since the query can still return its previous version for a moment.
 */
export async function refreshShop(t: string, changed: Drop): Promise<void> {
  try {
    const profile = await repo.getProfile(t);
    if (!profile?.slugClaimed) return;
    const drops = (await repo.listDrops(t)).map((x) => (x.dropId === changed.dropId ? changed : x));
    await writeShopJson(profile, drops);
    if (profile.listed) await refreshFeatured(profile, [changed]);
  } catch (e) {
    warn('shop.json refresh failed', e, { t });
  }
}

/** DropDeck's homepage list (p/featured.json), rebuilt from the FEATURED partition after syncing `drops`. */
export async function refreshFeatured(profile: MerchantProfile | undefined, drops: Drop[]): Promise<void> {
  await syncFeatured(profile, drops);
  await s3.send(new PutObjectCommand({
    Bucket: env.bucket(),
    Key: s3Keys.featuredJson(),
    Body: JSON.stringify(toPublicFeatured(await listFeatured())),
    ContentType: 'application/json',
    CacheControl: 'public, max-age=60',
  }));
}

/** New branding reaches drop pages that are already published (Scheduled or Live). Returns how many failed. */
export async function republishBranding(profile: MerchantProfile, drops: Drop[]): Promise<number> {
  const published = drops.filter((d) => d.state === 'Scheduled' || d.state === 'Live');
  let failed = 0;
  for (let i = 0; i < published.length; i += 5) {
    const results = await Promise.allSettled(published.slice(i, i + 5).map((d) => writeDropJson(d, profile)));
    for (const r of results) {
      if (r.status === 'rejected') {
        failed++;
        warn('drop.json republish failed', r.reason, { t: profile.tenantId });
      }
    }
  }
  return failed;
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
