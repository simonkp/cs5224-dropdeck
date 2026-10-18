import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { CognitoIdentityProviderClient, ListUsersCommand, type UserType } from '@aws-sdk/client-cognito-identity-provider';
import { BatchGetCommand, QueryCommand, UpdateCommand, type BatchGetCommandOutput } from '@aws-sdk/lib-dynamodb';
import {
  ApiError, errorResult, invoicePreview, json, keys, parseBody, PLANS, TIERS, usageMonth,
  type MerchantProfile, type Tier, type Usage,
} from '@dropdeck/shared';
import { ddb, isConditionFailure, listDrops, strip, table } from '@dropdeck/shared/ddb';
import { analytics, healthOverview, dropTelemetry } from './operations.js';
import type { OpsRange } from '@dropdeck/shared/operations';

/**
 * Operator API (/admin/*), for the people who run DropDeck itself. Same sign-in as merchants; the Cognito group
 * `operators` is the role. API Gateway has already checked the token; this checks the group on every call, so the
 * /ops/ page hiding itself from non-operators is convenience, not security.
 */
type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

export const OPERATORS = 'operators';
const cognito = new CognitoIdentityProviderClient({});

/** HTTP API JWT authorizers pass array claims as a string like "[operators admins]"; accept that or a real array. */
export function groupsOf(event: Event): string[] {
  const raw = event.requestContext.authorizer?.jwt?.claims?.['cognito:groups'] as unknown;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return raw.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
  return [];
}

function requireOperator(event: Event): void {
  if (!groupsOf(event).includes(OPERATORS)) throw new ApiError('FORBIDDEN', 'This is for DropDeck operators only');
}

async function tenantIds(): Promise<string[]> {
  const k = keys.tenantsPrefix();
  const ids: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': k.PK, ':sk': k.SKPrefix },
      ExclusiveStartKey: start,
    }));
    ids.push(...(r.Items ?? []).map((i) => String(i.tenantId)));
    start = r.LastEvaluatedKey;
  } while (start);
  return ids;
}

/** Profiles and one month's usage for many shops, 50 shops per BatchGet (two keys each). */
async function profilesAndUsage(ids: string[], month: string): Promise<{ profiles: Map<string, MerchantProfile>; usage: Map<string, Usage> }> {
  const profiles = new Map<string, MerchantProfile>();
  const usage = new Map<string, Usage>();
  for (let i = 0; i < ids.length; i += 50) {
    let request: Record<string, { Keys: Record<string, unknown>[] }> | undefined = {
      [table()]: { Keys: ids.slice(i, i + 50).flatMap((t) => [keys.profile(t), keys.usage(t, month)]) },
    };
    for (let attempt = 0; request && attempt < 5; attempt++) {
      const r: BatchGetCommandOutput = await ddb.send(new BatchGetCommand({ RequestItems: request }));
      for (const item of r.Responses?.[table()] ?? []) {
        if (item.SK === 'PROFILE') profiles.set(String(item.tenantId), strip<MerchantProfile>(item)!);
        else usage.set(String(item.tenantId), strip<Usage>(item)!);
      }
      request = r.UnprocessedKeys && Object.keys(r.UnprocessedKeys).length ? (r.UnprocessedKeys as typeof request) : undefined;
      if (request) await new Promise((res) => setTimeout(res, 50 * 2 ** attempt));
    }
  }
  return { profiles, usage };
}

/** Sign-in emails by tenant (the Cognito sub), so operators can contact a shop. */
async function emails(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const pool = process.env.USER_POOL_ID;
  if (!pool) return out;
  let token: string | undefined;
  do {
    const r = await cognito.send(new ListUsersCommand({ UserPoolId: pool, PaginationToken: token, AttributesToGet: ['sub', 'email'] }));
    for (const u of r.Users ?? ([] as UserType[])) {
      const attr = (n: string) => u.Attributes?.find((a) => a.Name === n)?.Value;
      const sub = attr('sub');
      if (sub) out.set(sub, attr('email') ?? '');
    }
    token = r.PaginationToken;
  } while (token);
  return out;
}

