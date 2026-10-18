import { describe, expect, it } from 'vitest';
import { batches, edgeObservation, observation, sesObservation } from '../src/events.js';

describe('redacted telemetry ingestion',()=>{
  const raw={_ops:true,kind:'request',tenantId:'t',dropId:'d',at:100000,Service:'claim',status:201,LatencyMs:123};
  it('counts newly created holds separately from duplicate successful claims',()=>{
    expect(observation(raw,'1')?.counts.newHolds).toBe(1);
    expect(observation({...raw,status:200},'2')?.counts.newHolds).toBe(0);
  });
  it('distinguishes successful confirmation responses from completed OTP verification',()=>{
    const response=observation({...raw,Service:'checkout',operation:'POST /api/holds/{holdId}/confirm',status:200},'confirm');
    expect(response?.counts.confirmResponses).toBe(1);expect(response?.counts.otpVerified).toBeUndefined();
    expect(observation({...raw,kind:'otpVerified'},'verified')?.counts.otpVerified).toBe(1);
  });
  it('rejects malformed identities and strips arbitrary personal fields',()=>{
    expect(observation({...raw,tenantId:'t/../../secret'},'1')).toBeUndefined();
    const event=observation({...raw,email:'buyer@example.com',body:{otp:'123456'},authorization:'Bearer secret'},'1');
    expect(JSON.stringify(event)).not.toMatch(/buyer@example|123456|Bearer/);
  });
  it('groups a redelivered batch deterministically and suppresses duplicate records within it',()=>{
    const a=observation(raw,'1')!;const b=observation({...raw,at:100002},'2')!;
    const grouped=batches([a,b,a]);expect(grouped[0]?.counts.requests).toBe(2);
    expect(grouped[0]?.receipt).toBe(batches([b,a])[0]?.receipt);
  });
  it('attributes edge throttling only when the public path proves drop identity',()=>{
    expect(edgeObservation({status:'429',path:'/api/d/t/d/ticket',at:100000},'1')?.counts.edge429).toBe(1);
    expect(edgeObservation({status:'429',path:'/api/holds/opaque/otp',at:100000},'1')).toBeUndefined();
  });
  it('correlates delivery from internal SES tags without retaining recipients or OTP content',()=>{
    const o=sesObservation({eventType:'Delivery',mail:{messageId:'mail-1',destination:['buyer@example.com'],tags:{'dd-tenant':['t'],'dd-drop':['d']},headers:[{name:'Subject',value:'Code 123456'}]},delivery:{recipients:['buyer@example.com']}},'event-1');
    expect(o?.counts).toEqual({otpDelivered:1});expect(JSON.stringify(o)).not.toMatch(/buyer@example|123456|headers|destination/);
    expect(sesObservation({eventType:'Delivery',mail:{tags:{}}},'event-2')).toBeUndefined();
  });
});
