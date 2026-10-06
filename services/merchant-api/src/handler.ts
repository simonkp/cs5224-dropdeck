import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { randomBytes } from 'node:crypto';
import {
  ALWAYS_EDITABLE, ApiError, canTransition, errorResult, isLockedForEdit, json, parseBody, slugProblem,
  type Drop, type MerchantProfile,
} from '@dropdeck/shared';
import * as repo from './repo.js';
import * as pub from './publish.js';
import { buildReport, ordersCsv } from './reports.js';
import { activeHoldCount, unitsSold } from '@dropdeck/shared/ddb';
import { decodeImage } from './images.js';
import { assertSchedulable, DEFAULTS, validateDropInput, validateProfileInput } from './validate.js';

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

const newId = () => randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').toLowerCase();

/** Fields baked into the open schedule and the stock shards; changing them means unschedule, edit, reschedule. */
const SCHEDULE_FIELDS: ReadonlyArray<keyof Drop> = ['openAt', 'entryWindowMin', 'variants', 'shardCount'];

/** Undo a half-finished /schedule. Best effort on the side effects; the state flip back is what matters. */
async function rollbackSchedule(drop: Drop): Promise<void> {
  const results = await Promise.allSettled([pub.deleteOpenSchedule(drop), pub.deleteDropJson(drop), pub.deleteStateJson(drop)]);
  for (const r of results) {
    if (r.status === 'rejected') console.error(JSON.stringify({ level: 'error', msg: 'schedule rollback step failed', err: String(r.reason) }));
  }
  await repo.transition(drop, 'Draft');
}

function tenantOf(event: Event): string {
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== 'string') throw new ApiError('UNAUTHORIZED', 'No merchant identity');
  return sub;
}

