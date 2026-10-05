import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { randomBytes } from 'node:crypto';
import {
  ALWAYS_EDITABLE, ApiError, canTransition, errorResult, isLockedForEdit, json, parseBody,
  type Drop, type MerchantProfile,
} from '@dropdeck/shared';
import * as repo from './repo.js';
import * as pub from './publish.js';
import { assertSchedulable, DEFAULTS, validateDropInput } from './validate.js';

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
        const b = body();
        const profile: MerchantProfile = {
          tenantId: t,
          name: String(b.name ?? '').slice(0, 80) || 'My shop',
          slug: String(b.slug ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || t.slice(0, 8),
          logoUrl: typeof b.logoUrl === 'string' ? b.logoUrl : undefined,
          colour: typeof b.colour === 'string' ? b.colour : undefined,
          paynow: typeof b.paynow === 'string' ? b.paynow : undefined,
          fulfilmentNote: typeof b.fulfilmentNote === 'string' ? b.fulfilmentNote.slice(0, 300) : undefined,
          tier: 'starter',
        };
        await repo.putProfile(profile);
        return json(200, profile);
      }

      case 'GET /m/drops':
        return json(200, await repo.listDrops(t));

      case 'POST /m/drops': {
        const input = validateDropInput(body());
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
        const patch = validateDropInput(body(), true);
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
        if (next.state === 'Scheduled') await pub.writeDropJson(next, await repo.getProfile(t));
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
        return json(200, scheduled);
      }

      case 'POST /m/drops/{dropId}/unschedule': {
        const drop = await repo.getDrop(t, d!);
        if (drop.state !== 'Scheduled' || isLockedForEdit(drop, new Date())) {
          throw new ApiError('LOCKED_FOR_EDIT', 'Only a scheduled drop before its entry window can be unscheduled');
        }
        await pub.deleteOpenSchedule(drop);
        await Promise.all([pub.deleteDropJson(drop), pub.deleteStateJson(drop)]);
        return json(200, await repo.transition(drop, 'Draft'));
      }

      case 'POST /m/drops/{dropId}/cancel': {
        const drop = await repo.getDrop(t, d!);
        if (!canTransition(drop.state, 'Cancelled')) throw new ApiError('INVALID_STATE', `Cannot cancel a ${drop.state} drop`);
        await pub.deleteOpenSchedule(drop);
        const cancelled = await repo.transition(drop, 'Cancelled');
        // drop.json stays so the page can say the drop was cancelled rather than "not found".
        // A Live drop's active holds are voided by the controller when it sees the Cancelled state.
        await pub.writeStateJson(cancelled, 'Cancelled');
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

      // Week 3 (enhance and harden): live view, orders, export, report.
      case 'GET /m/drops/{dropId}/live':
      case 'GET /m/drops/{dropId}/orders':
      case 'PATCH /m/orders/{ref}':
      case 'GET /m/drops/{dropId}/export.csv':
      case 'GET /m/drops/{dropId}/report':
        throw new ApiError('NOT_IMPLEMENTED', `${event.routeKey} is planned for week 3`);

      default:
        throw new ApiError('NOT_FOUND', `No route ${event.routeKey}`);
    }
  } catch (err) {
    return errorResult(err);
  }
}

/** Routes registered in infra; keep in sync with the switch above. */
export const ROUTES = [
  'GET /m/profile', 'PUT /m/profile',
  'GET /m/drops', 'POST /m/drops',
  'GET /m/drops/{dropId}', 'PATCH /m/drops/{dropId}', 'DELETE /m/drops/{dropId}',
  'POST /m/drops/{dropId}/schedule', 'POST /m/drops/{dropId}/unschedule',
  'POST /m/drops/{dropId}/cancel', 'POST /m/drops/{dropId}/duplicate',
  'GET /m/drops/{dropId}/live', 'GET /m/drops/{dropId}/orders', 'PATCH /m/orders/{ref}',
  'GET /m/drops/{dropId}/export.csv', 'GET /m/drops/{dropId}/report',
] as const;
