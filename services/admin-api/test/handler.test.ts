import { describe, expect, it } from 'vitest';
import { groupsOf, handler } from '../src/handler.js';

const ev = (groups: unknown) => ({
  routeKey: 'GET /admin/tenants',
  requestContext: { authorizer: { jwt: { claims: { sub: 'op-1', ...(groups === undefined ? {} : { 'cognito:groups': groups }) }, scopes: [] } } },
}) as never;

describe('operator check', () => {
  it('reads the group claim in the forms API Gateway passes it', () => {
    expect(groupsOf(ev('[operators]'))).toEqual(['operators']);
    expect(groupsOf(ev('[admins operators]'))).toEqual(['admins', 'operators']);
    expect(groupsOf(ev(['operators']))).toEqual(['operators']);
    expect(groupsOf(ev(undefined))).toEqual([]);
  });

  it('refuses anyone outside the operators group, before touching data', async () => {
    for (const g of [undefined, '[merchants]', '[operatorsx]']) for(const route of ['GET /admin/tenants','GET /admin/analytics','GET /admin/health','GET /admin/health/{tenantId}/{dropId}']) {
      const r = await handler({...ev(g) as object,routeKey:route} as never);
      expect(r.statusCode, String(g)).toBe(403);
      expect(JSON.parse(r.body).code).toBe('FORBIDDEN');
    }
  });
});