export async function handler(event: Event) {
  try {
    const t = tenantOf(event);
    const d = event.pathParameters?.dropId;
    const body = () => parseBody<Record<string, unknown>>(event.body, event.isBase64Encoded);

    switch (event.routeKey) {
      case 'GET /m/profile':
        return json(200, (await repo.getProfile(t)) ?? null);

      case 'PUT /m/profile': {
        // A merge: fields left out keep their value, null clears one. The tier is never the merchant's to set.
        const patch = validateProfileInput(body(), t);
        const cur = await repo.getProfile(t);
        // Without a chosen slug, the tenant ID itself: unique by construction (the console always sends one).
        const fallbackSlug = t.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
        const next: MerchantProfile = { name: 'My shop', slug: fallbackSlug, theme: 'auto', ...cur, tenantId: t, tier: cur?.tier ?? 'starter' };
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete (next as unknown as Record<string, unknown>)[k];
          else (next as unknown as Record<string, unknown>)[k] = v;
        }
        const saved = await repo.saveProfile(next, cur);
        // New branding reaches pages already out there; a moved slug takes the old shop page down.
        const drops = await repo.listDrops(t);
        await Promise.all([
          pub.republishBranding(saved, drops),
          pub.writeShopJson(saved, drops).catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'shop.json write failed', err: String(e) }))),
          cur?.slugClaimed && cur.slug !== saved.slug
            ? pub.deleteShopJson(cur.slug).catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'old shop.json delete failed', err: String(e) })))
            : undefined,
        ]);
        return json(200, saved);
      }

      case 'GET /m/slugs/{slug}': {
        const slug = String(event.pathParameters?.slug ?? '').toLowerCase();
        const problem = slugProblem(slug);
        const owner = problem ? undefined : await repo.slugOwner(slug);
        const taken = owner !== undefined && owner !== t;
        return json(200, { slug, available: !problem && !taken, problem: problem ?? (taken ? 'That shop link is taken' : null) });
      }

      case 'POST /m/uploads': {
        const img = decodeImage(body().image);
        await repo.bumpUploadQuota(t);
        const path = await pub.putImage(t, img);
        return json(201, { path, contentType: img.contentType, bytes: img.bytes.length });
      }

      case 'GET /m/drops':
        return json(200, await repo.listDrops(t));

      case 'POST /m/drops': {
        const input = validateDropInput(body(), false, t);
        const now = new Date().toISOString();
        const drop: Drop = {
          ...DEFAULTS,
          ...input,
          tenantId: t,
          dropId: newId(),
          state: 'Draft',
          createdAt: now,
          updatedAt: now,
          version: 1,
        } as Drop;
        await repo.createDrop(drop);
        return json(201, drop);
      }

      case 'GET /m/drops/{dropId}':
        return json(200, await repo.getDrop(t, d!));

      case 'PATCH /m/drops/{dropId}': {
        const current = await repo.getDrop(t, d!);
        const patch = validateDropInput(body(), true, t);
        const locked = isLockedForEdit(current, new Date());
        const touched = Object.keys(patch) as (keyof Drop)[];
        if (current.state === 'Closed' || current.state === 'Cancelled' || current.state === 'Live') {
          throw new ApiError('LOCKED_FOR_EDIT', `A ${current.state} drop cannot be edited`);
        }
        if (locked && touched.some((k) => !ALWAYS_EDITABLE.includes(k))) {
          throw new ApiError('LOCKED_FOR_EDIT', 'Stock, price and times are locked once the entry window opens');
        }
        if (current.state === 'Scheduled' && touched.some((k) => SCHEDULE_FIELDS.includes(k))) {
          throw new ApiError('LOCKED_FOR_EDIT', 'Unschedule the drop to change its times, variants or stock');
        }
        const merged = { ...current, ...patch };
        if (Date.parse(merged.endAt) <= Date.parse(merged.openAt)) throw new ApiError('VALIDATION', 'endAt must be after openAt');
        const next = await repo.saveDrop(merged, current.version);
        if (next.state === 'Scheduled') {
          await pub.writeDropJson(next, await repo.getProfile(t));
          await pub.refreshShop(t, next);
        }
        return json(200, next);
      }

      case 'DELETE /m/drops/{dropId}':
        await repo.deleteDraft(t, d!);
        return { statusCode: 204, headers: {}, body: '' };

      case 'POST /m/drops/{dropId}/schedule': {
        const drop = await repo.getDrop(t, d!);
        if (!canTransition(drop.state, 'Scheduled')) throw new ApiError('INVALID_STATE', `Cannot schedule a ${drop.state} drop`);
        assertSchedulable(drop, new Date());
        // Flip the state first: of two concurrent requests only one gets past this conditional write,
        // so the loser can never roll back the winner's schedule.
        const scheduled = await repo.transition(drop, 'Scheduled');
        try {
          await repo.writeStockShards(scheduled);
          await pub.writeDropJson(scheduled, await repo.getProfile(t));
          await pub.writeStateJson(scheduled, 'Scheduled');
          await pub.createOpenSchedule(scheduled);
        } catch (e) {
          await rollbackSchedule(scheduled);
          throw e;
        }
        await pub.refreshShop(t, scheduled);
        return json(200, scheduled);
      }

      case 'POST /m/drops/{dropId}/unschedule': {
        const drop = await repo.getDrop(t, d!);
        if (drop.state !== 'Scheduled' || isLockedForEdit(drop, new Date())) {
          throw new ApiError('LOCKED_FOR_EDIT', 'Only a scheduled drop before its entry window can be unscheduled');
        }
        await pub.deleteOpenSchedule(drop);
        await Promise.all([pub.deleteDropJson(drop), pub.deleteStateJson(drop)]);
        const draft = await repo.transition(drop, 'Draft');
        await pub.refreshShop(t, draft);
        return json(200, draft);
      }

      case 'POST /m/drops/{dropId}/cancel': {
        const drop = await repo.getDrop(t, d!);
        if (!canTransition(drop.state, 'Cancelled')) throw new ApiError('INVALID_STATE', `Cannot cancel a ${drop.state} drop`);
        await pub.deleteOpenSchedule(drop);
        const cancelled = await repo.transition(drop, 'Cancelled');
        // drop.json stays so the page can say the drop was cancelled rather than "not found".
        // A Live drop's active holds are voided by the controller when it sees the Cancelled state.
        await pub.writeStateJson(cancelled, 'Cancelled');
        await pub.refreshShop(t, cancelled);
        return json(200, cancelled);
      }

      case 'POST /m/drops/{dropId}/duplicate': {
        const src = await repo.getDrop(t, d!);
        const now = new Date().toISOString();
        const copy: Drop = {
          ...src, dropId: newId(), state: 'Draft', title: `${src.title} (copy)`,
          earlyCount: undefined, createdAt: now, updatedAt: now, version: 1,
        };
        await repo.createDrop(copy);
        return json(201, copy);
      }

      case 'GET /m/drops/{dropId}/live': {
        // While Live, units out (held or confirmed) come from the stock counters; orders are the confirmed part.
        const drop = await repo.getDrop(t, d!);
        const [sold, holds, orders, queue] = await Promise.all([unitsSold(drop), activeHoldCount(drop), repo.listOrders(t, d!), repo.queueCounts(drop)]);
        return json(200, {
          state: drop.state,
          variants: drop.variants.map((v) => ({ id: v.id, name: v.name, stock: v.stock, out: sold[v.id] ?? 0 })),
          activeHolds: holds,
          orders: orders.length,
          unitsOrdered: orders.reduce((n, o) => n + o.qty, 0),
          queue,
        });
      }

      case 'GET /m/drops/{dropId}/orders':
        await repo.getDrop(t, d!); // tenant check: a drop that is not yours is NOT_FOUND
        return json(200, await repo.listOrders(t, d!));

      case 'PATCH /m/orders/{ref}': {
        const b = body();
        const status = b.status;
        if (status !== 'paid' && status !== 'no-show' && status !== 'confirmed') throw new ApiError('VALIDATION', 'status must be paid, no-show or confirmed');
        if (typeof b.dropId !== 'string') throw new ApiError('VALIDATION', 'dropId is required');
        return json(200, await repo.setOrderStatus(t, b.dropId, event.pathParameters!.ref!, status));
      }

      case 'GET /m/drops/{dropId}/export.csv': {
        const drop = await repo.getDrop(t, d!);
        const name = drop.title.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || drop.dropId;
        return {
          statusCode: 200,
          headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}-orders.csv"`, 'cache-control': 'no-store' },
          body: ordersCsv(await repo.listOrders(t, d!)),
        };
      }

      case 'GET /m/drops/{dropId}/report': {
        const drop = await repo.getDrop(t, d!);
        const [orders, queue] = await Promise.all([repo.listOrders(t, d!), repo.queueCounts(drop)]);
        return json(200, buildReport(drop, orders, queue));
      }

      default:
        throw new ApiError('NOT_FOUND', `No route ${event.routeKey}`);
    }
  } catch (err) {
    return errorResult(err);
  }
}

/** Routes registered in infra; keep in sync with the switch above. */
export const ROUTES = [
  'GET /m/profile', 'PUT /m/profile', 'GET /m/slugs/{slug}', 'POST /m/uploads',
  'GET /m/drops', 'POST /m/drops',
  'GET /m/drops/{dropId}', 'PATCH /m/drops/{dropId}', 'DELETE /m/drops/{dropId}',
  'POST /m/drops/{dropId}/schedule', 'POST /m/drops/{dropId}/unschedule',
  'POST /m/drops/{dropId}/cancel', 'POST /m/drops/{dropId}/duplicate',
  'GET /m/drops/{dropId}/live', 'GET /m/drops/{dropId}/orders', 'PATCH /m/orders/{ref}',
  'GET /m/drops/{dropId}/export.csv', 'GET /m/drops/{dropId}/report',
] as const;
