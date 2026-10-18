import { afterEach, describe, expect, it, vi } from 'vitest';
import { attributeDrop, healthEvent, observeRequest } from '../src/observability.js';
import { healthIssues, type DropHealth } from '../src/operations.js';

afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('operational telemetry',()=>{
  it('does not emit telemetry when the stage is not opted in',async()=>{
    vi.stubEnv('OPS_ENABLED','');const log=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
    await observeRequest('checkout',{},async()=>({statusCode:400,body:'{"code":"OTP_INVALID"}'}));
    healthEvent('otpAccepted','t','d');expect(log).not.toHaveBeenCalled();
  });
  it('isolates overlapping requests and excludes response secrets from logs and dimensions',async()=>{
    vi.stubEnv('OPS_ENABLED','1');vi.stubEnv('STAGE','test');const log=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
    await Promise.all(['one','two'].map(async id=>observeRequest('checkout',{requestContext:{requestId:id}},async()=>{
      attributeDrop(id,`drop-${id}`);await Promise.resolve();return {statusCode:500,body:'{"email":"buyer@example.com","code":"123456","token":"secret-token"}'};
    })));
    const records=log.mock.calls.map(c=>JSON.parse(String(c[0])));
    expect(records).toHaveLength(2);
    for(const r of records){expect(r.tenantId).toBe(r.requestId);expect(r.Failures).toBe(1);expect(r._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Stage','Service']]);}
    expect(JSON.stringify(records)).not.toMatch(/buyer@example|123456|secret-token/);
  });
});
describe('health evidence',()=>{
  const now=1_000_000;
  const healthy:DropHealth={tenantId:'t',dropId:'d',lifecycle:'Live',observedAt:now,heartbeatAt:now-5000,publicLastModifiedAt:now-60000,publicState:'Live',publicVersion:2,sourceVersion:2,inventory:{counterUnits:8,activeUnits:3,orderUnits:5,expiredUnits:0,partial:false,sampledAt:now}};
  it('does not mistake an unchanged snapshot for a dead controller',()=>{expect(healthIssues(healthy,now)).toEqual([]);});
  it('exposes absent heartbeat, stale data and incomplete inventory instead of assuming healthy',()=>{
    const issues=healthIssues({...healthy,heartbeatAt:undefined,observedAt:now-200000,inventory:{...healthy.inventory!,partial:true}},now);
    expect(issues.join(' ')).toMatch(/heartbeat/);expect(issues.join(' ')).toMatch(/collection/);expect(issues.join(' ')).toMatch(/incomplete/);
  });
  it('treats inventory differences as diagnostic evidence, and distinguishes failed publication',()=>{
    expect(healthIssues({...healthy,publicationFailureAt:now,publicationSuccessAt:now-10,inventory:{...healthy.inventory!,counterUnits:10}},now).join(' ')).toMatch(/publication failed.*sample differs/);
  });
});
