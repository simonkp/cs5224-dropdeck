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
        const next = await repo.saveDrop({ ...current, ...patch }, current.version);
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
        await repo.writeStockShards(drop);
        await pub.writeDropJson(drop, await repo.getProfile(t));
        await pub.createOpenSchedule(drop);
        return json(200, await repo.transition(drop, 'Scheduled'));
      }

      case 'POST /m/drops/{dropId}/unschedule': {
        const drop = await repo.getDrop(t, d!);
        if (drop.state !== 'Scheduled' || isLockedForEdit(drop, new Date())) {
          throw new ApiError('LOCKED_FOR_EDIT', 'Only a scheduled drop before its entry window can be unscheduled');
        }
        await pub.deleteOpenSchedule(drop);
        await pub.deleteDropJson(drop);
        return json(200, await repo.transition(drop, 'Draft'));
      }

      case 'POST /m/drops/{dropId}/cancel': {
        const drop = await repo.getDrop(t, d!);
        if (!canTransition(drop.state, 'Cancelled')) throw new ApiError('INVALID_STATE', `Cannot cancel a ${drop.state} drop`);
        await pub.deleteOpenSchedule(drop);
        // TODO(week 2): the controller publishes state.json with state=Cancelled and voids active holds.
        return json(200, await repo.transition(drop, 'Cancelled'));
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