export async function handler(event: Event) {
  try {
    requireOperator(event);
    switch (event.routeKey) {
      case 'GET /admin/analytics':
        return json(200,await analytics(event.queryStringParameters?.month,event.queryStringParameters?.cursor));
      case 'GET /admin/health':
        return json(200,await healthOverview(event.queryStringParameters?.cursor));
      case 'GET /admin/health/{tenantId}/{dropId}':
        return json(200,await dropTelemetry(event.pathParameters?.tenantId??'',event.pathParameters?.dropId??'',(event.queryStringParameters?.range??'1h') as OpsRange));
      case 'GET /admin/tenants': {
        const month = /^\d{4}-\d{2}$/.test(event.queryStringParameters?.month ?? '') ? event.queryStringParameters!.month! : usageMonth(Date.now());
        const ids = await tenantIds();
        const [{ profiles, usage }, mail, drops] = await Promise.all([
          profilesAndUsage(ids, month),
          emails(),
          Promise.all(ids.map(async (t) => [t, await listDrops(t)] as const)),
        ]);
        const dropsOf = new Map(drops);
        const tenants = ids.map((t) => {
          const p = profiles.get(t);
          const tier: Tier = p?.tier ?? 'starter';
          const ds = dropsOf.get(t) ?? [];
          return {
            tenantId: t, name: p?.name ?? '(no profile)', slug: p?.slugClaimed ? p.slug : undefined, email: mail.get(t),
            tier, usage: usage.get(t) ?? null, invoice: invoicePreview(tier, usage.get(t)),
            live: ds.filter((d) => d.state === 'Live').length, scheduled: ds.filter((d) => d.state === 'Scheduled').length,
          };
        }).sort((a, b) => a.name.localeCompare(b.name));
        const sum = (f: (u: Usage) => number) => tenants.reduce((n, x) => n + (x.usage ? f(x.usage) : 0), 0);
        return json(200, {
          month,
          tenants,
          totals: {
            shops: tenants.length, liveNow: tenants.reduce((n, x) => n + x.live, 0),
            drops: sum((u) => u.drops), sessions: sum((u) => u.sessions), orders: sum((u) => u.orders),
            gmvCents: sum((u) => u.revenueCents), billedSgd: tenants.reduce((n, x) => n + x.invoice.totalSgd, 0),
          },
        });
      }

      case 'PATCH /admin/tenants/{tenantId}': {
        const t = event.pathParameters?.tenantId ?? '';
        const tier = parseBody<{ tier?: unknown }>(event.body, event.isBase64Encoded).tier;
        if (!TIERS.includes(tier as Tier)) throw new ApiError('VALIDATION', `tier must be one of ${TIERS.join(', ')}`);
        try {
          const r = await ddb.send(new UpdateCommand({
            TableName: table(),
            Key: keys.profile(t),
            UpdateExpression: 'SET tier = :tier',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeValues: { ':tier': tier },
            ReturnValues: 'ALL_NEW',
          }));
          console.log(JSON.stringify({ level: 'info', msg: 'tier changed', t, tier, by: event.requestContext.authorizer?.jwt?.claims?.sub }));
          return json(200, { ...strip<MerchantProfile>(r.Attributes)!, plan: PLANS[tier as Tier] });
        } catch (e) {
          if (isConditionFailure(e)) throw new ApiError('NOT_FOUND', 'No such shop');
          throw e;
        }
      }

      default:
        throw new ApiError('NOT_FOUND', `No route ${event.routeKey}`);
    }
  } catch (err) {
    return errorResult(err);
  }
}

/** Routes registered in infra; keep in sync with the switch above. */
export const ROUTES = ['GET /admin/tenants', 'PATCH /admin/tenants/{tenantId}', 'GET /admin/analytics','GET /admin/health','GET /admin/health/{tenantId}/{dropId}'] as const;
